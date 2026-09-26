import { expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import { homedir } from 'os';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import type { AppServices } from './types';
import { PathResolver } from '../utils/pathResolver';
import { registerTerminalPathHandlers } from './terminalPaths';

function setup(wsl = false, home = '/home/linux-user\n') {
  const execFile = vi.fn(async () => ({ stdout: home, stderr: '' }));
  const pathResolver = new PathResolver({ path: '/repo', wsl_enabled: wsl, wsl_distribution: 'Ubuntu' });
  // SAFETY: These fixtures supply precisely the session/context boundary exercised by this handler.
  const services = { sessionManager: {
    getSession: () => ({ worktreePath: '/repo' }),
    getProjectContext: () => ({ pathResolver, commandRunner: { wslContext: wsl ? { distribution: 'Ubuntu' } : null, execFile } }),
  } } as AppServices;
  const registry = new PaneCommandRegistry();
  // SAFETY: Registration requires only IpcMain.handle, which this fixture implements.
  registerTerminalPathHandlers({ handle: vi.fn() } as IpcMain, services, registry);
  return { registry, execFile };
}

it('gets the daemon host home independently of the worktree directory', async () => {
  const { registry, execFile } = setup();
  expect(await registry.invoke('terminal:getPathContext', ['session'])).toEqual({
    workingDirectory: '/repo', homeDirectory: homedir(),
  });
  expect(execFile).not.toHaveBeenCalled();
});

it('uses the session distribution HOME and maps both directories for WSL', async () => {
  const { registry } = setup(true);
  expect(await registry.invoke('terminal:getPathContext', ['session'])).toEqual({
    workingDirectory: '\\\\wsl.localhost\\Ubuntu\\repo',
    homeDirectory: '\\\\wsl.localhost\\Ubuntu\\home\\linux-user',
  });
});

it('leaves home unknown when WSL cannot resolve it instead of guessing', async () => {
  const { registry, execFile } = setup(true);
  execFile.mockRejectedValue(new Error('WSL unavailable'));
  expect(await registry.invoke('terminal:getPathContext', ['session'])).toEqual({
    workingDirectory: '\\\\wsl.localhost\\Ubuntu\\repo', homeDirectory: null,
  });
  await expect(registry.invoke('terminal:getPathContext', [42])).rejects.toThrow();
});
