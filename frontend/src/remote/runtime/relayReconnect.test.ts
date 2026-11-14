import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFetchEventStreamTransport } from '../../../../shared/remoteClient/fetchEventStreamTransport';
import { RemoteDaemonClient, type RemoteFetch } from '../../../../shared/remoteClient/remoteDaemonClient';
import type { RemotePaneConnectionProfile } from '../../../../shared/types/remoteDaemon';

const RELAY: RemotePaneConnectionProfile = {
  id: 'relay:abc', label: 'Studio Mac', baseUrl: 'https://abc.runpane.net', token: 't', transport: 'http+sse',
  relay: { computerId: 'abc', fingerprint: 'fp' },
};

/**
 * A computer behind Pane's servers. `frozen`: the servers take requests and answer none until they
 * resume (`kill -STOP`). `computer-away`: the servers answer, but the computer has not reconnected yet.
 */
function relayedComputer() {
  let phase: 'up' | 'frozen' | 'computer-away' = 'up';
  let parked: Array<() => void> = [];
  const answer: RemoteFetch = (url, init) => {
    const signal = init?.signal;
    if (phase === 'frozen') {
      return new Promise((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        parked.push(() => { if (!signal?.aborted) void answer(url, init).then(resolve, reject); });
      });
    }
    if (new URL(url).pathname === '/health') return Promise.resolve(Response.json({ ok: true }));
    if (phase === 'computer-away') return Promise.resolve(Response.json({ ok: false }, { status: 502 }));
    // An event stream that says ready, then stays open until the client cuts it.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: ready\ndata: {}\n\n'));
        signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
      },
    });
    return Promise.resolve(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
  };
  const client = new RemoteDaemonClient({
    profile: RELAY, transport: createFetchEventStreamTransport(answer), fetch: answer, runtimeId: () => 'runtime', clientLabel: 'Pane PWA',
  });
  const become = (next: typeof phase) => {
    phase = next;
    const waiting = parked;
    parked = [];
    for (const resume of waiting) resume();
  };
  return { client, become };
}

async function secondsUntilConnected(client: RemoteDaemonClient): Promise<number> {
  const started = Date.now();
  while (client.getState().status !== 'connected' && Date.now() - started < 120_000) {
    await vi.advanceTimersByTimeAsync(250);
  }
  return (Date.now() - started) / 1000;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a browser reaching a computer through Pane\'s servers', () => {
  it('is back within 5 s of the computer returning, however long the outage, with no tap', async () => {
    const { client, become } = relayedComputer();
    await client.connect();
    expect(await secondsUntilConnected(client)).toBeLessThan(1);

    become('frozen');
    await vi.advanceTimersByTimeAsync(75_000);
    expect(client.getState().status).toBe('reconnecting');
    // The servers resume; the computer takes a while longer to reconnect to them.
    become('computer-away');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.getState().status).toBe('reconnecting');

    become('up');
    expect(await secondsUntilConnected(client)).toBeLessThanOrEqual(5);
    client.disconnect();
  });
});
