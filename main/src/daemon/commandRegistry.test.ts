import { describe, expect, it } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { PaneCommandRegistry, type PaneCommandValue } from './commandRegistry';

describe('PaneCommandRegistry', () => {
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

  it('tracks in-flight calls per origin and when the last one ended', async () => {
    let now = 1_000;
    const registry = new PaneCommandRegistry(() => now);
    let release: () => void = () => {};
    registry.register('runpane:workspace:wait', () => new Promise<null>((resolve) => {
      release = () => resolve(null);
    }));

    const userCall = registry.invoke('runpane:workspace:wait', [], { origin: 'remote-user' });
    expect(registry.getChannelActivity('runpane:workspace:wait', ['local', 'remote-user'])).toEqual({
      inFlight: 1,
      lastFinishedAt: undefined,
    });
    expect(registry.getChannelActivity('runpane:workspace:wait', ['remote-peer']).inFlight).toBe(0);

    now = 2_500;
    release();
    await userCall;
    expect(registry.getChannelActivity('runpane:workspace:wait', ['remote-user'])).toEqual({
      inFlight: 0,
      lastFinishedAt: 2_500,
    });
  });

  it('counts a failed call as finished', async () => {
    const registry = new PaneCommandRegistry(() => 7);
    registry.register('runpane:panels:wait', () => {
      throw new Error('boom');
    });

    await expect(registry.invoke('runpane:panels:wait')).rejects.toThrow('boom');
    expect(registry.getChannelActivity('runpane:panels:wait', ['local'])).toEqual({ inFlight: 0, lastFinishedAt: 7 });
  });
});
