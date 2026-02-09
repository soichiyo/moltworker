import type { Sandbox } from '@cloudflare/sandbox';
import { R2_MOUNT_PATH } from '../config';
import { waitForProcess } from './utils';

export interface RestoreResult {
  restored: boolean;
  details?: string;
  legacyMigrated?: boolean;
}

/**
 * Restore OpenClaw config and workspace from R2 backup before the gateway starts.
 *
 * This runs BEFORE start-openclaw.sh so the startup script only deals with
 * local files. All s3fs-dependent I/O happens here with proper error handling
 * — a failure simply means "start fresh" instead of crashing the startup script.
 *
 * The config directory (/root/.openclaw/) includes workspace/ as a subdirectory,
 * so restoring the config also restores the workspace (IDENTITY.md, MEMORY.md, memory/, etc.).
 *
 * Restores from:
 * - Config+Workspace: R2:/openclaw/ (or legacy R2:/clawdbot/) → /root/.openclaw/
 * - Legacy migration: R2:/workspace/ → merged into /root/.openclaw/workspace/ (if exists)
 * - Legacy migration: R2:/skills/ → merged into /root/.openclaw/workspace/skills/ (if exists)
 */
export async function restoreFromR2(sandbox: Sandbox): Promise<RestoreResult> {
  const BACKUP_DIR = R2_MOUNT_PATH;
  const CONFIG_DIR = '/root/.openclaw';

  // Determine which backup format exists (new openclaw/ or legacy clawdbot/)
  let backupConfigDir: string | null = null;
  let needsMigration = false;

  try {
    const checkNew = await sandbox.startProcess(
      `test -f ${BACKUP_DIR}/openclaw/openclaw.json`,
    );
    await waitForProcess(checkNew, 5000);
    if (checkNew.exitCode === 0) {
      backupConfigDir = `${BACKUP_DIR}/openclaw`;
    }
  } catch (err) {
    // If the process was canceled (DO reset), abort restore and let caller retry
    if (err instanceof Error && err.message.includes('canceled')) {
      console.log('[Restore] Process canceled (DO reset detected), aborting restore');
      return { restored: false, details: 'DO reset during restore' };
    }
    // Otherwise ignore — will try legacy path
  }

  if (!backupConfigDir) {
    try {
      const checkLegacy = await sandbox.startProcess(
        `test -f ${BACKUP_DIR}/clawdbot/clawdbot.json`,
      );
      await waitForProcess(checkLegacy, 5000);
      if (checkLegacy.exitCode === 0) {
        backupConfigDir = `${BACKUP_DIR}/clawdbot`;
        needsMigration = true;
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('canceled')) {
        console.log('[Restore] Process canceled (DO reset detected), aborting restore');
        return { restored: false, details: 'DO reset during restore' };
      }
      // Otherwise ignore
    }
  }

  if (!backupConfigDir) {
    try {
      const checkFlat = await sandbox.startProcess(
        `test -f ${BACKUP_DIR}/clawdbot.json`,
      );
      await waitForProcess(checkFlat, 5000);
      if (checkFlat.exitCode === 0) {
        backupConfigDir = BACKUP_DIR;
        needsMigration = true;
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('canceled')) {
        console.log('[Restore] Process canceled (DO reset detected), aborting restore');
        return { restored: false, details: 'DO reset during restore' };
      }
      // Otherwise ignore
    }
  }

  if (!backupConfigDir) {
    // Diagnostic: show what the mounted bucket looks like. This helps distinguish:
    // - Empty/wrong bucket mounted
    // - Stale mount showing empty listings
    // - Permission issues (ls errors)
    try {
      const diagCmd = [
        `echo "=== R2 root (${BACKUP_DIR}) ==="`,
        `ls -la ${BACKUP_DIR} 2>&1 | head -100 || true`,
        `echo "=== R2 openclaw dir (${BACKUP_DIR}/openclaw) ==="`,
        `ls -la ${BACKUP_DIR}/openclaw 2>&1 | head -100 || true`,
        `echo "=== R2 clawdbot dir (${BACKUP_DIR}/clawdbot) ==="`,
        `ls -la ${BACKUP_DIR}/clawdbot 2>&1 | head -100 || true`,
        `echo "=== R2 last-sync (${BACKUP_DIR}/.last-sync) ==="`,
        `cat ${BACKUP_DIR}/.last-sync 2>&1 | head -20 || true`,
      ].join('; ');
      const proc = await sandbox.startProcess(diagCmd);
      await waitForProcess(proc, 10000);
      const logs = await proc.getLogs();
      console.log('[Restore] No R2 backup data found, starting fresh. Diagnostic:\n' + (logs.stdout || '').trim());
      return { restored: false, details: 'No backup data found', legacyMigrated: undefined };
    } catch {
      console.log('[Restore] No R2 backup data found, starting fresh');
      return { restored: false, details: 'No backup data found' };
    }
  }

  // Check if R2 backup is newer than local data
  if (!await shouldRestore(sandbox, BACKUP_DIR, CONFIG_DIR)) {
    return { restored: false, details: 'Local data is newer or same' };
  }

  // Restore config (includes workspace/ subdirectory)
  console.log('[Restore] Restoring config from', backupConfigDir);
  try {
    const restoreCmd = [
      `mkdir -p ${CONFIG_DIR}`,
      `cp -a ${backupConfigDir}/. ${CONFIG_DIR}/`,
      `cp -f ${BACKUP_DIR}/.last-sync ${CONFIG_DIR}/.last-sync 2>/dev/null || true`,
    ].join(' && ');
    const proc = await sandbox.startProcess(restoreCmd);
    await waitForProcess(proc, 15000);

    if (needsMigration) {
      const migrateProc = await sandbox.startProcess(
        `test -f ${CONFIG_DIR}/clawdbot.json && ! test -f ${CONFIG_DIR}/openclaw.json && mv ${CONFIG_DIR}/clawdbot.json ${CONFIG_DIR}/openclaw.json || true`,
      );
      await waitForProcess(migrateProc, 5000);
    }

    // Write a local marker so sync can distinguish "restore succeeded"
    // even when .last-sync is missing in older backups.
    try {
      const markerProc = await sandbox.startProcess(
        `date -Iseconds > ${CONFIG_DIR}/.r2-restored 2>/dev/null || echo "restored" > ${CONFIG_DIR}/.r2-restored`,
      );
      await waitForProcess(markerProc, 5000);
    } catch {
      // non-fatal
    }

    console.log('[Restore] Config restored successfully');
  } catch (err) {
    console.error('[Restore] Failed to restore config:', err);
    return { restored: false, details: 'Config restore failed' };
  }

  // Migrate legacy R2:/workspace/ data into config workspace (non-fatal)
  let legacyMigrated = false;
  legacyMigrated = await migrateLegacyWorkspace(sandbox, BACKUP_DIR, CONFIG_DIR);

  // Migrate legacy R2:/skills/ data into config workspace (non-fatal)
  await migrateLegacySkills(sandbox, BACKUP_DIR, CONFIG_DIR);

  // Validate restore quality
  await validateRestore(sandbox, CONFIG_DIR);

  return {
    restored: true,
    details: `Restored from ${backupConfigDir}`,
    legacyMigrated: legacyMigrated || undefined,
  };
}

/**
 * Migrate legacy R2:/workspace/ data into /root/.openclaw/workspace/.
 *
 * Earlier versions synced workspace separately to R2:/workspace/ from /root/clawd/.
 * This merges that data into the correct location under the config directory.
 * Only copies files that don't already exist locally (no overwriting).
 */
async function migrateLegacyWorkspace(
  sandbox: Sandbox,
  backupDir: string,
  configDir: string,
): Promise<boolean> {
  try {
    const checkProc = await sandbox.startProcess(
      `test -d ${backupDir}/workspace && ls ${backupDir}/workspace/ 2>/dev/null | head -1`,
    );
    await waitForProcess(checkProc, 5000);
    const logs = await checkProc.getLogs();

    if (checkProc.exitCode === 0 && logs.stdout?.trim()) {
      // Use cp -n (no-clobber) to avoid overwriting files already restored from R2:/openclaw/
      const migrateProc = await sandbox.startProcess(
        `mkdir -p ${configDir}/workspace && cp -a -n ${backupDir}/workspace/. ${configDir}/workspace/ 2>/dev/null || true`,
      );
      await waitForProcess(migrateProc, 15000);
      console.log('[Restore] Migrated legacy workspace data from R2:/workspace/');
      return true;
    }
  } catch (err) {
    console.log('[Restore] Legacy workspace migration failed (non-fatal):', err);
  }
  return false;
}

/**
 * Migrate legacy R2:/skills/ data into /root/.openclaw/workspace/skills/.
 */
async function migrateLegacySkills(
  sandbox: Sandbox,
  backupDir: string,
  configDir: string,
): Promise<void> {
  try {
    const checkProc = await sandbox.startProcess(
      `test -d ${backupDir}/skills && ls ${backupDir}/skills/ 2>/dev/null | head -1`,
    );
    await waitForProcess(checkProc, 5000);
    const logs = await checkProc.getLogs();

    if (checkProc.exitCode === 0 && logs.stdout?.trim()) {
      const migrateProc = await sandbox.startProcess(
        `mkdir -p ${configDir}/workspace/skills && cp -a -n ${backupDir}/skills/. ${configDir}/workspace/skills/ 2>/dev/null || true`,
      );
      await waitForProcess(migrateProc, 15000);
      console.log('[Restore] Migrated legacy skills data from R2:/skills/');
    }
  } catch (err) {
    console.log('[Restore] Legacy skills migration failed (non-fatal):', err);
  }
}

/**
 * Validate that the restored workspace has meaningful content.
 * Logs a warning if IDENTITY.md appears to be default (small size).
 */
async function validateRestore(sandbox: Sandbox, configDir: string): Promise<void> {
  try {
    const proc = await sandbox.startProcess(
      `wc -c < ${configDir}/workspace/IDENTITY.md 2>/dev/null || echo "0"`,
    );
    await waitForProcess(proc, 5000);
    const logs = await proc.getLogs();
    const size = parseInt(logs.stdout?.trim() || '0', 10);

    if (size > 0 && size <= 700) {
      console.warn(
        '[Restore] WARNING: IDENTITY.md is only',
        size,
        'bytes (likely default). The workspace may not have been fully backed up previously.',
      );
    } else if (size > 700) {
      console.log('[Restore] IDENTITY.md restored:', size, 'bytes');
    }
  } catch {
    // non-fatal
  }
}

/**
 * Compare R2 backup timestamp with local timestamp to decide if restore is needed.
 */
async function shouldRestore(
  sandbox: Sandbox,
  backupDir: string,
  configDir: string,
): Promise<boolean> {
  try {
    // Check local sync timestamp
    const checkLocal = await sandbox.startProcess(`cat ${configDir}/.last-sync 2>/dev/null`);
    await waitForProcess(checkLocal, 5000);
    const localLogs = await checkLocal.getLogs();
    const localTime = localLogs.stdout?.trim();

    // Check if R2 sync timestamp exists
    const checkR2 = await sandbox.startProcess(`cat ${backupDir}/.last-sync 2>/dev/null`);
    await waitForProcess(checkR2, 5000);
    const r2Logs = await checkR2.getLogs();
    const r2Time = r2Logs.stdout?.trim();

    if (!localTime) {
      if (r2Time) {
        console.log('[Restore] No local sync timestamp, will restore from R2');
      } else {
        // Older backups may not have .last-sync. If local has no timestamp,
        // prefer restoring whatever backup data we found.
        console.log('[Restore] No local sync timestamp and no R2 timestamp, will restore from R2');
      }
      return true;
    }

    if (!r2Time) {
      console.log('[Restore] Local data has a sync timestamp but R2 timestamp is missing, skipping restore');
      return false;
    }

    // Compare timestamps
    const compareProc = await sandbox.startProcess(
      `test "$(date -d '${r2Time}' +%s 2>/dev/null || echo 0)" -gt "$(date -d '${localTime}' +%s 2>/dev/null || echo 0)"`,
    );
    await waitForProcess(compareProc, 5000);

    if (compareProc.exitCode === 0) {
      console.log('[Restore] R2 backup is newer, will restore');
      return true;
    }

    console.log('[Restore] Local data is newer or same, skipping restore');
    return false;
  } catch (err) {
    console.log('[Restore] Timestamp comparison failed, will restore as fallback:', err);
    return true;
  }
}
