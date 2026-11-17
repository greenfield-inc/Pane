import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { remotePaneClientController } from '../daemon/client/remotePaneClient';
import { createDaemonBridgeRouter, registerDaemonBridgeHandlers } from './daemon';

interface TestIpcEvent { readonly sender?: { readonly id?: number } }
interface IpcMainStub {
  handlers: Map<string, (_event: TestIpcEvent, ...args: PaneCommandValue[]) => Promise<PaneCommandValue>>;
  handle(channel: string, listener: (_event: TestIpcEvent, ...args: PaneCommandValue[]) => Promise<PaneCommandValue>): void;
}

function createIpcMainStub(): IpcMainStub {
  const handlers = new Map<string, (_event: TestIpcEvent, ...args: PaneCommandValue[]) => Promise<PaneCommandValue>>();

  return {
    handlers,
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
  };
}

describe('daemon IPC bridge', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards daemon-owned channels into the shared command registry', async () => {
    const registry = new PaneCommandRegistry();
    const ipcMain = createIpcMainStub();
    const handler = vi.fn(async (sessionId: string) => ({ success: true, data: sessionId }));

    registry.register('sessions:get', handler);
    registerDaemonBridgeHandlers(ipcMain, createDaemonBridgeRouter(registry));

    const bridge = ipcMain.handlers.get('daemon:invoke');
    expect(bridge).toBeDefined();

    await expect(bridge?.({}, 'sessions:get', 'session-1')).resolves.toEqual({
      success: true,
      data: 'session-1',
    });
    expect(handler).toHaveBeenCalledWith('session-1');
  });

  it('preserves structured-clone arguments and results for local handlers', async () => {
    const registry = new PaneCommandRegistry();
    const ipcMain = createIpcMainStub();
    const timestamp = new Date('2026-08-17T00:00:00.000Z');
    const handler = vi.fn(async (_sessionId: string, optionalValue?: string) => ({
      optionalValue,
      timestamp,
    }));

    registry.register('sessions:get-output', handler);
    registerDaemonBridgeHandlers(ipcMain, createDaemonBridgeRouter(registry));

    const bridge = ipcMain.handlers.get('daemon:invoke');
    const result = await bridge?.({}, 'sessions:get-output', 'session-1', undefined);

    expect(handler).toHaveBeenCalledWith('session-1', undefined);
    expect(result).toEqual({ optionalValue: undefined, timestamp });
  });

  it('rejects adapter-only channels at the bridge boundary', async () => {
    const registry = new PaneCommandRegistry();
    const ipcMain = createIpcMainStub();

    registerDaemonBridgeHandlers(ipcMain, createDaemonBridgeRouter(registry));

    const bridge = ipcMain.handlers.get('daemon:invoke');
    await expect(bridge?.({}, 'sessions:open-ide', 'session-1')).rejects.toThrow(
      'Channel "sessions:open-ide" is not daemon-owned',
    );
  });

  it('rejects malformed bridge requests before reaching the registry', async () => {
    const registry = new PaneCommandRegistry();
    const ipcMain = createIpcMainStub();

    registerDaemonBridgeHandlers(ipcMain, createDaemonBridgeRouter(registry));

    const bridge = ipcMain.handlers.get('daemon:invoke');
    await expect(bridge?.({}, 123)).rejects.toThrow('Pane daemon bridge requires a string channel');
  });

  it('routes daemon-owned invokes through the remote client controller when remote mode is active', async () => {
    const registry = new PaneCommandRegistry();
    const ipcMain = createIpcMainStub();

    vi.spyOn(remotePaneClientController, 'invoke').mockResolvedValue({ source: 'remote' });
    vi.spyOn(remotePaneClientController, 'isRemoteModeActive').mockReturnValue(true);
    registerDaemonBridgeHandlers(ipcMain, createDaemonBridgeRouter(registry));

    const bridge = ipcMain.handlers.get('daemon:invoke');
    await expect(bridge?.({}, 'sessions:get', 'session-9')).resolves.toEqual({ source: 'remote' });
    expect(remotePaneClientController.invoke).toHaveBeenCalledWith(
      'sessions:get',
      ['session-9'],
      expect.any(Function),
    );
  });

  it('answers this computer\'s own linking, routes and SSH setup locally while switched to another computer', async () => {
    const registry = new PaneCommandRegistry();
    const ipcMain = createIpcMainStub();
    registry.register('relay:redeem-link', async () => ({ linked: ['Mac'] }));
    registry.register('computers:list', async () => []);
    registry.register('ssh:route-hosts', async () => ['devbox']);

    vi.spyOn(remotePaneClientController, 'invoke').mockResolvedValue({ source: 'remote' });
    vi.spyOn(remotePaneClientController, 'isRemoteModeActive').mockReturnValue(true);
    registerDaemonBridgeHandlers(ipcMain, createDaemonBridgeRouter(registry));

    const bridge = ipcMain.handlers.get('daemon:invoke');
    await expect(bridge?.({}, 'relay:redeem-link', { link: 'https://runpane.net/pair#s=x' })).resolves.toEqual({ linked: ['Mac'] });
    await expect(bridge?.({}, 'computers:list')).resolves.toEqual([]);
    await expect(bridge?.({}, 'ssh:route-hosts')).resolves.toEqual(['devbox']);
    expect(remotePaneClientController.invoke).not.toHaveBeenCalled();
  });
});
