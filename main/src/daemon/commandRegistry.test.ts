import { describe, expect, it } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { PaneCommandRegistry, isRemotePaneCommand, rejectWithPaneErrorText, type PaneCommandValue } from './commandRegistry';
import { PaneError } from '../../../shared/paneError';
import { runpaneWaits } from '../services/agentStatus/midTurn';

describe('PaneCommandRegistry', () => {
  it('marks the caller tab waiting while a runpane watch, panels wait or notify call is open', async () => {
    const registry = new PaneCommandRegistry();
    const finish: Array<() => void> = [];
    for (const channel of ['runpane:workspace:wait', 'runpane:panels:wait', 'runpane:notify']) {
      registry.register(channel, () => new Promise<void>(resolve => { finish.push(resolve); }));
    }
    registry.register('runpane:panels:list', () => []);
    const caller = { paneId: 'pane', panelId: 'tab' };
    const signal = new AbortController().signal;

    await registry.invokeConnected('runpane:panels:list', [], signal, caller);
    expect(runpaneWaits.isWaiting('tab')).toBe(false);
    const calls = ['runpane:workspace:wait', 'runpane:panels:wait', 'runpane:notify'].map(channel => registry.invokeConnected(channel, [], signal, caller));
    await Promise.resolve();
    expect(runpaneWaits.isWaiting('tab')).toBe(true);
    finish[0]();
    finish[1]();
    await Promise.all(calls.slice(0, 2));
    expect(runpaneWaits.isWaiting('tab')).toBe(true);
    finish[2]();
    await Promise.all(calls);
    expect(runpaneWaits.isWaiting('tab')).toBe(false);
  });
  it('stops marking a tab waiting the moment its caller disconnects, and after a call fails', async () => {
    const registry = new PaneCommandRegistry();
    registry.register('runpane:workspace:wait', () => new Promise<void>(() => undefined));
    registry.register('runpane:panels:wait', () => Promise.reject(new Error('no such panel')));
    const lifetime = new AbortController();
    void registry.invokeConnected('runpane:workspace:wait', [], lifetime.signal, { panelId: 'gone' });
    await Promise.resolve();
    expect(runpaneWaits.isWaiting('gone')).toBe(true);
    lifetime.abort();
    expect(runpaneWaits.isWaiting('gone')).toBe(false);
    await expect(registry.invokeConnected('runpane:panels:wait', [], new AbortController().signal, { panelId: 'failed' })).rejects.toThrow('no such panel');
    expect(runpaneWaits.isWaiting('failed')).toBe(false);
  });
  it('holds commands until startup work ends, except the ones allowed to run early', async () => {
    const registry = new PaneCommandRegistry();
    const ran: string[] = [];
    registry.register('runpane:panes:list', () => { ran.push('runpane:panes:list'); return []; });
    registry.register('panels:initialize', (panelId: PaneCommandValue) => { ran.push(`panels:initialize ${String(panelId)}`); return true; });
    let finishStartup!: () => void;
    registry.holdUntil(new Promise<void>(resolve => { finishStartup = resolve; }), (channel, args) => channel === 'panels:initialize' && args[0] === 'plain');

    const held = registry.invoke('runpane:panes:list');
    const heldPanel = registry.invoke('panels:initialize', ['agent']);
    await expect(registry.invoke('panels:initialize', ['plain'])).resolves.toBe(true);
    // A channel registered after the hold began still waits for it rather than failing as unknown.
    const lateRegistered = registry.invoke('ports:list');
    registry.register('ports:list', () => { ran.push('ports:list'); return []; });
    expect(ran).toEqual(['panels:initialize plain']);

    finishStartup();
    await Promise.all([held, heldPanel, lateRegistered]);
    expect(ran).toEqual(['panels:initialize plain', 'runpane:panes:list', 'panels:initialize agent', 'ports:list']);
  });
  it('releases held commands when startup work fails', async () => {
    const registry = new PaneCommandRegistry();
    registry.register('runpane:panes:list', () => []);
    registry.holdUntil(Promise.reject(new Error('skills could not be copied')), () => false);
    await expect(registry.invoke('runpane:panes:list')).resolves.toEqual([]);
  });
  it('keeps a PaneError\'s code in the text Electron IPC sends, as Node does for coded errors', async () => {
    const rejected = await rejectWithPaneErrorText(Promise.reject(new PaneError('CHAT_SWITCH_FAILED', 'The chat did not open.', 'Try again.'))).then(() => new Error('resolved'), (error: Error) => error);
    // Electron replies with error.toString(); the renderer reads the code back from it.
    expect(String(rejected)).toBe('Error [CHAT_SWITCH_FAILED]: The chat did not open. Next: Try again.');
    expect(rejected.message).toBe('The chat did not open. Next: Try again.');
  });
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
  it('fences new mutations and waits for existing work before update quiescence', async () => {
    const registry = new PaneCommandRegistry();
    let finish!: () => void;
    registry.register('panels:create', () => new Promise<void>(resolve => { finish = resolve; }));
    registry.register('panels:list', () => []);
    const pending = registry.invoke('panels:create');
    let settled = false;
    const quiescing = registry.quiesceForUpdate().then(() => { settled = true; });
    await expect(registry.invoke('panels:create')).rejects.toMatchObject({ code: 'ERR_UPDATE_QUIESCING' });
    expect(settled).toBe(false);
    await expect(registry.invoke('panels:list')).resolves.toEqual([]);
    finish(); await pending; await quiescing;
    expect(settled).toBe(true);
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
