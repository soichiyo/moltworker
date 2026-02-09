import { describe, it, expect, beforeEach } from 'vitest';
import { restoreFromR2 } from './restore';
import { createMockProcess, createMockSandbox, suppressConsole } from '../test-utils';

describe('restoreFromR2', () => {
  beforeEach(() => {
    suppressConsole();
  });

  describe('no backup data', () => {
    it('returns not restored when no backup files exist', async () => {
      const { sandbox, startProcessMock } = createMockSandbox();
      // All three test -f checks fail (openclaw, clawdbot/, clawdbot.json)
      startProcessMock
        .mockResolvedValueOnce(createMockProcess('', { exitCode: 1 }))
        .mockResolvedValueOnce(createMockProcess('', { exitCode: 1 }))
        .mockResolvedValueOnce(createMockProcess('', { exitCode: 1 }))
        // diagnostic ls/cat
        .mockResolvedValueOnce(createMockProcess(''));

      const result = await restoreFromR2(sandbox);

      expect(result.restored).toBe(false);
      expect(result.details).toBe('No backup data found');
    });
  });

  describe('openclaw backup format', () => {
    it('restores from openclaw/ prefix when R2 is newer', async () => {
      const { sandbox, startProcessMock } = createMockSandbox();
      startProcessMock
        // test -f openclaw/openclaw.json → exists
        .mockResolvedValueOnce(createMockProcess('', { exitCode: 0 }))
        // shouldRestore: cat .last-sync (local) — empty means no local timestamp
        .mockResolvedValueOnce(createMockProcess(''))
        // shouldRestore: cat .last-sync (R2)
        .mockResolvedValueOnce(createMockProcess('2026-02-08T12:00:00+00:00'))
        // restore config: mkdir + cp
        .mockResolvedValueOnce(createMockProcess(''))
        // write restore marker
        .mockResolvedValueOnce(createMockProcess(''))
        // legacy workspace migration: check → empty
        .mockResolvedValueOnce(createMockProcess(''))
        // legacy skills migration: check → empty
        .mockResolvedValueOnce(createMockProcess(''))
        // validateRestore: wc -c IDENTITY.md
        .mockResolvedValueOnce(createMockProcess('0'));

      const result = await restoreFromR2(sandbox);

      expect(result.restored).toBe(true);
      expect(result.details).toContain('openclaw');
    });

    it('skips restore when local data is newer', async () => {
      const { sandbox, startProcessMock } = createMockSandbox();
      startProcessMock
        // test -f openclaw/openclaw.json → exists
        .mockResolvedValueOnce(createMockProcess('', { exitCode: 0 }))
        // shouldRestore: cat .last-sync (local)
        .mockResolvedValueOnce(createMockProcess('2026-02-08T13:00:00+00:00'))
        // shouldRestore: cat .last-sync (R2)
        .mockResolvedValueOnce(createMockProcess('2026-02-08T12:00:00+00:00'))
        // shouldRestore: date compare → local is newer (exit 1)
        .mockResolvedValueOnce(createMockProcess('', { exitCode: 1 }));

      const result = await restoreFromR2(sandbox);

      expect(result.restored).toBe(false);
      expect(result.details).toBe('Local data is newer or same');
    });
  });

  describe('legacy clawdbot/ backup format', () => {
    it('restores from clawdbot/ prefix with migration', async () => {
      const { sandbox, startProcessMock } = createMockSandbox();
      startProcessMock
        // test -f openclaw/openclaw.json → not found
        .mockResolvedValueOnce(createMockProcess('', { exitCode: 1 }))
        // test -f clawdbot/clawdbot.json → found
        .mockResolvedValueOnce(createMockProcess('', { exitCode: 0 }))
        // shouldRestore: cat .last-sync (local) — empty
        .mockResolvedValueOnce(createMockProcess(''))
        // shouldRestore: cat .last-sync (R2)
        .mockResolvedValueOnce(createMockProcess('2026-02-08T12:00:00+00:00'))
        // restore config: mkdir + cp
        .mockResolvedValueOnce(createMockProcess(''))
        // migration: rename clawdbot.json → openclaw.json
        .mockResolvedValueOnce(createMockProcess(''))
        // write restore marker
        .mockResolvedValueOnce(createMockProcess(''))
        // legacy workspace migration: check → empty
        .mockResolvedValueOnce(createMockProcess(''))
        // legacy skills migration: check → empty
        .mockResolvedValueOnce(createMockProcess(''))
        // validateRestore: wc -c IDENTITY.md
        .mockResolvedValueOnce(createMockProcess('0'));

      const result = await restoreFromR2(sandbox);

      expect(result.restored).toBe(true);
      expect(result.details).toContain('clawdbot');
    });
  });

  describe('legacy workspace migration', () => {
    it('migrates legacy R2:/workspace/ data into config workspace', async () => {
      const { sandbox, startProcessMock } = createMockSandbox();
      startProcessMock
        // test -f openclaw/openclaw.json → exists
        .mockResolvedValueOnce(createMockProcess('', { exitCode: 0 }))
        // shouldRestore: cat .last-sync (local) — empty
        .mockResolvedValueOnce(createMockProcess(''))
        // shouldRestore: cat .last-sync (R2)
        .mockResolvedValueOnce(createMockProcess('2026-02-08T12:00:00+00:00'))
        // restore config: mkdir + cp
        .mockResolvedValueOnce(createMockProcess(''))
        // write restore marker
        .mockResolvedValueOnce(createMockProcess(''))
        // legacy workspace migration: check → has files
        .mockResolvedValueOnce(createMockProcess('IDENTITY.md'))
        // legacy workspace migration: cp -a -n
        .mockResolvedValueOnce(createMockProcess(''))
        // legacy skills migration: check → empty
        .mockResolvedValueOnce(createMockProcess(''))
        // validateRestore: wc -c IDENTITY.md → large (migrated)
        .mockResolvedValueOnce(createMockProcess('5000'));

      const result = await restoreFromR2(sandbox);

      expect(result.restored).toBe(true);
      expect(result.legacyMigrated).toBe(true);
      expect(console.log).toHaveBeenCalledWith(
        '[Restore] Migrated legacy workspace data from R2:/workspace/',
      );
    });

    it('skips migration when no legacy workspace data exists', async () => {
      const { sandbox, startProcessMock } = createMockSandbox();
      startProcessMock
        // test -f openclaw/openclaw.json → exists
        .mockResolvedValueOnce(createMockProcess('', { exitCode: 0 }))
        // shouldRestore: cat .last-sync (local) — empty
        .mockResolvedValueOnce(createMockProcess(''))
        // shouldRestore: cat .last-sync (R2)
        .mockResolvedValueOnce(createMockProcess('2026-02-08T12:00:00+00:00'))
        // restore config
        .mockResolvedValueOnce(createMockProcess(''))
        // write restore marker
        .mockResolvedValueOnce(createMockProcess(''))
        // legacy workspace migration: check → empty (no files)
        .mockResolvedValueOnce(createMockProcess('', { exitCode: 1 }))
        // legacy skills migration: check → empty
        .mockResolvedValueOnce(createMockProcess('', { exitCode: 1 }))
        // validateRestore: wc -c IDENTITY.md
        .mockResolvedValueOnce(createMockProcess('635'));

      const result = await restoreFromR2(sandbox);

      expect(result.restored).toBe(true);
      expect(result.legacyMigrated).toBeUndefined();
    });
  });

  describe('restore validation', () => {
    it('warns when restored IDENTITY.md is default size', async () => {
      const { sandbox, startProcessMock } = createMockSandbox();
      startProcessMock
        .mockResolvedValueOnce(createMockProcess('', { exitCode: 0 }))
        .mockResolvedValueOnce(createMockProcess(''))
        .mockResolvedValueOnce(createMockProcess('2026-02-08T12:00:00+00:00'))
        .mockResolvedValueOnce(createMockProcess(''))
        // write restore marker
        .mockResolvedValueOnce(createMockProcess(''))
        // legacy workspace: empty
        .mockResolvedValueOnce(createMockProcess(''))
        // legacy skills: empty
        .mockResolvedValueOnce(createMockProcess(''))
        // validateRestore: IDENTITY.md = 635 bytes (default)
        .mockResolvedValueOnce(createMockProcess('635'));

      await restoreFromR2(sandbox);

      expect(console.warn).toHaveBeenCalledWith(
        '[Restore] WARNING: IDENTITY.md is only',
        635,
        'bytes (likely default). The workspace may not have been fully backed up previously.',
      );
    });

    it('logs normally when IDENTITY.md has rich content', async () => {
      const { sandbox, startProcessMock } = createMockSandbox();
      startProcessMock
        .mockResolvedValueOnce(createMockProcess('', { exitCode: 0 }))
        .mockResolvedValueOnce(createMockProcess(''))
        .mockResolvedValueOnce(createMockProcess('2026-02-08T12:00:00+00:00'))
        .mockResolvedValueOnce(createMockProcess(''))
        // write restore marker
        .mockResolvedValueOnce(createMockProcess(''))
        .mockResolvedValueOnce(createMockProcess(''))
        .mockResolvedValueOnce(createMockProcess(''))
        // validateRestore: IDENTITY.md = 5000 bytes (rich)
        .mockResolvedValueOnce(createMockProcess('5000'));

      await restoreFromR2(sandbox);

      expect(console.log).toHaveBeenCalledWith('[Restore] IDENTITY.md restored:', 5000, 'bytes');
    });
  });

  describe('error handling', () => {
    it('returns not restored when config restore fails', async () => {
      const { sandbox, startProcessMock } = createMockSandbox();
      startProcessMock
        // test -f openclaw/openclaw.json → exists
        .mockResolvedValueOnce(createMockProcess('', { exitCode: 0 }))
        // shouldRestore: cat .last-sync (local) — empty
        .mockResolvedValueOnce(createMockProcess(''))
        // shouldRestore: cat .last-sync (R2)
        .mockResolvedValueOnce(createMockProcess('2026-02-08T12:00:00+00:00'))
        // restore config: throws
        .mockRejectedValueOnce(new Error('cp failed'));

      const result = await restoreFromR2(sandbox);

      expect(result.restored).toBe(false);
      expect(result.details).toBe('Config restore failed');
    });

    it('continues if legacy workspace migration fails', async () => {
      const { sandbox, startProcessMock } = createMockSandbox();
      startProcessMock
        // test -f openclaw/openclaw.json → exists
        .mockResolvedValueOnce(createMockProcess('', { exitCode: 0 }))
        // shouldRestore: cat .last-sync (local) — empty
        .mockResolvedValueOnce(createMockProcess(''))
        // shouldRestore: cat .last-sync (R2)
        .mockResolvedValueOnce(createMockProcess('2026-02-08T12:00:00+00:00'))
        // restore config: ok
        .mockResolvedValueOnce(createMockProcess(''))
        // write restore marker
        .mockResolvedValueOnce(createMockProcess(''))
        // legacy workspace migration: throws
        .mockRejectedValueOnce(new Error('s3fs timeout'))
        // legacy skills migration: empty
        .mockResolvedValueOnce(createMockProcess(''))
        // validateRestore
        .mockResolvedValueOnce(createMockProcess('0'));

      const result = await restoreFromR2(sandbox);

      // Config restored successfully, migration failure is non-fatal
      expect(result.restored).toBe(true);
    });

    it('handles R2 check errors gracefully', async () => {
      const { sandbox, startProcessMock } = createMockSandbox();
      // All checks throw
      startProcessMock
        .mockRejectedValueOnce(new Error('s3fs error'))
        .mockRejectedValueOnce(new Error('s3fs error'))
        .mockRejectedValueOnce(new Error('s3fs error'))
        // diagnostic startProcess also throws
        .mockRejectedValueOnce(new Error('s3fs error'));

      const result = await restoreFromR2(sandbox);

      expect(result.restored).toBe(false);
      expect(result.details).toBe('No backup data found');
    });

    it('detects DO reset during backup check and aborts restore', async () => {
      const { sandbox, startProcessMock } = createMockSandbox();
      // First test -f check returns a process with "canceled" status
      startProcessMock.mockResolvedValueOnce(
        createMockProcess('', { status: 'canceled' }),
      );

      const result = await restoreFromR2(sandbox);

      expect(result.restored).toBe(false);
      expect(result.details).toBe('DO reset during restore');
      expect(console.log).toHaveBeenCalledWith(
        '[Restore] Process canceled (DO reset detected), aborting restore',
      );
    });

    it('detects DO reset during legacy path check and aborts restore', async () => {
      const { sandbox, startProcessMock } = createMockSandbox();
      startProcessMock
        // First check (openclaw/) fails normally
        .mockResolvedValueOnce(createMockProcess('', { exitCode: 1 }))
        // Second check (clawdbot/) gets canceled
        .mockResolvedValueOnce(createMockProcess('', { status: 'canceled' }));

      const result = await restoreFromR2(sandbox);

      expect(result.restored).toBe(false);
      expect(result.details).toBe('DO reset during restore');
    });
  });
});
