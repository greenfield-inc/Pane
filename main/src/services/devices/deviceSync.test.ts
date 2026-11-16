import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { applySnapshot, checkoutHas, snapshotBundle } from './deviceSync';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pane-device-sync-'));
  roots.push(root);
  const worktree = path.join(root, 'worktree');
  const checkout = path.join(root, 'checkout');
  mkdirSync(worktree);
  git(worktree, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(worktree, '.gitignore'), 'node_modules/\n');
  writeFileSync(path.join(worktree, 'App.tsx'), 'one');
  writeFileSync(path.join(worktree, 'old.txt'), 'old');
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-qm', 'init');
  const sync = async (base?: string) => {
    const bundle = await snapshotBundle(worktree, 'pane-a', base, path.join(root, 'bundle'));
    await applySnapshot(checkout, bundle.path, bundle.commit);
    return bundle.commit;
  };
  return { worktree, checkout, sync };
}

describe('device checkout sync', () => {
  it('copies tracked and uncommitted files to the checkout, without ignored ones', async () => {
    const { worktree, checkout, sync } = setup();
    writeFileSync(path.join(worktree, 'App.tsx'), 'two, not committed');
    writeFileSync(path.join(worktree, 'new.txt'), 'untracked');
    mkdirSync(path.join(worktree, 'node_modules'));
    writeFileSync(path.join(worktree, 'node_modules', 'big.js'), 'ignored');
    await sync();
    expect(readFileSync(path.join(checkout, 'App.tsx'), 'utf8')).toBe('two, not committed');
    expect(readFileSync(path.join(checkout, 'new.txt'), 'utf8')).toBe('untracked');
    expect(existsSync(path.join(checkout, 'node_modules'))).toBe(false);
  });

  it('applies a later edit and a deletion as a delta, and keeps the checkout\'s ignored build products', async () => {
    const { worktree, checkout, sync } = setup();
    const first = await sync();
    mkdirSync(path.join(checkout, 'node_modules'));
    writeFileSync(path.join(checkout, 'node_modules', 'installed.js'), 'built on the Mac');
    writeFileSync(path.join(worktree, 'App.tsx'), 'three');
    rmSync(path.join(worktree, 'old.txt'));
    expect(await checkoutHas(checkout, first)).toBe(true);
    await sync(first);
    expect(readFileSync(path.join(checkout, 'App.tsx'), 'utf8')).toBe('three');
    expect(existsSync(path.join(checkout, 'old.txt'))).toBe(false);
    expect(readFileSync(path.join(checkout, 'node_modules', 'installed.js'), 'utf8')).toBe('built on the Mac');
  });

  it('leaves the person\'s index, branch and stash as they were', async () => {
    const { worktree, sync } = setup();
    writeFileSync(path.join(worktree, 'App.tsx'), 'edited');
    const before = { status: git(worktree, 'status', '--porcelain'), head: git(worktree, 'rev-parse', 'HEAD'), branch: git(worktree, 'branch', '--show-current'), stash: git(worktree, 'stash', 'list') };
    await sync();
    expect({ status: git(worktree, 'status', '--porcelain'), head: git(worktree, 'rev-parse', 'HEAD'), branch: git(worktree, 'branch', '--show-current'), stash: git(worktree, 'stash', 'list') }).toEqual(before);
  });
});
