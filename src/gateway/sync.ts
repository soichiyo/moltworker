import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { R2_MOUNT_PATH } from '../config';
import { mountR2Storage } from './r2';
import { waitForProcess } from './utils';

export interface SyncResult {
  success: boolean;
  lastSync?: string;
  error?: string;
  details?: string;
}

/**
 * Sync OpenClaw config and workspace from container to R2 for persistence.
 *
 * This function:
 * 1. Mounts R2 if not already mounted
 * 2. Verifies source has critical files (prevents overwriting good backup with empty data)
 * 3. Runs rsync to copy config, workspace, and skills to R2
 * 4. Writes a timestamp file for tracking
 *
 * Syncs three directories:
 * - Config: /root/.openclaw/ (or /root/.clawdbot/) → R2:/openclaw/
 * - Workspace: /root/clawd/ → R2:/workspace/ (IDENTITY.md, MEMORY.md, memory/, assets/)
 * - Skills: /root/clawd/skills/ → R2:/skills/
 *
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns SyncResult with success status and optional error details
 */
export async function syncToR2(sandbox: Sandbox, env: MoltbotEnv): Promise<SyncResult> {
  // Check if R2 is configured
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) {
    return { success: false, error: 'R2 storage is not configured' };
  }

  // Mount R2 if not already mounted
  const mounted = await mountR2Storage(sandbox, env);
  if (!mounted) {
    return { success: false, error: 'Failed to mount R2 storage' };
  }

  // Determine which config directory exists
  // Use ls + grep instead of test -f to avoid exit code timing issues with the sandbox API
  let configDir = '/root/.openclaw';
  try {
    const checkProc = await sandbox.startProcess(
      'ls /root/.openclaw/openclaw.json 2>/dev/null && echo FOUND_OPENCLAW || ' +
      '(ls /root/.clawdbot/clawdbot.json 2>/dev/null && echo FOUND_CLAWDBOT || echo FOUND_NONE)',
    );
    await waitForProcess(checkProc, 5000);
    const checkLogs = await checkProc.getLogs();
    const checkOutput = checkLogs.stdout || '';

    if (checkOutput.includes('FOUND_OPENCLAW')) {
      configDir = '/root/.openclaw';
    } else if (checkOutput.includes('FOUND_CLAWDBOT')) {
      configDir = '/root/.clawdbot';
    } else {
      // Gather diagnostic info
      const diagProc = await sandbox.startProcess(
        'echo "=== .openclaw ===" && ls -la /root/.openclaw/ 2>&1 && echo "=== .clawdbot ===" && ls -la /root/.clawdbot/ 2>&1',
      );
      await waitForProcess(diagProc, 5000);
      const diagLogs = await diagProc.getLogs();

      return {
        success: false,
        error: 'Sync aborted: no config file found',
        details: `Neither openclaw.json nor clawdbot.json found. Directory listing: ${diagLogs.stdout || '(empty)'}`,
      };
    }
  } catch (err) {
    return {
      success: false,
      error: 'Failed to verify source files',
      details: err instanceof Error ? err.message : 'Unknown error',
    };
  }

  // Sync to the new openclaw/ R2 prefix (even if source is legacy .clawdbot)
  // Also sync workspace directory (excluding skills since they're synced separately)
  const syncCmd = `rsync -r --no-times --delete --exclude='*.lock' --exclude='*.log' --exclude='*.tmp' ${configDir}/ ${R2_MOUNT_PATH}/openclaw/ && rsync -r --no-times --delete --exclude='skills' /root/clawd/ ${R2_MOUNT_PATH}/workspace/ && rsync -r --no-times --delete /root/clawd/skills/ ${R2_MOUNT_PATH}/skills/ && date -Iseconds > ${R2_MOUNT_PATH}/.last-sync`;

  try {
    const proc = await sandbox.startProcess(syncCmd);
    await waitForProcess(proc, 30000); // 30 second timeout for sync

    // Check for success by reading the timestamp file
    const timestampProc = await sandbox.startProcess(`cat ${R2_MOUNT_PATH}/.last-sync`);
    await waitForProcess(timestampProc, 5000);
    const timestampLogs = await timestampProc.getLogs();
    const lastSync = timestampLogs.stdout?.trim();

    if (lastSync && lastSync.match(/^\d{4}-\d{2}-\d{2}/)) {
      return { success: true, lastSync };
    } else {
      const logs = await proc.getLogs();
      return {
        success: false,
        error: 'Sync failed',
        details: logs.stderr || logs.stdout || 'No timestamp file created',
      };
    }
  } catch (err) {
    return {
      success: false,
      error: 'Sync error',
      details: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
