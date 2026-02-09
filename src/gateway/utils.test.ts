import { describe, it, expect } from 'vitest';
import { waitForProcess } from './utils';

describe('waitForProcess', () => {
  it('waits until process status is not running', async () => {
    const proc = { status: 'running' };
    // Immediately change status to completed
    setTimeout(() => {
      proc.status = 'completed';
    }, 10);

    await waitForProcess(proc, 1000);
    expect(proc.status).toBe('completed');
  });

  it('times out if process stays running too long', async () => {
    const proc = { status: 'running' };
    // Never completes

    await waitForProcess(proc, 100, 50);
    // Should exit loop after timeout
    expect(proc.status).toBe('running');
  });

  it('throws error when process is canceled', async () => {
    const proc = { status: 'canceled' };

    await expect(waitForProcess(proc, 1000)).rejects.toThrow(
      'Process was canceled (Durable Object reset?)',
    );
  });

  it('throws error when process becomes canceled during wait', async () => {
    const proc = { status: 'running' };
    // Change status to canceled after a short delay
    setTimeout(() => {
      proc.status = 'canceled';
    }, 10);

    await expect(waitForProcess(proc, 1000)).rejects.toThrow(
      'Process was canceled (Durable Object reset?)',
    );
  });

  it('does not throw for completed status', async () => {
    const proc = { status: 'completed' };

    await expect(waitForProcess(proc, 1000)).resolves.toBeUndefined();
  });

  it('does not throw for exited status', async () => {
    const proc = { status: 'exited' };

    await expect(waitForProcess(proc, 1000)).resolves.toBeUndefined();
  });
});
