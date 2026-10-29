import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RemoteAuthError,
  RemoteDaemonClient,
  RemoteRequestError,
  RemoteUnconfirmedResultError,
  createFetchEventStreamTransport,
  decodeRemoteConnectionCode,
  getOrCreateRuntimeId,
  loadRemoteProfiles,
  saveRemoteProfiles,
  type RemoteDaemonClientEvent,
  type RemoteKeyValueStorage,
} from '../../../shared/remoteClient';
import type { PaneRemoteConnectionImportPayload } from '../../../shared/types/remoteDaemon';

const PROFILE = {
  id: 'profile-1',
  label: 'Remote Host',
  baseUrl: 'https://host.example.test',
  token: 'secret-token',
  transport: 'http+sse' as const,
};

interface RecordedRequest {
  url: string;
  init?: RequestInit;
}

/** A host whose `/events` responses are streams the test writes into. */
function createFakeHost() {
  const requests: RecordedRequest[] = [];
  const streams: Array<ReadableStreamDefaultController<Uint8Array>> = [];
  let eventsStatus = 200;
  let sendReady = true;
  let hangEvents = false;
  let hostDown = false;
  let invokeHandler: (body: { channel: string; args: unknown[] }) => Response | Promise<Response> = () =>
    Response.json({ ok: true, result: null });

  const fetch = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    requests.push({ url, init });
    const path = new URL(url).pathname;
    if (hostDown) throw new TypeError('Network request failed');
    if (path === '/health') return Response.json({ ok: true });
    if (path === '/invoke') return invokeHandler(JSON.parse(String(init?.body)));
    if (path === '/events') {
      // Like a half-dead mobile socket: no headers, and aborting does not settle it.
      if (hangEvents) return new Promise<Response>(() => {});
      if (eventsStatus !== 200) return Response.json({ ok: false }, { status: eventsStatus });
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          streams.push(controller);
          if (sendReady) controller.enqueue(new TextEncoder().encode('event: ready\ndata: {"replay":"none"}\n\n'));
        },
      });
      init?.signal?.addEventListener('abort', () => {
        try { streams.at(-1)?.error(new DOMException('Aborted', 'AbortError')); } catch { /* closed */ }
      });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return new Response('not found', { status: 404 });
  });

  return {
    fetch,
    requests,
    get streamCount() { return streams.length; },
    write(text: string) { streams.at(-1)?.enqueue(new TextEncoder().encode(text)); },
    writeBytes(bytes: Uint8Array) { streams.at(-1)?.enqueue(bytes); },
    end() { streams.at(-1)?.close(); },
    sendReady(value: boolean) { sendReady = value; },
    rejectEvents(status: number) { eventsStatus = status; },
    hangEvents(hang: boolean) { hangEvents = hang; },
    goDown(down: boolean) { hostDown = down; },
    onInvoke(handler: typeof invokeHandler) { invokeHandler = handler; },
  };
}

function createClient(host: ReturnType<typeof createFakeHost>, staleStreamTimeoutMs?: number) {
  return new RemoteDaemonClient({
    profile: PROFILE,
    transport: createFetchEventStreamTransport(host.fetch),
    fetch: host.fetch,
    runtimeId: async () => 'runtime-1',
    clientLabel: 'Pane for iOS',
    staleStreamTimeoutMs,
  });
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('RemoteDaemonClient with the fetch event stream transport', () => {
  it.each(['suspend', 'retry'] as const)('does not dispatch an admitted mutation after %s retires its stream', async transition => {
    const host = createFakeHost();
    const client = createClient(host);
    await client.connect();
    await flush();
    expect(client.getState().status).toBe('connected');
    const pending = client.invoke('panels:create', ['session-1']);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'ERR_REMOTE_OFFLINE' });
    if (transition === 'suspend') client.suspend();
    else client.retryNow();
    await rejected;
    expect(host.requests.filter(request => request.url.endsWith('/invoke'))).toHaveLength(0);
    client.disconnect();
  });

  it('sends the token only in the Authorization header', async () => {
    const host = createFakeHost();
    const client = createClient(host);
    await client.connect();
    await flush();
    await client.invoke('panels:list', ['session-1']);

    for (const { url, init } of host.requests) {
      expect(url).not.toContain('secret-token');
      expect(String(init?.body ?? '')).not.toContain('secret-token');
    }
    const events = host.requests.find(({ url }) => url.endsWith('/events'));
    expect(events?.init?.headers).toMatchObject({
      Authorization: 'Bearer secret-token',
      'X-Pane-Remote-Runtime-Id': 'runtime-1',
      'X-Pane-Client-Label': 'Pane for iOS',
    });
    const invoke = host.requests.find(({ url }) => url.endsWith('/invoke'));
    expect(invoke?.init?.headers).toMatchObject({ Authorization: 'Bearer secret-token' });
    expect(JSON.parse(String(invoke?.init?.body))).toEqual({
      channel: 'panels:list',
      args: ['session-1'],
      runtimeId: 'runtime-1',
      clientLabel: 'Pane for iOS',
    });
    client.disconnect();
  });

  it('decodes ready, heartbeat and daemon events split across chunks', async () => {
    const host = createFakeHost();
    const client = createClient(host);
    const events: RemoteDaemonClientEvent[] = [];
    client.onEvent((event) => events.push(event));
    await client.connect();
    await flush();

    const smile = new TextEncoder().encode('🙂');
    host.write('retry: 1000\n\nevent: ready\ndata: {"replay":"none"}\n\nevent: heart');
    host.write('beat\r\ndata: {"timestamp":"2026-09-24T01:00:00.000Z"}\r\n\r\n');
    host.write('event: daemon-event\ndata: {"channel":"terminal:output","args":[{"data":"');
    host.writeBytes(smile.slice(0, 2));
    host.writeBytes(smile.slice(2));
    host.write('"}],"timestamp":"2026-09-24T01:00:01.000Z"}\n\n');
    await flush();

    expect(events).toMatchObject([
      { type: 'ready' },
      { type: 'heartbeat', payload: { timestamp: '2026-09-24T01:00:00.000Z' } },
      { type: 'daemon-event', payload: { channel: 'terminal:output', args: [{ data: '🙂' }] } },
    ]);
    expect(client.getState()).toEqual({
      status: 'connected',
      lastError: null,
      lastSeenAt: '2026-09-24T01:00:01.000Z',
    });
    client.disconnect();
  });

  it('reconnects with capped backoff for five minutes, then stops', async () => {
    const host = createFakeHost();
    host.rejectEvents(503);
    const client = createClient(host);
    const eventRequests = () => host.requests.filter(({ url }) => url.endsWith('/events')).length;
    await client.connect();
    await flush();

    for (const [index, delayMs] of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000].entries()) {
      expect(client.getState()).toMatchObject({
        status: 'reconnecting',
        lastError: 'Remote event stream failed with 503',
      });
      await vi.advanceTimersByTimeAsync(delayMs - 1);
      expect(eventRequests()).toBe(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(eventRequests()).toBe(index + 2);
    }
    await vi.runAllTimersAsync();
    expect(eventRequests()).toBeGreaterThan(6);
    expect(client.getState()).toMatchObject({ status: 'error', lastError: expect.stringContaining('five minutes') });
  });

  it('keeps the outage deadline while ready streams fail restoration', async () => {
    const host = createFakeHost();
    const client = createClient(host);
    client.onRestore(async () => { throw new Error('State refresh failed'); });
    await client.connect();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(client.getState().status).toBe('error');
    const requests = host.requests.length;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(host.requests).toHaveLength(requests);
    client.disconnect();
  });

  it('resets the backoff after a stream opens again', async () => {
    const host = createFakeHost();
    const client = createClient(host);
    await client.connect();
    await flush();

    for (let round = 0; round < 8; round += 1) {
      host.end();
      await flush();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(host.streamCount).toBe(9);
    expect(client.getState().status).toBe('connected');
    client.disconnect();
  });

  it('reconnects when a stream goes quiet past the stale timeout', async () => {
    const host = createFakeHost();
    const client = createClient(host, 12_000);
    await client.connect();
    await flush();

    await vi.advanceTimersByTimeAsync(10_000);
    host.write('event: heartbeat\ndata: {"timestamp":"2026-09-24T01:00:00.000Z"}\n\n');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.getState().status).toBe('connected');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(client.getState()).toMatchObject({
      status: 'reconnecting',
      lastError: 'Remote event stream stopped responding',
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(host.streamCount).toBe(2);
    expect(client.getState().status).toBe('connected');
    client.disconnect();
  });

  it('rejects unsent mutations while restoration is pending but permits snapshot reads', async () => {
    const host = createFakeHost();
    const client = createClient(host);
    let release!: () => void;
    client.onRestore(() => new Promise<void>(resolve => { release = resolve; }));
    await client.connect(); await flush();
    expect(client.getState().status).toBe('restoring');
    await expect(client.invoke('terminal:input', ['panel', 'never send'])).rejects.toMatchObject({ code: 'ERR_REMOTE_OFFLINE' });
    expect(host.requests.filter(request => request.url.endsWith('/invoke'))).toHaveLength(0);
    await client.invoke('terminal:getState', ['panel']);
    release(); await flush();
    expect(client.getState().status).toBe('connected');
    client.disconnect();
  });

  it('cuts an event stream request that never answers', async () => {
    const host = createFakeHost();
    host.hangEvents(true);
    const client = createClient(host, 12_000);
    await client.connect();
    await vi.advanceTimersByTimeAsync(12_000);

    expect(client.getState()).toMatchObject({
      status: 'reconnecting',
      lastError: 'Remote event stream stopped responding',
    });
    host.hangEvents(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(client.getState().status).toBe('connected');
    client.disconnect();
  });

  it('stays disconnected when a stalled stream request outlives disconnect', async () => {
    const host = createFakeHost();
    host.hangEvents(true);
    const client = createClient(host, 12_000);
    await client.connect();
    client.disconnect();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(client.getState().status).toBe('local');
    expect(host.requests.filter(({ url }) => url.endsWith('/events'))).toHaveLength(1);
  });

  it('stops without retrying when the host rejects the token on the stream', async () => {
    const host = createFakeHost();
    host.rejectEvents(401);
    const client = createClient(host);
    await client.connect();
    await vi.runAllTimersAsync();

    expect(host.requests.filter(({ url }) => url.endsWith('/events'))).toHaveLength(1);
    expect(client.getState()).toMatchObject({
      status: 'error',
      lastError: expect.stringContaining('connection code is not accepted'),
    });
  });

  it('reconnects after an event payload fails validation', async () => {
    const host = createFakeHost();
    const client = createClient(host);
    await client.connect();
    await flush();

    host.write('event: daemon-event\ndata: {"channel":42}\n\n');
    await flush();

    expect(client.getState()).toMatchObject({
      status: 'reconnecting',
      lastError: 'input.channel: expected string',
    });
    client.disconnect();
  });

  it('reports an error when the host cannot be reached, so a later connect can retry', async () => {
    const host = createFakeHost();
    host.goDown(true);
    const client = createClient(host);
    const connecting = client.connect();
    const rejected = expect(connecting).rejects.toThrow('Network request failed');
    await vi.runAllTimersAsync();
    await rejected;
    expect(client.getState()).toMatchObject({ status: 'error', lastError: expect.stringContaining('five minutes') });

    host.goDown(false);
    await client.connect();
    await flush();
    expect(client.getState().status).toBe('connected');
  });

  it('stops the stream and returns to local on disconnect', async () => {
    const host = createFakeHost();
    const client = createClient(host);
    await client.connect();
    await flush();
    client.disconnect();
    await vi.runAllTimersAsync();

    expect(host.streamCount).toBe(1);
    expect(client.getState().status).toBe('local');
  });
});

describe('RemoteDaemonClient when the phone leaves and returns', () => {
  it('reconnects on return after more than five minutes in the background', async () => {
    const host = createFakeHost();
    // No heartbeats in these tests; keep the stale-stream timer out of the way.
    const client = createClient(host, 600_000);
    await client.connect();
    await flush();

    client.suspend();
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    client.resume();
    await flush();

    expect(client.getState()).toMatchObject({ status: 'connected', lastError: null });
    client.disconnect();
  });

  it('finishes connecting when the app was backgrounded during the handshake', async () => {
    const host = createFakeHost();
    // No heartbeats in these tests; keep the stale-stream timer out of the way.
    const client = createClient(host, 600_000);
    const connecting = client.connect();
    client.suspend();
    await connecting;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.getState().status).not.toBe('connected');

    client.resume();
    await flush();
    expect(client.getState().status).toBe('connected');
    client.disconnect();
  });

  it('reconnects when restoration does not finish within 30 seconds', async () => {
    const host = createFakeHost();
    // No heartbeats in these tests; keep the stale-stream timer out of the way.
    const client = createClient(host, 600_000);
    let hang = true;
    client.onRestore(() => (hang ? new Promise<void>(() => {}) : Promise.resolve()));
    await client.connect();
    await flush();
    expect(client.getState().status).toBe('restoring');

    hang = false;
    await vi.advanceTimersByTimeAsync(29_000);
    expect(client.getState().status).toBe('restoring');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(client.getState().status).toBe('connected');
    expect(host.streamCount).toBe(2);
    client.disconnect();
  });

  it('reconnects and restores after terminal input times out', async () => {
    const host = createFakeHost();
    // No heartbeats in these tests; keep the stale-stream timer out of the way.
    const client = createClient(host, 600_000);
    const restores: number[] = [];
    client.onRestore(async () => { restores.push(Date.now()); });
    await client.connect();
    await flush();
    host.onInvoke(() => new Promise<Response>(() => {}));

    const typed = client.invoke('terminal:input', ['panel-1', 'x']);
    const failed = expect(typed).rejects.toThrow('Delivery unknown');
    await vi.advanceTimersByTimeAsync(10_000);
    await failed;
    await vi.advanceTimersByTimeAsync(2_000);

    expect(client.getState().status).toBe('connected');
    expect(host.streamCount).toBe(2);
    expect(restores).toHaveLength(2);
    client.disconnect();
  });
});

describe('RemoteDaemonClient invoke errors', () => {
  it('reports a host error with its status and code without retrying', async () => {
    const host = createFakeHost();
    host.onInvoke(() => Response.json(
      { ok: false, error: { message: 'No Pane daemon command registered', code: 'ERR_UNKNOWN_CHANNEL' } },
      { status: 404 },
    ));

    const error = await createClient(host).invoke('panels:list').catch((cause: Error) => cause);

    expect(error).toBeInstanceOf(RemoteRequestError);
    expect(error).toMatchObject({ status: 404, code: 'ERR_UNKNOWN_CHANNEL', message: 'No Pane daemon command registered' });
    expect(host.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a text body', () => new Response('Forbidden', { status: 403 })],
    ['a proxy JSON body', () => Response.json({ message: 'Forbidden' }, { status: 403 })],
  ])('reports a rejected token with %s as an auth error without retrying', async (_name, respond) => {
    const host = createFakeHost();
    host.onInvoke(respond);

    await expect(createClient(host).invoke('panels:list')).rejects.toBeInstanceOf(RemoteAuthError);
    expect(host.fetch).toHaveBeenCalledTimes(1);
  });

  it('reports uncertainty when the connection changes after a mutation was dispatched', async () => {
    const host = createFakeHost();
    const client = createClient(host);
    await client.connect();
    await flush();
    host.onInvoke(() => { client.disconnect(); return Response.json({ ok: true, result: 'stale' }); });
    await expect(client.invoke('panels:create', [])).rejects.toBeInstanceOf(RemoteUnconfirmedResultError);
    expect(host.requests.filter(request => request.url.endsWith('/invoke'))).toHaveLength(1);
  });

  it('does not replay a mutation whose response was lost', async () => {
    const host = createFakeHost();
    host.onInvoke(() => { throw new TypeError('Network connection was lost'); });

    const client = createClient(host);
    await client.connect();
    await flush();
    host.fetch.mockClear();
    const error = await client.invoke('terminal:input', ['panel-1', 'ls\r']).catch((cause: Error) => cause);

    expect(error.message).toMatch(/Delivery unknown.+Check the original panel/);
    client.disconnect();
    expect(host.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['panels:list', 'runpane:workspaces:machines'])('retries the safe read %s after 2, 4 and 6 s', async channel => {
    const host = createFakeHost();
    let calls = 0;
    host.onInvoke(() => {
      calls += 1;
      return calls < 4 ? Response.json({ ok: false }, { status: 503 }) : Response.json({ ok: true, result: ['panel'] });
    });

    const result = createClient(host).invoke(channel);
    await vi.advanceTimersByTimeAsync(2_000 + 4_000 + 5_999);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual(['panel']);
  });
});

describe('decodeRemoteConnectionCode', () => {
  function code(payload: Partial<PaneRemoteConnectionImportPayload>): string {
    return `pane-remote://${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
  }

  it('turns a pairing code into a connection profile', () => {
    expect(decodeRemoteConnectionCode(`  ${code({
      v: 1,
      label: 'Studio Mac',
      baseUrl: 'https://studio.tailnet.ts.net/',
      token: 'tok_abcdefgh12345678',
      transport: 'http+sse',
    })}\n`)).toEqual({
      id: 'Studio Mac:https://studio.tailnet.ts.net:12345678',
      label: 'Studio Mac',
      baseUrl: 'https://studio.tailnet.ts.net',
      token: 'tok_abcdefgh12345678',
      transport: 'http+sse',
      tunnel: undefined,
    });
  });

  it.each([
    ['another scheme', 'https://studio.tailnet.ts.net', /must start with pane-remote/],
    ['an empty payload', 'pane-remote://', /empty/],
    ['a payload that is not base64 JSON', 'pane-remote://%%%', /not valid/],
    ['plain HTTP to a non-loopback host', code({
      v: 1, label: 'Mac', baseUrl: 'http://192.168.1.20:42137', token: 't', transport: 'http+sse',
    }), /^Connection code is not valid$/],
    ['a missing token', code({ v: 1, label: 'Mac', baseUrl: 'https://mac.ts.net', transport: 'http+sse' }), /token/],
  ])('rejects %s', (_name, input, message) => {
    expect(() => decodeRemoteConnectionCode(input)).toThrow(message);
  });
});

describe('remote client storage', () => {
  function memoryStorage(): RemoteKeyValueStorage & { values: Map<string, string> } {
    const values = new Map<string, string>();
    return {
      values,
      async getItem(key) { return values.get(key) ?? null; },
      async setItem(key, value) { values.set(key, value); },
    };
  }

  it('creates the runtime ID once and reuses it', async () => {
    const storage = memoryStorage();
    const createId = vi.fn(() => 'generated-id');

    expect(await getOrCreateRuntimeId(storage, createId)).toBe('generated-id');
    expect(await getOrCreateRuntimeId(storage, createId)).toBe('generated-id');
    expect(createId).toHaveBeenCalledTimes(1);
  });

  it('round-trips saved profiles and drops entries that are not profiles', async () => {
    const storage = memoryStorage();
    await saveRemoteProfiles(storage, [PROFILE]);
    expect(await loadRemoteProfiles(storage)).toEqual([PROFILE]);

    storage.values.set('pane.remotePwa.savedProfiles', JSON.stringify([PROFILE, { id: 'broken' }]));
    expect(await loadRemoteProfiles(storage)).toEqual([PROFILE]);
    storage.values.set('pane.remotePwa.savedProfiles', '{not json');
    expect(await loadRemoteProfiles(storage)).toEqual([]);
  });
});
