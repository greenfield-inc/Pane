import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MachineHealthSettings, ReclaimItem, StorageInventory } from '../../../../shared/types/machineHealth';
import { CleanupEngine, type CleanupDeps } from './cleanupEngine';

let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'pane-cleanup-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

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
    paneDir: path.join(root, 'pane'),
    inventory: async (): Promise<StorageInventory> => ({ scannedAt: 0, durationMs: 0, items, panes: [], buckets: { paneWorktrees: 0, dependencies: 0, qaAndScratch: 0, agentTemp: 0, paneData: 0 } }),
    protectionOf: async () => null,
    processCwds: async () => [],
    recheck: async () => null,
    freeBytes: async () => 10_000,
    settings: () => settings,
    pruneWorktrees: async () => {},
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

  it('finishes a delete that a crash interrupted, from the trash folder, on the next start', async () => {
    const snapshot = folder('pane/updates/u-old');
    const first = engine([item('update-snapshot', 1, snapshot)], { remove: async () => { throw new Error('Pane stopped'); } });
    await first.cleanup.run({ source: 'schedule', tiers: [1] });
    // The rename landed and was recorded, then the delete never finished.
    expect(existsSync(snapshot)).toBe(false);
    const trash = path.join(root, 'pane', 'updates', '.pane-trash');
    expect(readdirSync(trash)).toHaveLength(1);

    const next = engine([]);
    await next.cleanup.finishPendingDeletes();
    expect(existsSync(trash)).toBe(false);
  });

  it('skips an item that changed since the inventory was taken', async () => {
    const temp = folder('claude-temp/loose');
    const { cleanup } = engine([item('agent-temp', 2, temp)], { recheck: async () => 'Something in it changed in the last 2 days.' });
    const run = await cleanup.run({ source: 'ui', tiers: [2], kinds: ['agent-temp'] });
    expect(run.skipped.map(entry => entry.reason)).toEqual(['Something in it changed in the last 2 days.']);
    expect(existsSync(temp)).toBe(true);
  });

  it('refuses a request that names no items or kinds, unless it is the schedule', async () => {
    const temp = folder('claude-temp/old');
    const { cleanup } = engine([item('agent-temp', 2, temp)]);
    await expect(cleanup.run({ source: 'cli', tiers: [1, 2] })).rejects.toMatchObject({ code: 'ERR_MACHINE_CLEANUP_UNNAMED' });
    expect(existsSync(temp)).toBe(true);
  });

  it('never deletes a journal entry outside a trash folder, even through ..', async () => {
    const keep = folder('Documents');
    mkdirSync(path.join(root, 'pane'), { recursive: true });
    writeFileSync(path.join(root, 'pane', 'machine-health-trash.json'), JSON.stringify([
      path.join(root, 'pane', '.pane-trash', '..', '..', 'Documents'),
      keep,
    ]));
    await engine([]).cleanup.finishPendingDeletes();
    expect(existsSync(keep)).toBe(true);
  });
});
