import fs from 'fs';
import os from 'os';
import path from 'path';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { afterEach, expect, it, vi } from 'vitest';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { CommandRunner } from '../utils/commandRunner';
import { PathResolver } from '../utils/pathResolver';
import type { AppServices } from './types';
import { registerDashboardHandlers } from './dashboard';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

it('reports main and remote counts after one completed fetch per remote', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-dashboard-'));
  directories.push(directory);
  fs.mkdirSync(path.join(directory, '.git'));
  const project = { id: 1, name: 'Repo', path: directory };
  const runner = new CommandRunner(project);
  const context = { commandRunner: runner, pathResolver: new PathResolver(project) };
  let releaseFetch = () => {};
  const fetchGate = new Promise<void>(resolve => { releaseFetch = resolve; });
  let fetched = false;
  const commands: string[] = [];
  vi.spyOn(runner, 'execAsync').mockImplementation(async command => {
    commands.push(command);
    if (command.startsWith('git fetch ')) { await fetchGate; fetched = true; }
    const stdout = command === 'git remote -v'
      ? 'origin\t/tmp/local-origin (fetch)\n'
      : command.startsWith('git rev-list ') ? (fetched ? '0\t2' : '0\t0') : '';
    return { stdout, stderr: '' };
  });
  // SAFETY: Registration and this request use only these public service methods.
  const services = {
    databaseService: { getProject: () => project, getAllSessions: () => [] },
    sessionManager: { getProjectContextByProjectId: () => context },
    worktreeManager: { getProjectMainBranch: async () => 'main' },
  } as AppServices;
  const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>();
  const handle: IpcMain['handle'] = (channel, listener) => { handlers.set(channel, listener); };
  // SAFETY: The registrar only uses IpcMain.handle; no Electron runtime is launched.
  registerDashboardHandlers({ handle } as IpcMain, services);
  const handler = handlers.get('dashboard:get-project-status-progressive');
  if (!handler) throw new Error('Dashboard command was not registered');
  // SAFETY: This command only publishes progressive updates through sender.send.
  const event = { sender: { send: vi.fn() } } as IpcMainInvokeEvent;
  const response = handler(event, 1);
  await vi.waitFor(() => expect(commands).toContain('git fetch origin'));
  releaseFetch();
  const result = decodeBoundary(await response, boundary.object({
    success: boundary.literal(true),
    data: boundary.object({
      mainBranchStatus: boundary.object({ status: boundary.string, behindCount: boundary.optional(boundary.number) }),
      remotes: boundary.array(boundary.object({ name: boundary.string, behindCount: boundary.number })),
    }),
  }));
  expect(result.data.mainBranchStatus).toEqual({ status: 'behind', behindCount: 2 });
  expect(result.data.remotes).toEqual([{ name: 'origin', behindCount: 2 }]);
  expect(commands.filter(command => command === 'git fetch origin')).toHaveLength(1);
});
