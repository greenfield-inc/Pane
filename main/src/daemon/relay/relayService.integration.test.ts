import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { createHash, X509Certificate } from 'crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import https from 'https';
import net from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import tls from 'tls';
import { createDefaultRemoteDaemonConfig, type RemoteDaemonConfig } from '../../../../shared/types/remoteDaemon';
import { PaneCommandRegistry } from '../commandRegistry';
import { PaneRemoteHttpApiServer } from '../httpApiServer';
import { RelayService } from './relayService';

/**
 * The computer side end to end: the Rust relay (with its DNS helper), Pebble validating DNS-01
 * through that DNS, the relay service, and Pane's real pairing listener. A phone scans the QR,
 * trades the secret through the relay, and calls the server with its new token.
 * Needs PANE_RELAY_BIN (relay/target/*\/pane-relay), PEBBLE_BIN and PEBBLE_DIR.
 */
const RELAY_BIN = process.env.PANE_RELAY_BIN;
const PEBBLE_BIN = process.env.PEBBLE_BIN;
const PEBBLE_DIR = process.env.PEBBLE_DIR;
const DOMAIN = 'relay.test';

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

function waitForOutput(child: ChildProcess, text: string, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not start`)), 30_000);
    const check = (chunk: Buffer) => { if (chunk.toString().includes(text)) { clearTimeout(timer); resolve(); } };
    child.stdout?.on('data', check);
    child.stderr?.on('data', check);
  });
}

async function until<T>(read: () => T | null | undefined | false, label: string, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe.skipIf(!RELAY_BIN || !PEBBLE_BIN || !PEBBLE_DIR)('phone access through the relay (integration)', () => {
  const children: ChildProcess[] = [];
  let relayPort = 0;
  let relayCa = '';
  let pebbleDirectory = '';
  let pebbleCa = '';
  let pebbleRoot = '';
  let service: RelayService;
  let server: PaneRemoteHttpApiServer;
  let config: RemoteDaemonConfig;
  const secrets = new Map<string, string>();

  beforeAll(async () => {
    const folder = mkdtempSync(join(tmpdir(), 'pane-relay-it-'));
    relayPort = await freePort();
    const dnsPort = await freePort();
    const relay = spawn(RELAY_BIN ?? '', ['--dev', '--domain', DOMAIN, '--listen', `127.0.0.1:${relayPort}`, '--dns', `127.0.0.1:${dnsPort}`, '--public-ip', '127.0.0.1'], {
      env: { ...process.env, TMPDIR: folder, RUST_LOG: 'info' },
    });
    children.push(relay);
    await waitForOutput(relay, 'listening', 'pane-relay');
    relayCa = readFileSync(join(folder, `pane-relay-dev-${DOMAIN}.pem`), 'utf8');

    const pebblePort = await freePort();
    const managementPort = await freePort();
    const pebbleConfig = join(folder, 'pebble.json');
    writeFileSync(pebbleConfig, JSON.stringify({ pebble: {
      listenAddress: `127.0.0.1:${pebblePort}`,
      managementListenAddress: `127.0.0.1:${managementPort}`,
      certificate: join(PEBBLE_DIR ?? '', 'test/certs/localhost/cert.pem'),
      privateKey: join(PEBBLE_DIR ?? '', 'test/certs/localhost/key.pem'),
      httpPort: 5002,
      tlsPort: 5001,
      externalAccountBindingRequired: false,
    } }));
    const pebble = spawn(PEBBLE_BIN ?? '', ['-config', pebbleConfig, '-dnsserver', `127.0.0.1:${dnsPort}`], {
      env: { ...process.env, PEBBLE_VA_NOSLEEP: '1', PEBBLE_WFE_NONCEREJECT: '0' },
    });
    children.push(pebble);
    await waitForOutput(pebble, 'Listening on', 'Pebble');
    pebbleDirectory = `https://localhost:${pebblePort}/dir`;
    pebbleCa = readFileSync(join(PEBBLE_DIR ?? '', 'test/certs/pebble.minica.pem'), 'utf8');
    pebbleRoot = await new Promise<string>((resolve, reject) => {
      https.get(`https://localhost:${managementPort}/roots/0`, { ca: pebbleCa }, (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve(body));
      }).on('error', reject);
    });

    config = createDefaultRemoteDaemonConfig();
    config.host.config = { ...config.host.config, enabled: true, listenHost: '127.0.0.1', listenPort: 0 };
    config.relay = { enabled: true, relayAddress: `us.relay.${DOMAIN}:${relayPort}` };
    const relayCaFile = join(folder, 'relay-ca.pem');
    writeFileSync(relayCaFile, relayCa);
    const pebbleCaFile = join(folder, 'pebble-ca.pem');
    writeFileSync(pebbleCaFile, pebbleCa);

    service = new RelayService({
      settings: () => config.relay,
      onSettingsChanged: () => () => undefined,
      secrets: { read: async (key) => secrets.get(key) ?? null, write: async (key, value) => { secrets.set(key, value); } },
      dataDir: folder,
      serverPort: () => server.getAddress()?.port ?? null,
      previewPort: () => null,
      displayName: () => 'Studio Mac',
      addClient: async (record) => { config.host.clients = [...config.host.clients, record]; },
      env: {
        PANE_RELAY_CONNECT_HOST: '127.0.0.1',
        PANE_RELAY_CA: relayCaFile,
        PANE_ACME_DIRECTORY: pebbleDirectory,
        PANE_ACME_CA: pebbleCaFile,
      },
    });
    const registry = new PaneCommandRegistry();
    registry.register('sessions:get-all-with-projects', () => [{ id: 'session-1' }]);
    server = new PaneRemoteHttpApiServer(registry, { getConfig: () => ({ remoteDaemon: config }) }, {
      pairing: { exchange: (secret, label) => service.exchangeSecret(secret, label) },
    });
    await server.start();
    service.start();
  }, 60_000);

  afterAll(async () => {
    await service?.stop();
    await server?.stop();
    for (const child of children) child.kill();
  });

  /** A phone's https request to the computer's name, through the relay's port. */
  function phoneRequest(host: string, method: string, path: string, body?: object, token?: string) {
    return new Promise<{ status: number; json: Record<string, unknown>; peerKey: Buffer }>((resolve, reject) => {
      let peerKey = Buffer.alloc(0);
      const request = https.request({
        host,
        path,
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ca: pebbleRoot,
        createConnection: () => {
          const socket = tls.connect({ host: '127.0.0.1', port: relayPort, servername: host, ca: pebbleRoot });
          socket.once('secureConnect', () => {
            peerKey = new X509Certificate(socket.getPeerCertificate().raw).publicKey.export({ format: 'der', type: 'spki' });
          });
          return socket;
        },
      }, (response) => {
        let text = '';
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, json: JSON.parse(text || '{}') as Record<string, unknown>, peerKey }));
      });
      request.on('error', reject);
      request.end(body ? JSON.stringify(body) : undefined);
    });
  }

  it('gets a certificate, shows a QR, and a phone pairs and calls the server through the relay', async () => {
    const status = await until(() => {
      const current = service.getStatus();
      return current.phase === 'ready' ? current : null;
    }, 'the relay to be ready with a certificate');
    expect(status.address).toBe(`https://${status.id}.${DOMAIN}`);

    const qr = new URL(service.createPairingCode().url);
    expect(qr.host).toBe(DOMAIN);
    const fragment = new URLSearchParams(qr.hash.slice(1));
    expect(fragment.get('c')).toBe(status.id);

    const host = `${status.id}.${DOMAIN}`;
    const paired = await phoneRequest(host, 'POST', '/pair/exchange', { secret: fragment.get('s'), label: 'Ana’s iPhone' });
    expect(paired.status).toBe(200);
    const computer = paired.json.computer as { fingerprint: string };
    // The app pins the computer's key: the certificate it saw carries the key the exchange named.
    expect(createHash('sha256').update(paired.peerKey).digest('base64url')).toBe(computer.fingerprint);

    const token = String(paired.json.token);
    const sessions = await phoneRequest(host, 'POST', '/invoke', { channel: 'sessions:get-all-with-projects', args: [] }, token);
    expect(sessions.status).toBe(200);

    const again = await phoneRequest(host, 'POST', '/pair/exchange', { secret: fragment.get('s'), label: 'Second phone' });
    expect(again).toMatchObject({ status: 410, json: { error: { code: 'ERR_PAIRING_CODE_USED' } } });
  }, 90_000);
});
