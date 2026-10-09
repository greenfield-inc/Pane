import net from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createDefaultRemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import { hashRemoteDaemonToken } from './auth';
import { PaneCommandRegistry } from './commandRegistry';
import { PaneRemoteHttpApiServer, type WorkspaceAccessPolicy } from './httpApiServer';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A TCP server on `host` that echoes every byte back, like any service a dev runs. */
async function startEchoServer(host = '127.0.0.1'): Promise<number> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.pipe(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve());
  });
  cleanups.push(() => new Promise<void>(resolve => {
    for (const socket of sockets) socket.destroy();
    server.close(() => resolve());
  }));
  // SAFETY: a server listening on a host and port reports an AddressInfo.
  return (server.address() as net.AddressInfo).port;
}

async function startPairingServer(forwarded: () => readonly number[]): Promise<PaneRemoteHttpApiServer> {
  const config = createDefaultRemoteDaemonConfig();
  config.host.config = { ...config.host.config, enabled: true, listenHost: '127.0.0.1', listenPort: 0 };
  config.host.clients = [{
    id: 'client-1',
    label: 'Mac mini',
    createdAt: new Date('2026-10-09T00:00:00.000Z').toISOString(),
    tokenHash: hashRemoteDaemonToken('secret-token'),
  }];
  const server = new PaneRemoteHttpApiServer(new PaneCommandRegistry(), { getConfig: () => ({ remoteDaemon: config }) }, {
    isForwardedPort: port => forwarded().includes(port),
  });
  await server.start();
  cleanups.push(() => server.stop());
  return server;
}

const owner = 'owner@example.com';
const teammate = 'teammate@example.com';

async function startWorkspaceServer(forwarded: () => readonly number[]): Promise<PaneRemoteHttpApiServer> {
  const access: WorkspaceAccessPolicy = {
    ownerLogin: owner,
    visibility: 'owner',
    tailnetLogins: new Set([owner, teammate]),
    verifySecret: null,
  };
  const server = new PaneRemoteHttpApiServer(new PaneCommandRegistry(), { getConfig: () => ({}) }, {
    workspace: { listenPort: 0, pathSecret: 'serve-secret', access: () => access },
    isForwardedPort: port => forwarded().includes(port),
  });
  await server.start();
  cleanups.push(() => server.stop());
  return server;
}

type StreamResult = { opened: WebSocket } | { statusCode: number };

function openStream(server: PaneRemoteHttpApiServer, path: string, headers: Record<string, string> = {}): Promise<StreamResult> {
  const address = server.getAddress();
  if (!address) throw new Error('server is not listening');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}${path}`, { headers });
  return new Promise((resolve, reject) => {
    socket.once('open', () => {
      cleanups.push(() => socket.terminate());
      resolve({ opened: socket });
    });
    socket.once('unexpected-response', (_request, response) => {
      resolve({ statusCode: response.statusCode ?? 0 });
      socket.terminate();
    });
    socket.once('error', reject);
  });
}

async function roundTrip(result: StreamResult, text: string): Promise<string> {
  if (!('opened' in result)) throw new Error(`stream refused with ${result.statusCode}`);
  const socket = result.opened;
  const reply = new Promise<string>(resolve => {
    let received = '';
    socket.on('message', (data: Buffer) => {
      received += data.toString('utf8');
      if (received.length >= text.length) resolve(received);
    });
  });
  socket.send(Buffer.from(text, 'utf8'));
  return reply;
}

const bearer = { Authorization: 'Bearer secret-token' };

describe('port stream through the pairing-code door', () => {
  it('carries bytes to and from a forwarded port', async () => {
    const port = await startEchoServer();
    const server = await startPairingServer(() => [port]);
    expect(await roundTrip(await openStream(server, `/ports/${port}`, bearer), 'hello host')).toBe('hello host');
  });

  it('reaches a service that listens only on IPv6 loopback, as Vite does on macOS', async () => {
    let port: number;
    try {
      port = await startEchoServer('::1');
    } catch {
      return; // This machine has no IPv6 loopback.
    }
    const server = await startPairingServer(() => [port]);
    expect(await roundTrip(await openStream(server, `/ports/${port}`, bearer), 'v6')).toBe('v6');
  });

  it('refuses a client without a pairing token', async () => {
    const port = await startEchoServer();
    const server = await startPairingServer(() => [port]);
    expect(await openStream(server, `/ports/${port}`)).toEqual({ statusCode: 401 });
  });

  it('refuses a port that is not in the forwarded list, even when something listens on it', async () => {
    const port = await startEchoServer();
    const server = await startPairingServer(() => []);
    expect(await openStream(server, `/ports/${port}`, bearer)).toEqual({ statusCode: 403 });
  });
});

describe('port stream through the Tailscale login door', () => {
  it('carries bytes for an admitted login that came through Serve', async () => {
    const port = await startEchoServer();
    const server = await startWorkspaceServer(() => [port]);
    const result = await openStream(server, `/serve-secret/ports/${port}`, { 'Tailscale-User-Login': owner });
    expect(await roundTrip(result, 'over serve')).toBe('over serve');
  });

  it('answers 404 without the per-launch path, even with a forged login header', async () => {
    const port = await startEchoServer();
    const server = await startWorkspaceServer(() => [port]);
    expect(await openStream(server, `/ports/${port}`, { 'Tailscale-User-Login': owner })).toEqual({ statusCode: 404 });
  });

  it('refuses a login that "Who can connect" does not admit', async () => {
    const port = await startEchoServer();
    const server = await startWorkspaceServer(() => [port]);
    expect(await openStream(server, `/serve-secret/ports/${port}`, { 'Tailscale-User-Login': teammate })).toEqual({ statusCode: 403 });
  });

  it('refuses a request a web page sent, which carries an Origin', async () => {
    const port = await startEchoServer();
    const server = await startWorkspaceServer(() => [port]);
    const fromPage = await openStream(server, `/serve-secret/ports/${port}`, {
      'Tailscale-User-Login': owner,
      Origin: 'https://attacker.example',
    });
    expect(fromPage).toEqual({ statusCode: 403 });
  });
});
