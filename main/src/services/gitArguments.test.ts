import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { GitStatusManager } from './gitStatusManager';
import { GitDiffManager } from './gitDiffManager';
import type { SessionManager } from './sessionManager';
import { detectGitBase, resolveDefaultWorktreeBase, WorktreeManager } from './worktreeManager';
import { CommandRunner } from '../utils/commandRunner';
import { PathResolver } from '../utils/pathResolver';
import type { IpcMain } from 'electron';
import type { AppServices } from '../ipc/types';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { registerFileHandlers } from '../ipc/file';
import { registerGitHandlers } from '../ipc/git';
import { detectProjectConfig } from './projectConfigDetector';
import { forceRemoveWorktree } from './gitPerformanceConfig';
import { worktreePoolManager } from './worktreePoolManager';
import { fastGetAheadBehind } from './gitPlumbingCommands';

let directory: string;
function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'pane-git-arguments-'));
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('commit', '--allow-empty', '-m', 'Initial');
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it('counts commits relative to a literal dollar-bearing branch', async () => {
  git('branch', 'base$PANE_AUDIT_LITERAL;branch&literal');
  writeFileSync(join(directory, 'change.txt'), 'one line\n');
  git('add', '.');
  git('commit', '-m', 'One change');
  expect(await fastGetAheadBehind(directory, 'base$PANE_AUDIT_LITERAL;branch&literal')).toEqual({ ahead: 1, behind: 0 });
  // SAFETY: Status reads only the session and its project execution context.
  const sessions = {
    getSession: () => ({ id: 'pane', worktreePath: directory, baseBranch: 'base$PANE_AUDIT_LITERAL;branch&literal' }),
    getProjectContext: () => ({ project: { path: directory }, commandRunner: new CommandRunner({ path: directory }) }),
  } as SessionManager;
  const status = await new GitStatusManager(sessions, new WorktreeManager(), new GitDiffManager()).getGitStatus('pane');
  expect(status).toMatchObject({ ahead: 1, totalCommits: 1, commitAdditions: 1, commitFilesChanged: 1 });
});

it('creates a worktree from a non-origin remote without inheriting its upstream', async () => {
  git('remote', 'add', 'upstream', directory);
  git('update-ref', 'refs/remotes/upstream/main', 'HEAD');
  const manager = new WorktreeManager();
  const project = { path: directory };
  const result = await manager.createWorktree(directory, 'pane', 'feature', 'upstream/main', undefined,
    new PathResolver(project), new CommandRunner(project));
  expect(result.baseBranch).toBe('upstream/main');
  expect(git('for-each-ref', '--format=%(upstream)', 'refs/heads/feature')).toBe('');
});

it('preserves literal worktree paths, branch names, and base refs', async () => {
  git('branch', 'base$PANE_AUDIT_LITERAL;branch&literal');
  const project = { path: directory };
  const result = await new WorktreeManager().createWorktree(directory, 'pane$PANE_AUDIT_LITERAL;path&literal',
    'topic$PANE_AUDIT_LITERAL;branch&literal', 'base$PANE_AUDIT_LITERAL;branch&literal', undefined,
    new PathResolver(project), new CommandRunner(project));
  expect(result.worktreePath).toBe(join(directory, 'worktrees', 'pane$PANE_AUDIT_LITERAL;path&literal'));
  expect(execFileSync('git', ['branch', '--show-current'], { cwd: result.worktreePath, encoding: 'utf8' }).trim())
    .toBe('topic$PANE_AUDIT_LITERAL;branch&literal');
});

it('reads local project configuration at a literal dollar-bearing path', async () => {
  const root = join(directory, 'project$PANE_AUDIT_LITERAL;path&literal');
  mkdirSync(root);
  writeFileSync(join(root, 'pane.json'), JSON.stringify({ scripts: { setup: 'pnpm install', run: 'pnpm dev' } }));
  expect(await detectProjectConfig(root, 'macos', new CommandRunner({ path: root })))
    .toMatchObject({ source: 'pane.json', setup: 'pnpm install', run: 'pnpm dev' });
});

it('reports the status of the literal file requested over IPC', async () => {
  const filename = 'notes$PANE_AUDIT_LITERAL;path&literal.txt';
  writeFileSync(join(directory, filename), 'original\n');
  git('add', '--', filename);
  git('commit', '-m', 'Track literal file');
  writeFileSync(join(directory, filename), 'changed\n');
  // SAFETY: The fixture implements all session boundaries used by git:file-status.
  const services = { sessionManager: {
    getSession: () => ({ id: 'pane', worktreePath: directory }),
    getProjectContext: () => ({ commandRunner: new CommandRunner({ path: directory }) }),
  } } as AppServices;
  // SAFETY: Binding needs only IpcMain.handle; invocation uses the public registry.
  const ipc = { handle: () => {} } as IpcMain;
  const registry = new PaneCommandRegistry();
  registerGitHandlers(ipc, services, registry);
  expect(await registry.invoke('git:file-status', ['pane', filename]))
    .toEqual({ success: true, data: { status: 'modified' } });
});

it('detects incoming commits from a literal comparison branch', async () => {
  const branch = 'incoming$PANE_AUDIT_LITERAL;branch&literal';
  git('checkout', '-b', branch);
  git('commit', '--allow-empty', '-m', 'Incoming change');
  git('checkout', 'main');
  expect(await new WorktreeManager().hasChangesToRebase(directory, branch, new CommandRunner({ path: directory }))).toBe(true);
});

it('finds the origin branch using the literal ref name', async () => {
  const branch = 'topic$PANE_AUDIT_LITERAL;branch&literal';
  git('update-ref', `refs/remotes/origin/${branch}`, 'HEAD');
  expect(await new WorktreeManager().getOriginBranch(directory, branch, new CommandRunner({ path: directory })))
    .toBe(`origin/${branch}`);
});


it('reads exact committed content through revision IPC for literal refs and paths', async () => {
  const filename = 'notes $PANE_AUDIT_LITERAL;path&literal.txt';
  const branch = 'snapshot$PANE_AUDIT_LITERAL;branch&literal';
  writeFileSync(join(directory, filename), 'committed fixture content\n');
  git('add', '--', filename);
  git('commit', '-m', 'Committed content');
  git('branch', branch);
  writeFileSync(join(directory, filename), 'uncommitted content\n');
  // SAFETY: The fixture implements all boundaries used by file:readAtRevision.
  const services = { sessionManager: {
    getSession: () => ({ id: 'pane', worktreePath: directory }),
    getProjectContext: () => ({ commandRunner: new CommandRunner({ path: directory }) }),
  } } as AppServices;
  const registry = new PaneCommandRegistry();
  // SAFETY: Registration uses only IpcMain.handle; invocation uses the registry.
  registerFileHandlers({ handle: () => {} } as IpcMain, services, registry);
  expect(await registry.invoke('file:readAtRevision', [{ sessionId: 'pane', filePath: filename, revision: branch }]))
    .toEqual({ success: true, content: 'committed fixture content\n' });
});


it('rejects option-like checkout input without changing the checked-out branch', async () => {
  await expect(detectGitBase(directory, new CommandRunner({ path: directory }), '--detach', true)).rejects.toThrow();
  expect(git('branch', '--show-current')).toBe('main');
});


it('claims a reserve with literal shell-sensitive refs and paths and no upstream', async () => {
  const base = 'base%PATH%$PANE_AUDIT_LITERAL;branch&literal';
  const target = 'claim%PATH%$PANE_AUDIT_LITERAL;path&literal';
  writeFileSync(join(directory, 'fixture.txt'), 'reserve content\n');
  git('add', '.');
  git('commit', '-m', 'Reserve content');
  git('branch', base);
  const project = { path: directory };
  const runner = new CommandRunner(project);
  const resolver = new PathResolver(project);
  await worktreePoolManager.createReserve(directory, base, undefined, resolver, runner);
  expect(worktreePoolManager.hasReserve(directory, base)).toBe(true);
  const claimed = await worktreePoolManager.claimReserve(directory, base, target, target, undefined, resolver, runner);
  if (!claimed) throw new Error('Expected a claimed reserve');
  expect(claimed.worktreePath).toBe(join(directory, 'worktrees', target));
  expect(execFileSync('git', ['show', 'HEAD:fixture.txt'], { cwd: claimed.worktreePath, encoding: 'utf8' }))
    .toBe('reserve content\n');
  expect(execFileSync('git', ['branch', '--show-current'], { cwd: claimed.worktreePath, encoding: 'utf8' }).trim()).toBe(target);
  expect(git('for-each-ref', '--format=%(upstream)', `refs/heads/${target}`)).toBe('');
  // Replenishment is asynchronous; finish it before the temporary repository is removed.
  await expect.poll(() => worktreePoolManager.hasReserve(directory, base)).toBe(true);
  await forceRemoveWorktree(claimed.worktreePath, directory, runner);
  expect(existsSync(claimed.worktreePath)).toBe(false);
});


it('tracks literal remote defaults and soft resets only commits ahead of that base', async () => {
  const remote = 'origin/base%PATH%$PANE_AUDIT_LITERAL;branch&literal';
  git('remote', 'add', 'origin', directory);
  git('update-ref', `refs/remotes/${remote}`, 'HEAD');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/${remote}`);
  const runner = new CommandRunner({ path: directory });
  const manager = new WorktreeManager();
  expect(await resolveDefaultWorktreeBase(directory, runner)).toBe(remote);
  await manager.setUpstream(directory, remote, runner);
  expect(git('rev-parse', '--abbrev-ref', '@{upstream}')).toBe(remote);
  await expect(manager.gitSoftReset(directory, remote, runner)).rejects.toThrow('No commits to undo');
  writeFileSync(join(directory, 'queued.txt'), 'queued content\n');
  git('add', '.');
  git('commit', '-m', 'Undo this fixture commit');
  expect(await manager.gitSoftReset(directory, remote, runner)).toMatchObject({ previousCommitMessage: 'Undo this fixture commit' });
  expect(git('log', '-1', '--format=%s')).toBe('Initial');
  expect(git('diff', '--cached', '--name-only')).toBe('queued.txt');
});
