import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import { registerMachineMirrorHandlers } from './machineMirror';
import type { MachineConnections } from '../services/machineConnections';
import type { MachineMirror } from '../services/machineMirror';

type Handler = (event: object, ...args: unknown[]) => unknown;

/** The mirror's handlers on a fake ipcMain, with a mirror that can appear later and a window that records what it is sent. */
function setup(machines: Partial<MachineConnections> = {}) {
  const on = new Map<string, Handler>();
  const handle = new Map<string, Handler>();
  // SAFETY: the handlers use only on and handle.
  const ipcMain = { on: (channel: string, fn: Handler) => on.set(channel, fn), handle: (channel: string, fn: Handler) => handle.set(channel, fn) } as unknown as IpcMain;
  let mirror: MachineMirror | null = null;
  // SAFETY: the handlers call only followChat on the connections.
  const handlers = registerMachineMirrorHandlers(ipcMain, () => mirror, machines as MachineConnections);
  const sent: Array<[string, unknown]> = [];
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: (channel: string, payload: unknown) => sent.push([channel, payload]) });
  let listener: ((change: { machineId: string }) => void) | undefined;
  const appear = () => {
    // SAFETY: the handlers use only subscribe and listings of the mirror.
    mirror = { subscribe: (fn: typeof listener) => { listener = fn; return () => undefined; }, listings: () => [] } as unknown as MachineMirror;
  };
  return { on, handle, handlers, contents, sent, appear, change: (machineId: string) => listener?.({ machineId }) };
}

describe('the mirror\'s renderer channels (T-116 PR 6)', () => {
  it('a window that subscribed before the mirror existed hears its changes once it does (review SF-2)', async () => {
    const { on, handle, handlers, contents, sent, appear, change } = setup();
    on.get('machine-mirror:subscribe')?.({ sender: contents }, true);
    expect(await handle.get('machine-mirror:list')?.({})).toEqual([]);

    appear();
    handlers.mirrorReady();
    change('build');

    expect(sent).toContainEqual(['machine-mirror:changed', { machineId: 'build' }]);
  });

  it('a window keeps one destroyed listener however many chats it follows, and unfollows on destroy (review SF-3)', () => {
    const stops: Array<ReturnType<typeof vi.fn>> = [];
    const { on, contents } = setup({ followChat: () => { const stop = vi.fn(); stops.push(stop); return stop; } });
    const follow = on.get('machine-chat:follow');
    for (let index = 0; index < 25; index++) {
      follow?.({ sender: contents }, { machineId: 'build', panelId: `p${index}` });
      follow?.({ sender: contents }, null);
    }
    follow?.({ sender: contents }, { machineId: 'build', panelId: 'last' });

    expect(contents.listenerCount('destroyed')).toBe(1);
    expect(stops.slice(0, 25).every(stop => stop.mock.calls.length === 1)).toBe(true);
    contents.emit('destroyed');
    expect(stops[25]).toHaveBeenCalledTimes(1);
  });
});
