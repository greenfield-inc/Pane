import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CommandRunner } from '../utils/commandRunner';
import { WorktreeManager } from './worktreeManager';

const base = 'main$PANE_OP_LITERAL;branch&ref';
const feature = 'feature%PATH%$PANE_OP_LITERAL;branch&ref';
let root: string;
let project: string;
let worktree: string;
let runner: CommandRunner;
const manager = new WorktreeManager();

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
function commit(cwd: string, file: string, content: string, message: string): void {
  writeFileSync(join(cwd, file), content);
  git(cwd, 'add', '--', file);
  git(cwd, 'commit', '-m', message);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pane-git-operations-'));
  project = join(root, 'project $literal;path&name');
  worktree = join(root, 'worktree $literal;path&name');
  mkdirSync(project);
  git(project, 'init', '-b', base);
  git(project, 'config', 'user.name', 'Fixture');
  git(project, 'config', 'user.email', 'fixture@example.invalid');
  git(project, 'config', 'commit.gpgsign', 'false');
  commit(project, 'shared.txt', 'initial\n', 'Initial');
  git(project, 'worktree', 'add', '-b', feature, worktree, base);
  runner = new CommandRunner({ path: project });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('reports a real conflict against the literal comparison ref without modifying either checkout', async () => {
  commit(project, 'shared.txt', 'base edit\n', 'Base change');
  commit(worktree, 'shared.txt', 'feature edit\n', 'Feature change');
  expect(await manager.checkForRebaseConflicts(worktree, base, runner))
    .toMatchObject({ hasConflicts: true, canAutoMerge: false, conflictingFiles: ['shared.txt'] });
  expect(readFileSync(join(worktree, 'shared.txt'), 'utf8')).toBe('feature edit\n');
  expect(git(worktree, 'status', '--porcelain')).toBe('');
  expect(readFileSync(join(project, 'shared.txt'), 'utf8')).toBe('base edit\n');
});

it('rebases onto the literal base while preserving both branches changes', async () => {
  commit(project, 'base.txt', 'base content\n', 'Base change');
  commit(worktree, 'feature.txt', 'feature content\n', 'Feature change');
  await manager.rebaseMainIntoWorktree(worktree, base, runner);
  expect(readFileSync(join(worktree, 'base.txt'), 'utf8')).toBe('base content\n');
  expect(readFileSync(join(worktree, 'feature.txt'), 'utf8')).toBe('feature content\n');
  expect(git(worktree, 'branch', '--show-current')).toBe(feature);
  expect(git(worktree, 'log', '-3', '--format=%s')).toBe('Feature change\nBase change\nInitial');
});

it('fast-forwards the literal target after rebasing the literal feature branch', async () => {
  commit(project, 'base.txt', 'base content\n', 'Base change');
  commit(worktree, 'feature.txt', 'feature content\n', 'Feature change');
  await manager.mergeWorktreeToMain(project, worktree, base, runner);
  expect(git(project, 'branch', '--show-current')).toBe(base);
  expect(git(project, 'log', '-3', '--format=%s')).toBe('Feature change\nBase change\nInitial');
  expect(readFileSync(join(project, 'base.txt'), 'utf8')).toBe('base content\n');
  expect(readFileSync(join(project, 'feature.txt'), 'utf8')).toBe('feature content\n');
});

it('squashes the literal feature branch with an unchanged literal message and attribution footer', async () => {
  commit(worktree, 'feature.txt', 'first content\n', 'First feature change');
  commit(worktree, 'feature.txt', 'final content\n', 'Second feature change');
  const message = 'Literal "$PANE_OP_LITERAL" `%PATH%`\n\nBody with ; and &';
  await manager.squashAndMergeWorktreeToMain(project, worktree, base, message, runner);
  expect(git(project, 'rev-list', '--count', 'HEAD')).toBe('2');
  expect(readFileSync(join(project, 'feature.txt'), 'utf8')).toBe('final content\n');
  expect(git(project, 'log', '-1', '--format=%B')).toBe(message + '\n\nCo-Authored-By: Pane <runpane@users.noreply.github.com>');
  expect(git(project, 'branch', '--show-current')).toBe(base);
});

for (const squash of [false, true]) {
  it(`aborts a conflicting ${squash ? 'squash' : 'regular'} merge without changing either branch`, async () => {
    commit(project, 'shared.txt', 'base edit\n', 'Base change');
    commit(worktree, 'shared.txt', 'feature edit\n', 'Feature change');
    const operation = squash
      ? manager.squashAndMergeWorktreeToMain(project, worktree, base, 'Must not commit', runner)
      : manager.mergeWorktreeToMain(project, worktree, base, runner);
    await expect(operation).rejects.toThrow(squash ? 'Failed to squash and merge' : 'Failed to merge');
    expect(git(worktree, 'status', '--porcelain')).toBe('');
    expect(git(worktree, 'log', '-1', '--format=%s')).toBe('Feature change');
    expect(git(project, 'log', '-1', '--format=%s')).toBe('Base change');
    expect(readFileSync(join(worktree, 'shared.txt'), 'utf8')).toBe('feature edit\n');
    expect(readFileSync(join(project, 'shared.txt'), 'utf8')).toBe('base edit\n');
  });
}
