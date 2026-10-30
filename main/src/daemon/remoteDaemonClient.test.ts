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
  let tunnelDown = false;
  let ready = '{"replay":"none"}';
  let invokeHandler: (body: { channel: string; args: unknown[]; requestId?: string }) => Response | Promise<Response> = () =>
    Response.json({ ok: true, result: null });

  const fetch = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    requests.push({ url, init });
    const path = new URL(url).pathname;
    if (hostDown) throw new TypeError('Network request failed');
    // Like a VPN tunnel still coming back after sleep: the request goes nowhere, even once the tunnel returns.
    if (tunnelDown) {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    }
    if (path === '/health') return Response.json({ ok: true });
    if (path === '/invoke') {
      // Like fetch: an aborted request rejects even when the host never answers.
      const signal = init?.signal;
      return Promise.race([
        invokeHandler(JSON.parse(String(init?.body))),
        new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })),
      ]);
    }
    if (path === '/events') {
      // Like a half-dead mobile socket: no headers, and aborting does not settle it.
      if (hangEvents) return new Promise<Response>(() => {});
      if (eventsStatus !== 200) return Response.json({ ok: false }, { status: eventsStatus });
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          streams.push(controller);
          if (sendReady) controller.enqueue(new TextEncoder().encode(`event: ready\ndata: ${ready}\n\n`));
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
    /** Says in its ready event that it runs each request id once, as hosts with that capability do. */
    deduplicateRequestIds() { ready = '{"replay":"none","deduplicatesRequestIds":true}'; },
    rejectEvents(status: number) { eventsStatus = status; },
    hangEvents(hang: boolean) { hangEvents = hang; },
    goDown(down: boolean) { hostDown = down; },
    dropTunnel(down: boolean) { tunnelDown = down; },
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

    for (const [index, delayMs] of [250, 750, 2_000, 4_000, 8_000, 16_000, 30_000].entries()) {
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
    expect(eventRequests()).toBeGreaterThan(7);
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

  it.each(['credentials:shared:get', 'credentials:shared:apply', 'mobile:push-register', 'mobile:push-controls', 'mobile:push-revoke'])(
    'sends %s from a client that never opened the event stream', async channel => {
      const host = createFakeHost();
      const client = createClient(host);
      await expect(client.invoke(channel, [{}])).resolves.toBeNull();
      expect(host.requests.filter(request => request.url.endsWith('/invoke'))).toHaveLength(1);
    },
  );

  it('passes a host\'s own refusal of a command through, not the pairing-code advice', async () => {
    const host = createFakeHost();
    host.onInvoke(() => Response.json({ ok: false, error: { code: 'ERR_MOBILE_PUSH_OWNER_REQUIRED', message: 'Only this computer\'s owner can get its alerts on a phone.' } }, { status: 403 }));
    const client = createClient(host);
    await expect(client.invoke('mobile:push-register', [{}])).rejects.toThrow('Only this computer\'s owner can get its alerts on a phone.');
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

  it('reconnects within a second of the tunnel returning after a wake, though the first try never answers', async () => {
    const host = createFakeHost();
    const client = createClient(host, 20_000);
    await client.connect();
    await flush();

    client.suspend();
    host.dropTunnel(true);
    await vi.advanceTimersByTimeAsync(60_000);
    client.resume();
    await vi.advanceTimersByTimeAsync(2_000);
    host.dropTunnel(false);
    await vi.advanceTimersByTimeAsync(1_000);

    const state = client.getState();
    expect(state).toMatchObject({ status: 'connected', lastError: null });
    // The record says the network, not the host, held it up.
    expect(state.lastWake).toMatchObject({ lastError: 'No answer within 2 s' });
    expect(state.lastWake?.firstAnswerMs).toBeGreaterThanOrEqual(2_000);
    expect(state.lastWake?.connectedMs).toBeLessThan(3_000);
    expect(state.lastWake?.attempts).toBeGreaterThan(5);
    client.disconnect();
  });

  it('keeps probing on the backoff after the first seconds, so a longer outage still ends well before the stale-stream timer', async () => {
    const host = createFakeHost();
    const client = createClient(host, 20_000);
    await client.connect();
    await flush();

    client.suspend();
    host.dropTunnel(true);
    client.resume();
    await vi.advanceTimersByTimeAsync(9_000);
    host.dropTunnel(false);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(client.getState().status).toBe('connected');
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

  it('stays connected through one unanswered terminal input and reconnects after three', async () => {
    const host = createFakeHost();
    // No heartbeats in these tests; keep the stale-stream timer out of the way.
    const client = createClient(host, 600_000);
    const restores: number[] = [];
    client.onRestore(async () => { restores.push(Date.now()); });
    await client.connect();
    await flush();
    host.onInvoke(() => new Promise<Response>(() => {}));

    for (let typedCount = 1; typedCount <= 3; typedCount += 1) {
      const failed = expect(client.invoke('terminal:input', ['panel-1', 'x'])).rejects.toThrow('Delivery unknown');
      await vi.advanceTimersByTimeAsync(10_000);
      await failed;
      expect(client.getState().status).toBe(typedCount < 3 ? 'connected' : 'reconnecting');
    }
    await vi.advanceTimersByTimeAsync(250);

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

  it('keeps the connection through one lost mutation response and reconnects after three in a row', async () => {
    const host = createFakeHost();
    const client = createClient(host, 600_000);
    await client.connect();
    await flush();
    host.onInvoke(() => { throw new TypeError('Network connection was lost'); });

    await expect(client.invoke('panels:create', [])).rejects.toBeInstanceOf(RemoteUnconfirmedResultError);
    await expect(client.invoke('panels:create', [])).rejects.toBeInstanceOf(RemoteUnconfirmedResultError);
    expect(client.getState().status).toBe('connected');
    await expect(client.invoke('panels:create', [])).rejects.toBeInstanceOf(RemoteUnconfirmedResultError);
    expect(client.getState()).toMatchObject({ status: 'reconnecting', lastError: expect.stringContaining('3 requests in a row failed') });
    client.disconnect();
  });

  it('retries a read lost in transit until the host answers, without reconnecting', async () => {
    const host = createFakeHost();
    const client = createClient(host, 600_000);
    await client.connect();
    await flush();
    let calls = 0;
    host.onInvoke(() => {
      calls += 1;
      if (calls <= 6) throw new TypeError('Network connection was lost');
      return Response.json({ ok: true, result: { text: 'Cleaned up.' } });
    });

    const result = client.invoke('voice:finalize-streaming', [{ rawText: 'cleaned up' }]);
    // 250 ms, 750 ms, 2 s, 4 s, 8 s, 16 s.
    await vi.advanceTimersByTimeAsync(31_000 - 1);
    expect(calls).toBe(6);
    expect(client.getState().status).toBe('connected');
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ text: 'Cleaned up.' });
    expect(host.streamCount).toBe(1);
    client.disconnect();
  });

  it('resends a chat prompt whose response was lost, since the host de-duplicates its operation ID', async () => {
    const host = createFakeHost();
    const client = createClient(host, 600_000);
    await client.connect();
    await flush();
    const sent: unknown[] = [];
    host.onInvoke(body => {
      sent.push(body.args[1]);
      if (sent.length === 1) throw new TypeError('Network connection was lost');
      return Response.json({ ok: true, result: { operationId: 'op-1', state: 'accepted' } });
    });

    const receipt = client.invoke('agent-chat:send', ['panel-1', { generation: 1, operationId: 'op-1', text: 'hi' }]);
    await vi.advanceTimersByTimeAsync(250);
    await expect(receipt).resolves.toEqual({ operationId: 'op-1', state: 'accepted' });
    expect(sent).toEqual([
      { generation: 1, operationId: 'op-1', text: 'hi' },
      { generation: 1, operationId: 'op-1', text: 'hi' },
    ]);
    client.disconnect();
  });

  it('does not replay a mutation whose response was lost', async () => {
    const host = createFakeHost();
    host.onInvoke(() => { throw new TypeError('Network connection was lost'); });

    const client = createClient(host);
    await client.connect();
    await flush();
    host.fetch.mockClear();
    const error = await client.invoke('terminal:input', ['panel-1', 'ls\r']).catch((cause: Error) => cause);

    expect(error.message).toMatch(/^Delivery unknown:.+Check the current state/);
    client.disconnect();
    expect(host.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['panels:list', 'runpane:workspaces:machines'])('retries the safe read %s after 250 ms, 750 ms and 2 s', async channel => {
    const host = createFakeHost();
    let calls = 0;
    host.onInvoke(() => {
      calls += 1;
      return calls < 4 ? Response.json({ ok: false }, { status: 503 }) : Response.json({ ok: true, result: ['panel'] });
    });

    const result = createClient(host).invoke(channel);
    await vi.advanceTimersByTimeAsync(250 + 750 + 1_999);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual(['panel']);
  });
});

describe('RemoteDaemonClient against a host that runs each request id once', () => {
  async function connectToDeduplicatingHost() {
    const host = createFakeHost();
    host.deduplicateRequestIds();
    const client = createClient(host, 600_000);
    await client.connect();
    await flush();
    expect(client.getState().status).toBe('connected');
    /** The link dies: requests fail and the stream ends, so the client reconnects. */
    const drop = () => { host.goDown(true); host.end(); };
    return { host, client, drop };
  }

  it('resends a write whose answer was lost, with the same id, and resolves once', async () => {
    const { host, client } = await connectToDeduplicatingHost();
    const ids: Array<string | undefined> = [];
    host.onInvoke(body => {
      ids.push(body.requestId);
      if (ids.length < 3) throw new TypeError('Network connection was lost');
      return Response.json({ ok: true, result: { id: 'pane-1' } });
    });

    const created = client.invoke('runpane:panes:create', [{ name: 'fix' }]);
    await vi.advanceTimersByTimeAsync(250 + 750);
    await expect(created).resolves.toEqual({ id: 'pane-1' });
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toEqual(expect.any(String));
    client.disconnect();
  });

  it('holds a write made during a drop and sends it once the connection is back', async () => {
    const { host, client, drop } = await connectToDeduplicatingHost();
    const sent: unknown[] = [];
    host.onInvoke(body => { sent.push(body.args); return Response.json({ ok: true, result: null }); });
    drop();
    await flush();
    expect(client.getState().status).toBe('reconnecting');

    const answered = client.invoke('notify:remote-command', [{ type: 'answer', id: 'q-1' }]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toEqual([]);
    host.goDown(false);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(answered).resolves.toBeNull();
    expect(sent).toEqual([[{ type: 'answer', id: 'q-1' }]]);
    client.disconnect();
  });

  it('delivers terminal input caught in a drop once, in order, after reconnecting', async () => {
    const { host, client, drop } = await connectToDeduplicatingHost();
    const applied = new Map<string, string>();
    let holdFirst = true;
    host.onInvoke(body => {
      // The first batch reaches the host, but its answer is lost in the drop.
      if (body.requestId && !applied.has(body.requestId)) applied.set(body.requestId, String(body.args[1]));
      if (holdFirst) { holdFirst = false; drop(); throw new TypeError('Network connection was lost'); }
      return Response.json({ ok: true, result: null });
    });

    const typed = [client.invoke('terminal:input', ['panel-1', 'l']), client.invoke('terminal:input', ['panel-1', 's\r'])];
    await vi.advanceTimersByTimeAsync(20_000);
    expect(client.getState().status).toBe('reconnecting');
    host.goDown(false);
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(Promise.all(typed)).resolves.toEqual([null, null]);
    expect([...applied.values()].join('')).toBe('ls\r');
    expect(client.getState().status).toBe('connected');
    client.disconnect();
  });

  it('resends terminal input in flight when the app is backgrounded, and the host applies it once', async () => {
    const { host, client } = await connectToDeduplicatingHost();
    const applied = new Map<string, string>();
    const attempts: Array<string | undefined> = [];
    host.onInvoke(body => {
      attempts.push(body.requestId);
      if (body.requestId && !applied.has(body.requestId)) applied.set(body.requestId, String(body.args[1]));
      // The first attempt reaches the host but never answers; backgrounding cuts it.
      if (attempts.length === 1) return new Promise<Response>(() => {});
      return Response.json({ ok: true, result: null });
    });

    const typed = client.invoke('terminal:input', ['panel-1', 'y']);
    await flush();
    client.suspend();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(attempts).toHaveLength(1);
    client.resume();
    // Well inside the 30 s attempt timeout: only cutting the old attempt resends this soon.
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(typed).resolves.toBeNull();
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toBe(attempts[0]);
    expect([...applied.values()]).toEqual(['y']);
    client.disconnect();
  });

  it('does not resend a write whose five minutes passed while the app was asleep', async () => {
    const { host, client } = await connectToDeduplicatingHost();
    const attempts: Array<string | undefined> = [];
    host.onInvoke(body => {
      attempts.push(body.requestId);
      // Applied, but the answer is lost as the phone goes to sleep.
      client.suspend();
      throw new TypeError('Network connection was lost');
    });

    const typed = expect(client.invoke('terminal:input', ['panel-1', 'ls\r'])).rejects.toThrow(/^Delivery unknown:/);
    await flush();
    // Asleep for ten minutes: the clock moves, but no timer runs.
    vi.setSystemTime(Date.now() + 601_000);
    host.onInvoke(body => { attempts.push(body.requestId); return Response.json({ ok: true, result: null }); });
    client.resume();
    await vi.advanceTimersByTimeAsync(30_000);

    await typed;
    expect(attempts).toHaveLength(1);
    client.disconnect();
  });

  it('resends a write the host refused because its memory of answers was full', async () => {
    const { host, client } = await connectToDeduplicatingHost();
    let calls = 0;
    host.onInvoke(() => {
      calls += 1;
      return calls === 1
        ? Response.json({ ok: false, error: { message: 'Still holding answers', code: 'ERR_REMOTE_WRITES_BUSY' } }, { status: 503 })
        : Response.json({ ok: true, result: 'ran' });
    });

    const created = client.invoke('panels:create', ['session-1']);
    await vi.advanceTimersByTimeAsync(250);
    await expect(created).resolves.toBe('ran');
    expect(calls).toBe(2);
    client.disconnect();
  });

  it('takes the host\'s own error as the answer, without resending', async () => {
    const { host, client } = await connectToDeduplicatingHost();
    host.onInvoke(() => Response.json({ ok: false, error: { message: 'No terminal panel-1', code: 'ERR_PANEL_NOT_FOUND' } }, { status: 500 }));

    await expect(client.invoke('terminal:input', ['panel-1', 'x'])).rejects.toMatchObject({ message: 'No terminal panel-1', code: 'ERR_PANEL_NOT_FOUND' });
    expect(host.requests.filter(request => request.url.endsWith('/invoke'))).toHaveLength(1);
    client.disconnect();
  });

  it('says a held write was not sent when reconnecting gives up', async () => {
    const { client, drop } = await connectToDeduplicatingHost();
    drop();
    await flush();
    const held = expect(client.invoke('panels:create', ['session-1'])).rejects.toMatchObject({
      code: 'ERR_REMOTE_OFFLINE',
      message: expect.stringContaining('The action was not sent.'),
    });
    await vi.advanceTimersByTimeAsync(300_000);
    await held;
    expect(client.getState().status).toBe('error');
  });

  it('says a sent write was not confirmed when reconnecting gives up', async () => {
    const { host, client, drop } = await connectToDeduplicatingHost();
    host.onInvoke(() => { drop(); throw new TypeError('Network connection was lost'); });
    const sent = expect(client.invoke('panels:create', ['session-1'])).rejects.toThrow(/^Delivery unknown: Pane resent this action for up to five minutes, but the host never confirmed it/);
    await vi.advanceTimersByTimeAsync(300_000);
    await sent;
  });

  it('still refuses a write made while restoring, which restore steps rely on', async () => {
    const { client, host, drop } = await connectToDeduplicatingHost();
    let restoring: Promise<unknown> | null = null;
    client.onRestore(async () => { restoring ??= client.invoke('panels:initialize', ['panel-1']).catch((error: Error) => error); });
    drop();
    await flush();
    host.goDown(false);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(restoring).resolves.toMatchObject({ code: 'ERR_REMOTE_OFFLINE' });
    client.disconnect();
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
