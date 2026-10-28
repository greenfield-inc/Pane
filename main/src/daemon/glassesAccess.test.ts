import http from 'http';
import type { AddressInfo } from 'net';
import WebSocket, { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../types/config';
import { PaneCommandRegistry, type PaneCommandValue } from './commandRegistry';
import { GlassesAccess } from './glassesAccess';
import { PaneRemoteHttpApiServer, type WorkspaceAccessPolicy } from './httpApiServer';
import { hashRemoteDaemonToken } from './auth';
import { createDefaultRemoteDaemonConfig, normalizeRemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import { GLASSES_COMMANDS } from '../../../shared/types/glasses';
import { boundary, decodeBoundary, type JsonValue } from '../../../shared/validation/boundaryDecoder';

const OWNER = 'owner@example.com';
const TEAMMATE = 'teammate@example.com';
const EVEN = 'https://even-app.example';
const servers: PaneRemoteHttpApiServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  vi.unstubAllEnvs();
});

/** What a request through Tailscale Serve carries; the glasses add Origin and Authorization. */
interface RequestHeaders {
  [name: string]: string;
}

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: JsonValue;
}

async function setup(options: { visibility?: WorkspaceAccessPolicy['visibility']; heartbeatIntervalMs?: number; deepgramListenEndpoint?: string } = {}) {
  let config: Pick<AppConfig, 'remoteDaemon' | 'workspaces'> = { remoteDaemon: createDefaultRemoteDaemonConfig() };
  const store = {
    getConfig: () => config,
    updateConfigWith: async (update: (current: AppConfig) => Partial<AppConfig>) => {
      // SAFETY: the glasses store reads and writes only remoteDaemon.
      config = { ...config, ...update(config as AppConfig) };
      return config;
    },
  };
  let now = Date.parse('2026-10-28T08:00:00.000Z');
  const log: string[] = [];
  const glasses = new GlassesAccess(store, { now: () => now, env: { PANE_GLASSES_ORIGINS: EVEN }, log: (line) => log.push(line) });
  const registry = new PaneCommandRegistry();
  const calls: Array<{ channel: string; args: PaneCommandValue[] }> = [];
  const record = (channel: string) => registry.register(channel, (...args: PaneCommandValue[]) => {
    calls.push({ channel, args });
    return { ran: channel };
  });
  for (const channel of ['runpane:panels:screen', 'runpane:panels:submit', 'notify:remote-command', 'file:write', 'git:commit', 'runpane:machine:exec', 'remote:settings:update', 'terminal:input']) {
    record(channel);
  }
  registry.register(GLASSES_COMMANDS.createPairingSecret, (request: PaneCommandValue) => {
    const { deviceName, phoneId } = decodeBoundary(request, boundary.object({ deviceName: boundary.string, phoneId: boundary.string }));
    return glasses.createPairingSecret(deviceName, phoneId);
  });
  registry.register(GLASSES_COMMANDS.list, () => ({ devices: glasses.list() }));
  const access = (): WorkspaceAccessPolicy => ({
    ownerLogin: OWNER,
    visibility: options.visibility ?? 'owner',
    tailnetLogins: new Set([OWNER, TEAMMATE]),
    verifySecret: null,
  });
  const server = new PaneRemoteHttpApiServer(registry, { getConfig: () => ({ remoteDaemon: config.remoteDaemon }) }, {
    heartbeatIntervalMs: options.heartbeatIntervalMs,
    deepgramListenEndpoint: options.deepgramListenEndpoint,
    workspace: { listenPort: 0, pathSecret: 'serve-secret', access, glasses },
  });
  servers.push(server);
  await server.start();
  const port = server.getAddress()?.port ?? 0;

  const request = (method: string, path: string, headers: Record<string, string>, body?: JsonValue) => new Promise<Response>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: `/serve-secret${path}`, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text ? decodeBoundary(JSON.parse(text), boundary.json) : null });
      });
    });
    req.once('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const invoke = (channel: string, args: JsonValue[], headers: Record<string, string>) => request('POST', '/invoke', headers, { channel, args });
  /** Serve's identity header, the Even origin and the token, as the glasses send them through Serve. */
  const fromGlasses = (token?: string, extra: Record<string, string> = {}) => {
    const headers: RequestHeaders = { 'Tailscale-User-Login': OWNER, 'X-Forwarded-For': '100.101.102.103', Origin: EVEN };
    if (token) headers.Authorization = `Bearer ${token}`;
    return { ...headers, ...extra };
  };
  /** The owner's Pane phone app: identity, no Origin. */
  const fromPhone = { 'Tailscale-User-Login': OWNER };

  const pair = async (deviceName = 'Even G2 · iPhone', phoneId = 'pane-native-phone-a') => {
    const minted = await invoke(GLASSES_COMMANDS.createPairingSecret, [{ deviceName, phoneId }], fromPhone);
    const secret = readString(minted.body, 'result', 'secret');
    const paired = await invoke(GLASSES_COMMANDS.pair, [{ secret }], fromGlasses());
    return { secret, token: readString(paired.body, 'result', 'token'), paired };
  };

  return {
    server, glasses, calls, log, port, request, invoke, fromGlasses, fromPhone, pair,
    config: () => config,
    advance: (ms: number) => { now += ms; },
  };
}

function readString(value: JsonValue, ...path: string[]): string {
  let current: JsonValue = value;
  for (const key of path) current = decodeBoundary(current, boundary.jsonObject)[key] ?? null;
  return decodeBoundary(current, boundary.string);
}

function errorCode(response: Response): string {
  return readString(response.body, 'error', 'code');
}

describe('glasses on the workspace listener', () => {
  it('pairs from the phone in one step: a single-use secret becomes a 256-bit device token stored only as a hash', async () => {
    const host = await setup();
    const { secret, token, paired } = await host.pair();

    expect(paired.status).toBe(200);
    expect(Buffer.from(token.slice('pgt_'.length), 'base64url').length).toBeGreaterThanOrEqual(32);
    expect(Buffer.from(secret.slice('pgs_'.length), 'base64url').length).toBeGreaterThanOrEqual(32);
    const stored = JSON.stringify(host.config());
    expect(stored).not.toContain(token);
    // Stored in its own hash domain, so a Pane that predates glasses can't admit it as a paired client.
    expect(stored).not.toContain(hashRemoteDaemonToken(token));
    expect(host.glasses.verifyToken(token)?.label).toBe('Even G2 · iPhone');

    const reused = await host.invoke(GLASSES_COMMANDS.pair, [{ secret }], host.fromGlasses());
    expect(reused.status).toBe(403);
    expect(errorCode(reused)).toBe('ERR_GLASSES_PAIRING_SECRET_INVALID');

    const listed = await host.invoke(GLASSES_COMMANDS.list, [], host.fromPhone);
    expect(listed.body).toMatchObject({ ok: true, result: { devices: [{ label: 'Even G2 · iPhone' }] } });
  });

  it('tells two phones with the same name apart, and replaces only the glasses a phone paired before', async () => {
    const host = await setup();
    const first = await host.pair('Even G2 · iPhone', 'pane-native-phone-a');
    const other = await host.pair('Even G2 · iPhone', 'pane-native-phone-b');
    const again = await host.pair('Even G2 · iPhone', 'pane-native-phone-a');

    expect(host.glasses.verifyToken(first.token)).toBeNull();
    expect(host.glasses.verifyToken(other.token)?.phoneId).toBe('pane-native-phone-b');
    expect(host.glasses.verifyToken(again.token)?.phoneId).toBe('pane-native-phone-a');
    expect(host.glasses.list().map((device) => device.phoneId).sort()).toEqual(['pane-native-phone-a', 'pane-native-phone-b']);
  });

  it('refuses a pairing secret that is more than 10 minutes old', async () => {
    const host = await setup();
    const minted = await host.invoke(GLASSES_COMMANDS.createPairingSecret, [{ deviceName: 'Even G2', phoneId: 'pane-native-phone-a' }], host.fromPhone);
    host.advance(10 * 60_000 + 1);
    const late = await host.invoke(GLASSES_COMMANDS.pair, [{ secret: readString(minted.body, 'result', 'secret') }], host.fromGlasses());
    expect(late.status).toBe(403);
  });

  it('reaches exactly its allowlist', async () => {
    const host = await setup();
    const { token } = await host.pair();
    const allowed = await host.invoke('runpane:panels:screen', [{ panelId: 'p1' }], host.fromGlasses(token));
    expect(allowed).toMatchObject({ status: 200, body: { ok: true, result: { ran: 'runpane:panels:screen' } } });

    for (const channel of ['file:write', 'git:commit', 'runpane:machine:exec', 'remote:settings:update', 'terminal:input',
      GLASSES_COMMANDS.createPairingSecret, GLASSES_COMMANDS.list, GLASSES_COMMANDS.revoke]) {
      const refused = await host.invoke(channel, [{}], host.fromGlasses(token));
      expect({ channel, status: refused.status, code: errorCode(refused) })
        .toEqual({ channel, status: 403, code: 'ERR_GLASSES_CHANNEL_REFUSED' });
    }
    expect(host.calls.map((call) => call.channel)).toEqual(['runpane:panels:screen']);

    for (const path of ['/media?sessionId=s&filePath=a', '/app/index.html']) {
      expect((await host.request('GET', path, host.fromGlasses(token))).status).toBe(403);
    }
  });

  it('needs both factors: the owner\'s Tailscale identity and a glasses token', async () => {
    const host = await setup({ visibility: 'tailnet' });
    const { token } = await host.pair();
    const screen = (headers: Record<string, string>) => host.invoke('runpane:panels:screen', [{}], headers);

    const { 'Tailscale-User-Login': _login, ...noIdentity } = host.fromGlasses(token);
    expect((await screen(noIdentity)).status).toBe(403);
    expect((await screen(host.fromGlasses())).status).toBe(401);
    expect((await screen(host.fromGlasses(token, { 'Tailscale-User-Login': TEAMMATE }))).status).toBe(403);
    expect((await screen(host.fromGlasses(token))).status).toBe(200);
  });

  it('accepts only an exact allowed origin and never a credential in the URL', async () => {
    const host = await setup();
    const { token } = await host.pair();
    const screen = (headers: Record<string, string>, query = '') => host.request('POST', `/invoke${query}`, headers, { channel: 'runpane:panels:screen', args: [{}] });

    for (const origin of ['https://attacker.example', 'null', `${EVEN}.attacker.example`]) {
      const refused = await screen(host.fromGlasses(token, { Origin: origin }));
      expect({ origin, status: refused.status }).toEqual({ origin, status: 403 });
    }
    const { Origin: _origin, ...noOrigin } = host.fromGlasses(token);
    expect(errorCode(await screen(noOrigin))).toBe('ERR_GLASSES_ORIGIN_REFUSED');
    expect(errorCode(await screen(host.fromGlasses(), `?access_token=${token}`))).toBe('ERR_GLASSES_CREDENTIAL_IN_URL');

    const preflight = await host.request('OPTIONS', '/invoke', { Origin: EVEN, 'Access-Control-Request-Headers': 'authorization' });
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-headers']).toContain('Authorization');
    expect((await host.request('OPTIONS', '/invoke', { Origin: 'https://attacker.example' })).status).toBe(403);
  });

  it('does not let a web page on the owner\'s phone lock the glasses out with wrong-origin requests', async () => {
    const host = await setup();
    const { token } = await host.pair();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await host.invoke('runpane:panels:screen', [{}], host.fromGlasses('pgt_guess', { Origin: 'https://attacker.example' }));
    }
    expect((await host.invoke('runpane:panels:screen', [{}], host.fromGlasses(token))).status).toBe(200);
  });

  it('refuses glasses tokens while Funnel is on, saying so', async () => {
    const host = await setup();
    const { token } = await host.pair();
    const viaFunnel = await host.invoke('runpane:panels:screen', [{}], host.fromGlasses(token, { 'Tailscale-Funnel-Request': '?1' }));
    expect(viaFunnel.status).toBe(403);
    expect(readString(viaFunnel.body, 'error', 'message')).toContain('Funnel');

    host.glasses.setFunnelOn(true);
    expect(errorCode(await host.invoke('runpane:panels:screen', [{}], host.fromGlasses(token)))).toBe('ERR_GLASSES_FUNNEL_REFUSED');
  });

  it('locks a source out for a minute after 5 failures in 10 minutes, doubling on repeat, and logs no token', async () => {
    const host = await setup();
    const { token } = await host.pair();
    const badToken = `pgt_${'A'.repeat(43)}`;
    const screen = (presented: string) => host.invoke('runpane:panels:screen', [{}], host.fromGlasses(presented));

    for (let attempt = 0; attempt < 5; attempt += 1) expect((await screen(badToken)).status).toBe(401);
    expect(errorCode(await screen(token))).toBe('ERR_GLASSES_LOCKED_OUT');
    host.advance(60_000);
    expect((await screen(token)).status).toBe(200);

    for (let attempt = 0; attempt < 5; attempt += 1) await screen(badToken);
    host.advance(60_000);
    expect((await screen(token)).status).toBe(429);
    host.advance(60_000);
    expect((await screen(token)).status).toBe(200);

    const failures = host.log.filter((line) => line.includes('refused token'));
    expect(failures).toHaveLength(10);
    expect(failures[0]).toMatch(/refused token from owner@example\.com@100\.101\.102\.103 at 2026-10-28T08:00:00\.000Z/);
    expect(host.log.join('\n')).not.toContain(badToken);
    expect(host.log.join('\n')).not.toContain(token);
  });

  it('stamps a Notify answer with the glasses\' own name, whatever the request claims', async () => {
    const host = await setup();
    const { token } = await host.pair('Even G2 · Parsa\'s iPhone');
    await host.invoke('notify:remote-command', [{ id: 'q1', answer: 'yes' }, { device: 'someone else' }],
      host.fromGlasses(token, { 'X-Pane-Client-Device-Label': 'spoofed' }));
    expect(host.calls).toEqual([{ channel: 'notify:remote-command', args: [{ id: 'q1', answer: 'yes' }, { device: 'Even G2 · Parsa\'s iPhone' }] }]);
  });

  it('streams Notify, status and list events to glasses, never terminal output, and closes the stream on revoke', async () => {
    const host = await setup({ heartbeatIntervalMs: 50 });
    const { token } = await host.pair();
    const events: string[] = [];
    let closed = false;
    await new Promise<void>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: host.port, path: '/serve-secret/events', headers: host.fromGlasses(token) }, (res) => {
        expect(res.statusCode).toBe(200);
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          for (const match of chunk.matchAll(/"channel":"([^"]+)"/g)) events.push(match[1]);
        });
        res.on('end', () => { closed = true; });
        resolve();
      });
      req.once('error', reject);
      req.end();
    });

    const sink = host.server.getEventSink();
    sink.send('terminal:output', { panelId: 'p1', data: 'secret shell output' });
    sink.send('session:output', { sessionId: 's1', data: 'more output' });
    sink.send('notify:shared-changed', { items: [] });
    sink.send('panel:agentStatus', { panelId: 'p1', status: 'working' });
    await vi.waitFor(() => expect(events).toEqual(['notify:shared-changed', 'panel:agentStatus']));

    const id = host.glasses.list()[0].id;
    await host.glasses.revoke(id);
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1000 });
    expect((await host.invoke('runpane:panels:screen', [{}], host.fromGlasses(token))).status).toBe(401);
  });

  it('ends an open stream when the owner removes the origin it came in with', async () => {
    const host = await setup({ heartbeatIntervalMs: 50 });
    const { token } = await host.pair();
    const origin = 'https://plugins.even.example';
    await host.glasses.setOwnerOrigin(origin, true);
    let closed = false;
    await new Promise<void>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: host.port, path: '/serve-secret/events', headers: host.fromGlasses(token, { Origin: origin }) }, (res) => {
        expect(res.statusCode).toBe(200);
        res.resume();
        res.on('end', () => { closed = true; });
        resolve();
      });
      req.once('error', reject);
      req.end();
    });
    await host.glasses.setOwnerOrigin(origin, false);
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1000 });
  });

  it('runs no command whose body arrives after the glasses lost access', async () => {
    const host = await setup();
    const { token } = await host.pair();
    const origin = 'https://plugins.even.example';
    await host.glasses.setOwnerOrigin(origin, true);
    /** Sends the headers now and the body only after `withdraw` has run. */
    const slowSubmit = (headers: Record<string, string>, withdraw: () => Promise<void>) => new Promise<Response>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: host.port, method: 'POST', path: '/serve-secret/invoke', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: decodeBoundary(JSON.parse(Buffer.concat(chunks).toString('utf8')), boundary.json) }));
      });
      req.once('error', reject);
      req.write('{"channel":"runpane:panels:submit",');
      req.flushHeaders();
      setTimeout(() => {
        void withdraw().then(() => req.end('"args":[{"text":"rm -rf build"}]}'), reject);
      }, 50);
    });

    const afterOriginRemoved = await slowSubmit(host.fromGlasses(token, { Origin: origin }), async () => { await host.glasses.setOwnerOrigin(origin, false); });
    const afterRevoke = await slowSubmit(host.fromGlasses(token), async () => { await host.glasses.revoke(host.glasses.list()[0].id); });

    expect([afterOriginRemoved.status, errorCode(afterOriginRemoved)]).toEqual([403, 'ERR_GLASSES_ACCESS_WITHDRAWN']);
    expect([afterRevoke.status, errorCode(afterRevoke)]).toEqual([403, 'ERR_GLASSES_ACCESS_WITHDRAWN']);
    expect(host.calls).toEqual([]);
  });

  it('closes an open voice stream when the owner removes the origin it came in with', async () => {
    const upstream = new WebSocketServer({ port: 0 });
    let upstreamClosed = false;
    upstream.on('connection', (socket) => socket.once('close', () => { upstreamClosed = true; }));
    await new Promise<void>((resolve) => upstream.once('listening', resolve));
    vi.stubEnv('DEEPGRAM_API_KEY', 'test-key');
    try {
      // SAFETY: a TCP server that is listening reports an AddressInfo.
      const host = await setup({ heartbeatIntervalMs: 50, deepgramListenEndpoint: `ws://127.0.0.1:${(upstream.address() as AddressInfo).port}` });
      const { token } = await host.pair();
      const origin = 'https://plugins.even.example';
      await host.glasses.setOwnerOrigin(origin, true);
      const socket = new WebSocket(`ws://127.0.0.1:${host.port}/serve-secret/voice/deepgram-stream`, ['pane-glasses', token], {
        headers: { 'Tailscale-User-Login': OWNER, Origin: origin },
      });
      let closed = false;
      socket.once('close', () => { closed = true; });
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });

      await host.glasses.setOwnerOrigin(origin, false);
      await vi.waitFor(() => expect([closed, upstreamClosed]).toEqual([true, true]), { timeout: 1000 });
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it('carries the voice token in the WebSocket subprotocol and checks the origin there too', async () => {
    vi.stubEnv('DEEPGRAM_API_KEY', '');
    const host = await setup();
    const { token } = await host.pair();
    const upgrade = (origin: string) => new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${host.port}/serve-secret/voice/deepgram-stream`, ['pane-glasses', token], {
        headers: { 'Tailscale-User-Login': OWNER, Origin: origin },
      });
      socket.once('unexpected-response', (_request, response) => {
        resolve(response.statusCode ?? 0);
        socket.terminate();
      });
      socket.once('open', () => reject(new Error('opened without a Deepgram key')));
      socket.once('error', reject);
    });
    // Admitted past every glasses check, the host reports the missing key.
    expect(await upgrade(EVEN)).toBe(503);
    expect(await upgrade('https://attacker.example')).toBe(403);
  });

  it('keeps today\'s refusal for browser pages without a glasses token', async () => {
    const host = await setup();
    const page = await host.invoke('runpane:panels:screen', [{}], { 'Tailscale-User-Login': OWNER, Origin: 'https://attacker.example' });
    expect(errorCode(page)).toBe('ERR_WORKSPACE_BROWSER_REFUSED');
  });

  it('lets the owner allow a refused origin exactly, in one step, and never null or a wildcard', async () => {
    const host = await setup();
    const { token } = await host.pair();
    const newOrigin = 'https://plugins.even.example';
    const screen = () => host.invoke('runpane:panels:screen', [{}], host.fromGlasses(token, { Origin: newOrigin }));

    expect(errorCode(await screen())).toBe('ERR_GLASSES_ORIGIN_REFUSED');
    expect(host.glasses.state().refusedOrigins).toEqual([{ origin: newOrigin, at: '2026-10-28T08:00:00.000Z' }]);
    host.advance(60_000);
    await screen();
    expect(host.glasses.state().refusedOrigins).toEqual([{ origin: newOrigin, at: '2026-10-28T08:01:00.000Z' }]);
    expect(host.log.filter((line) => line.includes(`refused browser origin ${newOrigin}`))).toHaveLength(1);

    await host.glasses.setOwnerOrigin(newOrigin, true);
    expect((await screen()).status).toBe(200);
    expect(host.glasses.state()).toMatchObject({ refusedOrigins: [], allowedOrigins: [{ origin: EVEN, source: 'environment' }, { origin: newOrigin, source: 'owner' }] });
    expect((await host.invoke('runpane:panels:screen', [{}], host.fromGlasses(token, { Origin: `${newOrigin}:8080` }))).status).toBe(403);

    for (const invalid of ['null', 'https://*.even.example', 'https://even.example/path', '*']) {
      await expect(host.glasses.setOwnerOrigin(invalid, true)).rejects.toMatchObject({ code: 'ERR_GLASSES_ORIGIN_INVALID' });
    }
    await host.glasses.setOwnerOrigin(newOrigin, false);
    expect((await screen()).status).toBe(403);

    await host.invoke('runpane:panels:screen', [{}], { 'Tailscale-User-Login': OWNER, Origin: 'null' });
    expect(host.glasses.state().refusedOrigins.map((entry) => entry.origin)).not.toContain('null');
  });

  it('lets only the owner\'s own app pair, list and revoke glasses', async () => {
    const host = await setup({ visibility: 'tailnet' });
    const teammate = await host.invoke(GLASSES_COMMANDS.createPairingSecret, [{ deviceName: 'x' }], { 'Tailscale-User-Login': TEAMMATE });
    expect(errorCode(teammate)).toBe('ERR_GLASSES_OWNER_REQUIRED');
    const pairWithoutGlassesOrigin = await host.invoke(GLASSES_COMMANDS.pair, [{ secret: 'pgs_x' }], host.fromPhone);
    expect(errorCode(pairWithoutGlassesOrigin)).toBe('ERR_GLASSES_OWNER_REQUIRED');
  });
});

describe('glasses tokens on the paired listener', () => {
  it('are refused: they work only on the workspace listener', async () => {
    const config = createDefaultRemoteDaemonConfig();
    config.host.config = { ...config.host.config, enabled: true, listenPort: 0 };
    config.host.clients = normalizeRemoteDaemonConfig({ host: { clients: [{ id: 'g1', label: 'Even G2', createdAt: '2026-10-28T00:00:00.000Z', tokenHash: hashRemoteDaemonToken('pgt_glasses'), kind: 'glasses' }] } }).host.clients;
    expect(config.host.clients[0].kind).toBe('glasses');
    const registry = new PaneCommandRegistry();
    registry.register('runpane:panels:screen', () => ({}));
    const server = new PaneRemoteHttpApiServer(registry, { getConfig: () => ({ remoteDaemon: config }) });
    servers.push(server);
    await server.start();
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.getAddress()?.port, method: 'POST', path: '/invoke', headers: { Authorization: 'Bearer pgt_glasses', 'Content-Type': 'application/json' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.once('error', reject);
      req.end(JSON.stringify({ channel: 'runpane:panels:screen', args: [] }));
    });
    expect(status).toBe(403);
  });
});
