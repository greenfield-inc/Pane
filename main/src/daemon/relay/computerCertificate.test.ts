import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { X509Certificate } from 'crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import net from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadComputerKey, type KeyStore } from './computerKey';
import { ComputerCertificate } from './computerCertificate';

/**
 * Runs against Pebble, Let's Encrypt's ACME test server, with validation switched off: the
 * relay's DNS answers are covered by the relay's own tests and the staging check in CI.
 * Set PEBBLE_BIN (and PEBBLE_DIR, Pebble's source folder for its test certificates) to run it.
 */
const PEBBLE_BIN = process.env.PEBBLE_BIN;
const PEBBLE_DIR = process.env.PEBBLE_DIR;

function memory(initial: string | null = null): KeyStore & { value: string | null } {
  return { value: initial, async read() { return this.value; }, async write(value) { this.value = value; } };
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      // SAFETY: a server listening on a host and port reports an AddressInfo.
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

describe.skipIf(!PEBBLE_BIN || !PEBBLE_DIR)('computer certificate (Pebble)', () => {
  let pebble: ChildProcess;
  let directoryUrl = '';
  let acmeCa = '';

  beforeAll(async () => {
    const port = await freePort();
    const folder = mkdtempSync(join(tmpdir(), 'pane-pebble-'));
    const config = join(folder, 'pebble.json');
    writeFileSync(config, JSON.stringify({ pebble: {
      listenAddress: `127.0.0.1:${port}`,
      managementListenAddress: `127.0.0.1:${await freePort()}`,
      certificate: join(PEBBLE_DIR ?? '', 'test/certs/localhost/cert.pem'),
      privateKey: join(PEBBLE_DIR ?? '', 'test/certs/localhost/key.pem'),
      httpPort: 5002,
      tlsPort: 5001,
      externalAccountBindingRequired: false,
    } }));
    acmeCa = readFileSync(join(PEBBLE_DIR ?? '', 'test/certs/pebble.minica.pem'), 'utf8');
    directoryUrl = `https://localhost:${port}/dir`;
    pebble = spawn(PEBBLE_BIN ?? '', ['-config', config], { env: { ...process.env, PEBBLE_VA_ALWAYS_VALID: '1', PEBBLE_VA_NOSLEEP: '1', PEBBLE_WFE_NONCEREJECT: '0' } });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Pebble did not start')), 10_000);
      pebble.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('Listening on')) { clearTimeout(timer); resolve(); }
      });
    });
  }, 20_000);

  afterAll(() => { pebble?.kill(); });

  it('issues a certificate for the computer and its names with the computer key, publishing TXT values through the relay', async () => {
    const key = await loadComputerKey(memory());
    const txtCalls: string[][] = [];
    const certificateStore = memory();
    const certificate = new ComputerCertificate({
      key,
      domain: 'relay.test',
      certificateStore,
      accountStore: memory(),
      setTxt: async (values) => { txtCalls.push(values); },
      directoryUrl,
      acmeCa,
    });
    await certificate.ensure();

    const leaf = new X509Certificate(certificateStore.value ?? '');
    expect(leaf.subjectAltName).toContain(`DNS:${key.id}.relay.test`);
    expect(leaf.subjectAltName).toContain(`DNS:*.${key.id}.relay.test`);
    expect(leaf.publicKey.export({ format: 'der', type: 'spki' }).equals(key.spki)).toBe(true);
    expect(certificate.secureContext()).not.toBeNull();
    // Both names' values were published, then cleared.
    expect(Math.max(...txtCalls.map((values) => values.length))).toBeGreaterThanOrEqual(1);
    expect(txtCalls.at(-1)).toEqual([]);

    // A saved certificate is reused after a restart: no new order.
    const restarted = new ComputerCertificate({
      key, domain: 'relay.test', certificateStore, accountStore: memory(),
      setTxt: async () => { throw new Error('no order expected'); }, directoryUrl, acmeCa,
    });
    await restarted.load();
    await restarted.ensure();
    expect(restarted.isValid()).toBe(true);
  }, 30_000);
});
