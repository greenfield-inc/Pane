import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron';
import { registerMachineMirrorHandlers } from './machineMirror';
import type { MachineConnections } from '../services/machineConnections';
import type { MachineMirror } from '../services/machineMirror';
import type { MachineMirrorListing } from '../../../shared/types/machineMirror';
import type { SessionSnapshot } from '../../../shared/types/sessionSnapshot';
import type { MachineConnectionsEvent } from '../../../shared/types/machineConnections';

function partial<Contract>(value: Partial<Contract>): Contract {
  // SAFETY: each fixture supplies every member the mirror's handlers read.
  return value as Contract;
}

type OnHandler = (event: IpcMainEvent, ...args: Array<string | boolean | object | null>) => void;
type InvokeHandler = (event: IpcMainInvokeEvent, ...args: string[]) => MachineMirrorListing[] | Promise<MachineMirrorListing[] | SessionSnapshot | null>;

/** The mirror's handlers on a fake ipcMain, with a mirror that can appear later and a window that records what it is sent. */
function setup(machines: Partial<MachineConnections> = {}, local?: Parameters<typeof registerMachineMirrorHandlers>[3]) {
  const on = new Map<string, OnHandler>();
  const handle = new Map<string, InvokeHandler>();
  const ipcMain = partial<IpcMain>({
    on: (channel: string, fn: OnHandler) => { on.set(channel, fn); return ipcMain; },
    handle: (channel: string, fn: InvokeHandler) => { handle.set(channel, fn); },
  });
  let mirror: MachineMirror | null = null;
  const handlers = registerMachineMirrorHandlers(ipcMain, () => mirror, partial<MachineConnections>(machines), local);
  const sent: Array<[string, { machineId: string }]> = [];
  const emitter = new EventEmitter();
  const contents = Object.assign(emitter, partial<WebContents>({ isDestroyed: () => false, send: (channel: string, payload: { machineId: string }) => { sent.push([channel, payload]); } }));
  const event = partial<IpcMainEvent>({ sender: partial<WebContents>(contents) });
  let listener: ((change: { machineId: string }) => void) | undefined;
  const appear = () => {
    mirror = partial<MachineMirror>({ subscribe: fn => { listener = fn; return () => undefined; }, listings: () => [] });
  };
  return { on, handle, handlers, emitter, event, sent, appear, change: (machineId: string) => listener?.({ machineId }) };
}

describe('the mirror\'s renderer channels (T-116 PR 6)', () => {
  it('a window that subscribed before the mirror existed hears its changes once it does (review SF-2)', async () => {
    const { on, handle, handlers, event, sent, appear, change } = setup();
    on.get('machine-mirror:subscribe')?.(event, true);
    await expect(handle.get('machine-mirror:list')?.(partial<IpcMainInvokeEvent>({}))).resolves.toEqual([]);

    appear();
    handlers.mirrorReady();
    change('build');

    expect(sent).toContainEqual(['machine-mirror:changed', { machineId: 'build' }]);
  });

  it('a window keeps one destroyed listener however many chats it follows, and unfollows on destroy (review SF-3)', () => {
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    const { on, emitter, event } = setup({ followChat: () => { const stop = vi.fn(); stops.push(stop); return stop; } });
    const follow = on.get('machine-chat:follow');
    for (let index = 0; index < 25; index++) {
      follow?.(event, { machineId: 'build', panelId: `p${index}` });
      follow?.(event, null);
    }
    follow?.(event, { machineId: 'build', panelId: 'last' });

    expect(emitter.listenerCount('destroyed')).toBe(1);
    expect(stops.slice(0, 25).every(stop => stop.mock.calls.length === 1)).toBe(true);
    emitter.emit('destroyed');
    expect(stops[25]).toHaveBeenCalledTimes(1);
  });

  it('lists this computer beside the mirrored machines and reads its Sessions, for its rows in a window on another machine (D-20)', async () => {
    // SAFETY: the handlers read only a snapshot's session id and revision here.
    const snapshot = { sessionId: 'a', revision: 7 } as SessionSnapshot;
    let notice: ((event: MachineConnectionsEvent) => void) | undefined;
    const { on, handle, event, sent, appear } = setup(
      { subscribe: fn => { notice = fn; return () => undefined; } },
      { index: async () => [{ sessionId: 'a', revision: 7 }], snapshot: async id => (id === 'a' ? snapshot : undefined) },
    );
    appear();
    on.get('machine-mirror:subscribe')?.(event, true);

    const listed = await handle.get('machine-mirror:list')?.(partial<IpcMainInvokeEvent>({}));
    expect(listed).toEqual([{ state: expect.objectContaining({ machineId: 'local', sync: 'live', sessionCount: 1 }), sessions: { a: 7 } }]);
    await expect(handle.get('machine-mirror:session')?.(partial<IpcMainInvokeEvent>({}), 'local', 'a')).resolves.toBe(snapshot);

    notice?.({ type: 'event', machineId: 'local', channel: 'session-snapshot:changed', args: [{ sessionId: 'a', revision: 8 }] });
    expect(sent).toContainEqual(['machine-mirror:changed', { machineId: 'local' }]);
  });
});
