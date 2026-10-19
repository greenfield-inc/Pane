import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiffManifest, FileDiffRequest } from '../../../../shared/types/gitDiff';
import { CommandRunner } from '../../utils/commandRunner';
import { GitDiffManager } from '../gitDiffManager';
import { changeKindFromStatus, mergeSummaries, parseNameStatusZ, parseNumstatZ, parseUnmergedFilesZ } from '../gitDiffScope';

const directories: string[] = [];
// NTFS cannot represent tab or glob characters in file names, so Windows exercises
// the same code paths with the closest legal spellings. The tab-bearing cases — a
// stage-record-shaped untracked name and a tab-bearing untracked path — are proven
// on POSIX through real git and on every platform by the mergeSummaries and NUL
// parser unit tests below.
const isWindows = process.platform === 'win32';
const untrackedTabPath = isWindows ? 'ta b.txt' : 'ta\tb.txt';
const literalGlobPath = isWindows ? '[isolated].txt' : '*isolated.txt';
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });
const head = (cwd: string): string => git(cwd, 'rev-parse', 'HEAD').trim();
const sortedPaths = (manifest: DiffManifest): string[] => manifest.files.map(file => file.path).sort();

function write(cwd: string, path: string, content: string | NodeJS.ArrayBufferView): void {
  const segments = path.split('/');
  if (segments.length > 1) mkdirSync(join(cwd, ...segments.slice(0, -1)), { recursive: true });
  writeFileSync(join(cwd, path), content);
}

function commitPaths(cwd: string, message: string, paths: string[]): string {
  git(cwd, 'add', '--', ...paths);
  git(cwd, 'commit', '-m', message);
  return head(cwd);
}

function repository(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'pane-git-diff-'));
  directories.push(cwd);
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.name', 'Pane Test');
  git(cwd, 'config', 'user.email', 'pane@example.test');
  write(cwd, 'tracked.txt', 'before\n');
  commitPaths(cwd, 'base', ['tracked.txt']);
  git(cwd, 'checkout', '-b', 'feature');
  return cwd;
}

function harness(cwd: string) {
  return {
    manager: new GitDiffManager(),
    runner: new CommandRunner({ path: cwd }),
    deps: { comparisonBase: async () => 'main' },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// Real-Git history capture uses the integration budget, not a latency contract.
describe('GitDiffManager asynchronous history and execution capture', { timeout: 15000 }, () => {
  it('keeps history, graph, commit diffs, and working changes usable through the async runner', async () => {
    const cwd = repository();
    const before = head(cwd);
    write(cwd, 'tracked.txt', 'after\n');
    const after = commitPaths(cwd, 'feature change', ['tracked.txt']);
    const { manager, runner } = harness(cwd);

    expect(await manager.getCurrentCommitHash(cwd, runner)).toBe(after);
    const commits = await manager.getCommitHistory(cwd, 50, 'main', runner);
    expect(commits.map(commit => commit.hash)).toEqual([after]);
    expect(commits[0].stats).toEqual({ additions: 1, deletions: 1, filesChanged: 1 });
    expect((await manager.getGraphCommitHistory(cwd, 'feature', 50, 'main', runner))[0].message).toBe('feature change');
    expect((await manager.getCommitDiff(cwd, after, runner)).diff).toContain('+after');
    const range = await manager.captureCommitDiff(cwd, before, after, runner);
    expect(range.changedFiles).toEqual(['tracked.txt']);
    expect(range.afterHash).toBe(after);
    expect(await manager.hasChanges(cwd, runner)).toBe(false);

    write(cwd, 'tracked.txt', 'working\n');
    expect(await manager.hasChanges(cwd, runner)).toBe(true);
    const working = await manager.captureWorkingDirectoryDiff(cwd, runner);
    expect(working.diff).toContain('+working');
    expect(working.stats).toEqual({ additions: 1, deletions: 1, filesChanged: 1 });
    expect(working.beforeHash).toBe(after);
  });
});

// Real-Git manifest coverage uses the integration budget, not a latency contract.
describe('GitDiffManager manifests', { timeout: 15000 }, () => {
  it('lists the complete net session diff across 60 commits plus staged, unstaged, and untracked work', async () => {
    const cwd = repository();
    const committedPaths: string[] = [];
    for (let index = 1; index <= 60; index += 1) {
      const path = `ahead-${String(index).padStart(2, '0')}.txt`;
      committedPaths.push(path);
      write(cwd, path, `commit ${index}\n`);
      commitPaths(cwd, `ahead ${index}`, [path]);
    }
    write(cwd, 'staged.txt', 'staged\n');
    git(cwd, 'add', '--', 'staged.txt');
    write(cwd, 'tracked.txt', 'unstaged\n');
    write(cwd, 'untracked.txt', 'untracked\n');
    const { manager, runner, deps } = harness(cwd);

    const manifest = await manager.getDiffManifest(cwd, { kind: 'session' }, runner, deps);
    const mergeBase = git(cwd, 'merge-base', 'main', 'HEAD').trim();

    expect(sortedPaths(manifest)).toEqual([...committedPaths, 'staged.txt', 'tracked.txt', 'untracked.txt'].sort());
    expect(manifest.resolvedBase).toEqual({ kind: 'comparison-base', ref: 'main', hash: mergeBase });
  });

  it('anchors a session at the merge-base when main advances after the feature fork', async () => {
    const cwd = repository();
    git(cwd, 'checkout', 'main');
    write(cwd, 'upstream-after-fork.txt', 'upstream\n');
    commitPaths(cwd, 'advance main', ['upstream-after-fork.txt']);
    git(cwd, 'checkout', 'feature');
    write(cwd, 'feature-only.txt', 'feature\n');
    commitPaths(cwd, 'feature work', ['feature-only.txt']);
    const { manager, runner, deps } = harness(cwd);

    const manifest = await manager.getDiffManifest(cwd, { kind: 'session' }, runner, deps);
    const mergeBase = git(cwd, 'merge-base', 'main', 'HEAD').trim();

    expect(sortedPaths(manifest)).toEqual(['feature-only.txt']);
    expect(manifest.files.some(file => file.path === 'upstream-after-fork.txt')).toBe(false);
    expect(manifest.resolvedBase).toEqual({ kind: 'comparison-base', ref: 'main', hash: mergeBase });
  });

  it('uses exactly the bounded metadata commands and never transfers an untracked body', async () => {
    const cwd = repository();
    const bodyMarker = 'UNTRACKED-BODY-MUST-NOT-BE-READ';
    const deceptivePath = `100644 ${'0'.repeat(40)} 1${isWindows ? ' ' : '\t'}looks-unmerged.txt`;
    write(cwd, deceptivePath, `${bodyMarker}\n`);
    const { manager, runner, deps } = harness(cwd);
    const mergeBase = git(cwd, 'merge-base', 'main', 'HEAD').trim();
    const outputs: string[] = [];
    const execute = runner.execFile.bind(runner);
    const execFile = vi.spyOn(runner, 'execFile').mockImplementation(async (file, args, worktreePath, options) => {
      const result = await execute(file, args, worktreePath, options);
      outputs.push(result.stdout, result.stderr);
      return result;
    });

    const manifest = await manager.getDiffManifest(cwd, { kind: 'session' }, runner, deps);
    const invocations = execFile.mock.calls.map(([file, args]) => [file, [...args]]);

    expect(sortedPaths(manifest)).toEqual([deceptivePath]);
    expect(manifest.files[0].kind).toBe('added');
    expect(manifest.files.some(file => file.path === 'looks-unmerged.txt')).toBe(false);
    const expectedInvocations = [
      ['git', ['merge-base', '--end-of-options', 'main', 'HEAD']],
      ['git', ['rev-parse', '--verify', '--end-of-options', 'HEAD']],
      ['git', ['diff', '-z', '-M', '--name-status', mergeBase, '--']],
      ['git', ['diff', '-z', '-M', '--numstat', mergeBase, '--']],
      ['git', ['ls-files', '-z', '--others', '--exclude-standard']],
      ['git', ['ls-files', '-z', '--unmerged']],
    ];
    expect(invocations).toHaveLength(expectedInvocations.length);
    expect(invocations).toEqual(expect.arrayContaining(expectedInvocations));
    expect(outputs.join('\n')).not.toContain(bodyMarker);
    expect(invocations.flat(2)).not.toContain('cat');
    expect(invocations.flat(2)).not.toContain('wc');
    expect(invocations.flat(2)).not.toContain('show');
    expect(invocations.flat(2)).not.toContain(deceptivePath);
  });

  it('uses a commit parent, a merge first parent, and the empty tree for a root commit', async () => {
    const cwd = repository();
    const { manager, runner, deps } = harness(cwd);
    write(cwd, 'normal.txt', 'normal\n');
    const normal = commitPaths(cwd, 'normal', ['normal.txt']);
    const normalManifest = await manager.getDiffManifest(cwd, { kind: 'commit', hash: normal }, runner, deps);
    expect(sortedPaths(normalManifest)).toEqual(['normal.txt']);
    expect(normalManifest.resolvedBase.hash).toBe(git(cwd, 'rev-parse', `${normal}^1`).trim());

    git(cwd, 'checkout', '-b', 'topic');
    write(cwd, 'second-parent.txt', 'topic\n');
    commitPaths(cwd, 'topic work', ['second-parent.txt']);
    git(cwd, 'checkout', 'feature');
    write(cwd, 'first-parent.txt', 'feature\n');
    commitPaths(cwd, 'feature work', ['first-parent.txt']);
    git(cwd, 'merge', '--no-ff', 'topic', '-m', 'merge topic');
    const merge = head(cwd);

    const mergeManifest = await manager.getDiffManifest(cwd, { kind: 'commit', hash: merge }, runner, deps);
    expect(sortedPaths(mergeManifest)).toEqual(['second-parent.txt']);
    expect(mergeManifest.resolvedBase).toEqual({ kind: 'commit', hash: git(cwd, 'rev-parse', `${merge}^1`).trim() });

    const root = git(cwd, 'rev-list', '--max-parents=0', 'HEAD').trim();
    const rootManifest = await manager.getDiffManifest(cwd, { kind: 'commit', hash: root }, runner, deps);
    expect(sortedPaths(rootManifest)).toEqual(['tracked.txt']);
    expect(rootManifest.resolvedBase.kind).toBe('empty-tree');
  });

  it('preserves working-tree, commit-range, root-range, and working-tree-range semantics', async () => {
    const cwd = repository();
    write(cwd, 'older.txt', 'older\n');
    const older = commitPaths(cwd, 'older', ['older.txt']);
    write(cwd, 'newer.txt', 'newer\n');
    const newer = commitPaths(cwd, 'newer', ['newer.txt']);
    write(cwd, 'tracked.txt', 'working tree\n');
    write(cwd, 'staged.txt', 'staged\n');
    git(cwd, 'add', '--', 'staged.txt');
    write(cwd, 'untracked.txt', 'untracked\n');
    const { manager, runner, deps } = harness(cwd);

    const workingTree = await manager.getDiffManifest(cwd, { kind: 'working-tree' }, runner, deps);
    expect(sortedPaths(workingTree)).toEqual(['staged.txt', 'tracked.txt', 'untracked.txt']);

    const commitRange = await manager.getDiffManifest(cwd, { kind: 'commit-range', olderHash: older, newerHash: newer }, runner, deps);
    expect(sortedPaths(commitRange)).toEqual(['newer.txt', 'older.txt']);
    expect(commitRange.resolvedBase.hash).toBe(git(cwd, 'rev-parse', `${older}^1`).trim());

    const root = git(cwd, 'rev-list', '--max-parents=0', newer).trim();
    const rootRange = await manager.getDiffManifest(cwd, { kind: 'commit-range', olderHash: root, newerHash: newer }, runner, deps);
    expect(sortedPaths(rootRange)).toEqual(['newer.txt', 'older.txt', 'tracked.txt']);
    expect(rootRange.resolvedBase.kind).toBe('empty-tree');

    const workingTreeRange = await manager.getDiffManifest(cwd, { kind: 'working-tree-range', baseHash: older }, runner, deps);
    expect(sortedPaths(workingTreeRange)).toEqual(['newer.txt', 'staged.txt', 'tracked.txt', 'untracked.txt']);
  });

  it('resolves commit, root, and commit-range scopes in a SHA-256 repository when supported', async (context) => {
    const cwd = mkdtempSync(join(tmpdir(), 'pane-git-diff-sha256-scopes-'));
    directories.push(cwd);
    try {
      git(cwd, 'init', '--object-format=sha256', '-b', 'main');
    } catch {
      context.skip();
      return;
    }
    git(cwd, 'config', 'user.name', 'Pane Test');
    git(cwd, 'config', 'user.email', 'pane@example.test');
    write(cwd, 'root.txt', 'root\n');
    const root = commitPaths(cwd, 'root', ['root.txt']);
    write(cwd, 'child.txt', 'child\n');
    const child = commitPaths(cwd, 'child', ['child.txt']);
    write(cwd, 'newest.txt', 'newest\n');
    const newest = commitPaths(cwd, 'newest', ['newest.txt']);
    const emptyTree = git(cwd, 'hash-object', '-t', 'tree', '/dev/null').trim();
    const { manager, runner, deps } = harness(cwd);

    const commitManifest = await manager.getDiffManifest(cwd, { kind: 'commit', hash: child }, runner, deps);
    const rootManifest = await manager.getDiffManifest(cwd, { kind: 'commit', hash: root }, runner, deps);
    const rangeManifest = await manager.getDiffManifest(
      cwd,
      { kind: 'commit-range', olderHash: child, newerHash: newest },
      runner,
      deps,
    );

    expect(child).toHaveLength(64);
    expect(sortedPaths(commitManifest)).toEqual(['child.txt']);
    expect(sortedPaths(rootManifest)).toEqual(['root.txt']);
    expect(rootManifest.resolvedBase).toEqual({ kind: 'empty-tree', hash: emptyTree });
    expect(sortedPaths(rangeManifest)).toEqual(['child.txt', 'newest.txt']);
    expect(rangeManifest.resolvedBase.hash).toBe(root);
  });

  it('coalesces a real conflicted path into one unmerged manifest entry', async () => {
    const cwd = repository();
    write(cwd, 'conflict.ts', 'feature version\n');
    commitPaths(cwd, 'feature version', ['conflict.ts']);
    git(cwd, 'checkout', 'main');
    write(cwd, 'conflict.ts', 'main version\n');
    commitPaths(cwd, 'main version', ['conflict.ts']);
    git(cwd, 'checkout', 'feature');
    expect(() => git(cwd, 'merge', 'main')).toThrow();
    write(cwd, untrackedTabPath, 'untracked tab path\n');
    const { manager, runner, deps } = harness(cwd);

    const manifest = await manager.getDiffManifest(cwd, { kind: 'working-tree' }, runner, deps);

    expect(manifest.files).toHaveLength(2);
    expect(manifest.files).toContainEqual(expect.objectContaining({ path: 'conflict.ts', kind: 'unmerged' }));
    expect(manifest.files).toContainEqual(expect.objectContaining({ path: untrackedTabPath, kind: 'added' }));
    expect(manifest.stats.filesChanged).toBe(2);
  });
});

// Real-Git file-state coverage uses the integration budget, not a latency contract.
describe('GitDiffManager file diffs', { timeout: 15000 }, () => {
  it('returns isolated real-git patches for every supported file state', async () => {
    const cwd = repository();
    write(cwd, 'modified.txt', 'before modified\n');
    write(cwd, 'deleted.txt', 'delete from base\n');
    write(cwd, 'rename-pure-old.txt', 'pure rename\n');
    write(cwd, 'rename-edit-old.txt', 'one\ntwo\nthree\nfour\n');
    write(cwd, 'binary.bin', Buffer.from([0, 1, 2, 3]));
    commitPaths(cwd, 'file states base', [
      'modified.txt',
      'deleted.txt',
      'rename-pure-old.txt',
      'rename-edit-old.txt',
      'binary.bin',
    ]);

    write(cwd, 'added.txt', 'added\n');
    git(cwd, 'add', '--', 'added.txt');
    write(cwd, 'modified.txt', 'after modified\n');
    unlinkSync(join(cwd, 'deleted.txt'));
    git(cwd, 'mv', 'rename-pure-old.txt', 'rename-pure-new.txt');
    git(cwd, 'mv', 'rename-edit-old.txt', 'rename-edit-new.txt');
    write(cwd, 'rename-edit-new.txt', 'one\ntwo changed\nthree\nfour\n');
    write(cwd, 'binary.bin', Buffer.from([0, 9, 8, 7]));
    write(cwd, 'untracked.txt', 'untracked patch\n');
    write(cwd, literalGlobPath, 'literal glob\n');
    const { manager, runner, deps } = harness(cwd);
    const execFile = vi.spyOn(runner, 'execFile');
    const load = (request: FileDiffRequest) => manager.getFileDiff(cwd, { kind: 'working-tree' }, request, runner, deps);

    const added = await load({ path: 'added.txt' });
    expect(added).toMatchObject({ status: 'changed', file: { path: 'added.txt', kind: 'added' } });
    expect(added.patch).toContain('+added');

    const modified = await load({ path: 'modified.txt' });
    expect(modified).toMatchObject({ status: 'changed', file: { path: 'modified.txt', kind: 'modified' } });
    expect(modified.patch).toContain('-before modified');
    expect(modified.patch).toContain('+after modified');

    const deleted = await load({ path: 'deleted.txt' });
    expect(deleted).toMatchObject({ status: 'changed', file: { path: 'deleted.txt', kind: 'deleted' } });
    expect(deleted.patch).toContain('-delete from base');

    const pureRename = await load({ path: 'rename-pure-new.txt', previousPath: 'rename-pure-old.txt' });
    expect(pureRename).toMatchObject({
      status: 'changed',
      file: { path: 'rename-pure-new.txt', previousPath: 'rename-pure-old.txt', kind: 'renamed' },
    });
    expect(pureRename.patch).not.toContain('@@');
    expect(pureRename.patch).toContain('rename-pure-old.txt');
    expect(pureRename.patch).toContain('rename-pure-new.txt');

    const editedRename = await load({ path: 'rename-edit-new.txt', previousPath: 'rename-edit-old.txt' });
    expect(editedRename).toMatchObject({
      status: 'changed',
      file: { path: 'rename-edit-new.txt', previousPath: 'rename-edit-old.txt', kind: 'renamed' },
    });
    expect(editedRename.patch).toContain('@@');
    expect(editedRename.patch).toContain('+two changed');
    expect(editedRename.patch).toContain('rename-edit-old.txt');
    expect(editedRename.patch).toContain('rename-edit-new.txt');

    const binary = await load({ path: 'binary.bin' });
    expect(binary).toMatchObject({
      status: 'changed',
      file: { path: 'binary.bin', kind: 'modified', isBinary: true, additions: null, deletions: null },
    });
    expect(binary.patch).toContain('Binary files');

    const untracked = await load({ path: 'untracked.txt' });
    expect(untracked).toMatchObject({
      status: 'changed',
      file: { path: 'untracked.txt', kind: 'added', additions: null, deletions: null },
    });
    expect(untracked.patch).toContain('diff --git');
    expect(untracked.patch).toContain('+untracked patch');
    expect(execFile.mock.calls.map(([, args]) => [...args])).toContainEqual([
      'diff', '--no-index', '--no-color', '--', '/dev/null', 'untracked.txt',
    ]);

    const literalGlob = await load({ path: literalGlobPath });
    expect(literalGlob).toMatchObject({ status: 'changed', file: { path: literalGlobPath, kind: 'added' } });
    expect(literalGlob.patch).toContain(literalGlobPath);
    expect(literalGlob.patch).not.toContain('modified.txt');
    expect(literalGlob.patch).not.toContain('untracked.txt');
    expect(execFile.mock.calls.map(([, args]) => [...args])).toContainEqual([
      'diff', '--no-index', '--no-color', '--', '/dev/null', literalGlobPath,
    ]);
  });

  it('reports an untracked file that vanishes before no-index diff as no longer changed', async () => {
    const cwd = repository();
    write(cwd, 'vanished.txt', 'temporary\n');
    const { manager, runner, deps } = harness(cwd);
    const execute = runner.execFile.bind(runner);
    let removed = false;
    vi.spyOn(runner, 'execFile').mockImplementation(async (file, args, worktreePath, options) => {
      const result = await execute(file, args, worktreePath, options);
      if (!removed && args[0] === 'ls-files' && args.includes('vanished.txt')) {
        removed = true;
        unlinkSync(join(cwd, 'vanished.txt'));
      }
      return result;
    });

    const result = await manager.getFileDiff(cwd, { kind: 'working-tree' }, { path: 'vanished.txt' }, runner, deps);

    expect(removed).toBe(true);
    expect(result).toMatchObject({ status: 'no-longer-changed', file: { path: 'vanished.txt', kind: 'added' }, patch: '' });
  });

  it('ignores an unrelated renderer-supplied previous path', async () => {
    const cwd = repository();
    write(cwd, 'a.ts', 'a before\n');
    write(cwd, 'b.ts', 'b before\n');
    commitPaths(cwd, 'two files', ['a.ts', 'b.ts']);
    write(cwd, 'a.ts', 'a after\n');
    write(cwd, 'b.ts', 'b after\n');
    const { manager, runner, deps } = harness(cwd);

    const result = await manager.getFileDiff(
      cwd,
      { kind: 'working-tree' },
      { path: 'a.ts', previousPath: 'b.ts' },
      runner,
      deps,
    );

    expect(result).toMatchObject({ status: 'changed', file: { path: 'a.ts', kind: 'modified' } });
    expect(result.file.previousPath).toBeUndefined();
    expect(result.patch).toContain('a.ts');
    expect(result.patch).not.toContain('b.ts');
    expect(result.patch).not.toContain('b after');
  });

  it('returns a patch for a changed tracked symlink that points to a directory', async () => {
    const cwd = repository();
    mkdirSync(join(cwd, 'target-before'));
    mkdirSync(join(cwd, 'target-after'));
    symlinkSync('target-before', join(cwd, 'linked-directory'), 'dir');
    commitPaths(cwd, 'tracked symlink', ['linked-directory']);
    unlinkSync(join(cwd, 'linked-directory'));
    symlinkSync('target-after', join(cwd, 'linked-directory'), 'dir');
    const { manager, runner, deps } = harness(cwd);

    const result = await manager.getFileDiff(
      cwd,
      { kind: 'working-tree' },
      { path: 'linked-directory' },
      runner,
      deps,
    );

    expect(result).toMatchObject({ status: 'changed', file: { path: 'linked-directory', kind: 'modified' } });
    expect(result.patch).toContain('-target-before');
    expect(result.patch).toContain('+target-after');
  });

  it('maps an oversized untracked no-index patch to diff-too-large', async () => {
    const cwd = repository();
    write(cwd, 'large-untracked.txt', `${'oversized line\n'.repeat(100)}`);
    const runner = new CommandRunner({ path: cwd });
    const execFile = vi.spyOn(runner, 'execFile');
    const manager = new GitDiffManager(undefined, undefined, 128);
    const deps = { comparisonBase: async () => 'main' };

    await expect(manager.getFileDiff(
      cwd,
      { kind: 'working-tree' },
      { path: 'large-untracked.txt' },
      runner,
      deps,
    )).rejects.toMatchObject({ code: 'diff-too-large' });
    expect(execFile.mock.calls.map(([, args]) => [...args])).toContainEqual([
      'diff', '--no-index', '--no-color', '--', '/dev/null', 'large-untracked.txt',
    ]);
  });

  it.each([
    ['', 'empty'],
    ['../outside.txt', 'parent-relative'],
    ['/tmp/absolute.txt', 'absolute'],
    ['folder', 'directory'],
  ])('rejects the %s path as invalid (%s)', async (path) => {
    const cwd = repository();
    mkdirSync(join(cwd, 'folder'));
    const { manager, runner, deps } = harness(cwd);

    await expect(manager.getFileDiff(cwd, { kind: 'working-tree' }, { path }, runner, deps)).rejects.toMatchObject({ code: 'invalid-path' });
  });
});

describe('NUL parsers', () => {
  it('keeps a stage-record-shaped untracked name whole instead of parsing it as an unmerged record', () => {
    const deceptive = `100644 ${'0'.repeat(40)} 1\tlooks-unmerged.txt`;
    const files = mergeSummaries([], [], [deceptive]);
    expect(files).toEqual([{ path: deceptive, kind: 'added', additions: null, deletions: null, isBinary: false }]);
    expect(files.some(file => file.path === 'looks-unmerged.txt')).toBe(false);
  });

  it('parses rename and binary records without path regexes', () => {
    const names = parseNameStatusZ('R100\0old name\0new name\0M\0[odd]?.bin\0');
    const stats = parseNumstatZ('1\t2\t\0old name\0new name\0-\t-\t[odd]?.bin\0');
    expect(mergeSummaries(names, stats, [])).toEqual([
      { path: 'new name', previousPath: 'old name', kind: 'renamed', additions: 1, deletions: 2, isBinary: false },
      { path: '[odd]?.bin', previousPath: undefined, kind: 'modified', additions: null, deletions: null, isBinary: true },
    ]);
    expect(changeKindFromStatus('U')).toBe('unmerged');
  });

  it('coalesces duplicate conflict records and prefers the unmerged kind', () => {
    expect(mergeSummaries(
      parseNameStatusZ('M\0conflict.ts\0U\0conflict.ts\0'),
      parseNumstatZ('1\t2\tconflict.ts\0' + '3\t4\tconflict.ts\0'),
      [],
    )).toEqual([{
      path: 'conflict.ts',
      previousPath: undefined,
      kind: 'unmerged',
      additions: 4,
      deletions: 6,
      isBinary: false,
    }]);
  });

  it('parses SHA-1 and SHA-256 unmerged stage records without a fixed object-id width', () => {
    const firstHash = 'd'.repeat(40);
    const secondHash = 'c'.repeat(64);
    expect(parseUnmergedFilesZ(
      `100644 ${firstHash} 1\tconflict.ts\0`
      + `100644 ${secondHash} 2\tconflict.ts\0`
      + 'ta\tb.txt\0',
    )).toEqual(['conflict.ts']);
  });

  it('parses unmerged records from a SHA-256 repository when supported', async (context) => {
    const cwd = mkdtempSync(join(tmpdir(), 'pane-git-diff-sha256-'));
    directories.push(cwd);
    try {
      git(cwd, 'init', '--object-format=sha256', '-b', 'main');
    } catch {
      context.skip();
      return;
    }
    git(cwd, 'config', 'user.name', 'Pane Test');
    git(cwd, 'config', 'user.email', 'pane@example.test');
    write(cwd, 'conflict.ts', 'base\n');
    commitPaths(cwd, 'base', ['conflict.ts']);
    git(cwd, 'checkout', '-b', 'feature');
    write(cwd, 'conflict.ts', 'feature\n');
    commitPaths(cwd, 'feature', ['conflict.ts']);
    git(cwd, 'checkout', 'main');
    write(cwd, 'conflict.ts', 'main\n');
    commitPaths(cwd, 'main', ['conflict.ts']);
    git(cwd, 'checkout', 'feature');
    expect(() => git(cwd, 'merge', 'main')).toThrow();

    const output = git(cwd, 'ls-files', '-z', '--unmerged');
    const firstObjectId = output.split('\0')[0].split('\t')[0].split(' ')[1];
    expect(firstObjectId).toHaveLength(64);
    expect(parseUnmergedFilesZ(output)).toEqual(['conflict.ts']);

    const { manager, runner, deps } = harness(cwd);
    const manifest = await manager.getDiffManifest(cwd, { kind: 'working-tree' }, runner, deps);
    expect(manifest.files.filter(file => file.path === 'conflict.ts')).toEqual([
      expect.objectContaining({ kind: 'unmerged' }),
    ]);
  });
});
