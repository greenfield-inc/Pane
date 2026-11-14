import { afterEach, describe, expect, it } from 'vitest';
import { createPublicKey, createVerify, randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import http from 'http';
import net, { type AddressInfo } from 'net';
import { join } from 'path';
import tls from 'tls';
import { loadComputerKey } from './computerKey';
import { createComputerTlsServer } from './computerTlsServer';
import { RelayAgent } from './relayAgent';
import { boundary, decodeBoundary, type JsonObject } from '../../../../shared/validation/boundaryDecoder';

const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name));
const DOMAIN = 'relay.test';
const RELAY_HOST = `us.relay.${DOMAIN}`;

/**
 * A relay reduced to relay/PROTOCOL.md's control and data connections: it checks the hello
 * signature, announces each raw client connection with `open`, and splices it to the computer's
 * data connection. Clients connect to it as plain TCP standing in for the relay's port 443.
 */
async function startFakeRelay() {
  const agents: tls.TLSSocket[] = [];
  const waiting = new Map<string, net.Socket>();
  const hellos: JsonObject[] = [];
  const verified: boolean[] = [];
  const control = tls.createServer({ key: fixture('relay.key'), cert: fixture('relay.pem') }, (socket) => {
    let head = '';
    const onHead = (chunk: Buffer) => {
      head += chunk.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      socket.off('data', onHead);
      const path = head.split(' ')[1];
      if (path === '/v1/agent') {
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: pane-relay/1\r\nConnection: Upgrade\r\n\r\n');
        const nonce = randomBytes(32).toString('base64url');
        socket.write(`${JSON.stringify({ t: 'challenge', nonce })}\n`);
        let buffered = '';
        socket.on('data', (data: Buffer) => {
          buffered += data.toString('utf8');
          let newline: number;
          while ((newline = buffered.indexOf('\n')) !== -1) {
            const frame = decodeBoundary(JSON.parse(buffered.slice(0, newline)), boundary.jsonObject);
            buffered = buffered.slice(newline + 1);
            if (frame.t === 'hello') {
              hellos.push(frame);
              const verifier = createVerify('sha256');
              verifier.update(`pane-relay-v1:${nonce}`);
              const key = createPublicKey({ key: Buffer.from(String(frame.spki), 'base64url'), format: 'der', type: 'spki' });
              verified.push(verifier.verify(key, Buffer.from(String(frame.sig), 'base64url')));
              socket.write(`${JSON.stringify({ t: 'welcome', id: 'x', domain: DOMAIN, region: 'us' })}\n`);
              agents.push(socket);
            } else if (frame.t === 'txt') {
              socket.write(`${JSON.stringify({ t: 'ok', req: frame.req })}\n`);
            }
          }
        });
      } else if (path?.startsWith('/v1/data/')) {
        const client = waiting.get(path.slice('/v1/data/'.length));
        if (!client) {
          socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
          return;
        }
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: pane-relay/1\r\nConnection: Upgrade\r\n\r\n');
        client.pipe(socket).pipe(client);
        client.resume();
      }
    };
    socket.on('data', onHead);
  });
  const front = net.createServer((client) => {
    client.pause();
    const conn = randomBytes(16).toString('base64url');
    waiting.set(conn, client);
    agents.at(-1)?.write(`${JSON.stringify({ t: 'open', conn, peer: '203.0.113.9' })}\n`);
  });
  await new Promise<void>((resolve) => control.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve));
  return {
    // SAFETY: both servers listen on a host and port, so they report an AddressInfo.
    controlPort: (control.address() as AddressInfo).port,
    // SAFETY: as above.
    frontPort: (front.address() as AddressInfo).port,
    hellos,
    verified,
    agentsConnected: () => agents.length,
    close: () => { control.close(); front.close(); for (const agent of agents) agent.destroy(); },
  };
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
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
});
