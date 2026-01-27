import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { findExistingClawdbotProcess } from '../gateway';

/**
 * Debug routes for inspecting container state
 * Note: These routes should be protected by Cloudflare Access middleware
 * when mounted in the main app
 */
const debug = new Hono<AppEnv>();

// GET /debug/version - Returns version info from inside the container
debug.get('/version', async (c) => {
  const sandbox = c.get('sandbox');
  try {
    // Get clawdbot version
    const versionProcess = await sandbox.startProcess('clawdbot --version');
    await new Promise(resolve => setTimeout(resolve, 500));
    const versionLogs = await versionProcess.getLogs();
    const clawdbotVersion = (versionLogs.stdout || versionLogs.stderr || '').trim();

    // Get node version
    const nodeProcess = await sandbox.startProcess('node --version');
    await new Promise(resolve => setTimeout(resolve, 500));
    const nodeLogs = await nodeProcess.getLogs();
    const nodeVersion = (nodeLogs.stdout || '').trim();

    return c.json({
      clawdbot_version: clawdbotVersion,
      node_version: nodeVersion,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ status: 'error', message: `Failed to get version info: ${errorMessage}` }, 500);
  }
});

// GET /debug/processes - List all processes with optional logs
debug.get('/processes', async (c) => {
  const sandbox = c.get('sandbox');
  try {
    const processes = await sandbox.listProcesses();
    const includeLogs = c.req.query('logs') === 'true';

    const processData = await Promise.all(processes.map(async p => {
      const data: Record<string, unknown> = {
        id: p.id,
        command: p.command,
        status: p.status,
        startTime: p.startTime?.toISOString(),
        endTime: p.endTime?.toISOString(),
        exitCode: p.exitCode,
      };

      if (includeLogs) {
        try {
          const logs = await p.getLogs();
          data.stdout = logs.stdout || '';
          data.stderr = logs.stderr || '';
        } catch {
          data.logs_error = 'Failed to retrieve logs';
        }
      }

      return data;
    }));

    // Sort by status (running first, then starting, completed, failed)
    // Within each status, sort by startTime descending (newest first)
    const statusOrder: Record<string, number> = {
      'running': 0,
      'starting': 1,
      'completed': 2,
      'failed': 3,
    };
    
    processData.sort((a, b) => {
      const statusA = statusOrder[a.status as string] ?? 99;
      const statusB = statusOrder[b.status as string] ?? 99;
      if (statusA !== statusB) {
        return statusA - statusB;
      }
      // Within same status, sort by startTime descending
      const timeA = a.startTime as string || '';
      const timeB = b.startTime as string || '';
      return timeB.localeCompare(timeA);
    });

    return c.json({ count: processes.length, processes: processData });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage }, 500);
  }
});

// GET /debug/gateway-api - Probe the clawdbot gateway HTTP API
debug.get('/gateway-api', async (c) => {
  const sandbox = c.get('sandbox');
  const path = c.req.query('path') || '/';
  const CLAWDBOT_PORT = 18789;
  
  try {
    const url = `http://localhost:${CLAWDBOT_PORT}${path}`;
    const response = await sandbox.containerFetch(new Request(url), CLAWDBOT_PORT);
    const contentType = response.headers.get('content-type') || '';
    
    let body: string | object;
    if (contentType.includes('application/json')) {
      body = await response.json();
    } else {
      body = await response.text();
    }
    
    return c.json({
      path,
      status: response.status,
      contentType,
      body,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage, path }, 500);
  }
});

// GET /debug/cli - Test clawdbot CLI commands
debug.get('/cli', async (c) => {
  const sandbox = c.get('sandbox');
  const cmd = c.req.query('cmd') || 'clawdbot --help';
  
  try {
    const proc = await sandbox.startProcess(cmd);
    
    // Wait longer for command to complete
    let attempts = 0;
    while (attempts < 30) {
      await new Promise(r => setTimeout(r, 500));
      if (proc.status !== 'running') break;
      attempts++;
    }

    const logs = await proc.getLogs();
    return c.json({
      command: cmd,
      status: proc.status,
      exitCode: proc.exitCode,
      attempts,
      stdout: logs.stdout || '',
      stderr: logs.stderr || '',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: errorMessage, command: cmd }, 500);
  }
});

// GET /debug/logs - Returns container logs for debugging
debug.get('/logs', async (c) => {
  const sandbox = c.get('sandbox');
  try {
    const processId = c.req.query('id');
    let process = null;

    if (processId) {
      const processes = await sandbox.listProcesses();
      process = processes.find(p => p.id === processId);
      if (!process) {
        return c.json({
          status: 'not_found',
          message: `Process ${processId} not found`,
          stdout: '',
          stderr: '',
        }, 404);
      }
    } else {
      process = await findExistingClawdbotProcess(sandbox);
      if (!process) {
        return c.json({
          status: 'no_process',
          message: 'No Clawdbot process is currently running',
          stdout: '',
          stderr: '',
        });
      }
    }

    const logs = await process.getLogs();
    return c.json({
      status: 'ok',
      process_id: process.id,
      process_status: process.status,
      stdout: logs.stdout || '',
      stderr: logs.stderr || '',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return c.json({
      status: 'error',
      message: `Failed to get logs: ${errorMessage}`,
      stdout: '',
      stderr: '',
    }, 500);
  }
});

export { debug };
