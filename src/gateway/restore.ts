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
 * With the new architecture, config/workspace lives directly in R2 mount (/data/moltbot/openclaw).
 * The startup script creates a symlink: /root/.openclaw -> /data/moltbot/openclaw
 *
 * This function now only needs to:
 * 1. Check if R2 data exists at /data/moltbot/openclaw
 * 2. Migrate legacy data if needed (from old backup locations)
 * 3. Return success (data is already available via R2 mount)
 *
 * Legacy migration paths (for backward compatibility):
 * - R2:/workspace/ → merged into R2:/openclaw/workspace/ (if exists)
 * - R2:/skills/ → merged into R2:/openclaw/workspace/skills/ (if exists)
 */
export async function restoreFromR2(sandbox: Sandbox): Promise<RestoreResult> {
  const BACKUP_DIR = R2_MOUNT_PATH;
  // Config now lives directly in R2 mount (symlinked from /root/.openclaw)
  const R2_CONFIG_DIR = `${BACKUP_DIR}/openclaw`;

  // Check if config already exists in R2 mount (primary location)
  try {
    const checkR2Config = await sandbox.startProcess(
      `test -f ${R2_CONFIG_DIR}/openclaw.json || test -f ${R2_CONFIG_DIR}/clawdbot.json`,
    );
    await waitForProcess(checkR2Config, 5000);

    if (checkR2Config.exitCode === 0) {
      console.log('[Restore] Config already exists in R2 mount at', R2_CONFIG_DIR);

      // Migrate clawdbot.json to openclaw.json if needed
      try {
        const migrateProc = await sandbox.startProcess(
          `test -f ${R2_CONFIG_DIR}/clawdbot.json && ! test -f ${R2_CONFIG_DIR}/openclaw.json && mv ${R2_CONFIG_DIR}/clawdbot.json ${R2_CONFIG_DIR}/openclaw.json || true`,
        );
        await waitForProcess(migrateProc, 5000);
      } catch {
        // non-fatal
      }

      // Migrate legacy data if present
      let legacyMigrated = false;
      legacyMigrated = await migrateLegacyWorkspace(sandbox, BACKUP_DIR, R2_CONFIG_DIR);
      await migrateLegacySkills(sandbox, BACKUP_DIR, R2_CONFIG_DIR);

      // Validate data quality
      await validateRestore(sandbox, R2_CONFIG_DIR);

      return {
        restored: true,
        details: 'Data already in R2 mount',
        legacyMigrated: legacyMigrated || undefined,
      };
    }
  } catch (err) {
    // If the process was canceled (DO reset), abort restore and let caller retry
    if (err instanceof Error && err.message.includes('canceled')) {
      console.log('[Restore] Process canceled (DO reset detected), aborting restore');
      return { restored: false, details: 'DO reset during restore' };
    }
    // Otherwise continue to check legacy locations
  }

  // Check legacy backup locations and migrate if found
  console.log('[Restore] No config in R2 mount, checking legacy backup locations...');

  let legacySourceDir: string | null = null;

  // Check R2:/clawdbot/ (legacy backup location)
  try {
    const checkLegacyDir = await sandbox.startProcess(
      `test -f ${BACKUP_DIR}/clawdbot/clawdbot.json`,
    );
    await waitForProcess(checkLegacyDir, 5000);
    if (checkLegacyDir.exitCode === 0) {
      legacySourceDir = `${BACKUP_DIR}/clawdbot`;
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('canceled')) {
      console.log('[Restore] Process canceled (DO reset detected), aborting restore');
      return { restored: false, details: 'DO reset during restore' };
    }
  }

  // Check R2:/clawdbot.json (flat legacy backup)
  if (!legacySourceDir) {
    try {
      const checkLegacyFlat = await sandbox.startProcess(
        `test -f ${BACKUP_DIR}/clawdbot.json`,
      );
      await waitForProcess(checkLegacyFlat, 5000);
      if (checkLegacyFlat.exitCode === 0) {
        legacySourceDir = BACKUP_DIR;
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('canceled')) {
        console.log('[Restore] Process canceled (DO reset detected), aborting restore');
        return { restored: false, details: 'DO reset during restore' };
      }
    }
  }

  if (legacySourceDir) {
    // Migrate legacy backup to new R2 location
    console.log('[Restore] Migrating legacy backup from', legacySourceDir, 'to', R2_CONFIG_DIR);
    try {
      const migrateCmd = [
        `mkdir -p ${R2_CONFIG_DIR}`,
        `cp -a ${legacySourceDir}/. ${R2_CONFIG_DIR}/`,
        `test -f ${R2_CONFIG_DIR}/clawdbot.json && ! test -f ${R2_CONFIG_DIR}/openclaw.json && mv ${R2_CONFIG_DIR}/clawdbot.json ${R2_CONFIG_DIR}/openclaw.json || true`,
      ].join(' && ');
      const proc = await sandbox.startProcess(migrateCmd);
      await waitForProcess(proc, 15000);
      console.log('[Restore] Legacy backup migrated successfully');
    } catch (err) {
      console.error('[Restore] Failed to migrate legacy backup:', err);
      return { restored: false, details: 'Legacy migration failed' };
    }
  } else {
    // No backup data found anywhere
    console.log('[Restore] No backup data found, starting fresh');
    return { restored: false, details: 'No backup data found' };
  }

  // Migrate legacy workspace/skills data if present
  let legacyMigrated = false;
  legacyMigrated = await migrateLegacyWorkspace(sandbox, BACKUP_DIR, R2_CONFIG_DIR);
  await migrateLegacySkills(sandbox, BACKUP_DIR, R2_CONFIG_DIR);

  // Validate restore quality
  await validateRestore(sandbox, R2_CONFIG_DIR);

  return {
    restored: true,
    details: legacySourceDir ? `Migrated from ${legacySourceDir}` : 'Restored',
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
