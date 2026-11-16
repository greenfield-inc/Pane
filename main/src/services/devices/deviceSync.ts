import { execFile } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Snapshot commits need an author; these never reach the person's branch. */
const SYNC_IDENTITY = { GIT_AUTHOR_NAME: 'Pane', GIT_AUTHOR_EMAIL: 'devices@runpane.com', GIT_COMMITTER_NAME: 'Pane', GIT_COMMITTER_EMAIL: 'devices@runpane.com' };

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  // No background gc or maintenance: Pane's checkouts and snapshot calls stay quiet when they return.
  const { stdout } = await execFileAsync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd, env: { ...process.env, ...SYNC_IDENTITY, ...env }, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

function syncRef(key: string): string {
  return `refs/pane/device-sync/${key.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

/**
 * A snapshot of the worktree as a commit with no parent (tracked, untracked and deleted files;
 * ignored files left out), bundled with only what `base` lacks. A temporary index keeps the
 * person's index, branch and stash untouched; the commit lives under refs/pane/device-sync.
 */
export async function snapshotBundle(worktree: string, key: string, base: string | undefined, bundlePath: string): Promise<{ commit: string; path: string }> {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'pane-device-index-'));
  try {
    const index = { GIT_INDEX_FILE: path.join(scratch, 'index') };
    const hasHead = await git(worktree, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => true, () => false);
    if (hasHead) await git(worktree, ['read-tree', 'HEAD'], index);
    await git(worktree, ['add', '-A', '--', '.'], index);
    const tree = await git(worktree, ['write-tree'], index);
    const commit = await git(worktree, ['commit-tree', tree, '-m', 'Pane device sync']);
    const ref = syncRef(key);
    await git(worktree, ['update-ref', ref, commit]);
    rmSync(bundlePath, { force: true });
    await git(worktree, ['bundle', 'create', bundlePath, ref, ...(base ? [`^${base}`] : [])]);
    return { commit, path: bundlePath };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Whether the checkout already has `commit`, so the next bundle can be a delta against it. */
export async function checkoutHas(checkout: string, commit: string): Promise<boolean> {
  if (!existsSync(path.join(checkout, '.git'))) return false;
  return git(checkout, ['cat-file', '-e', `${commit}^{commit}`]).then(() => true, () => false);
}

/**
 * Checks the bundled snapshot out over the checkout: edited and deleted files follow the
 * worktree, and ignored build products (node_modules, Pods, DerivedData) stay between syncs.
 */
export async function applySnapshot(checkout: string, bundlePath: string, commit: string): Promise<void> {
  mkdirSync(checkout, { recursive: true });
  if (!existsSync(path.join(checkout, '.git'))) await git(checkout, ['init', '-q']);
  await git(checkout, ['fetch', '--quiet', bundlePath, `+refs/pane/device-sync/*:refs/pane/device-sync/*`]);
  await git(checkout, ['checkout', '--quiet', '--force', '--detach', commit]);
}
