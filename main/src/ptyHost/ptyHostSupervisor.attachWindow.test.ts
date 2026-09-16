import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PtyHostSupervisor } from './ptyHostSupervisor';
import { MessageChannelMain, type FakeMessagePortMain } from '../test/setup';

/**
 * `attachWindow` is the only thing that gives a renderer its ptyHost data port.
 * If it never runs — or early-returns on a reload whose preload has already
 * dropped its port reference — `electronAPI.ptyHost.onData` has no source and
 * every ptyHost-spawned terminal renders one frame and then goes silent.
 */
function createPortTargetStub(id: number) {
  return {
    id,
    postMessage: vi.fn<(channel: string, message: null, transfer?: FakeMessagePortMain[]) => void>(),
    once: vi.fn<(event: 'destroyed', listener: () => void) => void>(),
  };
}

type PortTargetStub = ReturnType<typeof createPortTargetStub>;

function transferredPort(target: PortTargetStub, call: number): FakeMessagePortMain {
  const [channel, payload, ports] = target.postMessage.mock.calls[call];
  expect(channel).toBe('ptyHost-port');
  expect(payload).toBeNull();
  const port = ports?.[0];
  if (!port) throw new Error(`attachWindow transferred no port on call ${call}`);
  return port;
}

describe('PtyHostSupervisor.attachWindow', () => {
  beforeEach(() => {
    MessageChannelMain.instances.length = 0;
  });

  it('hands the renderer one end of a started port pair', () => {
    const supervisor = new PtyHostSupervisor();
    const target = createPortTargetStub(1);

    supervisor.attachWindow(target);

    expect(target.postMessage).toHaveBeenCalledTimes(1);
    const [channel] = MessageChannelMain.instances;
    // The renderer receives port2; main keeps port1 and must start it before
    // renderer ack/write frames can be read.
    expect(transferredPort(target, 0)).toBe(channel.port2);
    expect(channel.port1.started).toBe(true);
    expect(channel.port1.listeners.get('message')).toHaveLength(1);
  });

  it('replaces the stale pair when the same window loads again', () => {
    const supervisor = new PtyHostSupervisor();
    const target = createPortTargetStub(2);

    supervisor.attachWindow(target);
    const firstPort = transferredPort(target, 0);

    // A reload keeps `webContents.id` but re-runs preload, so the renderer no
    // longer holds the first port. Returning early here is what left the window
    // permanently without a data source.
    supervisor.attachWindow(target);

    expect(target.postMessage).toHaveBeenCalledTimes(2);
    const secondPort = transferredPort(target, 1);
    expect(secondPort).not.toBe(firstPort);
    expect(firstPort.closed).toBe(true);
    expect(secondPort.closed).toBe(false);
  });

  it('routes data frames to the newest main-side port only', () => {
    const supervisor = new PtyHostSupervisor();
    const target = createPortTargetStub(3);

    supervisor.attachWindow(target);
    supervisor.attachWindow(target);
    const [first, second] = MessageChannelMain.instances;

    supervisor.postDataToRenderers('pty-3', 'out');

    expect(first.port1.posted).toHaveLength(0);
    expect(second.port1.posted).toEqual([{ type: 'data', ptyId: 'pty-3', data: 'out' }]);
  });

  it('registers the destroy cleanup once across repeated loads', () => {
    const supervisor = new PtyHostSupervisor();
    const target = createPortTargetStub(4);

    supervisor.attachWindow(target);
    supervisor.attachWindow(target);
    supervisor.attachWindow(target);

    expect(target.once).toHaveBeenCalledTimes(1);
    expect(target.once.mock.calls[0][0]).toBe('destroyed');
  });
});
