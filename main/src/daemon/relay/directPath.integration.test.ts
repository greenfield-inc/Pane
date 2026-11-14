import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, X509Certificate } from 'crypto';
import dgram from 'dgram';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import https from 'https';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import path from 'path';
import tls from 'tls';
import { DirectPath } from './directPath';
import { PaneDirectProcess } from './paneDirect';
import { integrationEnvSet } from './__fixtures__/integrationEnv';

/**
 * The direct path end to end: `pane-direct serve` in front of a TLS server holding the
 * computer's test certificate, and a desktop's `DirectPath` reaching it through
 * `pane-direct connect`. The computer's public name does not resolve here, so the relay path
 * fails its probes and the direct path must carry the pinned request.
 * Needs PANE_DIRECT_BIN (direct/target/debug/pane-direct).
 */
const DIRECT_BIN = process.env.PANE_DIRECT_BIN;
const FIXTURES = path.join(__dirname, '__fixtures__');
const COMPUTER = '75rnqtlvttepjja3.relay.test';

async function freeUdpAddress(): Promise<string> {
  const socket = dgram.createSocket('udp4');
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return `127.0.0.1:${port}`;
}

async function until<T>(read: () => T | null | undefined, label: string, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function get(url: URL, agent: https.Agent): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    https.get(url, { agent }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

describe.skipIf(!integrationEnvSet(['PANE_DIRECT_BIN']))('a desktop reaches a computer over the direct path (integration)', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'pane-direct-it-'));
  const cert = readFileSync(path.join(FIXTURES, 'computer.pem'));
  const fingerprint = createHash('sha256').update(new X509Certificate(cert).publicKey.export({ format: 'der', type: 'spki' })).digest('base64url');
  const server = https.createServer({ cert, key: readFileSync(path.join(FIXTURES, 'computer.key')) }, (request, response) => {
    response.end(`${request.socket instanceof tls.TLSSocket ? request.socket.servername : ''} ${request.url}`);
  });
  let serve: PaneDirectProcess;
  let endpoint: { nodeId: string; addrs: string[] } | null = null;
  const defaultCas = tls.getCACertificates('default');

  beforeAll(async () => {
    tls.setDefaultCACertificates([...defaultCas, readFileSync(path.join(FIXTURES, 'ca.pem'), 'utf8')]);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    // SAFETY: a server listening on a host and port reports an AddressInfo.
    const address = server.address() as AddressInfo;
    const bind = await freeUdpAddress();
    serve = new PaneDirectProcess({
      bin: DIRECT_BIN ?? '',
      args: ['serve', '--secret-key-file', path.join(folder, 'direct-key'), '--target', `127.0.0.1:${address.port}`, '--bind', bind],
      onEvent: (event) => { if (event.t === 'ready' && event.nodeId) endpoint = { nodeId: event.nodeId, addrs: [bind] }; },
    });
    serve.start();
  });

  afterAll(async () => {
    await serve.stop();
    server.close();
    tls.setDefaultCACertificates(defaultCas);
    rmSync(folder, { recursive: true, force: true });
  });

  it('switches to the direct path and carries a request pinned to the computer key', async () => {
    const computer = await until(() => endpoint, 'pane-direct serve');
    const baseUrl = new URL(`https://${COMPUTER}/`);
    const direct = new DirectPath({ bin: DIRECT_BIN ?? '', baseUrl, fingerprint, label: 'Studio' });
    try {
      await direct.update({ ...computer, relayUrls: [] });
      const relayAgent = direct.agent();
      // The first probe after 5 s finds the relay unreachable and the direct path answering.
      const agent = await until(() => (direct.agent() === relayAgent ? null : direct.agent()), 'the direct path', 20_000);
      expect(await get(new URL('hello', baseUrl), agent)).toEqual({ status: 200, body: `${COMPUTER} /hello` });
    } finally {
      await direct.close();
    }
  }, 40_000);
});
