import type { IpcMain } from 'electron';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { WorktreeManager } from '../services/worktreeManager';
import { CommandRunner } from '../utils/commandRunner';
import { PathResolver } from '../utils/pathResolver';
import type { AppServices } from './types';
import { registerGitHandlers } from './git';

let repo: string;
let runner: CommandRunner;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'pane-abort-rebase-'));
  runner = new CommandRunner({ path: repo });
  await runner.execFile('git', ['init', '--initial-branch=main'], repo);
  await runner.execFile('git', ['config', 'user.name', 'Test User'], repo);
  await runner.execFile('git', ['config', 'user.email', 'test@example.com'], repo);
  await runner.execFile('git', ['config', 'commit.gpgsign', 'false'], repo);
  await runner.execFile('git', ['config', 'core.autocrlf', 'false'], repo);
  await writeFile(join(repo, 'example.txt'), 'base\n');
  await runner.execFile('git', ['add', '-A'], repo);
  await runner.execFile('git', ['commit', '-m', 'Base'], repo);
  await runner.execFile('git', ['checkout', '-b', 'feature'], repo);
  await writeFile(join(repo, 'example.txt'), 'feature\n');
  await runner.execFile('git', ['commit', '-am', 'Feature'], repo);
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

async function conflictingRebase(): Promise<void> {
  await runner.execFile('git', ['checkout', 'main'], repo);
  await writeFile(join(repo, 'example.txt'), 'main\n');
  await runner.execFile('git', ['commit', '-am', 'Main'], repo);
  await runner.execFile('git', ['checkout', 'feature'], repo);
  await expect(runner.execFile('git', ['rebase', 'main'], repo)).rejects.toThrow();
}

function registeredHandler(baseBranch = 'main', projectPath = repo) {
  const session = { id: 'test-session', worktreePath: repo, baseBranch };
  const project = { id: 1, path: projectPath, name: 'Test' };
  const launchedFiles: string[] = [];
  const prompts: string[] = [];
  const startSession = async (_id: string, _cwd: string, prompt: string) => {
    launchedFiles.push(await readFile(join(repo, 'example.txt'), 'utf8'));
    prompts.push(prompt);
  };
  // SAFETY: This fixture implements the service members used by the registered abort-rebase handler.
  const services = {
    sessionManager: {
      getSession: () => session,
      getProjectForSession: () => project,
      getProjectContext: () => ({ project, commandRunner: runner, pathResolver: new PathResolver(project) }),
      addSessionOutput: vi.fn(),
    },
    worktreeManager: new WorktreeManager(),
    claudeCodeManager: { startSession },
  } as AppServices;
  // SAFETY: Registration only uses IpcMain.handle to bind daemon channels in this test.
  const ipc = { handle: vi.fn() } as IpcMain;
  const registry = new PaneCommandRegistry();
  registerGitHandlers(ipc, services, registry);
  return { registry, launchedFiles, prompts };
}

it('aborts a conflicting rebase before starting the resolution agent', async () => {
  await conflictingRebase();
  const { registry, launchedFiles } = registeredHandler();
  await expect(registry.invoke('sessions:abort-rebase-and-use-claude', ['test-session'])).resolves.toMatchObject({ success: true });
  expect(launchedFiles).toEqual(['feature\n']);
  const branch = await runner.execFile('git', ['branch', '--show-current'], repo);
  expect(branch.stdout.trim()).toBe('feature');
});

it('starts the agent when no rebase was started', async () => {
  const { registry, launchedFiles } = registeredHandler();
  await expect(registry.invoke('sessions:abort-rebase-and-use-claude', ['test-session'])).resolves.toMatchObject({ success: true });
  expect(launchedFiles).toEqual(['feature\n']);
});

it('reports an abort failure and leaves the agent stopped', async () => {
  await conflictingRebase();
  await writeFile(join(repo, '.git', 'index.lock'), '');
  const { registry, launchedFiles } = registeredHandler();
  await expect(registry.invoke('sessions:abort-rebase-and-use-claude', ['test-session'])).resolves.toMatchObject({
    success: false,
    error: expect.stringContaining('index.lock'),
  });
  expect(launchedFiles).toEqual([]);
});

it('resolves the main comparison branch after restoring an existing feature branch', async () => {
  await conflictingRebase();
  const baseWorktree = join(repo, 'base-worktree');
  await runner.execFile('git', ['worktree', 'add', baseWorktree, 'main'], repo);
  const { registry, prompts } = registeredHandler('feature', baseWorktree);
  await expect(registry.invoke('sessions:abort-rebase-and-use-claude', ['test-session'])).resolves.toMatchObject({ success: true });
  expect(prompts).toEqual(['Please rebase main into this branch and resolve all conflicts']);
});
