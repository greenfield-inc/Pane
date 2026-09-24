import http, { type ServerResponse } from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteDaemonBrowserClient } from '../../../../frontend/src/remote/runtime/remoteDaemonBrowserClient';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';
import { RemotePaneClient } from './remotePaneClient';

interface InputRequest {
  channel: string;
  args: unknown[];
  response: ServerResponse;
}

const clients: Array<RemotePaneClient | RemoteDaemonBrowserClient> = [];
const servers: http.Server[] = [];

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
  vi.stubGlobal('navigator', { platform: 'Test' });
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.disconnect()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
  vi.unstubAllGlobals();
});

describe.each([
  ['desktop', RemotePaneClient],
  ['browser', RemoteDaemonBrowserClient],
] as const)('%s remote terminal input', (_name, Client) => {
  async function setup() {
    const requests: InputRequest[] = [];
    let eventResponse: ServerResponse | undefined;
    const server = http.createServer(async (request, response) => {
      if (request.url?.startsWith('/health')) {
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (request.url?.startsWith('/events')) {
        eventResponse = response;
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(`event: ready\ndata: ${JSON.stringify({
          replay: 'none', resync: 'refetch-state-after-reconnect', timestamp: new Date().toISOString(),
        })}\n\n`);
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const parsed = decodeBoundary(JSON.parse(Buffer.concat(chunks).toString()), boundary.object({
        channel: boundary.string,
        args: boundary.array(boundary.json),
      }));
      requests.push({ ...parsed, response });
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = decodeBoundary(server.address(), boundary.object({ port: boundary.number }));
    const client = new Client({
      id: 'input-test', label: 'Input test', token: 'test-token', transport: 'http+sse',
      baseUrl: `http://127.0.0.1:${address.port}`,
    });
    clients.push(client);
    return { client, requests, getEventResponse: () => eventResponse };
  }

  it('keeps fast typing ordered and combines pending keys into the next request', async () => {
    const { client, requests } = await setup();
    const completed = Promise.allSettled([
      client.invoke('terminal:input', ['panel-1', 'a']),
      client.invoke('terminal:input', ['panel-1', 'b']),
      client.invoke('terminal:input', ['panel-1', 'c']),
    ]);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(requests.map(request => request.args[1])).toEqual(['a']);

    reply(requests[0]);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].args).toEqual(['panel-1', 'bc']);
    reply(requests[1]);
    expect(await completed).toEqual([
      { status: 'fulfilled', value: undefined },
      { status: 'fulfilled', value: undefined },
      { status: 'fulfilled', value: undefined },
    ]);
  });

  it('preserves Unicode, paste boundaries, and control keys, ending a write at a bare Escape', async () => {
    const { client, requests } = await setup();
    const keys = ['a', 'é🙂', '\x1b[200~pasted\ntext\x1b[201~', '\x7f', '\x1b', '\x1b[D', '\t', '\x03', '\r'];
    const completed = Promise.allSettled(keys.map(key => client.invoke('terminal:input', ['panel-1', key])));
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    reply(requests[0]);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].args[1]).toBe(keys.slice(1, 5).join(''));
    reply(requests[1]);
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2].args[1]).toBe(keys.slice(5).join(''));
    reply(requests[2]);
    expect((await completed).every(result => result.status === 'fulfilled')).toBe(true);
  });

  it('does not block other panels or ordinary remote commands', async () => {
    const { client, requests } = await setup();
    const completed = Promise.allSettled([
      client.invoke('terminal:input', ['panel-1', 'a']),
      client.invoke('terminal:input', ['panel-2', 'b']),
      client.invoke('sessions:get-all', []),
    ]);
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    for (const request of requests) reply(request);
    expect((await completed).every(result => result.status === 'fulfilled')).toBe(true);
  });

  it('orders both terminal input channels together and preserves their results', async () => {
    const { client, requests } = await setup();
    const completed = Promise.allSettled([
      client.invoke('terminal:input', ['panel-1', 'a']),
      client.invoke('panels:send-terminal-input', ['panel-1', 'b']),
      client.invoke('panels:send-terminal-input', ['panel-1', 'c']),
      client.invoke('terminal:input', ['panel-1', '\r']),
    ]);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    reply(requests[0]);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toMatchObject({ channel: 'panels:send-terminal-input', args: ['panel-1', 'bc'] });
    requests[1].response.end(JSON.stringify({ ok: true, result: { success: true } }));
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[2]).toMatchObject({ channel: 'terminal:input', args: ['panel-1', '\r'] });
    reply(requests[2]);
    expect(await completed).toEqual([
      { status: 'fulfilled', value: undefined },
      { status: 'fulfilled', value: { success: true } },
      { status: 'fulfilled', value: { success: true } },
      { status: 'fulfilled', value: undefined },
    ]);
  });

  it('discards pending input on an HTTP failure without retrying the write', async () => {
    const { client, requests } = await setup();
    const completed = Promise.allSettled([
      client.invoke('terminal:input', ['panel-1', 'a']),
      client.invoke('terminal:input', ['panel-1', 'b']),
    ]);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    reply(requests[0], 503);
    expect(await completed).toEqual([
      { status: 'rejected', reason: new Error('Input failed') },
      { status: 'rejected', reason: new Error('Input failed') },
    ]);
    expect(requests).toHaveLength(1);
  });

  it('does not replay input if the connection drops after the host receives it', async () => {
    const { client, requests } = await setup();
    const completed = Promise.allSettled([
      client.invoke('terminal:input', ['panel-1', 'a']),
      client.invoke('terminal:input', ['panel-1', 'b']),
    ]);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    requests[0].response.destroy();
    expect((await completed).every(result => result.status === 'rejected')).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it('cancels input on disconnect and never sends its buffered suffix', async () => {
    const { client, requests } = await setup();
    const completed = Promise.allSettled([
      client.invoke('terminal:input', ['panel-1', 'a']),
      client.invoke('terminal:input', ['panel-1', 'b']),
    ]);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await client.disconnect();
    expect((await completed).every(result => result.status === 'rejected')).toBe(true);
    await vi.waitFor(() => expect(requests[0].response.destroyed).toBe(true));
    expect(requests).toHaveLength(1);
  });

  it('discards queued input when the remote event connection is lost', async () => {
    const { client, requests, getEventResponse } = await setup();
    await client.connect();
    await vi.waitFor(() => expect(getEventResponse()).toBeDefined());
    const completed = Promise.allSettled([
      client.invoke('terminal:input', ['panel-1', 'a']),
      client.invoke('terminal:input', ['panel-1', 'b']),
    ]);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    getEventResponse()?.destroy();
    expect((await completed).every(result => result.status === 'rejected')).toBe(true);
    expect(requests).toHaveLength(1);
  });
});

function reply(request: InputRequest, status = 200): void {
  request.response.writeHead(status, { 'Content-Type': 'application/json' });
  request.response.end(JSON.stringify(status === 200
    ? { ok: true }
    : { ok: false, error: { message: 'Input failed' } }));
}
