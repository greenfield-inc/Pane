import http from 'http';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultRemoteDaemonConfig } from '../../../../shared/types/remoteDaemon';
import { boundary, decodeBoundary, type JsonValue } from '../../../../shared/validation/boundaryDecoder';
import { hashRemoteDaemonToken } from '../auth';
import { PaneCommandError } from '../../core/commandError';
import { PaneCommandRegistry, type PaneCommandValue } from '../commandRegistry';
import { PaneRemoteHttpApiServer } from '../httpApiServer';
import { SESSION_STOPPING_CODE } from './stopLease';

const servers: PaneRemoteHttpApiServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

async function startServer() {
  const calls: string[] = [];
  const registry = new PaneCommandRegistry();
  for (const channel of [
    'runpane:cloud:safe-to-stop', 'runpane:cloud:stop-lease:release', 'runpane:cloud:upgrade', 'runpane:cloud:coordinator-client:pair',
    'runpane:cloud:coordinator-client:revoke', 'runpane:panels:submit', 'runpane:repos:list',
  ]) {
    registry.register(channel, (..._args: PaneCommandValue[]) => {
      calls.push(channel);
      return { ok: true };
    });
  }
  const config = createDefaultRemoteDaemonConfig();
  config.host.config = { ...config.host.config, enabled: true, listenHost: '127.0.0.1', listenPort: 0 };
  const createdAt = '2026-09-30T00:00:00.000Z';
  config.host.clients = [
    { id: 'desk', label: 'Desk', createdAt, tokenHash: hashRemoteDaemonToken('full-token') },
    {
      id: 'coord', label: 'runpane-cloud-coordinator', createdAt, tokenHash: hashRemoteDaemonToken('coord-token'),
      scope: 'coordinator',
    },
  ];
  const server = new PaneRemoteHttpApiServer(registry, { getConfig: () => ({ remoteDaemon: config }) });
  await server.start();
  servers.push(server);
  return { server, calls, registry };
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

function upgrade(server: PaneRemoteHttpApiServer, token: string): Promise<number> {
  const address = server.getAddress();
  if (!address) throw new Error('server is not listening');
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      host: address.host,
      port: address.port,
      path: '/voice/deepgram-stream',
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

describe('coordinator-scoped client on the remote HTTP API', () => {
  it('may call the cloud channels the coordinator needs', async () => {
    const { server, calls } = await startServer();
    for (const channel of ['runpane:cloud:safe-to-stop', 'runpane:cloud:stop-lease:release', 'runpane:cloud:upgrade']) {
      const response = await request(server, 'POST', '/invoke', 'coord-token', { channel, args: [{}] });
      expect(response.statusCode).toBe(200);
    }
    expect(calls).toEqual(['runpane:cloud:safe-to-stop', 'runpane:cloud:stop-lease:release', 'runpane:cloud:upgrade']);
  });

  it('is refused every other channel, the event stream and WebSocket upgrades', async () => {
    const { server, calls } = await startServer();
    // Nor can it pair itself a fresh token or revoke the record the laptop revokes it by.
    for (const channel of ['runpane:panels:submit', 'runpane:repos:list', 'runpane:cloud:coordinator-client:pair', 'runpane:cloud:coordinator-client:revoke']) {
      const response = await request(server, 'POST', '/invoke', 'coord-token', { channel, args: [{ panelId: 'shell', input: 'id' }] });
      expect([response.statusCode, errorCode(response.body)]).toEqual([403, 'ERR_COORDINATOR_CHANNEL_FORBIDDEN']);
    }
    const events = await request(server, 'GET', '/events', 'coord-token');
    expect([events.statusCode, errorCode(events.body)]).toEqual([403, 'ERR_COORDINATOR_EVENTS_FORBIDDEN']);
    expect(await upgrade(server, 'coord-token')).toBe(403);
    expect(calls).toEqual([]);
  });

  it('leaves full-access clients alone', async () => {
    const { server, calls } = await startServer();
    const response = await request(server, 'POST', '/invoke', 'full-token', { channel: 'runpane:repos:list', args: [{}] });
    expect(response.statusCode).toBe(200);
    expect(calls).toEqual(['runpane:repos:list']);
  });

  it('answers a call refused by a stop lease with a retryable 503 ERR_SESSION_STOPPING', async () => {
    const { server, calls, registry } = await startServer();
    registry.setInvokeFence(channel => (channel === 'runpane:panels:submit'
      ? new PaneCommandError('This cloud Session is being stopped', SESSION_STOPPING_CODE)
      : null));
    const response = await request(server, 'POST', '/invoke', 'full-token', { channel: 'runpane:panels:submit', args: [{}] });
    expect([response.statusCode, errorCode(response.body)]).toEqual([503, 'ERR_SESSION_STOPPING']);
    expect(calls).toEqual([]);
  });
});
