import { execFile, execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PaneError } from '../../../../shared/paneError';
import {
  addWorktree,
  applySnapshot,
  createBundle,
  createSnapshot,
  deleteRefs,
  putBackRef,
  ignoredPaths,
  importBundle,
  MoveGitError,
  placeBranch,
  snapshotMatches,
} from './gitSnapshot';

const SNAPSHOT_REF = 'refs/pane-move/test/snapshot';
const PREFIX = 'refs/pane-move/test/incoming';

// A git process start takes about 30-60 ms on Windows, more on a busy CI runner. Each test that runs a
// move's git steps states its bound from this and the number of git commands it runs one after another.
const GIT_START_BUDGET_MS = 250;
const execFileAsync = promisify(execFile);
/** A test's timeout from the number of git commands it runs one after another. */
const gitSteps = (count: number) => ({ timeout: count * GIT_START_BUDGET_MS });

let root = '';
const savedEnv: Record<string, string | undefined> = {};
const isolatedEnv: Record<string, string> = {};

const GIT_IDENTITY = ['-c', 'user.name=Pane Test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main'];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', [...GIT_IDENTITY, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...isolatedEnv },
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** git without blocking the event loop, so read-only checks can run side by side. */
async function gitAsync(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...GIT_IDENTITY, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...isolatedEnv },
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
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

/**
 * A bare origin, a source clone A on spike-x with one pushed and one unpushed commit, and clone B of
 * origin. Built once (ten git commands, two pushes among them) into `into`; each test gets its own copy.
 */
function buildTemplateRepos(into: string): void {
  const branch = 'spike-x';
  const origin = path.join(into, 'origin.git');
  git(root, ['init', '-q', '--bare', origin]);
  const a = path.join(into, 'a');
  git(root, ['clone', '-q', origin, a]);
  write(path.join(a, '.gitignore'), 'ignored.log\nbuild/\n');
  write(path.join(a, 'file.txt'), 'line 1\nline 2\nline 3\n');
  write(path.join(a, 'other.txt'), 'other\n');
  write(path.join(a, 'doomed.txt'), 'delete me\n');
  write(path.join(a, 'script.sh'), '#!/bin/sh\necho hi\n');
  write(path.join(a, 'ünïcode name.txt'), 'unicode\n');
  // Windows checks symlinks out as plain files (core.symlinks false); the move targets macOS and Linux.
  if (process.platform !== 'win32') fs.symlinkSync('other.txt', path.join(a, 'link'));
  git(a, ['add', '-A']);
  git(a, ['commit', '-qm', 'base']);
  git(a, ['push', '-q', 'origin', 'main']);
  git(a, ['checkout', '-q', '-b', branch]);
  write(path.join(a, 'other.txt'), 'other pushed\n');
  git(a, ['commit', '-qam', 'pushed']);
  git(a, ['push', '-q', '-u', 'origin', branch]);
  write(path.join(a, 'other.txt'), 'other unpushed\n');
  git(a, ['commit', '-qam', 'unpushed']);
  git(root, ['clone', '-q', origin, path.join(into, 'b')]);
}

let template = '';

/** This test's copy of the template repositories, with A's and B's origin pointing at its own copy of origin. */
function setupRepos() {
  const copy = dir('repos');
  // verbatimSymlinks keeps A's relative `link` as it is; kept timestamps leave most of git's index entries fresh.
  fs.cpSync(template, copy, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  const origin = path.join(copy, 'origin.git');
  const a = path.join(copy, 'a');
  const b = path.join(copy, 'b');
  // Forward slashes need no escaping in git config, and git accepts them for a Windows path.
  const url = origin.split(path.sep).join('/');
  for (const clone of [a, b]) {
    const config = path.join(clone, '.git', 'config');
    const lines = fs.readFileSync(config, 'utf8').split('\n');
    const urlLines = lines.filter((line) => line.trim().startsWith('url = '));
    if (urlLines.length !== 1) throw new Error(`expected one remote url in ${config}, found ${urlLines.length}`);
    fs.writeFileSync(config, lines.map((line) => (line.trim().startsWith('url = ') ? `\turl = ${url}` : line)).join('\n'));
  }
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

async function fingerprint(worktree: string) {
  // status and diff may rewrite the index's cached stat data, so they run first, one at a time; the rest only read.
  const status = await gitAsync(worktree, ['status', '--porcelain=v2', '-z', '--untracked-files=all']);
  const diff = await gitAsync(worktree, ['diff']);
  const [listed, cached, untracked] = await Promise.all([
    gitAsync(worktree, ['ls-files', '-z', '--cached', '--others']),
    gitAsync(worktree, ['diff', '--cached']),
    gitAsync(worktree, ['ls-files', '--others', '--exclude-standard']),
  ]);
  const files = listed.split('\0').filter(Boolean);
  const hashes = files.sort().map((file) => {
    const full = path.join(worktree, file);
    if (!fs.existsSync(full) && !isSymlink(full)) return `${file}:missing`;
    const stat = fs.lstatSync(full);
    const content = stat.isSymbolicLink() ? fs.readlinkSync(full) : fs.readFileSync(full);
    return `${file}:${stat.mode.toString(8)}:${createHash('sha1').update(content).digest('hex')}`;
  });
  return { status, diff, cached, untracked, files: hashes.join('\n') };
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
  template = path.join(root, 'template');
  buildTemplateRepos(template);
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('gitSnapshot', () => {
  // About 60 git commands in sequence: snapshot (11), bundle, import, branch, worktree, apply, match check (6), plus four fingerprints.
  it('J1: moves commits and all uncommitted work to another clone byte for byte', gitSteps(60), async () => {
    const { a, b } = setupRepos();
    makeMess(a);
    const before = await fingerprint(a);
    const indexBefore = indexBytes(a);

    const snap = await createSnapshot(a, SNAPSHOT_REF);
    expect(indexBytes(a)).toBe(indexBefore);
    expect(await fingerprint(a)).toEqual(before);
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

    const after = await fingerprint(target);
    expect(after.diff).toBe(before.diff);
    expect(after.cached).toBe(before.cached);
    expect(after.untracked).toBe(before.untracked);
    // Windows checkouts don't track the executable bit (core.filemode false).
    if (process.platform !== 'win32') expect(after.diff).toContain('old mode 100644');
    expect(after.untracked).toContain('untracked file.txt');
    expect(after.untracked).toContain('newdir/inner.txt');
    expect(git(target, ['rev-parse', 'HEAD']).trim()).toBe(snap.head);
    expect(git(target, ['symbolic-ref', '--short', 'HEAD']).trim()).toBe('spike-x');
    expect(fs.existsSync(path.join(target, 'ignored.log'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'build'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'doomed.txt'))).toBe(false);
    if (process.platform !== 'win32') expect(fs.readlinkSync(path.join(target, 'link'))).toBe('other.txt');
    expect(await snapshotMatches(target, snap.commit)).toBe(true);

    expect(await fingerprint(a)).toEqual(before);
    expect(await ignoredPaths(a)).toEqual(['build/', 'ignored.log']);
  });

  // About 45 git commands in sequence: snapshot (11), bundle, import, branch, worktree, apply, then two match checks (6 each).
  it('snapshotMatches is false once the reapplied work changes', gitSteps(45), async () => {
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

  // About 25 git commands in sequence: snapshot (11), bundle, import with the branch recovered, branch.
  it('carries the branch when its tip is already on origin, which git bundle leaves out', gitSteps(25), async () => {
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

  // About 25 git commands in sequence: snapshot (11), bundle, import, then the branch checks.
  it('refuses a branch that diverged there, counting its extra commits', gitSteps(25), async () => {
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

  // About 30 git commands in sequence: snapshot (11), bundle, import, then placing the branch twice.
  it('fast-forwards a branch that is behind, and reports same when equal', gitSteps(30), async () => {
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

  // About 25 git commands in sequence: snapshot (11), bundle, import, then the branch checks.
  it('refuses to fast-forward a branch checked out in a worktree there', gitSteps(25), async () => {
    const { a, b } = setupRepos();
    git(b, ['checkout', '-q', '-b', 'spike-x', 'origin/spike-x']);
    await createSnapshot(a, SNAPSHOT_REF);
    const bundle = path.join(root, 'checked-out.bundle');
    await createBundle(a, ['refs/heads/spike-x', SNAPSHOT_REF], bundle);
    await importBundle(b, bundle, { branch: 'spike-x', snapshotRef: SNAPSHOT_REF, incomingPrefix: PREFIX });
    const error = await failureOf(placeBranch(b, 'spike-x', `${PREFIX}/branch`));
    expect(error.code).toBe('ERR_MOVE_BRANCH_CHECKED_OUT');
    // git names the worktree with forward slashes on every platform.
    expect(error.message).toContain(`branch spike-x is checked out at ${b.replace(/\\/g, '/')} there`);
  });

  // About 35 git commands in sequence: two fingerprints, snapshot (11), bundle, import, worktree, apply, match check (6).
  it('moves a detached HEAD', gitSteps(35), async () => {
    const { a, b } = setupRepos();
    git(a, ['checkout', '-q', '--detach']);
    makeMess(a);
    const before = await fingerprint(a);
    const snap = await createSnapshot(a, SNAPSHOT_REF);
    expect(snap.branch).toBeNull();
    const bundle = path.join(root, 'detached.bundle');
    await createBundle(a, [SNAPSHOT_REF], bundle);
    const imported = await importBundle(b, bundle, { branch: null, snapshotRef: SNAPSHOT_REF, incomingPrefix: PREFIX });
    expect(imported.branchHead).toBeNull();
    const target = dir('detached');
    expect(await addWorktree(b, target, null, snap.head)).toEqual({ upstream: null });
    await applySnapshot(target, snap.commit);
    const after = await fingerprint(target);
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

  it('keeps a same-size edit made in the index\'s timestamp window', async () => {
    const { a } = setupRepos();
    // ctime can't be set from a test, so git is told not to trust it; mtime and size then match the index entry.
    git(a, ['config', 'core.trustctime', 'false']);
    const file = path.join(a, 'other.txt');
    const stamp = new Date(Math.floor(Date.now() / 1000 - 60) * 1000);
    fs.utimesSync(file, stamp, stamp);
    git(a, ['add', 'other.txt']);
    write(file, 'other unstaged\n');
    fs.utimesSync(file, stamp, stamp);
    // A valid cache tree means write-tree leaves the first copy alone, so the second copy is checked too.
    git(a, ['write-tree']);
    fs.utimesSync(path.join(a, '.git', 'index'), stamp, stamp);
    expect(git(a, ['diff', '--name-only'])).toBe('other.txt\n');

    const snap = await createSnapshot(a, SNAPSHOT_REF);
    expect(git(a, ['show', `${snap.commit}:other.txt`])).toBe('other unstaged\n');
  });

  it('a move that didn\'t happen puts the snapshot ref back as it was: gone, or the earlier one for Restore (QA r3 finding 3)', async () => {
    const { a } = setupRepos();
    makeMess(a);
    const first = await createSnapshot(a, SNAPSHOT_REF);
    expect(first.previous).toBeNull();
    await putBackRef(a, SNAPSHOT_REF, first.previous);
    expect(git(a, ['for-each-ref', '--format=%(refname)', SNAPSHOT_REF])).toBe('');
    // An earlier move's ref (kept for Restore) is overwritten by a new move, then comes back when it fails.
    git(a, ['update-ref', SNAPSHOT_REF, 'HEAD']);
    const earlier = git(a, ['rev-parse', SNAPSHOT_REF]).trim();
    const second = await createSnapshot(a, SNAPSHOT_REF);
    expect(second.previous).toBe(earlier);
    await putBackRef(a, SNAPSHOT_REF, second.previous);
    await putBackRef(a, SNAPSHOT_REF, second.previous);
    expect(git(a, ['rev-parse', SNAPSHOT_REF]).trim()).toBe(earlier);
  });
});
