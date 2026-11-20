import { createPublicKey, createVerify, randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import net, { type AddressInfo } from 'net';
import { join } from 'path';
import tls from 'tls';
import { boundary, decodeBoundary, type JsonObject } from '../../../../../shared/validation/boundaryDecoder';

const fixture = (name: string) => readFileSync(join(__dirname, name));
/** The relay's domain; its certificate (relay.pem) names `us.relay.relay.test`. */
export const DOMAIN = 'relay.test';
export const RELAY_HOST = `us.relay.${DOMAIN}`;

/**
 * A relay reduced to relay/PROTOCOL.md's control and data connections: it checks the hello
 * signature, announces each raw client connection with `open`, and splices it to the computer's
 * data connection. Clients connect to it as plain TCP standing in for the relay's port 443.
 */
export async function startFakeRelay(options: { refuse?: string } = {}) {
  const agents: tls.TLSSocket[] = [];
  const waiting = new Map<string, net.Socket>();
  const hellos: JsonObject[] = [];
  const link = { answerPings: true, pings: 0 };
  const dataSockets: tls.TLSSocket[] = [];
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
              if (options.refuse) {
                socket.end(`${JSON.stringify({ t: 'error', code: options.refuse, message: 'refused' })}\n`);
                continue;
              }
              socket.write(`${JSON.stringify({ t: 'welcome', id: 'x', domain: DOMAIN, region: 'us' })}\n`);
              agents.push(socket);
            } else if (frame.t === 'ping') {
              link.pings += 1;
              if (link.answerPings) socket.write(`${JSON.stringify({ t: 'pong' })}\n`);
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
        dataSockets.push(socket);
        client.pipe(socket).pipe(client);
        client.resume();
      }
    };
    socket.on('data', onHead);
  });
  // TLS sockets cannot send a reset; their TCP sockets, found by the client's port, can.
  const rawSockets = new Map<number, net.Socket>();
  control.on('connection', (raw: net.Socket) => { rawSockets.set(raw.remotePort ?? 0, raw); });
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
    /** Whether the relay answers pings, and how many it got. */
    link,
    agentsConnected: () => agents.length,
    /** Resets every data connection, as the relay does when it drops a parked client. */
    resetData: () => {
      for (const socket of dataSockets) rawSockets.get(socket.remotePort ?? 0)?.resetAndDestroy();
    },
    close: () => { control.close(); front.close(); for (const agent of agents) agent.destroy(); },
  };
}
