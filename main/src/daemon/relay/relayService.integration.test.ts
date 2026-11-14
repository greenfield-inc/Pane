import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { createHash, X509Certificate } from 'crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import type { OutgoingHttpHeaders } from 'http';
import https from 'https';
import net from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import tls from 'tls';
import { createDefaultRemoteDaemonConfig, type RemoteDaemonConfig } from '../../../../shared/types/remoteDaemon';
import { PaneCommandRegistry } from '../commandRegistry';
import { PaneRemoteHttpApiServer } from '../httpApiServer';
import { RelayService } from './relayService';
import { createComputerCaller, RelayLinks, relayComputerSchema } from './relayLinks';
import { registerRelayCommands } from './relayCommands';
import { RelayPreviews } from './relayPreviews';
import { integrationEnvSet } from './__fixtures__/integrationEnv';
import type { AppConfig } from '../../types/config';
import { boundary, decodeBoundary, type JsonObject, type JsonValue } from '../../../../shared/validation/boundaryDecoder';

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
const tokenSchema = boundary.object({ token: boundary.string });
const everywhereSchema = boundary.object({ removed: boundary.array(boundary.string), notReached: boundary.array(boundary.string) });

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      // SAFETY: a server listening on a host and port reports an AddressInfo.
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
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

describe.skipIf(!integrationEnvSet(['PANE_RELAY_BIN', 'PEBBLE_BIN', 'PEBBLE_DIR']))('phone access through the relay (integration)', () => {
  const children: ChildProcess[] = [];
  let relayPort = 0;
  let relayCa = '';
  let pebbleDirectory = '';
  let pebbleCa = '';
  let pebbleRoot = '';
  let env: NodeJS.ProcessEnv = {};
  let dial = { host: '127.0.0.1', port: 0 };
  let extraCa = '';
  let studio: Computer;
  let laptop: Computer;

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

    const relayCaFile = join(folder, 'relay-ca.pem');
    writeFileSync(relayCaFile, relayCa);
    const pebbleCaFile = join(folder, 'pebble-ca.pem');
    writeFileSync(pebbleCaFile, pebbleCa);
    const extraCaFile = join(folder, 'pebble-root.pem');
    writeFileSync(extraCaFile, pebbleRoot);
    env = {
      PANE_RELAY_CONNECT_HOST: '127.0.0.1',
      PANE_RELAY_CA: relayCaFile,
      PANE_ACME_DIRECTORY: pebbleDirectory,
      PANE_ACME_CA: pebbleCaFile,
    };
    dial = { host: '127.0.0.1', port: relayPort };
    extraCa = pebbleRoot;
    studio = await startComputer('Studio Mac', join(folder, 'studio'));
    laptop = await startComputer('Travel Laptop', join(folder, 'laptop'));
  }, 60_000);

  afterAll(async () => {
    for (const computer of [studio, laptop]) {
      await computer?.service.stop();
      await computer?.server.stop();
    }
    for (const child of children) child.kill();
  });

  interface Computer {
    service: RelayService;
    links: RelayLinks;
    server: PaneRemoteHttpApiServer;
    registry: PaneCommandRegistry;
    config(): RemoteDaemonConfig;
  }

  async function startComputer(name: string, dataDir: string): Promise<Computer> {
    let config = createDefaultRemoteDaemonConfig();
    config.host.config = { ...config.host.config, enabled: true, listenHost: '127.0.0.1', listenPort: 0 };
    config.relay = { enabled: true, relayAddress: `us.relay.${DOMAIN}:${relayPort}` };
    const secrets = new Map<string, string>();
    const configManager = {
      getConfig: () => ({ remoteDaemon: config }),
      updateConfigWith: async (update: (current: AppConfig) => Partial<AppConfig>) => {
        // SAFETY: the relay code reads and writes only remoteDaemon.
        const current = { remoteDaemon: config } as AppConfig;
        const patch = update(current);
        if (patch.remoteDaemon) config = patch.remoteDaemon;
        return { ...current, remoteDaemon: config };
      },
    };
    let server: PaneRemoteHttpApiServer | null = null;
    const service = new RelayService({
      settings: () => config.relay,
      onSettingsChanged: () => () => undefined,
      secrets: { read: async (key) => secrets.get(key) ?? null, write: async (key, value) => { secrets.set(key, value); } },
      dataDir,
      serverPort: () => server?.getAddress()?.port ?? null,
      previewPort: () => null,
      displayName: () => name,
      addClient: async (record) => { config = { ...config, host: { ...config.host, clients: [...config.host.clients, record] } }; },
      env,
    });
    const links = new RelayLinks({
      config: configManager,
      self: () => service.computerInfo(),
      call: createComputerCaller({ dial, extraCa }),
      disconnect: (ids) => server?.disconnectClients(ids),
      connectedClientIds: () => new Set(),
    });
    const registry = new PaneCommandRegistry();
    registry.register('sessions:get-all-with-projects', () => [{ id: `${name} session` }]);
    registerRelayCommands(registry, service, new RelayPreviews({
      id: () => null, domain: () => null, isForwardedPort: () => false, clientActive: () => false,
    }), links, configManager);
    server = new PaneRemoteHttpApiServer(registry, { getConfig: () => ({ remoteDaemon: config }) }, {
      pairing: {
        exchange: async (request) => {
          const result = await service.exchangeSecret(request);
          if (!result.ok) return result;
          return { ...result, linked: await links.grantsFor({ label: result.client.label, phoneId: request.phoneId }, []) };
        },
        clientAddress: (remoteAddress, remotePort) => service.clientAddress(remoteAddress, remotePort),
      },
    });
    await server.start();
    service.start();
    await until(() => service.getStatus().phase === 'ready', `${name} to be ready with a certificate`);
    return { service, links, server, registry, config: () => config };
  }

  /** A phone's https request to the computer's name, through the relay's port. */
  function phoneRequest(host: string, method: string, path: string, body?: JsonObject, token?: string) {
    return new Promise<{ status: number; json: JsonObject; peerKey: Buffer }>((resolve, reject) => {
      let peerKey = Buffer.alloc(0);
      const headers: OutgoingHttpHeaders = { 'content-type': 'application/json' };
      if (token) headers.authorization = `Bearer ${token}`;
      const request = https.request({
        host,
        path,
        method,
        headers,
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
        response.on('end', () => resolve({ status: response.statusCode ?? 0, json: decodeBoundary(JSON.parse(text || '{}'), boundary.jsonObject), peerKey }));
      });
      request.on('error', reject);
      request.end(body ? JSON.stringify(body) : undefined);
    });
  }

  async function pair(computer: Computer, label: string, phoneId: string) {
    const qr = new URL(computer.service.createPairingCode().url);
    expect(qr.host).toBe(DOMAIN);
    const fragment = new URLSearchParams(qr.hash.slice(1));
    const host = `${fragment.get('c')}.${DOMAIN}`;
    const paired = await phoneRequest(host, 'POST', '/pair/exchange', { secret: fragment.get('s'), label, phoneId });
    return { paired, fragment, host };
  }

  async function invoke(host: string, token: string, channel: string, args: JsonValue[] = []) {
    return phoneRequest(host, 'POST', '/invoke', { channel, args }, token);
  }

  it('gets a certificate, shows a QR, and a phone pairs and calls the server through the relay', async () => {
    const status = studio.service.getStatus();
    expect(status.address).toBe(`https://${status.id}.${DOMAIN}`);

    const { paired, fragment, host } = await pair(studio, 'Ana’s iPhone', 'phone-ana');
    expect(fragment.get('c')).toBe(status.id);
    expect(paired.status).toBe(200);
    const computer = decodeBoundary(paired.json.computer, relayComputerSchema);
    // The app pins the computer's key: the certificate it saw carries the key the exchange named.
    expect(createHash('sha256').update(paired.peerKey).digest('base64url')).toBe(computer.fingerprint);

    const sessions = await invoke(host, String(paired.json.token), 'sessions:get-all-with-projects');
    expect(sessions.json).toMatchObject({ ok: true, result: [{ id: 'Studio Mac session' }] });

    const again = await phoneRequest(host, 'POST', '/pair/exchange', { secret: fragment.get('s'), label: 'Second phone' });
    expect(again).toMatchObject({ status: 410, json: { error: { code: 'ERR_PAIRING_CODE_USED' } } });
  }, 90_000);

  it('links the computers a phone pairs with, so a second phone that scans one reaches both, until removed or unlinked', async () => {
    // Ana pairs with both computers; her app links them (the orchestration the phone runs).
    const a = await pair(studio, 'Ana’s iPhone', 'phone-ana');
    const b = await pair(laptop, 'Ana’s iPhone', 'phone-ana');
    const studioInfo = a.paired.json.computer;
    const laptopInfo = b.paired.json.computer;
    const tokenA = String(a.paired.json.token);
    const tokenB = String(b.paired.json.token);
    const laptopForStudio = await invoke(b.host, tokenB, 'relay:client:mint-link', [{ peer: studioInfo }]);
    const studioForLaptop = await invoke(a.host, tokenA, 'relay:client:mint-link', [{ peer: laptopInfo }]);
    expect((await invoke(a.host, tokenA, 'relay:client:save-link', [{ peer: laptopInfo, token: decodeBoundary(laptopForStudio.json.result, tokenSchema).token }])).status).toBe(200);
    expect((await invoke(b.host, tokenB, 'relay:client:save-link', [{ peer: studioInfo, token: decodeBoundary(studioForLaptop.json.result, tokenSchema).token }])).status).toBe(200);

    // Devices on the laptop says who linked the studio.
    const laptopDevices = decodeBoundary(
      await laptop.registry.invoke('relay:devices', []),
      boundary.array(boundary.object({ kind: boundary.string, label: boundary.string, linkedBy: boundary.optional(boundary.string) })),
    );
    expect(laptopDevices).toContainEqual(expect.objectContaining({ kind: 'computer', label: 'Studio Mac', linkedBy: 'Ana’s iPhone' }));

    // Ben scans only the studio and gets the laptop too.
    const ben = await pair(studio, 'Ben’s Pixel', 'phone-ben');
    const linked = decodeBoundary(ben.paired.json.linked, boundary.array(boundary.object({ computer: relayComputerSchema, token: boundary.string })));
    expect(linked.map((grant) => grant.computer.name)).toEqual(['Travel Laptop']);
    const benOnLaptop = await invoke(b.host, linked[0].token, 'sessions:get-all-with-projects');
    expect(benOnLaptop.json).toMatchObject({ ok: true, result: [{ id: 'Travel Laptop session' }] });

    // "Remove from all your computers" on Ben's row on the studio.
    const benRecord = studio.config().host.clients.find((client) => client.phoneId === 'phone-ben');
    const removal = decodeBoundary(await studio.registry.invoke('relay:remove-phone-everywhere', [{ clientId: benRecord?.id }]), everywhereSchema);
    expect(removal).toEqual({ removed: expect.arrayContaining(['Studio Mac', 'Travel Laptop']), notReached: [] });
    expect((await invoke(b.host, linked[0].token, 'sessions:get-all-with-projects')).status).toBe(403);
    expect((await invoke(a.host, String(ben.paired.json.token), 'sessions:get-all-with-projects')).status).toBe(403);

    // "Unlink from all your computers" on the laptop's row on the studio.
    const unlink = decodeBoundary(
      await studio.registry.invoke('relay:unlink-computer-everywhere', [{ computerId: decodeBoundary(laptopInfo, relayComputerSchema).id }]),
      everywhereSchema,
    );
    expect(unlink.notReached).toEqual([]);
    expect(studio.config().client.profiles.some((profile) => profile.relay)).toBe(false);
    expect(laptop.config().client.profiles.some((profile) => profile.relay)).toBe(false);
    expect(laptop.config().host.clients.some((client) => client.kind === 'computer')).toBe(false);
    // Ana's own pairings stay.
    expect((await invoke(b.host, tokenB, 'sessions:get-all-with-projects')).status).toBe(200);
  }, 90_000);
});
