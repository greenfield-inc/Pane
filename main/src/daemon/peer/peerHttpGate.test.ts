import http from 'http';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultRemoteDaemonConfig, type RemoteDaemonConfig } from '../../../../shared/types/remoteDaemon';
import { boundary, decodeBoundary, type JsonValue } from '../../../../shared/validation/boundaryDecoder';
import { hashRemoteDaemonToken } from '../auth';
import { PaneCommandRegistry, type PaneCommandValue } from '../commandRegistry';
import { PaneRemoteHttpApiServer } from '../httpApiServer';
import { PeerRateLimiter, type PeerSessionInfo } from './peerPolicy';

const servers: PaneRemoteHttpApiServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

const sessionB: PeerSessionInfo = {
  id: 'session-b',
  name: 'Session B',
  archived: false,
  internalSessionId: 'pane-b',
  orchestratorPanelId: 'panel-orch-b',
};

function remoteConfig(): RemoteDaemonConfig {
  const config = createDefaultRemoteDaemonConfig();
  config.host.config = { ...config.host.config, enabled: true, listenHost: '127.0.0.1', listenPort: 0 };
  const createdAt = '2026-09-30T00:00:00.000Z';
  config.host.clients = [
    { id: 'desk', label: 'Desk', createdAt, tokenHash: hashRemoteDaemonToken('full-token') },
    {
      id: 'peer-a', label: 'Session A', createdAt, tokenHash: hashRemoteDaemonToken('peer-token'),
      scope: 'peer', allowedSessionIds: ['session-b'],
    },
    {
      id: 'peer-x', label: 'Session X', createdAt, tokenHash: hashRemoteDaemonToken('unlisted-token'),
      scope: 'peer', allowedSessionIds: [],
    },
  ];
  return config;
}

async function startServer(options: { rateLimit?: number } = {}) {
  const calls: Array<{ channel: string; args: PaneCommandValue[] }> = [];
  const registry = new PaneCommandRegistry();
  const record = (channel: string, result: PaneCommandValue) => {
    registry.register(channel, (...args: PaneCommandValue[]) => {
      calls.push({ channel, args });
      return result;
    });
  };
  record('runpane:panels:submit', { ok: true, panelId: 'panel-orch-b' });
  record('runpane:panels:list', {
    ok: true,
    paneId: 'pane-b',
    panels: [{ id: 'panel-orch-b', title: 'Claude' }, { id: 'panel-shell-b', title: 'Terminal' }],
  });
  record('runpane:workspace:wait', { ok: true, entries: [] });
  record('runpane:report', { ok: true });
  const config = remoteConfig();
  const server = new PaneRemoteHttpApiServer(registry, { getConfig: () => ({ remoteDaemon: config }) }, {
    readPeerSessions: async () => [sessionB],
    peerRateLimiter: new PeerRateLimiter(options.rateLimit ?? 10, 60_000),
  });
  await server.start();
  servers.push(server);
  return { server, calls };
}

function invoke(server: PaneRemoteHttpApiServer, token: string, channel: string, args: JsonValue[]) {
  return request(server, 'POST', '/invoke', token, { channel, args });
}

function request(
  server: PaneRemoteHttpApiServer,
  method: 'GET' | 'POST',
  path: string,
  token: string,
  body?: JsonValue,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; body: string }> {
  const address = server.getAddress();
  if (!address) throw new Error('server is not listening');
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      host: address.host,
      port: address.port,
      path,
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({ statusCode: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    outgoing.once('error', reject);
    if (body !== undefined) outgoing.write(JSON.stringify(body));
    outgoing.end();
  });
}

function upgrade(server: PaneRemoteHttpApiServer, path: string, token: string): Promise<number> {
  const address = server.getAddress();
  if (!address) throw new Error('server is not listening');
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      host: address.host,
      port: address.port,
      path,
      headers: {
        Authorization: `Bearer ${token}`,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    });
    outgoing.on('response', response => { response.resume(); resolve(response.statusCode ?? 0); });
    outgoing.on('upgrade', (response, socket) => { socket.destroy(); resolve(response.statusCode ?? 101); });
    outgoing.once('error', reject);
    outgoing.end();
  });
}

function errorCode(body: string): string | undefined {
  const parsed = decodeBoundary(JSON.parse(body), boundary.object({
    error: boundary.optional(boundary.object({ code: boundary.string })),
  }));
  return parsed.error?.code;
}

describe('peer gate on the remote HTTP API', () => {
  it('delivers a framed submit to the allowlisted orchestrator panel with a per-peer idempotency key', async () => {
    const { server, calls } = await startServer();
    const response = await invoke(server, 'peer-token', 'runpane:panels:submit', [
      { panelId: 'panel-orch-b', input: 'build is green', idempotencyKey: 'msg-1' },
    ]);
    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([{
      channel: 'runpane:panels:submit',
      args: [{ panelId: 'panel-orch-b', input: '[peer message from Session A] build is green', agentOnly: true, idempotencyKey: 'peer-a:msg-1' }],
    }]);
  });

  it('refuses a shell panel, other channels and an unlisted peer with 403 before any command runs', async () => {
    const { server, calls } = await startServer();
    const shell = await invoke(server, 'peer-token', 'runpane:panels:submit', [{ panelId: 'panel-shell-b', input: 'ls' }]);
    expect([shell.statusCode, errorCode(shell.body)]).toEqual([403, 'ERR_PEER_PANEL_FORBIDDEN']);
    const report = await invoke(server, 'peer-token', 'runpane:report', [{ state: 'done' }]);
    expect([report.statusCode, errorCode(report.body)]).toEqual([403, 'ERR_PEER_CHANNEL_FORBIDDEN']);
    const unlisted = await invoke(server, 'unlisted-token', 'runpane:panels:submit', [{ panelId: 'panel-orch-b', input: 'hi' }]);
    expect([unlisted.statusCode, errorCode(unlisted.body)]).toEqual([403, 'ERR_PEER_NOT_ALLOWLISTED']);
    expect(calls).toEqual([]);
  });

  it('refuses the event stream and WebSocket upgrades to peers but not to full clients', async () => {
    const { server } = await startServer();
    const events = await request(server, 'GET', '/events?auth_check=1', 'peer-token');
    expect([events.statusCode, errorCode(events.body)]).toEqual([403, 'ERR_PEER_EVENTS_FORBIDDEN']);
    expect((await request(server, 'GET', '/events?auth_check=1', 'full-token')).statusCode).toBe(204);
    expect(await upgrade(server, '/voice/deepgram-stream', 'peer-token')).toBe(403);
    expect(await upgrade(server, '/anything', 'peer-token')).toBe(403);
    // A full client still reaches the voice proxy's own checks (no Deepgram key here).
    expect(await upgrade(server, '/voice/deepgram-stream', 'full-token')).toBe(503);
  });

  it('shows a peer only the orchestrator panel and scopes workspace:wait to its Session', async () => {
    const { server, calls } = await startServer();
    const list = await invoke(server, 'peer-token', 'runpane:panels:list', []);
    expect(list.statusCode).toBe(200);
    expect(JSON.parse(list.body).result.panels).toEqual([{ id: 'panel-orch-b', title: 'Claude' }]);
    await invoke(server, 'peer-token', 'runpane:workspace:wait', [{ timeoutMs: 10 }]);
    expect(calls.map(call => call.args)).toEqual([[{ paneId: 'pane-b' }], [{ timeoutMs: 10, session: 'session-b' }]]);
  });

  it('rate limits peer submits', async () => {
    const { server } = await startServer({ rateLimit: 1 });
    const args: JsonValue[] = [{ panelId: 'panel-orch-b', input: 'one' }];
    expect((await invoke(server, 'peer-token', 'runpane:panels:submit', args)).statusCode).toBe(200);
    const limited = await invoke(server, 'peer-token', 'runpane:panels:submit', args);
    expect([limited.statusCode, errorCode(limited.body)]).toEqual([429, 'ERR_PEER_RATE_LIMITED']);
  });

  it('leaves full clients unrestricted and namespaces their idempotency keys too', async () => {
    const { server, calls } = await startServer();
    expect((await invoke(server, 'full-token', 'runpane:report', [{}])).statusCode).toBe(200);
    await invoke(server, 'full-token', 'runpane:panels:submit', [{ panelId: 'panel-shell-b', input: 'ls', idempotencyKey: 'k' }]);
    expect(calls[1]).toEqual({
      channel: 'runpane:panels:submit',
      args: [{ panelId: 'panel-shell-b', input: 'ls', idempotencyKey: 'desk:k' }],
    });
  });
});
