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
  let invokeHandler: (body: { channel: string; args: unknown[] }) => Response = () =>
    Response.json({ ok: true, result: null });

  const fetch = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    requests.push({ url, init });
    const path = new URL(url).pathname;
    if (path === '/health') return Response.json({ ok: true });
    if (path === '/invoke') return invokeHandler(JSON.parse(String(init?.body)));
    if (path === '/events') {
      if (eventsStatus !== 200) return Response.json({ ok: false }, { status: eventsStatus });
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => { streams.push(controller); },
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
    rejectEvents(status: number) { eventsStatus = status; },
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
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RemoteDaemonClient with the fetch event stream transport', () => {
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

  it('reconnects with 1, 2, 4, 8, 15 s backoff, then gives up', async () => {
    const host = createFakeHost();
    host.rejectEvents(503);
    const client = createClient(host);
    const eventRequests = () => host.requests.filter(({ url }) => url.endsWith('/events')).length;
    await client.connect();
    await flush();

    for (const [index, delayMs] of [1_000, 2_000, 4_000, 8_000, 15_000].entries()) {
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
    expect(eventRequests()).toBe(6);
    expect(client.getState()).toMatchObject({ status: 'error', lastError: 'Remote event stream failed with 503' });
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

  it('reports a rejected token as an auth error', async () => {
    const host = createFakeHost();
    host.onInvoke(() => new Response('Forbidden', { status: 403 }));

    await expect(createClient(host).invoke('panels:list')).rejects.toBeInstanceOf(RemoteAuthError);
  });

  it('does not replay a mutation whose response was lost', async () => {
    const host = createFakeHost();
    host.onInvoke(() => { throw new TypeError('Network connection was lost'); });

    const error = await createClient(host).invoke('terminal:input', ['panel-1', 'ls\r']).catch((cause: Error) => cause);

    expect(error).toBeInstanceOf(RemoteUnconfirmedResultError);
    expect(error.message).toMatch(/may have completed.+Network connection was lost/);
    expect(host.fetch).toHaveBeenCalledTimes(1);
  });

  it('retries a safe read after 2, 4 and 6 s', async () => {
    const host = createFakeHost();
    let calls = 0;
    host.onInvoke(() => {
      calls += 1;
      return calls < 4 ? Response.json({ ok: false }, { status: 503 }) : Response.json({ ok: true, result: ['panel'] });
    });

    const result = createClient(host).invoke('panels:list');
    await vi.advanceTimersByTimeAsync(2_000 + 4_000 + 5_999);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual(['panel']);
  });
});

describe('decodeRemoteConnectionCode', () => {
  function code(payload: object): string {
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
