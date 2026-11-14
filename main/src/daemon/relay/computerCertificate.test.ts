import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { generateKeyPairSync, X509Certificate } from 'crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import net from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadComputerKey, type KeyStore } from './computerKey';
import { ComputerCertificate } from './computerCertificate';
import { integrationEnvSet } from './__fixtures__/integrationEnv';

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

describe.skipIf(!integrationEnvSet(['PEBBLE_BIN', 'PEBBLE_DIR']))('computer certificate (Pebble)', () => {
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

  /** A certificate issued now, with the stores a restarted computer reads it back from. */
  async function issued() {
    const key = await loadComputerKey(memory());
    const certificateStore = memory();
    const accountStore = memory();
    const first = new ComputerCertificate({ key, domain: 'relay.test', certificateStore, accountStore, setTxt: async () => undefined, directoryUrl, acmeCa });
    await first.ensure();
    const status = first.getStatus();
    if (!status) throw new Error('no certificate was issued');
    return { key, certificateStore, accountStore, status, serial: new X509Certificate(certificateStore.value ?? '').serialNumber };
  }

  it('renews with the saved ACME account once a third of the lifetime is left', async () => {
    const { key, certificateStore, accountStore, status, serial } = await issued();
    const account = accountStore.value;
    const later = new ComputerCertificate({
      key, domain: 'relay.test', certificateStore, accountStore, setTxt: async () => undefined, directoryUrl, acmeCa,
      now: () => Date.parse(status.renewAt) + 1_000,
    });
    await later.load();
    expect(later.needsRenewal()).toBe(true);
    await later.ensure();

    expect(new X509Certificate(certificateStore.value ?? '').serialNumber).not.toBe(serial);
    expect(accountStore.value).toBe(account);
    expect(later.isValid()).toBe(true);
  }, 30_000);

  it('registers a saved account key this ACME server has never seen, as after switching directories', async () => {
    const key = await loadComputerKey(memory());
    const certificate = new ComputerCertificate({
      key, domain: 'relay.test', certificateStore: memory(), accountStore: memory(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()),
      setTxt: async () => undefined, directoryUrl, acmeCa,
    });
    await certificate.ensure();
    expect(certificate.isValid()).toBe(true);
  }, 30_000);

  it('replaces a certificate that expired while the computer was off', async () => {
    const { key, certificateStore, accountStore, status, serial } = await issued();
    const afterExpiry = new ComputerCertificate({
      key, domain: 'relay.test', certificateStore, accountStore, setTxt: async () => undefined, directoryUrl, acmeCa,
      now: () => Date.parse(status.notAfter) + 24 * 60 * 60_000,
    });
    await afterExpiry.load();
    expect(afterExpiry.isValid()).toBe(false);
    await afterExpiry.ensure();

    expect(new X509Certificate(certificateStore.value ?? '').serialNumber).not.toBe(serial);
    expect(afterExpiry.secureContext()).not.toBeNull();
  }, 30_000);
});
