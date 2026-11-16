import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { measureSizesHere } from './sizeWalker';
import { scanStorage, type InventoryDeps, type InventoryPane } from './storageInventory';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-15T12:00:00Z');

let root: string;
const file = (rel: string, bytes: number, ageDays = 0) => {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, Buffer.alloc(bytes));
  const at = new Date(NOW - ageDays * DAY);
  utimesSync(full, at, at);
  return full;
};
const dirAge = (rel: string, ageDays: number) => {
  const at = new Date(NOW - ageDays * DAY);
  utimesSync(path.join(root, rel), at, at);
};

beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'pane-inventory-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function deps(panes: InventoryPane[], overrides: Partial<InventoryDeps> = {}): InventoryDeps {
  return {
    now: () => NOW,
    paneDir: path.join(root, 'pane'),
    panes: () => panes,
    worktreeRoots: () => [path.join(root, 'repo', 'worktrees')],
    agentTempRoots: () => [path.join(root, 'claude-temp')],
    installPath: () => null,
    cleanOpenAt: () => null,
    archiveJobsInFlight: () => new Set(),
    readUpdates: async () => [],
    listGitWorktrees: async () => [],
    ignoredDirs: async () => [],
    processCwds: async () => [],
    otherTools: async () => [],
    appScratchDir: id => path.join(root, 'pane', 'scratch', id),
    measure: async requests => measureSizesHere(requests),
    ...overrides,
  };
}

const pane = (id: string, name: string, extra: Partial<InventoryPane> = {}): InventoryPane & { worktreePath: string } => ({
  id, name, worktreePath: path.join(root, 'repo', 'worktrees', name), projectPath: path.join(root, 'repo'), branch: name,
  archived: false, paused: false, updatedAt: NOW - 30 * DAY, isMainRepo: false, ownedByPane: true, ...extra, worktreePath: path.join(root, 'repo', 'worktrees', name),
});

describe('scanStorage', () => {
  it('splits an open Pane into dependencies, build outputs and scratch', async () => {
    file('repo/worktrees/homepage/src/a.ts', 1000);
    file('repo/worktrees/homepage/node_modules/x/index.js', 5000);
    file('repo/worktrees/homepage/dist/out.js', 3000);
    file('repo/worktrees/homepage/.pane/scratch/qa.png', 2000);
    file('pane/scratch/p1/log.txt', 700);
    const inventory = await scanStorage(deps([pane('p1', 'homepage')], { ignoredDirs: async () => ['dist/', 'node_modules/', '.pane/'] }));
    expect(inventory.panes).toEqual([expect.objectContaining({
      sessionId: 'p1', worktreeBytes: 11000, dependencyBytes: 5000, buildOutputBytes: 3000, scratchBytes: 2700, agentTempBytes: 0,
    })]);
    expect(inventory.buckets).toMatchObject({ paneWorktrees: 4000, dependencies: 5000, qaAndScratch: 2700 });
    expect(inventory.items).toEqual([]);
  });

  it('attributes agent temp by folder name and offers only what belongs to gone Panes or sat idle 2 days', async () => {
    const open = pane('p1', 'homepage');
    const gone = pane('p2', 'old-feature', { archived: true });
    mkdirSync(open.worktreePath, { recursive: true });
    const tempOf = (p: { worktreePath: string }) => `claude-temp/${p.worktreePath.replace(/[^a-zA-Z0-9]/gu, '-')}`;
    file(`${tempOf(open)}/tasks/a.out`, 400);
    file(`${tempOf(gone)}/tasks/b.out`, 900);
    file('claude-temp/qa1.noindex/home/big.bin', 3000, 3);
    dirAge('claude-temp/qa1.noindex/home', 3);
    dirAge('claude-temp/qa1.noindex', 3);
    file('claude-temp/fresh.noindex/x.bin', 100);
    const busyCwd = path.join(root, 'claude-temp', 'busy.noindex', 'work');
    file('claude-temp/busy.noindex/work/y.bin', 100, 5);
    dirAge('claude-temp/busy.noindex/work', 5);
    dirAge('claude-temp/busy.noindex', 5);
    // The temp root is reached through a symlink (macOS /tmp -> /private/tmp) while the process reports the real path.
    symlinkSync(path.join(root, 'claude-temp'), path.join(root, 'temp-link'));

    const inventory = await scanStorage(deps([open, gone], {
      agentTempRoots: () => [path.join(root, 'temp-link')],
      processCwds: async () => [busyCwd],
    }));
    expect(inventory.panes[0].agentTempBytes).toBe(400);
    expect(inventory.items.map(item => [item.kind, item.tier, path.basename(item.path), item.sessionId, item.sizeBytes])).toEqual([
      ['agent-temp', 2, 'qa1.noindex', null, 3000],
      ['agent-temp', 2, path.basename(tempOf(gone)), 'p2', 900],
    ]);
  });

  it('offers no agent temp or paused scratch when running processes could not be listed', async () => {
    const paused = pane('p1', 'homepage', { paused: true });
    file('repo/worktrees/homepage/.pane/scratch/qa.png', 2000);
    file('claude-temp/qa1.noindex/big.bin', 3000, 3);
    dirAge('claude-temp/qa1.noindex', 3);
    const inventory = await scanStorage(deps([paused], { processCwds: async () => null }));
    expect(inventory.items).toEqual([]);
    expect(inventory.buckets.agentTemp).toBe(3000);
  });

  it('never offers the temp folder of an open main-repo Pane', async () => {
    const mainRepo = { ...pane('m1', 'repo', { isMainRepo: true }), worktreePath: path.join(root, 'repo') };
    mkdirSync(mainRepo.worktreePath, { recursive: true });
    const temp = `claude-temp/${mainRepo.worktreePath.replace(/[^a-zA-Z0-9]/gu, '-')}`;
    file(`${temp}/scratchpad/notes.md`, 500, 3);
    dirAge(`${temp}/scratchpad`, 3);
    dirAge(temp, 3);
    const inventory = await scanStorage(deps([mainRepo]));
    expect(inventory.items).toEqual([]);
  });

  it('removes replaced update copies and old backups alone, and only shows copies Pane did not write', async () => {
    file('pane/updates/u-old/snapshot/data/sessions.db', 9000);
    file('pane/updates/u-new/status.json', 10);
    file('pane/sessions.db.pre-panel-buffers-1.bak', 1800, 40);
    file('pane/sessions.db.before-repair', 1300, 3);
    file('pane/sessions.db', 500);
    const inventory = await scanStorage(deps([], {
      readUpdates: async () => [
        { id: 'u-old', phase: 'needs-attention', updatedAt: NOW - 15 * DAY },
        { id: 'u-new', phase: 'complete', updatedAt: NOW - 1 * DAY },
      ],
      cleanOpenAt: () => NOW - DAY,
    }));
    expect(inventory.items.map(item => [item.kind, item.tier, path.basename(item.path), item.sizeBytes])).toEqual([
      ['update-snapshot', 1, 'u-old', 9000],
      ['migration-backup', 1, 'sessions.db.pre-panel-buffers-1.bak', 1800],
      ['foreign-pane-data', 3, 'sessions.db.before-repair', 1300],
    ]);
  });

  it('leaves folders in Pane\'s data folder out of the worktree scan', async () => {
    file('pane/sessions/pane-chat/notes.md', 500);
    file('pane/sessions/orchestration-session-1/notes.md', 500);
    const chat = pane('c1', 'chat', { worktreePath: path.join(root, 'pane', 'sessions', 'pane-chat') });
    const inventory = await scanStorage(deps([{ ...chat, worktreePath: path.join(root, 'pane', 'sessions', 'pane-chat') }], {
      worktreeRoots: () => [path.join(root, 'pane', 'sessions')],
    }));
    expect(inventory.items.filter(item => item.kind === 'foreign-worktree')).toEqual([]);
  });

  it('offers a folder at an archived Pane\'s path only when git shows it as that Pane\'s worktree', async () => {
    const mine = pane('p3', 'merged-feature', { archived: true, updatedAt: NOW + DAY });
    const recreated = pane('p4', 'reused-name', { archived: true, updatedAt: NOW + DAY });
    file('repo/worktrees/merged-feature/a.txt', 600);
    file('repo/worktrees/reused-name/a.txt', 700);
    file('repo/worktrees/agent-made/a.txt', 800);
    const inventory = await scanStorage(deps([mine, recreated], {
      listGitWorktrees: async () => [
        { path: mine.worktreePath, branch: 'merged-feature' },
        { path: recreated.worktreePath, branch: 'someone-else' },
        { path: path.join(root, 'repo', 'worktrees', 'agent-made'), branch: 'agent-made' },
      ],
    }));
    expect(inventory.items.map(item => [item.kind, item.tier, path.basename(item.path)])).toEqual([
      ['archived-pane-folder', 2, 'merged-feature'],
      ['foreign-worktree', 3, 'agent-made'],
      ['foreign-worktree', 3, 'reused-name'],
    ]);
  });

  it('never offers an adopted worktree kept at an archived Pane\'s path', async () => {
    const adopted = pane('p5', 'my-feature', { archived: true, updatedAt: NOW + DAY, ownedByPane: false });
    file('repo/worktrees/my-feature/work.txt', 600);
    const inventory = await scanStorage(deps([adopted], { listGitWorktrees: async () => [{ path: adopted.worktreePath, branch: 'my-feature' }] }));
    expect(inventory.items.map(item => [item.kind, item.tier])).toEqual([['foreign-worktree', 3]]);
  });

  it('credits a temp folder to the open Pane when an archived Pane had the same path', async () => {
    const old = pane('old', 'feat', { archived: true });
    const current = pane('new', 'feat');
    mkdirSync(current.worktreePath, { recursive: true });
    file(`claude-temp/${current.worktreePath.replace(/[^a-zA-Z0-9]/gu, '-')}/a.out`, 300);
    const inventory = await scanStorage(deps([old, current]));
    expect(inventory.items).toEqual([]);
    expect(inventory.panes[0]).toMatchObject({ sessionId: 'new', agentTempBytes: 300 });
  });
});
