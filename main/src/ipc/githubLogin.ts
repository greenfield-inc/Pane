import type { IpcMain } from 'electron';
import type { PaneCommandRegistry } from '../daemon/commandRegistry';
import { createGhSpawner, GitHubDeviceLogin } from '../services/githubDeviceLogin';
import { getShellPath } from '../utils/shellPath';
import type { GitHubDeviceLoginStartRequest } from '../../../shared/types/githubDeviceLogin';

const DAEMON_GITHUB_LOGIN_CHANNELS = [
  'github:device-login-start',
  'github:device-login-status',
  'github:device-login-cancel',
] as const;

/**
 * Sign the active host in to GitHub with gh's device flow. These run on that
 * host's daemon; the renderer shows the code and opens the approval page on
 * the user's own computer. Never log these results: they carry the code.
 */
export function registerGitHubLoginHandlers(
  ipcMain: IpcMain,
  commandRegistry: PaneCommandRegistry,
  login = new GitHubDeviceLogin({ spawnGh: createGhSpawner({ ...process.env, PATH: getShellPath() }) }),
): void {
  commandRegistry.register('github:device-login-start', async (request?: GitHubDeviceLoginStartRequest) => (
    { success: true, data: login.start(request ?? {}) }
  ));
  commandRegistry.register('github:device-login-status', async () => ({ success: true, data: login.getState() }));
  commandRegistry.register('github:device-login-cancel', async () => ({ success: true, data: login.cancel() }));

  commandRegistry.bindChannels(ipcMain, DAEMON_GITHUB_LOGIN_CHANNELS);
}
