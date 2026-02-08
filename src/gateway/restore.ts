import type { Sandbox } from '@cloudflare/sandbox';
import { R2_MOUNT_PATH } from '../config';
import { waitForProcess } from './utils';

export interface RestoreResult {
  restored: boolean;
  details?: string;
}

/**
 * Restore OpenClaw config and workspace from R2 backup before the gateway starts.
 *
 * This runs BEFORE start-openclaw.sh so the startup script only deals with
 * local files. All s3fs-dependent I/O happens here with proper error handling
 * — a failure simply means "start fresh" instead of crashing the startup script.
 *
 * Restores three directories:
 * - Config: R2:/openclaw/ (or legacy R2:/clawdbot/) → /root/.openclaw/
 * - Workspace: R2:/workspace/ → /root/clawd/
 * - Skills: R2:/skills/ → /root/clawd/skills/
 */
export async function restoreFromR2(sandbox: Sandbox): Promise<RestoreResult> {
  const BACKUP_DIR = R2_MOUNT_PATH;
  const CONFIG_DIR = '/root/.openclaw';
  const WORKSPACE_DIR = '/root/clawd';
  const SKILLS_DIR = '/root/clawd/skills';

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
  } catch {
    // ignore — will try legacy path
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
    } catch {
      // ignore
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
    } catch {
      // ignore
    }
  }

  if (!backupConfigDir) {
    console.log('[Restore] No R2 backup data found, starting fresh');
    return { restored: false, details: 'No backup data found' };
  }

  // Check if R2 backup is newer than local data
  if (!await shouldRestore(sandbox, BACKUP_DIR, CONFIG_DIR)) {
    return { restored: false, details: 'Local data is newer or same' };
  }

  // Restore config
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
    console.log('[Restore] Config restored successfully');
  } catch (err) {
    console.error('[Restore] Failed to restore config:', err);
    return { restored: false, details: 'Config restore failed' };
  }

  // Restore workspace (non-fatal if it fails)
  try {
    const checkWorkspace = await sandbox.startProcess(
      `test -d ${BACKUP_DIR}/workspace && ls ${BACKUP_DIR}/workspace/ 2>/dev/null | head -1`,
    );
    await waitForProcess(checkWorkspace, 5000);
    const wsLogs = await checkWorkspace.getLogs();
    if (checkWorkspace.exitCode === 0 && wsLogs.stdout?.trim()) {
      const wsProc = await sandbox.startProcess(
        `mkdir -p ${WORKSPACE_DIR} && cp -a ${BACKUP_DIR}/workspace/. ${WORKSPACE_DIR}/`,
      );
      await waitForProcess(wsProc, 15000);
      console.log('[Restore] Workspace restored');
    }
  } catch (err) {
    console.log('[Restore] Workspace restore failed (non-fatal):', err);
  }

  // Restore skills (non-fatal if it fails)
  try {
    const checkSkills = await sandbox.startProcess(
      `test -d ${BACKUP_DIR}/skills && ls ${BACKUP_DIR}/skills/ 2>/dev/null | head -1`,
    );
    await waitForProcess(checkSkills, 5000);
    const skLogs = await checkSkills.getLogs();
    if (checkSkills.exitCode === 0 && skLogs.stdout?.trim()) {
      const skProc = await sandbox.startProcess(
        `mkdir -p ${SKILLS_DIR} && cp -a ${BACKUP_DIR}/skills/. ${SKILLS_DIR}/`,
      );
      await waitForProcess(skProc, 15000);
      console.log('[Restore] Skills restored');
    }
  } catch (err) {
    console.log('[Restore] Skills restore failed (non-fatal):', err);
  }

  return { restored: true, details: `Restored from ${backupConfigDir}` };
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
    // Check if R2 sync timestamp exists
    const checkR2 = await sandbox.startProcess(`cat ${backupDir}/.last-sync 2>/dev/null`);
    await waitForProcess(checkR2, 5000);
    const r2Logs = await checkR2.getLogs();
    const r2Time = r2Logs.stdout?.trim();

    if (!r2Time) {
      console.log('[Restore] No R2 sync timestamp, skipping restore');
      return false;
    }

    // Check local sync timestamp
    const checkLocal = await sandbox.startProcess(`cat ${configDir}/.last-sync 2>/dev/null`);
    await waitForProcess(checkLocal, 5000);
    const localLogs = await checkLocal.getLogs();
    const localTime = localLogs.stdout?.trim();

    if (!localTime) {
      console.log('[Restore] No local sync timestamp, will restore from R2');
      return true;
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
