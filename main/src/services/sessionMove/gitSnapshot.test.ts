import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PaneError } from '../../../../shared/paneError';
import {
  addWorktree,
  applySnapshot,
  createBundle,
  createSnapshot,
  deleteRefs,
  ignoredPaths,
  importBundle,
  MoveGitError,
  placeBranch,
  snapshotMatches,
} from './gitSnapshot';

const SNAPSHOT_REF = 'refs/pane-move/test/snapshot';
const PREFIX = 'refs/pane-move/test/incoming';

let root = '';
const savedEnv: Record<string, string | undefined> = {};
const isolatedEnv: Record<string, string> = {};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Pane Test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...isolatedEnv },
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

let counter = 0;
function dir(name: string): string {
  counter += 1;
  return path.join(root, `${counter}-${name}`);
}

/** A bare origin, a source clone A on `branch` with one pushed and one unpushed commit, and clone B of origin. */
function setupRepos(branch = 'spike-x') {
  const origin = dir('origin.git');
  git(root, ['init', '-q', '--bare', origin]);
  const a = dir('a');
  git(root, ['clone', '-q', origin, a]);
  write(path.join(a, '.gitignore'), 'ignored.log\nbuild/\n');
  write(path.join(a, 'file.txt'), 'line 1\nline 2\nline 3\n');
  write(path.join(a, 'other.txt'), 'other\n');
  write(path.join(a, 'doomed.txt'), 'delete me\n');
  write(path.join(a, 'script.sh'), '#!/bin/sh\necho hi\n');
  write(path.join(a, 'ünïcode name.txt'), 'unicode\n');
  fs.symlinkSync('other.txt', path.join(a, 'link'));
  git(a, ['add', '-A']);
  git(a, ['commit', '-qm', 'base']);
  git(a, ['push', '-q', 'origin', 'main']);
  git(a, ['checkout', '-q', '-b', branch]);
  write(path.join(a, 'other.txt'), 'other pushed\n');
  git(a, ['commit', '-qam', 'pushed']);
  git(a, ['push', '-q', '-u', 'origin', branch]);
  write(path.join(a, 'other.txt'), 'other unpushed\n');
  git(a, ['commit', '-qam', 'unpushed']);
  const b = dir('b');
  git(root, ['clone', '-q', origin, b]);
  return { origin, a, b };
}

function makeMess(a: string): void {
  write(path.join(a, 'file.txt'), 'line 1\nstaged\nline 3\n');
  git(a, ['add', 'file.txt']);
  write(path.join(a, 'file.txt'), 'line 1\nstaged\nline 3\nunstaged\n');
  write(path.join(a, 'other.txt'), 'other unstaged\n');
  fs.rmSync(path.join(a, 'doomed.txt'));
  write(path.join(a, 'untracked file.txt'), 'new\n');
  write(path.join(a, 'newdir', 'inner.txt'), 'inner\n');
  write(path.join(a, 'ignored.log'), 'secret\n');
  write(path.join(a, 'build', 'out.bin'), 'binary\n');
  fs.chmodSync(path.join(a, 'script.sh'), 0o755);
  write(path.join(a, 'ünïcode name.txt'), 'unicode changed\n');
}

function fingerprint(worktree: string) {
  const files = git(worktree, ['ls-files', '-z', '--cached', '--others']).split('\0').filter(Boolean);
  const hashes = files.sort().map((file) => {
    const full = path.join(worktree, file);
    if (!fs.existsSync(full) && !isSymlink(full)) return `${file}:missing`;
    const stat = fs.lstatSync(full);
    const content = stat.isSymbolicLink() ? fs.readlinkSync(full) : fs.readFileSync(full);
    return `${file}:${stat.mode.toString(8)}:${createHash('sha1').update(content).digest('hex')}`;
  });
  return {
    status: git(worktree, ['status', '--porcelain=v2', '-z', '--untracked-files=all']),
    diff: git(worktree, ['diff']),
    cached: git(worktree, ['diff', '--cached']),
    untracked: git(worktree, ['ls-files', '--others', '--exclude-standard']),
    files: hashes.join('\n'),
  };
}

function isSymlink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

function indexBytes(worktree: string): string {
  const indexPath = path.resolve(worktree, git(worktree, ['rev-parse', '--git-path', 'index']).trim());
  return createHash('sha1').update(fs.readFileSync(indexPath)).digest('hex');
}

async function failureOf(promise: Promise<unknown>): Promise<PaneError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PaneError) return error;
    throw error;
  }
  throw new Error('expected the call to fail with a PaneError, but it resolved');
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  return (await failureOf(promise)).code;
}

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pane-git-snapshot-')));
  Object.assign(isolatedEnv, {
    GIT_CONFIG_NOSYSTEM: '1',
    HOME: root,
    XDG_CONFIG_HOME: root,
    GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'),
  });
  for (const [key, value] of Object.entries(isolatedEnv)) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('gitSnapshot', () => {
  it('J1: moves commits and all uncommitted work to another clone byte for byte', async () => {
    const { a, b } = setupRepos();
    makeMess(a);
    const before = fingerprint(a);
    const indexBefore = indexBytes(a);

    const snap = await createSnapshot(a, SNAPSHOT_REF);
    expect(indexBytes(a)).toBe(indexBefore);
    expect(fingerprint(a)).toEqual(before);
    expect(snap.branch).toBe('spike-x');
    expect(snap.head).toBe(git(a, ['rev-parse', 'HEAD']).trim());
    expect(git(a, ['rev-parse', SNAPSHOT_REF]).trim()).toBe(snap.commit);

    const bundle = path.join(root, 'j1.bundle');
    const { prerequisites } = await createBundle(a, ['refs/heads/spike-x', SNAPSHOT_REF], bundle);
    expect(prerequisites).toContain(git(a, ['rev-parse', 'origin/spike-x']).trim());

    const imported = await importBundle(b, bundle, { branch: 'spike-x', snapshotRef: SNAPSHOT_REF, incomingPrefix: PREFIX });
    expect(imported.snapshot).toBe(snap.commit);
    expect(imported.branchHead).toBe(snap.head);
    expect(git(b, ['for-each-ref', '--format=%(refname)', 'refs/heads/'])).toBe('refs/heads/main\n');

    expect(await placeBranch(b, 'spike-x', `${PREFIX}/branch`)).toBe('created');
    const target = dir('b-worktree');
    const { upstream } = await addWorktree(b, target, 'spike-x', snap.head);
    expect(upstream).toBe('origin/spike-x');
    expect(git(target, ['rev-parse', '--abbrev-ref', '@{upstream}']).trim()).toBe('origin/spike-x');
    await applySnapshot(target, snap.commit);

    const after = fingerprint(target);
    expect(after.diff).toBe(before.diff);
    expect(after.cached).toBe(before.cached);
    expect(after.untracked).toBe(before.untracked);
    expect(after.diff).toContain('old mode 100644');
    expect(after.untracked).toContain('untracked file.txt');
    expect(after.untracked).toContain('newdir/inner.txt');
    expect(git(target, ['rev-parse', 'HEAD']).trim()).toBe(snap.head);
    expect(git(target, ['symbolic-ref', '--short', 'HEAD']).trim()).toBe('spike-x');
    expect(fs.existsSync(path.join(target, 'ignored.log'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'build'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'doomed.txt'))).toBe(false);
    expect(fs.readlinkSync(path.join(target, 'link'))).toBe('other.txt');
    expect(await snapshotMatches(target, snap.commit)).toBe(true);

    expect(fingerprint(a)).toEqual(before);
    expect(await ignoredPaths(a)).toEqual(['build/', 'ignored.log']);
  });

  it('snapshotMatches is false once the reapplied work changes', async () => {
    const { a, b } = setupRepos();
    makeMess(a);
    const snap = await createSnapshot(a, SNAPSHOT_REF);
    const bundle = path.join(root, 'drift.bundle');
    await createBundle(a, ['refs/heads/spike-x', SNAPSHOT_REF], bundle);
    await importBundle(b, bundle, { branch: 'spike-x', snapshotRef: SNAPSHOT_REF, incomingPrefix: PREFIX });
    await placeBranch(b, 'spike-x', `${PREFIX}/branch`);
    const target = dir('drift');
    await addWorktree(b, target, 'spike-x', snap.head);
    await applySnapshot(target, snap.commit);
    write(path.join(target, 'extra.txt'), 'drift\n');
    expect(await snapshotMatches(target, snap.commit)).toBe(false);
    fs.rmSync(path.join(target, 'extra.txt'));
    git(target, ['add', 'other.txt']);
    expect(await snapshotMatches(target, snap.commit)).toBe(false);
  });

  it('carries the branch when its tip is already on origin, which git bundle leaves out', async () => {
    const { a, b } = setupRepos();
    git(a, ['push', '-q', 'origin', 'spike-x']);
    git(b, ['fetch', '-q', 'origin']);
    write(path.join(a, 'other.txt'), 'dirty\n');
    const snap = await createSnapshot(a, SNAPSHOT_REF);
    const bundle = path.join(root, 'pushed.bundle');
    await createBundle(a, ['refs/heads/spike-x', SNAPSHOT_REF], bundle);
    const imported = await importBundle(b, bundle, { branch: 'spike-x', snapshotRef: SNAPSHOT_REF, incomingPrefix: PREFIX });
    expect(imported.branchHead).toBe(snap.head);
    expect(await placeBranch(b, 'spike-x', `${PREFIX}/branch`)).toBe('created');
  });

  it('refuses a branch that diverged there, counting its extra commits', async () => {
    const { a, b } = setupRepos();
    git(b, ['checkout', '-q', 'spike-x']);
    write(path.join(b, 'b1.txt'), '1\n');
    git(b, ['add', '-A']);
    git(b, ['commit', '-qm', 'b1']);
    write(path.join(b, 'b2.txt'), '2\n');
    git(b, ['add', '-A']);
    git(b, ['commit', '-qm', 'b2']);
    git(b, ['checkout', '-q', 'main']);
    await createSnapshot(a, SNAPSHOT_REF);
    const bundle = path.join(root, 'diverged.bundle');
    await createBundle(a, ['refs/heads/spike-x', SNAPSHOT_REF], bundle);
    await importBundle(b, bundle, { branch: 'spike-x', snapshotRef: SNAPSHOT_REF, incomingPrefix: PREFIX });
    const localBefore = git(b, ['rev-parse', 'spike-x']).trim();
    const error = await failureOf(placeBranch(b, 'spike-x', `${PREFIX}/branch`));
    expect(error.code).toBe('ERR_MOVE_BRANCH_DIVERGED');
    expect(error.message).toContain("branch spike-x already exists there with 2 commits this machine doesn't have");
    expect(error).toBeInstanceOf(MoveGitError);
    if (error instanceof MoveGitError) expect(error.details).toEqual({ branch: 'spike-x', extraCommits: 2 });
    expect(git(b, ['rev-parse', 'spike-x']).trim()).toBe(localBefore);
  });

  it('fast-forwards a branch that is behind, and reports same when equal', async () => {
    const { a, b } = setupRepos();
    git(b, ['branch', '-q', 'spike-x', 'origin/spike-x']);
    const snap = await createSnapshot(a, SNAPSHOT_REF);
    const bundle = path.join(root, 'ff.bundle');
    await createBundle(a, ['refs/heads/spike-x', SNAPSHOT_REF], bundle);
    await importBundle(b, bundle, { branch: 'spike-x', snapshotRef: SNAPSHOT_REF, incomingPrefix: PREFIX });
    expect(await placeBranch(b, 'spike-x', `${PREFIX}/branch`)).toBe('fast-forwarded');
    expect(git(b, ['rev-parse', 'spike-x']).trim()).toBe(snap.head);
    expect(await placeBranch(b, 'spike-x', `${PREFIX}/branch`)).toBe('same');
  });

  it('refuses to fast-forward a branch checked out in a worktree there', async () => {
    const { a, b } = setupRepos();
    git(b, ['checkout', '-q', '-b', 'spike-x', 'origin/spike-x']);
    await createSnapshot(a, SNAPSHOT_REF);
    const bundle = path.join(root, 'checked-out.bundle');
    await createBundle(a, ['refs/heads/spike-x', SNAPSHOT_REF], bundle);
    await importBundle(b, bundle, { branch: 'spike-x', snapshotRef: SNAPSHOT_REF, incomingPrefix: PREFIX });
    const error = await failureOf(placeBranch(b, 'spike-x', `${PREFIX}/branch`));
    expect(error.code).toBe('ERR_MOVE_BRANCH_CHECKED_OUT');
    expect(error.message).toContain(`branch spike-x is checked out at ${b} there`);
  });

  it('moves a detached HEAD', async () => {
    const { a, b } = setupRepos();
    git(a, ['checkout', '-q', '--detach']);
    makeMess(a);
    const before = fingerprint(a);
    const snap = await createSnapshot(a, SNAPSHOT_REF);
    expect(snap.branch).toBeNull();
    const bundle = path.join(root, 'detached.bundle');
    await createBundle(a, [SNAPSHOT_REF], bundle);
    const imported = await importBundle(b, bundle, { branch: null, snapshotRef: SNAPSHOT_REF, incomingPrefix: PREFIX });
    expect(imported.branchHead).toBeNull();
    const target = dir('detached');
    expect(await addWorktree(b, target, null, snap.head)).toEqual({ upstream: null });
    await applySnapshot(target, snap.commit);
    const after = fingerprint(target);
    expect(after.diff).toBe(before.diff);
    expect(after.cached).toBe(before.cached);
    expect(after.untracked).toBe(before.untracked);
    expect(git(target, ['rev-parse', 'HEAD']).trim()).toBe(snap.head);
    expect(await snapshotMatches(target, snap.commit)).toBe(true);
  });

  it('names missing prerequisite commits', async () => {
    const { a } = setupRepos();
    await createSnapshot(a, SNAPSHOT_REF);
    const bundle = path.join(root, 'prereq.bundle');
    await createBundle(a, ['refs/heads/spike-x', SNAPSHOT_REF], bundle);
    const empty = dir('empty');
    git(root, ['init', '-q', empty]);
    const error = await failureOf(importBundle(empty, bundle, { branch: 'spike-x', snapshotRef: SNAPSHOT_REF, incomingPrefix: PREFIX }));
    expect(error.code).toBe('ERR_MOVE_BUNDLE_PREREQUISITES');
    expect(error.message).toContain(git(a, ['rev-parse', 'origin/spike-x']).trim());
    expect(error.next).toMatch(/fetch origin/i);
  });

  it('writes a full bundle when there is no origin remote', async () => {
    const solo = dir('solo');
    git(root, ['init', '-q', solo]);
    write(path.join(solo, 'a.txt'), 'a\n');
    git(solo, ['add', '-A']);
    git(solo, ['commit', '-qm', 'a']);
    write(path.join(solo, 'a.txt'), 'b\n');
    const snap = await createSnapshot(solo, SNAPSHOT_REF);
    const bundle = path.join(root, 'solo.bundle');
    expect(await createBundle(solo, ['refs/heads/main', SNAPSHOT_REF], bundle)).toEqual({ prerequisites: [] });
    const empty = dir('solo-target');
    git(root, ['init', '-q', empty]);
    const imported = await importBundle(empty, bundle, { branch: 'main', snapshotRef: SNAPSHOT_REF, incomingPrefix: PREFIX });
    expect(imported).toEqual({ branchHead: snap.head, snapshot: snap.commit });
  });

  it('refuses an unborn HEAD and a dirty target worktree', async () => {
    const unborn = dir('unborn');
    git(root, ['init', '-q', unborn]);
    write(path.join(unborn, 'a.txt'), 'a\n');
    expect(await codeOf(createSnapshot(unborn, SNAPSHOT_REF))).toBe('ERR_MOVE_UNBORN_HEAD');

    const { a } = setupRepos();
    write(path.join(a, 'other.txt'), 'dirty\n');
    const snap = await createSnapshot(a, SNAPSHOT_REF);
    expect(await codeOf(applySnapshot(a, snap.commit))).toBe('ERR_MOVE_WORKTREE_NOT_CLEAN');
  });

  it('deletes every ref under a prefix and nothing else', async () => {
    const { a } = setupRepos();
    git(a, ['update-ref', `${PREFIX}/one`, 'HEAD']);
    git(a, ['update-ref', `${PREFIX}/two`, 'HEAD']);
    git(a, ['update-ref', 'refs/pane-move/keep', 'HEAD']);
    await deleteRefs(a, PREFIX);
    expect(git(a, ['for-each-ref', '--format=%(refname)', 'refs/pane-move/'])).toBe('refs/pane-move/keep\n');
  });
});
