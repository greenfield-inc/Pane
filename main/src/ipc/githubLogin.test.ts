import type { IpcMain } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { remotePaneClientController } from '../daemon/client/remotePaneClient';
import { isDaemonOwnedChannel } from '../../../shared/types/daemon';
import { createDaemonBridgeRouter, registerDaemonBridgeHandlers } from './daemon';
import { registerGitHubLoginHandlers } from './githubLogin';

// SAFETY: Registry binding only needs IpcMain.handle.
const ipcStub = () => ({ handle: vi.fn() } as IpcMain);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('github:device-login-* channels', () => {
  it.each(['github:device-login-start', 'github:device-login-status', 'github:device-login-cancel'])(
    '%s is daemon-owned so the renderer sends it to the active host',
    channel => {
      expect(isDaemonOwnedChannel(channel)).toBe(true);
    },
  );

  it('run on the remote host daemon, not this computer, in remote mode', async () => {
    const registry = new PaneCommandRegistry();
    registerGitHubLoginHandlers(ipcStub(), registry);
    const localInvoke = vi.spyOn(registry, 'invoke');
    const remoteState = { success: true, data: { status: 'starting', loginId: 'login-1' } };
    const remoteInvoke = vi.spyOn(remotePaneClientController, 'invoke').mockResolvedValue(remoteState);
    vi.spyOn(remotePaneClientController, 'isRemoteModeActive').mockReturnValue(true);
    const handlers = new Map<string, (event: { readonly sender?: { readonly id?: number } }, ...args: PaneCommandValue[]) => Promise<PaneCommandValue>>();
    registerDaemonBridgeHandlers({ handle: (channel, listener) => handlers.set(channel, listener) }, createDaemonBridgeRouter(registry));

    const result = await handlers.get('daemon:invoke')?.({}, 'github:device-login-start', { hostLabel: 'sandbox-1' });

    expect(result).toEqual(remoteState);
    expect(remoteInvoke).toHaveBeenCalledWith('github:device-login-start', [{ hostLabel: 'sandbox-1' }], expect.any(Function));
    expect(localInvoke).not.toHaveBeenCalled();
  });

  it('report idle before any sign-in', async () => {
    const registry = new PaneCommandRegistry();
    registerGitHubLoginHandlers(ipcStub(), registry);
    await expect(registry.invoke('github:device-login-status', [])).resolves.toEqual({ success: true, data: { status: 'idle' } });
    await expect(registry.invoke('github:device-login-cancel', [])).resolves.toEqual({ success: true, data: { status: 'idle' } });
  });
});
