import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionActivity } from '../../../shared/types/orchestrationSession';
import { subscribeSessionActivity, useSessionActivityStore, type SessionActivitySource } from './sessionActivitySync';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const activity = (sessionId: string) => useSessionActivityStore.getState().activity[sessionId];

let emit: (value: SessionActivity) => void;
let resync: () => void;
let disconnect: () => void;
let reads: Array<{ resolve: (value: SessionActivity[]) => void; reject: (error: Error) => void }>;
let cleanup: () => void;

function subscribe(overrides: Partial<SessionActivitySource> = {}) {
  reads = [];
  const source: SessionActivitySource = {
    onActivity: callback => { emit = callback; return vi.fn(); },
    onResync: callback => { resync = callback; return vi.fn(); },
    onDisconnect: callback => { disconnect = callback; return vi.fn(); },
    readActivity: () => new Promise((resolve, reject) => reads.push({ resolve, reject })),
    ...overrides,
  };
  cleanup = subscribeSessionActivity(source);
}

beforeEach(() => {
  useSessionActivityStore.setState({ activity: {} });
});
afterEach(() => cleanup());

describe('Session activity sync', () => {
  it('shows what the host says from its baseline', async () => {
    subscribe();
    reads[0].resolve([{ sessionId: 's1', state: 'working', workingPanes: 2 }, { sessionId: 's2', state: 'idle', workingPanes: 0 }]);
    await flush();
    expect(activity('s1')).toEqual({ sessionId: 's1', state: 'working', workingPanes: 2 });
    expect(activity('s2')?.state).toBe('idle');
  });

  it('follows change events', async () => {
    subscribe();
    reads[0].resolve([]);
    await flush();
    emit({ sessionId: 's1', state: 'working', workingPanes: 1 });
    expect(activity('s1')?.state).toBe('working');
    emit({ sessionId: 's1', state: 'idle', workingPanes: 0 });
    expect(activity('s1')?.state).toBe('idle');
  });

  it('keeps an event that arrives while the baseline is being read', async () => {
    subscribe();
    emit({ sessionId: 's1', state: 'idle', workingPanes: 0 });
    reads[0].resolve([{ sessionId: 's1', state: 'working', workingPanes: 1 }]);
    await flush();
    expect(activity('s1')?.state).toBe('idle');
  });

  it('replaces everything it had on a resync, so a turn that ended while disconnected reads idle', async () => {
    subscribe();
    reads[0].resolve([{ sessionId: 's1', state: 'working', workingPanes: 1 }, { sessionId: 'gone', state: 'working', workingPanes: 1 }]);
    await flush();
    resync();
    reads[1].resolve([{ sessionId: 's1', state: 'idle', workingPanes: 0 }]);
    await flush();
    expect(activity('s1')?.state).toBe('idle');
    expect(activity('gone')).toBeUndefined();
  });

  it('shows idle while the host is unreachable, not its last state, and reads it again on reconnect', async () => {
    subscribe();
    reads[0].resolve([{ sessionId: 's1', state: 'working', workingPanes: 1 }]);
    await flush();
    resync();
    disconnect();
    expect(activity('s1')).toBeUndefined();
    // A read that was in flight when the connection dropped answers from before the drop.
    reads[1].resolve([{ sessionId: 's1', state: 'working', workingPanes: 1 }]);
    await flush();
    expect(activity('s1')).toBeUndefined();
    resync();
    reads[2].resolve([{ sessionId: 's1', state: 'working', workingPanes: 1 }]);
    await flush();
    expect(activity('s1')?.state).toBe('working');
  });

  it('shows idle, with no error, for a host that does not have the read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    useSessionActivityStore.setState({ activity: { s1: { sessionId: 's1', state: 'working', workingPanes: 1 } } });
    subscribe({ readActivity: undefined });
    await flush();
    expect(activity('s1')).toBeUndefined();
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
    warn.mockRestore();
  });

  it('clears what it showed when it unsubscribes, as on a host switch', async () => {
    subscribe();
    reads[0].resolve([{ sessionId: 's1', state: 'working', workingPanes: 1 }]);
    await flush();
    cleanup();
    expect(activity('s1')).toBeUndefined();
    cleanup = () => undefined;
  });

  it('drops a malformed event rather than show it', async () => {
    subscribe();
    reads[0].resolve([]);
    await flush();
    // An old or foreign host can send anything on the channel.
    const malformed = JSON.parse('{"sessionId":"s1","state":"busy","workingPanes":1}');
    emit(malformed);
    expect(activity('s1')).toBeUndefined();
  });
});
