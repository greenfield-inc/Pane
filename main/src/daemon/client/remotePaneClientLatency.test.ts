import http, { type IncomingMessage, type ServerResponse } from 'http';
import { constants as zlibConstants, createGzip, gzipSync } from 'zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';
import { RemotePaneClient } from './remotePaneClient';

interface Seen {
  path: string;
  channel?: string;
  args?: unknown[];
  headers: IncomingMessage['headers'];
  response: ServerResponse;
}

interface HostOptions {
  capabilities?: string[];
  gzipEvents?: boolean;
  keepAliveTimeoutMs?: number;
  answerInvokes?: boolean;
}

const clients: RemotePaneClient[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.disconnect()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
  vi.unstubAllGlobals();
});

async function startHost(options: HostOptions = {}) {
  const seen: Seen[] = [];
  let events: { write: (text: string) => void } | null = null;
  const server = http.createServer(async (request, response) => {
    const path = request.url ?? '/';
    if (path.startsWith('/events')) {
      const ready = { replay: 'none', resync: 'refetch-state-after-reconnect', timestamp: new Date().toISOString(), capabilities: options.capabilities };
      if (options.gzipEvents && request.headers['accept-encoding']?.includes('gzip')) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Content-Encoding': 'gzip' });
        const gzip = createGzip({ flush: zlibConstants.Z_SYNC_FLUSH });
        gzip.pipe(response);
        events = { write: text => gzip.write(text) };
      } else {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        events = { write: text => response.write(text) };
      }
      events.write(`event: ready\ndata: ${JSON.stringify(ready)}\n\n`);
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const entry: Seen = { path, headers: request.headers, response };
    if (path.startsWith('/invoke')) {
      const parsed = decodeBoundary(JSON.parse(Buffer.concat(chunks).toString()), boundary.object({
        channel: boundary.string,
        args: boundary.array(boundary.json),
      }));
      entry.channel = parsed.channel;
      entry.args = parsed.args;
    }
    seen.push(entry);
    if (path.startsWith('/health')) response.end('{"ok":true}');
    else if (options.answerInvokes) answer(entry, { ok: true, result: { echoed: entry.args?.[1] ?? null } });
  });
  if (options.keepAliveTimeoutMs) server.keepAliveTimeout = options.keepAliveTimeoutMs;
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = decodeBoundary(server.address(), boundary.object({ port: boundary.number }));
  const received: Array<{ channel: string; args: unknown[] }> = [];
  const client = new RemotePaneClient({
    id: 'latency-test', label: 'Latency test', token: 'test-token', transport: 'http+sse',
    baseUrl: `http://127.0.0.1:${address.port}`,
  }, { eventSink: { send: (channel, ...args) => received.push({ channel, args }) } });
  clients.push(client);
  return { client, seen, received, sendEvent: (text: string) => events?.write(text) };
}

function answer(entry: Seen, payload: unknown): void {
  const body = JSON.stringify(payload);
  if (entry.headers['accept-encoding']?.includes('gzip')) {
    entry.response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
    entry.response.end(gzipSync(body));
    return;
  }
  entry.response.writeHead(200, { 'Content-Type': 'application/json' });
  entry.response.end(body);
}

const inputs = (seen: Seen[]) => seen.filter(entry => entry.channel === 'terminal:input');

describe('RemotePaneClient latency', () => {
  it('pipelines terminal input with sequence stamps once the host advertises input-seq', async () => {
    const { client, seen } = await startHost({ capabilities: ['input-seq'] });
    await client.connect();
    const typed = Promise.all([...'abc'].map(key => client.invoke('terminal:input', ['panel-1', key])));
    // All three leave before the first is answered: no round trip between keys.
    await vi.waitFor(() => expect(inputs(seen)).toHaveLength(3));
    const stamps = inputs(seen).map(entry => String(entry.headers['x-pane-input-seq']));
    const stream = stamps[0].split(':')[0];
    expect(stamps.slice().sort()).toEqual([`${stream}:0`, `${stream}:1`, `${stream}:2`]);
    const byKey = Object.fromEntries(inputs(seen).map(entry => [String(entry.args?.[1]), String(entry.headers['x-pane-input-seq'])]));
    expect(byKey).toEqual({ a: `${stream}:0`, b: `${stream}:1`, c: `${stream}:2` });
    for (const entry of inputs(seen)) answer(entry, { ok: true });
    await typed;
  });

  it('keeps one write in flight per terminal on hosts without input-seq', async () => {
    const { client, seen } = await startHost();
    await client.connect();
    const typed = Promise.all([...'abc'].map(key => client.invoke('terminal:input', ['panel-1', key])));
    await vi.waitFor(() => expect(inputs(seen)).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(inputs(seen)).toHaveLength(1);
    expect(inputs(seen)[0].headers['x-pane-input-seq']).toBeUndefined();
    answer(inputs(seen)[0], { ok: true });
    await vi.waitFor(() => expect(inputs(seen)).toHaveLength(2));
    expect(inputs(seen)[1].args).toEqual(['panel-1', 'bc']);
    answer(inputs(seen)[1], { ok: true });
    await typed;
  });

  it('asks for and decodes gzip invoke responses', async () => {
    const { client, seen } = await startHost({ answerInvokes: true });
    await expect(client.invoke('terminal:getState', ['panel-1', 'x'.repeat(10)])).resolves.toEqual({ echoed: 'x'.repeat(10) });
    expect(seen[0].headers['accept-encoding']).toBe('gzip');
  });

  it('decodes a gzip event stream event by event', async () => {
    const { client, received, sendEvent } = await startHost({ gzipEvents: true });
    await client.connect();
    const envelope = { channel: 'terminal:output', args: [{ panelId: 'panel-1', output: 'hello' }], timestamp: new Date().toISOString() };
    sendEvent(`event: daemon-event\ndata: ${JSON.stringify(envelope)}\n\n`);
    await vi.waitFor(() => expect(received).toEqual([{ channel: 'terminal:output', args: [{ panelId: 'panel-1', output: 'hello' }] }]));
  });

  it('reuses one keep-alive connection for consecutive requests', async () => {
    const { client, seen } = await startHost({ answerInvokes: true });
    for (let i = 0; i < 3; i++) await client.invoke('sessions:get-all', []);
    const ports = new Set(seen.map(entry => entry.response.socket?.remotePort));
    expect(ports.size).toBe(1);
  });

  it('pings /health without a token while active on a host with a short keep-alive, and not on a long one', async () => {
    const short = await startHost({ answerInvokes: true, keepAliveTimeoutMs: 5_000 });
    await short.client.invoke('sessions:get-all', []);
    const long = await startHost({ answerInvokes: true, keepAliveTimeoutMs: 120_000 });
    await long.client.invoke('sessions:get-all', []);
    await new Promise(resolve => setTimeout(resolve, 3_300));
    const shortPings = short.seen.filter(entry => entry.path.startsWith('/health'));
    expect(shortPings.length).toBeGreaterThanOrEqual(1);
    expect(shortPings.every(entry => entry.headers.authorization === undefined)).toBe(true);
    expect(long.seen.filter(entry => entry.path.startsWith('/health'))).toHaveLength(0);
  });
});
