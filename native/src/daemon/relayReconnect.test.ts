import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { connectionNotice, createFetchEventStreamTransport, RemoteDaemonClient } from '@shared/remoteClient';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';

const TAILSCALE: RemotePaneConnectionProfile = { id: 'ts', label: 'Studio Mac', baseUrl: 'https://studio.tail1.ts.net', token: 't', transport: 'http+sse' };
const RELAY: RemotePaneConnectionProfile = {
  id: 'relay:abc', label: 'Studio Mac', baseUrl: 'https://abc.runpane.net', token: 't', transport: 'http+sse',
  relay: { computerId: 'abc', fingerprint: 'fp' },
};

/** A computer whose /health answers and whose /events stream answers with `eventsStatus`. */
function host(eventsStatus: number) {
  const events: number[] = [];
  const fetch = vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === '/health') return Response.json({ ok: true });
    events.push(Date.now());
    return Response.json({ ok: false }, { status: eventsStatus });
  });
  return { fetch, events };
}

function client(profile: RemotePaneConnectionProfile, fetch: ReturnType<typeof host>['fetch']) {
  return new RemoteDaemonClient({
    profile,
    transport: createFetchEventStreamTransport(fetch),
    fetch,
    runtimeId: () => 'runtime',
    clientLabel: 'Pane for iOS',
  });
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

describe('reconnecting to a computer through a relay (D-15)', () => {
  it('gives up on a Tailscale computer after five minutes', async () => {
    const down = host(503);
    const tailscale = client(TAILSCALE, down.fetch);
    await tailscale.connect();
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(tailscale.getState().status).toBe('error');
  });

  it('keeps retrying a relay computer, at most 30 s apart, for as long as the app is open', async () => {
    const down = host(503);
    const relay = client(RELAY, down.fetch);
    await relay.connect();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(relay.getState().status).toBe('reconnecting');
    const gaps = down.events.slice(1).map((at, index) => at - (down.events[index] ?? at));
    expect(Math.max(...gaps)).toBeLessThanOrEqual(30_000);
    expect(down.events.length).toBeGreaterThan(100);
    relay.disconnect();
  });

  it('stops at once and asks to pair again when the computer refuses the token', async () => {
    const removed = host(401);
    const relay = client(RELAY, removed.fetch);
    await relay.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(relay.getState().status).toBe('error');
    expect(connectionNotice(relay.getState(), 0, 'Studio Mac', { asleepSince: null })).toMatchObject({ pairAgain: true, canRetry: false });
  });

  it('says a sleeping computer is asleep instead of unreachable', () => {
    const notice = connectionNotice({ status: 'reconnecting', lastError: 'down' }, 10_000, 'Studio Mac', { asleepSince: '9:40' });
    expect(notice?.message).toBe('Studio Mac: Asleep since 9:40');
  });
});
