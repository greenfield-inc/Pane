import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import http from 'http';
import net, { type AddressInfo } from 'net';
import { join } from 'path';
import tls from 'tls';
import type { Duplex } from 'stream';
import { loadComputerKey } from './computerKey';
import { createComputerTlsServer } from './computerTlsServer';
import { RelayAgent } from './relayAgent';
import { DOMAIN, RELAY_HOST, startFakeRelay } from './__fixtures__/fakeRelay';

const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name));

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('relay agent', () => {
  it('serves a dev server to a phone through the relay, ending TLS with the computer certificate', async () => {
    const relay = await startFakeRelay();
    cleanups.push(relay.close);
    let terminator: ReturnType<typeof createComputerTlsServer> | null = null;
    const devServer = http.createServer((request, response) => response.end(
      `dev server saw ${request.headers.host} from ${terminator?.clientAddress(request.socket.remoteAddress, request.socket.remotePort)}`,
    ));
    await new Promise<void>((resolve) => devServer.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => { devServer.close(); });
    // SAFETY: the server listens on a host and port, so it reports an AddressInfo.
    const devPort = (devServer.address() as AddressInfo).port;

    const key = await loadComputerKey({ read: async () => fixture('computer.key').toString(), write: async () => undefined });
    const context = tls.createSecureContext({ key: fixture('computer.key'), cert: fixture('computer.pem') });
    const computer = createComputerTlsServer({
      id: key.id,
      domain: DOMAIN,
      secureContext: () => context,
      target: (name) => (name.kind === 'port' && name.port === 5173 ? devPort : null),
    });
    terminator = computer;
    cleanups.push(() => computer.close());
    const agent = new RelayAgent({
      relayHost: RELAY_HOST,
      connectHost: '127.0.0.1',
      relayPort: relay.controlPort,
      key,
      displayName: () => 'Studio Mac',
      localAddresses: () => ['192.168.1.20'],
      ca: fixture('ca.pem'),
      onClient: (stream, peer) => computer.accept(stream, peer),
    });
    cleanups.push(() => agent.stop());
    agent.start();
    await waitFor(() => agent.getState().status === 'online', 'the agent to come online');

    expect(relay.verified).toEqual([true]);
    expect(relay.hellos[0]).toMatchObject({ v: 1, local: ['192.168.1.20'], name: 'Studio Mac' });

    const get = (port: number) => new Promise<string>((resolve, reject) => {
      const request = http.get({
        host: `p5173.${key.id}.${DOMAIN}`,
        path: '/',
        headers: { host: `p5173.${key.id}.${DOMAIN}` },
        createConnection: () => tls.connect({ host: '127.0.0.1', port, servername: `p5173.${key.id}.${DOMAIN}`, ca: fixture('ca.pem') }),
      }, (response) => {
        let text = '';
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => resolve(text));
      });
      request.on('error', reject);
    });
    // The dev server learns the phone's address from the relay's `open` frame.
    expect(await get(relay.frontPort)).toBe(`dev server saw p5173.${key.id}.${DOMAIN} from 203.0.113.9`);
    // A same-network phone reaches the local listener directly.
    expect(await get(await computer.listen(0, '127.0.0.1'))).toBe(`dev server saw p5173.${key.id}.${DOMAIN} from 127.0.0.1`);
    await agent.setAcmeTxt(['token-digest']);
  });

  it('shrugs off the relay resetting a client stream the computer has not taken up', async () => {
    const relay = await startFakeRelay();
    cleanups.push(relay.close);
    const key = await loadComputerKey({ read: async () => fixture('computer.key').toString(), write: async () => undefined });
    const streams: Duplex[] = [];
    const agent = new RelayAgent({
      relayHost: RELAY_HOST,
      connectHost: '127.0.0.1',
      relayPort: relay.controlPort,
      key,
      displayName: () => 'Studio Mac',
      localAddresses: () => [],
      ca: fixture('ca.pem'),
      // Like a computer whose TLS listener is not up yet.
      onClient: (stream) => { streams.push(stream); },
    });
    cleanups.push(() => agent.stop());
    agent.start();
    await waitFor(() => agent.getState().status === 'online', 'the agent to come online');
    const phone = net.connect(relay.frontPort, '127.0.0.1');
    phone.on('error', () => {});
    cleanups.push(() => { phone.destroy(); });
    phone.write('hello');
    await waitFor(() => streams.length === 1, 'the client stream');

    relay.resetData();

    await waitFor(() => streams[0].destroyed, 'the stream to close');
    expect(agent.getState().status).toBe('online');
  });

  it('keeps a link the relay answers, through a stall, and redials about 10 s after the relay goes quiet', async () => {
    const relay = await startFakeRelay();
    cleanups.push(relay.close);
    const key = await loadComputerKey({ read: async () => fixture('computer.key').toString(), write: async () => undefined });
    // The ping clock is faked; sockets and the redial delay run in real time.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    cleanups.push(() => { vi.useRealTimers(); });
    const agent = new RelayAgent({
      relayHost: RELAY_HOST,
      connectHost: '127.0.0.1',
      relayPort: relay.controlPort,
      key,
      displayName: () => 'Studio Mac',
      localAddresses: () => [],
      ca: fixture('ca.pem'),
      onClient: (stream) => stream.destroy(),
    });
    cleanups.push(() => agent.stop());
    agent.start();
    await waitFor(() => agent.getState().status === 'online', 'the agent to come online');
    const ping = async () => {
      const before = relay.link.pings;
      vi.advanceTimersByTime(5_000);
      await waitFor(() => relay.link.pings === before + 1 || relay.hellos.length > 1, 'a ping');
      // The relay has written its answer; one I/O turn lets the agent read it before time moves on.
      await new Promise((resolve) => setImmediate(resolve));
    };

    for (let i = 0; i < 6; i++) await ping();
    // The process stalls for 30 s, as under a debugger; the relay's answer is not read until after.
    vi.setSystemTime(Date.now() + 30_000);
    await ping();
    await ping();
    expect(relay.hellos).toHaveLength(1);

    relay.link.answerPings = false;
    await ping();
    expect(relay.hellos).toHaveLength(1);
    vi.advanceTimersByTime(5_000);
    await waitFor(() => relay.hellos.length === 2, 'the redial 10 s after the last answer');
  }, 10_000);

  it('waits minutes, not seconds, before retrying a relay that refused this computer', async () => {
    const relay = await startFakeRelay({ refuse: 'full' });
    cleanups.push(relay.close);
    const key = await loadComputerKey({ read: async () => fixture('computer.key').toString(), write: async () => undefined });
    const agent = new RelayAgent({
      relayHost: RELAY_HOST,
      connectHost: '127.0.0.1',
      relayPort: relay.controlPort,
      key,
      displayName: () => 'Studio Mac',
      localAddresses: () => [],
      ca: fixture('ca.pem'),
      onClient: (stream) => stream.destroy(),
    });
    cleanups.push(() => agent.stop());
    agent.start();
    await waitFor(() => relay.hellos.length === 1, 'the first hello');
    // An ordinary drop retries within a second or two; a refusal must not.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(relay.hellos).toHaveLength(1);
    expect(agent.getState()).toMatchObject({ status: 'connecting' });
  }, 10_000);
});

