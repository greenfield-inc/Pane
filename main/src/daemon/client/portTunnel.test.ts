import http from 'http';
import net from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { createDefaultRemoteDaemonConfig } from '../../../../shared/types/remoteDaemon';
import { hashRemoteDaemonToken } from '../auth';
import { PaneCommandRegistry } from '../commandRegistry';
import { PaneRemoteHttpApiServer } from '../httpApiServer';
import { createPortTunnel, type PortTunnel } from './portTunnel';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function track(tunnel: PortTunnel): PortTunnel {
  cleanups.push(() => tunnel.close());
  return tunnel;
}

/** Stands in for the host: every stream echoes its bytes back and records which port it asked for. */
async function startEchoHost(): Promise<{ openStream(port: number): WebSocket; requestedPorts: number[] }> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => wss.once('listening', () => resolve()));
  wss.on('connection', socket => socket.on('message', data => socket.send(data)));
  cleanups.push(() => new Promise<void>(resolve => {
    for (const client of wss.clients) client.terminate();
    wss.close(() => resolve());
  }));
  // SAFETY: a server listening on a host and port reports an AddressInfo.
  const { port } = wss.address() as net.AddressInfo;
  const requestedPorts: number[] = [];
  return {
    requestedPorts,
    openStream(hostPort) {
      requestedPorts.push(hostPort);
      return new WebSocket(`ws://127.0.0.1:${port}/ports/${hostPort}`);
    },
  };
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  // SAFETY: a server listening on a host and port reports an AddressInfo.
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

async function listen(server: net.Server, host: string, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  // SAFETY: a server listening on a host and port reports an AddressInfo.
  return (server.address() as net.AddressInfo).port;
}

function echoThrough(host: string, port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let received = '';
    socket.on('data', chunk => {
      received += chunk.toString('utf8');
      if (received.length >= text.length) {
        socket.destroy();
        resolve(received);
      }
    });
    socket.on('error', reject);
    socket.write(text);
  });
}

function refuses(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(true));
  });
}

describe('port tunnel', () => {
  it('listens on the host port number when it is free here, on IPv4 and IPv6 loopback', async () => {
    const host = await startEchoHost();
    const port = await freePort();
    const tunnel = track(createPortTunnel(host.openStream));

    expect(await tunnel.sync([port])).toEqual(new Map([[port, port]]));
    expect(await echoThrough('127.0.0.1', port, 'v4 bytes')).toBe('v4 bytes');
    expect(await echoThrough('::1', port, 'v6 bytes')).toBe('v6 bytes');
    expect(host.requestedPorts).toEqual([port, port]);
  });

  it('moves to another port when something here already answers on the host port', async () => {
    const host = await startEchoHost();
    // A wildcard listener, as `python3 -m http.server` makes: macOS would still let 127.0.0.1 bind over it.
    const taken = await listen(net.createServer(socket => {
      socket.on('error', () => {});
      socket.end('local app');
    }), '0.0.0.0');
    const tunnel = track(createPortTunnel(host.openStream));

    const local = (await tunnel.sync([taken])).get(taken);
    expect(local).toBeDefined();
    expect(local).not.toBe(taken);
    expect(await echoThrough('127.0.0.1', local!, 'to the host')).toBe('to the host');
    expect(host.requestedPorts).toEqual([taken]);
  });

  it('closes a port\'s listener once the host stops listing it', async () => {
    const host = await startEchoHost();
    const port = await freePort();
    const tunnel = track(createPortTunnel(host.openStream));

    await tunnel.sync([port]);
    expect(await tunnel.sync([])).toEqual(new Map());
    expect(await refuses(port)).toBe(true);
  });

  it('tunnels a host port whose number another host port moved to here', async () => {
    const host = await startEchoHost();
    // The host serves A and A+1; this computer already uses A, so A moves up and A+1 must still get a listener.
    const taken = await listen(net.createServer(), '127.0.0.1');
    const tunnel = track(createPortTunnel(host.openStream));

    const localPorts = await tunnel.sync([taken, taken + 1]);
    expect([...localPorts.keys()].sort()).toEqual([taken, taken + 1]);
    expect(new Set(localPorts.values()).size).toBe(2);
    expect(await echoThrough('127.0.0.1', localPorts.get(taken + 1)!, 'second app')).toBe('second app');
    expect(host.requestedPorts).toEqual([taken + 1]);
  });

  it('closes every listener on close', async () => {
    const host = await startEchoHost();
    const port = await freePort();
    const tunnel = createPortTunnel(host.openStream);

    await tunnel.sync([port]);
    await tunnel.close();
    expect(await refuses(port)).toBe(true);
  });

  it('loads a host web server through the host\'s port stream route', async () => {
    const page = http.createServer((_request, response) => response.end('host page'));
    const pagePort = await listen(page, '127.0.0.1');
    const config = createDefaultRemoteDaemonConfig();
    config.host.config = { ...config.host.config, enabled: true, listenHost: '127.0.0.1', listenPort: 0 };
    config.host.clients = [{
      id: 'client-1',
      label: 'Laptop',
      createdAt: new Date('2026-10-09T00:00:00.000Z').toISOString(),
      tokenHash: hashRemoteDaemonToken('secret-token'),
    }];
    const server = new PaneRemoteHttpApiServer(new PaneCommandRegistry(), { getConfig: () => ({ remoteDaemon: config }) }, {
      isForwardedPort: port => port === pagePort,
    });
    await server.start();
    cleanups.push(() => server.stop());
    const tunnel = track(createPortTunnel(port => new WebSocket(`ws://127.0.0.1:${server.getAddress()!.port}/ports/${port}`, {
      headers: { Authorization: 'Bearer secret-token' },
    })));

    // Host and client share this machine, so the page's own port is taken here and the tunnel moves.
    const local = (await tunnel.sync([pagePort])).get(pagePort)!;
    const body = await new Promise<string>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: local, path: '/', agent: false }, response => {
        let text = '';
        response.on('data', chunk => { text += chunk; });
        response.on('end', () => resolve(text));
      }).on('error', reject);
    });
    expect(body).toBe('host page');
  });
});
