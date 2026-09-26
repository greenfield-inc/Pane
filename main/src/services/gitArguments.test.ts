import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { GitStatusManager } from './gitStatusManager';
import { GitDiffManager } from './gitDiffManager';
import type { SessionManager } from './sessionManager';
import { WorktreeManager } from './worktreeManager';
import { CommandRunner } from '../utils/commandRunner';
import { PathResolver } from '../utils/pathResolver';
import type { IpcMain } from 'electron';
import type { AppServices } from '../ipc/types';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { registerGitHandlers } from '../ipc/git';
import { detectProjectConfig } from './projectConfigDetector';
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
