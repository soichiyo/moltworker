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
        .mockResolvedValueOnce(createMockProcess('', { exitCode: 1 }));

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
        // shouldRestore: cat .last-sync (R2)
        .mockResolvedValueOnce(createMockProcess('2026-02-08T12:00:00+00:00'))
        // shouldRestore: cat .last-sync (local) — empty means no local timestamp
        .mockResolvedValueOnce(createMockProcess(''))
        // restore config: mkdir + cp
        .mockResolvedValueOnce(createMockProcess(''))
        // check workspace: test + ls
        .mockResolvedValueOnce(createMockProcess(''))
        // check skills: test + ls
        .mockResolvedValueOnce(createMockProcess(''));

      const result = await restoreFromR2(sandbox);

      expect(result.restored).toBe(true);
      expect(result.details).toContain('openclaw');
    });

    it('skips restore when local data is newer', async () => {
      const { sandbox, startProcessMock } = createMockSandbox();
      startProcessMock
        // test -f openclaw/openclaw.json → exists
        .mockResolvedValueOnce(createMockProcess('', { exitCode: 0 }))
        // shouldRestore: cat .last-sync (R2)
        .mockResolvedValueOnce(createMockProcess('2026-02-08T12:00:00+00:00'))
        // shouldRestore: cat .last-sync (local)
        .mockResolvedValueOnce(createMockProcess('2026-02-08T13:00:00+00:00'))
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
        // shouldRestore: cat .last-sync (R2)
        .mockResolvedValueOnce(createMockProcess('2026-02-08T12:00:00+00:00'))
        // shouldRestore: cat .last-sync (local) — empty
        .mockResolvedValueOnce(createMockProcess(''))
        // restore config: mkdir + cp
        .mockResolvedValueOnce(createMockProcess(''))
        // migration: rename clawdbot.json → openclaw.json
        .mockResolvedValueOnce(createMockProcess(''))
        // check workspace
        .mockResolvedValueOnce(createMockProcess(''))
        // check skills
        .mockResolvedValueOnce(createMockProcess(''));

      const result = await restoreFromR2(sandbox);

      expect(result.restored).toBe(true);
      expect(result.details).toContain('clawdbot');
    });
  });

  describe('workspace and skills restore', () => {
    it('restores workspace when backup has files', async () => {
      const { sandbox, startProcessMock } = createMockSandbox();
      startProcessMock
        // test -f openclaw/openclaw.json → exists
        .mockResolvedValueOnce(createMockProcess('', { exitCode: 0 }))
        // shouldRestore: cat .last-sync (R2)
        .mockResolvedValueOnce(createMockProcess('2026-02-08T12:00:00+00:00'))
        // shouldRestore: cat .last-sync (local) — empty
        .mockResolvedValueOnce(createMockProcess(''))
        // restore config
        .mockResolvedValueOnce(createMockProcess(''))
        // check workspace: test + ls → has files
        .mockResolvedValueOnce(createMockProcess('IDENTITY.md'))
        // restore workspace: mkdir + cp
        .mockResolvedValueOnce(createMockProcess(''))
        // check skills: test + ls → has files
        .mockResolvedValueOnce(createMockProcess('my-skill'))
        // restore skills: mkdir + cp
        .mockResolvedValueOnce(createMockProcess(''));

      const result = await restoreFromR2(sandbox);

      expect(result.restored).toBe(true);
      expect(console.log).toHaveBeenCalledWith('[Restore] Workspace restored');
      expect(console.log).toHaveBeenCalledWith('[Restore] Skills restored');
    });
  });

  describe('error handling', () => {
    it('returns not restored when config restore fails', async () => {
      const { sandbox, startProcessMock } = createMockSandbox();
      startProcessMock
        // test -f openclaw/openclaw.json → exists
        .mockResolvedValueOnce(createMockProcess('', { exitCode: 0 }))
        // shouldRestore: cat .last-sync (R2)
        .mockResolvedValueOnce(createMockProcess('2026-02-08T12:00:00+00:00'))
        // shouldRestore: cat .last-sync (local) — empty
        .mockResolvedValueOnce(createMockProcess(''))
        // restore config: throws
        .mockRejectedValueOnce(new Error('cp failed'));

      const result = await restoreFromR2(sandbox);

      expect(result.restored).toBe(false);
      expect(result.details).toBe('Config restore failed');
    });

    it('continues if workspace restore fails', async () => {
      const { sandbox, startProcessMock } = createMockSandbox();
      startProcessMock
        // test -f openclaw/openclaw.json → exists
        .mockResolvedValueOnce(createMockProcess('', { exitCode: 0 }))
        // shouldRestore: cat .last-sync (R2)
        .mockResolvedValueOnce(createMockProcess('2026-02-08T12:00:00+00:00'))
        // shouldRestore: cat .last-sync (local) — empty
        .mockResolvedValueOnce(createMockProcess(''))
        // restore config: ok
        .mockResolvedValueOnce(createMockProcess(''))
        // check workspace: throws
        .mockRejectedValueOnce(new Error('s3fs timeout'))
        // check skills: empty
        .mockResolvedValueOnce(createMockProcess(''));

      const result = await restoreFromR2(sandbox);

      // Config restored successfully, workspace failure is non-fatal
      expect(result.restored).toBe(true);
    });

    it('handles R2 check errors gracefully', async () => {
      const { sandbox, startProcessMock } = createMockSandbox();
      // All checks throw
      startProcessMock
        .mockRejectedValueOnce(new Error('s3fs error'))
        .mockRejectedValueOnce(new Error('s3fs error'))
        .mockRejectedValueOnce(new Error('s3fs error'));

      const result = await restoreFromR2(sandbox);

      expect(result.restored).toBe(false);
      expect(result.details).toBe('No backup data found');
    });
  });
});
