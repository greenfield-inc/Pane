import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAppDirectory } from '../../utils/appDirectory';
import type { MachineHealthSettings, ReclaimItem, StorageInventory } from '../../../../shared/types/machineHealth';
import { CleanupEngine, type CleanupDeps } from './cleanupEngine';

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'pane-cleanup-')); });
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(path.join(getAppDirectory(), 'agent-logs'), { recursive: true, force: true });
});

const folder = (rel: string, bytes = 1000) => {
  const full = path.join(root, rel);
  mkdirSync(full, { recursive: true });
  writeFileSync(path.join(full, 'data.bin'), Buffer.alloc(bytes));
  return full;
};

const item = (kind: ReclaimItem['kind'], tier: ReclaimItem['tier'], full: string, sessionId: string | null = null): ReclaimItem =>
  ({ id: `${kind}:${full}`, kind, tier, path: full, sizeBytes: 1000, modifiedAt: 0, sessionId, reason: 'test' });

function engine(items: ReclaimItem[], extra: Partial<CleanupDeps> = {}) {
  const settings: MachineHealthSettings = {};
  const deps: CleanupDeps = {
    now: () => 1,
    inventory: async (): Promise<StorageInventory> => ({ scannedAt: 0, durationMs: 0, items, panes: [], buckets: { paneWorktrees: 0, dependencies: 0, qaAndScratch: 0, agentTemp: 0, paneData: 0 } }),
    protectionOf: async () => null,
    processCwds: async () => [],
    recheck: async () => null,
    freeBytes: async () => 10_000,
    settings: () => settings,
    trashParents: () => [],
    moveWorktree: async (_item, move) => move(),
    log: () => {},
    ...extra,
  };
  const cleanup = new CleanupEngine(deps);
  return { cleanup, settings };
}

describe('CleanupEngine', () => {
  it('removes tier 1 items on a scheduled pass and reports bytes freed from the free-space change', async () => {
    const snapshot = folder('pane/updates/u-old');
    const backup = folder('pane/backup.bak');
    const dataLeft = () => readdirSync(root, { recursive: true }).some(name => String(name).endsWith('data.bin'));
    const { cleanup } = engine([item('update-snapshot', 1, snapshot), item('migration-backup', 1, backup)], {
      freeBytes: async () => (dataLeft() ? 10_000 : 12_500),
    });
    const run = await cleanup.run({ source: 'schedule', tiers: [1] });
    expect(run.removed.map(entry => path.basename(entry.path)).sort()).toEqual(['backup.bak', 'u-old']);
    expect(run.freedBytes).toBe(2500);
    expect(existsSync(snapshot)).toBe(false);
    expect(readdirSync(path.join(root, 'pane', 'updates'))).toEqual([]);
    expect(cleanup.history()).toHaveLength(1);
  });

  it('leaves tier 2 alone on a schedule until its automatic switch is on', async () => {
    const temp = folder('claude-temp/old');
    const { cleanup, settings } = engine([item('agent-temp', 2, temp)]);
    expect((await cleanup.run({ source: 'schedule', tiers: [1, 2] })).removed).toEqual([]);
    settings.autoClearAgentTemp = true;
    expect((await cleanup.run({ source: 'schedule', tiers: [1, 2] })).removed).toHaveLength(1);
  });

  it('refuses tier 3 with the reason and the command that frees it', async () => {
    const foreign = folder('repo/worktrees/agent-made');
    const { cleanup } = engine([{ ...item('foreign-worktree', 3, foreign), howToFree: `git worktree remove "${foreign}"` }]);
    await expect(cleanup.run({ source: 'cli', ids: [`foreign-worktree:${foreign}`], tiers: [1, 2] })).rejects.toMatchObject({
      code: 'ERR_MACHINE_CLEANUP_NOT_PANES',
      next: `git worktree remove "${foreign}"`,
    });
    expect(existsSync(foreign)).toBe(true);
  });

  it('skips an item whose Pane is protected or whose folder a process is working in, and says why', async () => {
    const scratch = folder('repo/worktrees/paused/.pane/scratch');
    const temp = folder('claude-temp/busy');
    const { cleanup } = engine([item('paused-scratch', 2, scratch, 'p1'), item('agent-temp', 2, temp)], {
      protectionOf: async sessionId => (sessionId === 'p1' ? 'It has uncommitted changes.' : null),
      // lsof reports real paths (/private/var on macOS), not the /var a temp dir is named by.
      processCwds: async () => [path.join(realpathSync(temp), 'sub')],
    });
    const run = await cleanup.run({ source: 'ui', tiers: [1, 2], kinds: ['paused-scratch', 'agent-temp'] });
    expect(run.removed).toEqual([]);
    expect(run.skipped.map(entry => [path.basename(entry.path), entry.reason])).toEqual([
      ['scratch', 'It has uncommitted changes.'],
      ['busy', 'A running process is working in this folder.'],
    ]);
    expect(existsSync(scratch) && existsSync(temp)).toBe(true);
  });

  it('deletes what an interrupted run left in the trash on the next start', async () => {
    const updates = path.join(root, 'pane', 'updates');
    folder('pane/updates/.pane-trash/u-old-0a1b2c3d');
    await engine([], { trashParents: () => [updates] }).cleanup.finishPendingDeletes();
    expect(readdirSync(updates)).toEqual([]);
  });

  it('returns once items are moved and fills in the space freed when the delete finishes', async () => {
    const snapshot = folder('pane/updates/u-old');
    let release = () => {};
    const deleted = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    const { cleanup } = engine([item('update-snapshot', 1, snapshot)], {
      deleteGraceMs: 10,
      // The first read is before the move; the one after the delete waits until released.
      freeBytes: async () => (reads++ === 0 ? 10_000 : deleted.then(() => 14_000)),
    });
    const run = await cleanup.run({ source: 'cli', tiers: [1], kinds: ['update-snapshot'] });
    expect(run).toMatchObject({ deleting: true, freedBytes: 0 });
    expect(existsSync(snapshot)).toBe(false);
    release();
    await vi.waitFor(() => expect(cleanup.history()[0]).toMatchObject({ deleting: false, freedBytes: 4000 }));
  });

  it('keeps agent transcripts from a paused Pane\'s scratch before deleting it', async () => {
    const scratch = folder('repo/worktrees/paused/.pane/scratch');
    mkdirSync(path.join(scratch, 'qa', 'home', '.claude', 'projects', 'p'), { recursive: true });
    writeFileSync(path.join(scratch, 'qa', 'home', '.claude', 'projects', 'p', 'qa.jsonl'), 'transcript');
    const { cleanup } = engine([item('paused-scratch', 2, scratch, 'pane-1')]);
    expect((await cleanup.run({ source: 'ui', tiers: [2], kinds: ['paused-scratch'] })).removed).toHaveLength(1);
    expect(existsSync(scratch)).toBe(false);
    expect(readFileSync(path.join(getAppDirectory(), 'agent-logs', 'claude', 'pane-1', 'claude-projects', '0', 'p', 'qa.jsonl'), 'utf8')).toBe('transcript');
  });

  it('skips folders when Pane cannot read which folders processes work in, and still removes backups', async () => {
    const temp = folder('claude-temp/old');
    const backup = folder('pane/backup.bak');
    const { cleanup } = engine([item('agent-temp', 2, temp), item('migration-backup', 1, backup)], { processCwds: async () => null });
    const run = await cleanup.run({ source: 'ui', tiers: [1, 2], kinds: ['agent-temp', 'migration-backup'] });
    expect(run.skipped.map(entry => [path.basename(entry.path), entry.reason])).toEqual([['old', 'Pane could not check for running processes.']]);
    expect(run.removed.map(entry => path.basename(entry.path))).toEqual(['backup.bak']);
    expect(existsSync(temp)).toBe(true);
  });

  it('skips an item that changed since the inventory was taken', async () => {
    const temp = folder('claude-temp/loose');
    const { cleanup } = engine([item('agent-temp', 2, temp)], { recheck: async () => 'Something in it changed in the last 2 days.' });
    const run = await cleanup.run({ source: 'ui', tiers: [2], kinds: ['agent-temp'] });
    expect(run.skipped.map(entry => entry.reason)).toEqual(['Something in it changed in the last 2 days.']);
    expect(existsSync(temp)).toBe(true);
  });

  it('checks an archived Pane\'s folder again inside the repository lock, so a Pane restored meanwhile keeps it', async () => {
    const leftover = folder('repo/worktrees/restored');
    let checks = 0;
    // Clear when the run starts; restored by the time the lock is held.
    const { cleanup } = engine([item('archived-pane-folder', 2, leftover, 'p1')], {
      recheck: async () => (++checks === 1 ? null : 'A Pane that is open now uses this folder.'),
    });
    const run = await cleanup.run({ source: 'ui', tiers: [2], kinds: ['archived-pane-folder'] });
    expect(run.skipped.map(entry => entry.reason)).toEqual(['A Pane that is open now uses this folder.']);
    expect(existsSync(leftover)).toBe(true);
  });

  it('skips an item inside WSL, where Pane cannot see which folders Linux processes work in', async () => {
    const wsl = item('archived-pane-folder', 2, String.raw`\\wsl.localhost\Ubuntu-24.04\repos\site\worktrees\old`, 'p1');
    const { cleanup } = engine([wsl]);
    const run = await cleanup.run({ source: 'ui', tiers: [2], kinds: ['archived-pane-folder'] });
    expect(run.skipped.map(entry => entry.reason)).toEqual(['Pane cannot check for running processes inside WSL.']);
  });

  it('refuses a request that names no items or kinds, unless it is the schedule', async () => {
    const temp = folder('claude-temp/old');
    const { cleanup } = engine([item('agent-temp', 2, temp)]);
    await expect(cleanup.run({ source: 'cli', tiers: [1, 2] })).rejects.toMatchObject({ code: 'ERR_MACHINE_CLEANUP_UNNAMED' });
    expect(existsSync(temp)).toBe(true);
  });

  it('never deletes through a link named like the trash folder', async () => {
    const documents = folder('Documents');
    const parent = path.join(root, 'claude-temp');
    mkdirSync(parent, { recursive: true });
    symlinkSync(documents, path.join(parent, '.pane-trash'), process.platform === 'win32' ? 'junction' : 'dir');
    await engine([], { trashParents: () => [parent] }).cleanup.finishPendingDeletes();
    expect(readdirSync(documents)).toEqual(['data.bin']);
  });
});
