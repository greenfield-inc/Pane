import type { IpcMain } from 'electron';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, readdir, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { remotePaneClientController } from '../daemon/client/remotePaneClient';
import { CommandRunner } from '../utils/commandRunner';
import { isDaemonOwnedChannel } from '../../../shared/types/daemon';
import type { AppServices } from './types';
import { createDaemonBridgeRouter, registerDaemonBridgeHandlers } from './daemon';
import { registerGitHandlers } from './git';
import { registerHostFsHandlers } from './hostFs';
import { registerProjectHandlers } from './project';

const WINDOWS_PATH_MESSAGE = "That's a path on this computer; testina is a Linux host. Pick a folder on testina.";
const posixOnly = process.platform === 'win32' ? it.skip : it;

let home: string;
let gitCommands: string[];

// SAFETY: These registry tests only need IpcMain.handle for channel binding.
const ipcStub = () => ({ handle: vi.fn() } as IpcMain);

function createProjectRegistry() {
  const createProject = vi.fn((name: string, projectPath: string) => ({ id: 7, name, path: projectPath }));
  // SAFETY: The fixture provides only the services projects:create reaches.
  const services = {
    databaseService: { createProject, getAllProjects: () => [], createRunCommand: vi.fn() },
    sessionManager: {},
    worktreeManager: { getProjectMainBranch: async () => 'main' },
    configManager: { getConfig: () => ({}) },
  } as AppServices;
  const registry = new PaneCommandRegistry();
  registerProjectHandlers(ipcStub(), services, registry);
  return { registry, createProject };
}

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'pane-host-repo-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  gitCommands = [];
  vi.spyOn(CommandRunner.prototype, 'execAsync').mockImplementation(async (command: string) => {
    gitCommands.push(command);
    if (command.startsWith('git rev-parse')) throw new Error('not a git repository');
    return { stdout: '', stderr: '' };
  });
  vi.spyOn(CommandRunner.prototype, 'execFile').mockImplementation(async (_file: string, args: string[], cwd: string) => {
    gitCommands.push(`git ${args.join(' ')}`);
    return { stdout: existsSync(path.join(cwd, '.git')) ? 'true\n' : 'false\n', stderr: '' };
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

describe('projects:create on the active host', () => {
  posixOnly('rejects a Windows path without mode and creates nothing (the empty git init bug)', async () => {
    const { registry, createProject } = createProjectRegistry();
    const before = await readdir(home);

    const result = await registry.invoke('projects:create', [{
      name: 'montlakev2',
      path: 'C:\\runpane-temp-home\\montlakev2',
      hostLabel: 'testina',
    }]);

    expect(result).toEqual({ success: false, error: WINDOWS_PATH_MESSAGE, code: 'WINDOWS_PATH_ON_POSIX_HOST' });
    expect(await readdir(home)).toEqual(before);
    expect(gitCommands).toEqual([]);
    expect(createProject).not.toHaveBeenCalled();
  });

  posixOnly.each(['open', 'new'] as const)('rejects a Windows path in %s mode', async mode => {
    const { registry } = createProjectRegistry();
    await expect(registry.invoke('projects:create', [{ name: 'x', path: 'C:\\x', mode, hostLabel: 'testina' }]))
      .resolves.toMatchObject({ code: 'WINDOWS_PATH_ON_POSIX_HOST', error: WINDOWS_PATH_MESSAGE });
  });

  it('fails Open on a missing folder without mkdir or git init', async () => {
    const { registry, createProject } = createProjectRegistry();

    const result = await registry.invoke('projects:create', [{ name: 'gone', path: '~/gone', mode: 'open' }]);

    expect(result).toMatchObject({ success: false, code: 'NOT_FOUND' });
    expect(existsSync(path.join(home, 'gone'))).toBe(false);
    expect(gitCommands.filter(command => command.startsWith('git init'))).toEqual([]);
    expect(createProject).not.toHaveBeenCalled();
  });

  it('fails Open on a folder that is not a repo without git init', async () => {
    await mkdir(path.join(home, 'plain'));
    const { registry, createProject } = createProjectRegistry();

    const result = await registry.invoke('projects:create', [{ name: 'plain', path: '~/plain', mode: 'open' }]);

    expect(result).toMatchObject({ success: false, code: 'NOT_A_GIT_REPO' });
    expect(await readdir(path.join(home, 'plain'))).toEqual([]);
    expect(gitCommands.some(command => command.startsWith('git init'))).toBe(false);
    expect(createProject).not.toHaveBeenCalled();
  });

  it('registers an existing repo for Open without initializing it', async () => {
    await mkdir(path.join(home, 'repo', '.git'), { recursive: true });
    const { registry, createProject } = createProjectRegistry();
    vi.mocked(CommandRunner.prototype.execAsync).mockImplementation(async (command: string) => {
      gitCommands.push(command);
      return { stdout: 'true\n', stderr: '' };
    });

    const result = await registry.invoke('projects:create', [{ name: 'repo', path: '~/repo', mode: 'open' }]);

    expect(result).toMatchObject({ success: true });
    expect(createProject).toHaveBeenCalledWith('repo', path.join(home, 'repo'), undefined, undefined, undefined, undefined, undefined, undefined, null);
    expect(gitCommands.some(command => command.startsWith('git init'))).toBe(false);
  });

  it('creates the folder and repo for New', async () => {
    const { registry, createProject } = createProjectRegistry();

    const result = await registry.invoke('projects:create', [{ name: 'fresh', path: '~/fresh', mode: 'new' }]);

    expect(result).toMatchObject({ success: true });
    expect(existsSync(path.join(home, 'fresh'))).toBe(true);
    expect(gitCommands).toContain('git init');
    expect(createProject).toHaveBeenCalledWith('fresh', path.join(home, 'fresh'), undefined, undefined, undefined, undefined, undefined, undefined, null);
  });
});

describe('projects:validate-path', () => {
  it('reports the resolved host path without creating anything', async () => {
    const { registry } = createProjectRegistry();

    await expect(registry.invoke('projects:validate-path', [{ path: '~/fresh', mode: 'new' }]))
      .resolves.toEqual({ success: true, data: { path: path.join(home, 'fresh'), isGitRepo: false } });
    await expect(registry.invoke('projects:validate-path', [{ path: '~/fresh', mode: 'open' }]))
      .resolves.toMatchObject({ success: false, code: 'NOT_FOUND' });
    expect(existsSync(path.join(home, 'fresh'))).toBe(false);
  });
});

describe('git:clone-repo destination', () => {
  function createGitRegistry() {
    const registry = new PaneCommandRegistry();
    // SAFETY: git:clone-repo uses no app services.
    registerGitHandlers(ipcStub(), {} as AppServices, registry);
    return registry;
  }

  it('clones into the host home when no destination is given', async () => {
    const registry = createGitRegistry();

    for (const destDir of [undefined, '', '~']) {
      gitCommands = [];
      await expect(registry.invoke('git:clone-repo', ['https://github.com/acme/widgets.git', destDir]))
        .resolves.toEqual({ success: true, data: { clonedPath: path.join(home, 'widgets'), repoName: 'widgets' } });
      expect(gitCommands).toEqual([`git clone "https://github.com/acme/widgets.git" "${path.join(home, 'widgets')}"`]);
    }
  });

  it('expands ~ in the destination on the host', async () => {
    const registry = createGitRegistry();
    await expect(registry.invoke('git:clone-repo', ['https://github.com/acme/widgets.git', '~/src']))
      .resolves.toMatchObject({ success: true, data: { clonedPath: path.join(home, 'src', 'widgets') } });
  });

  posixOnly('rejects a Windows destination on a POSIX host before cloning', async () => {
    const registry = createGitRegistry();

    await expect(registry.invoke('git:clone-repo', ['https://github.com/acme/widgets.git', 'C:\\runpane-temp-home', { hostLabel: 'testina' }]))
      .resolves.toEqual({ success: false, error: WINDOWS_PATH_MESSAGE, code: 'WINDOWS_PATH_ON_POSIX_HOST' });
    expect(gitCommands).toEqual([]);
  });
});

describe('fs:* channels', () => {
  it('are daemon-owned so the renderer sends them to the active host', () => {
    expect(isDaemonOwnedChannel('fs:browse-directories')).toBe(true);
    expect(isDaemonOwnedChannel('fs:create-directory')).toBe(true);
    expect(isDaemonOwnedChannel('projects:validate-path')).toBe(true);
  });

  it('browse on the remote host daemon, not this computer, in remote mode', async () => {
    const registry = new PaneCommandRegistry();
    registerHostFsHandlers(ipcStub(), registry);
    const localBrowse = vi.spyOn(registry, 'invoke');
    const remoteListing = { success: true, data: { path: '/home/user', parent: '/home', home: '/home/user', platform: 'linux', entries: [] } };
    const remoteInvoke = vi.spyOn(remotePaneClientController, 'invoke').mockResolvedValue(remoteListing);
    vi.spyOn(remotePaneClientController, 'isRemoteModeActive').mockReturnValue(true);
    const handlers = new Map<string, (event: { readonly sender?: { readonly id?: number } }, ...args: PaneCommandValue[]) => Promise<PaneCommandValue>>();
    registerDaemonBridgeHandlers({ handle: (channel, listener) => handlers.set(channel, listener) }, createDaemonBridgeRouter(registry));

    const result = await handlers.get('daemon:invoke')?.({}, 'fs:browse-directories', { hostLabel: 'testina' });

    expect(result).toEqual(remoteListing);
    expect(remoteInvoke).toHaveBeenCalledWith('fs:browse-directories', [{ hostLabel: 'testina' }], expect.any(Function));
    expect(localBrowse).not.toHaveBeenCalled();
  });

  it('browse and create folders on this daemon in local mode', async () => {
    const registry = new PaneCommandRegistry();
    registerHostFsHandlers(ipcStub(), registry);

    await expect(registry.invoke('fs:create-directory', [{ parent: '~', name: 'projects' }]))
      .resolves.toEqual({ success: true, data: { path: path.join(home, 'projects') } });
    await expect(registry.invoke('fs:browse-directories', [{}])).resolves.toMatchObject({
      success: true,
      data: { path: home, home, entries: [{ name: 'projects', path: path.join(home, 'projects'), isGitRepo: false, isHidden: false }] },
    });
    await expect(registry.invoke('fs:browse-directories', [{ path: '~/missing' }]))
      .resolves.toMatchObject({ success: false, code: 'NOT_FOUND' });
  });
});
