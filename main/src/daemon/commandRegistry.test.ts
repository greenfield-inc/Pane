import { describe, expect, it } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { PaneCommandRegistry, isRemotePaneCommand, type PaneCommandValue } from './commandRegistry';

describe('PaneCommandRegistry', () => {
  it('keeps remote provenance through async handlers without affecting concurrent local calls', async () => {
    const registry = new PaneCommandRegistry();
    registry.register('panels:origin', async () => {
      await Promise.resolve();
      return isRemotePaneCommand();
    });
    expect(await Promise.all([
      registry.invokeRemote('panels:origin'), registry.invoke('panels:origin'),
    ])).toEqual([true, false]);
  });
  it('registers and invokes daemon-owned commands', async () => {
    const registry = new PaneCommandRegistry();
    registry.register('folders:get-by-project', async (projectId: number) => ({ projectId }));

    await expect(registry.invoke('folders:get-by-project', [42])).resolves.toEqual({ projectId: 42 });
  });

  it('rejects non-daemon-owned channels', () => {
    const registry = new PaneCommandRegistry();

    expect(() => registry.register('openExternal', () => true)).toThrow(
      'Cannot register non-daemon-owned channel "openExternal" in PaneCommandRegistry',
    );
  });

  it('rejects duplicate registrations', () => {
    const registry = new PaneCommandRegistry();
    registry.register('logs:get-by-project', () => []);

    expect(() => registry.register('logs:get-by-project', () => [])).toThrow(
      'Pane daemon command "logs:get-by-project" is already registered',
    );
  });

  it('throws when invoking an unregistered command', async () => {
    const registry = new PaneCommandRegistry();

    await expect(registry.invoke('folders:get-by-project', [1])).rejects.toThrow(
      'No Pane daemon command registered for channel "folders:get-by-project"',
    );
  });

  it('binds registered commands back to IPC handles', async () => {
    const registry = new PaneCommandRegistry();
    const bound = new Map<string, (
      _event: IpcMainInvokeEvent,
      ...args: PaneCommandValue[]
    ) => Promise<PaneCommandValue> | PaneCommandValue>();
    const ipcMain = {
      handle(
        channel: string,
        listener: (_event: IpcMainInvokeEvent, ...args: PaneCommandValue[]) => Promise<PaneCommandValue> | PaneCommandValue,
      ) {
        bound.set(channel, listener);
      },
    };

    registry.register('resource-monitor:get-snapshot', async () => ({ success: true }));
    registry.bindChannels(ipcMain, ['resource-monitor:get-snapshot']);

    const listener = bound.get('resource-monitor:get-snapshot');
    expect(listener).toBeTruthy();
    if (!listener) {
      throw new Error('Expected IPC listener to be bound');
    }
    const testEvent: IpcMainInvokeEvent = Object.create(null);
    await expect(listener(testEvent)).resolves.toEqual({ success: true });
  });
});
