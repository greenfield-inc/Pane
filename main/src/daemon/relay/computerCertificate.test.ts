import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import http from 'http';
import { generateKeyPairSync, X509Certificate } from 'crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import net from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadComputerKey, type KeyStore } from './computerKey';
import { CertificateRateLimited, ComputerCertificate } from './computerCertificate';
import { integrationEnvSet } from './__fixtures__/integrationEnv';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';

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

describe('computer certificate', () => {
  it('starts with no certificate when the saved one cannot be read, so it orders a new one', async () => {
    const key = await loadComputerKey(memory());
    const certificate = new ComputerCertificate({
      key, domain: 'relay.test', certificateStore: memory('not a certificate'), accountStore: memory(), setTxt: async () => undefined,
    });

    await certificate.load();

    expect(certificate.getStatus()).toBeNull();
    expect(certificate.needsRenewal()).toBe(true);
  });
});

/** Let's Encrypt's answer to a new order on 2026-11-20, once runpane.net had used its weekly certificates. */
const LETS_ENCRYPT_LIMIT = 'too many certificates (50) already issued for "runpane.net" in the last 168h0m0s, retry after 2026-11-20 22:16:39 UTC: see https://letsencrypt.org/docs/rate-limits/#new-certificates-per-registered-domain';

/** What an ACME client sent to register: the binding is present only for a CA that asked for one. */
interface AccountRequest {
  externalAccountBinding?: { protected: string };
}

/** The port a listening server is bound to. */
function portOf(server: http.Server): number {
  // SAFETY: a server listening on a host and port reports an AddressInfo.
  return (server.address() as net.AddressInfo).port;
}

/** An ACME server that registers any account and refuses every order for its rate limits, as Let's Encrypt did. */
async function refusingCa(): Promise<{ directoryUrl: string; accounts: AccountRequest[]; close(): Promise<void> }> {
  const accounts: AccountRequest[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    request.on('end', () => {
      const base = `http://127.0.0.1:${portOf(server)}`;
      response.setHeader('Replay-Nonce', `nonce${Math.random().toString(36).slice(2)}`);
      if (request.url === '/dir') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ newNonce: `${base}/nonce`, newAccount: `${base}/account`, newOrder: `${base}/order` }));
      } else if (request.url === '/nonce') {
        response.end();
      } else if (request.url === '/account') {
        const { payload } = decodeBoundary(JSON.parse(body), boundary.object({ payload: boundary.string }));
        accounts.push(decodeBoundary(JSON.parse(Buffer.from(payload, 'base64url').toString()), accountSchema));
        response.writeHead(201, { 'Content-Type': 'application/json', Location: `${base}/account/1` });
        response.end(JSON.stringify({ status: 'valid' }));
      } else {
        response.writeHead(429, { 'Content-Type': 'application/problem+json', 'Retry-After': '8177' });
        response.end(JSON.stringify({ type: 'urn:ietf:params:acme:error:rateLimited', detail: LETS_ENCRYPT_LIMIT, status: 429 }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    directoryUrl: `http://127.0.0.1:${portOf(server)}/dir`,
    accounts,
    close: () => new Promise((resolve) => { server.close(() => resolve()); }),
  };
}

const accountSchema = boundary.object({ externalAccountBinding: boundary.optional(boundary.object({ protected: boundary.string })) });

describe('a certificate authority that refuses for its rate limits', () => {
  it('fails the order at once, saying when the CA takes new orders again, instead of waiting for it', async () => {
    const ca = await refusingCa();
    const certificate = new ComputerCertificate({
      key: await loadComputerKey(memory()), domain: 'runpane.net', certificateStore: memory(), accountStore: memory(),
      setTxt: async () => undefined, authorities: [{ directoryUrl: ca.directoryUrl }],
    });

    const started = Date.now();
    const failure = await certificate.ensure().then(() => null, (error: Error) => error);

    expect(failure).toBeInstanceOf(CertificateRateLimited);
    expect(failure).toMatchObject({ retryAt: Date.parse('2026-11-20T22:16:39Z') });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(certificate.isValid()).toBe(false);
    await ca.close();
  });

  it('asks the fallback CA, with its external account binding, when the first one refuses', async () => {
    const first = await refusingCa();
    const fallback = await refusingCa();
    const certificate = new ComputerCertificate({
      key: await loadComputerKey(memory()), domain: 'runpane.net', certificateStore: memory(), accountStore: memory(),
      setTxt: async () => undefined,
      authorities: [
        { directoryUrl: first.directoryUrl },
        { directoryUrl: fallback.directoryUrl, eab: { kid: 'kid-1', hmacKey: Buffer.from('hmac key for tests').toString('base64url') } },
      ],
    });

    await expect(certificate.ensure()).rejects.toBeInstanceOf(CertificateRateLimited);

    expect(first.accounts[0]?.externalAccountBinding).toBeUndefined();
    const binding = fallback.accounts[0]?.externalAccountBinding?.protected ?? '';
    expect(JSON.parse(Buffer.from(binding, 'base64url').toString())).toMatchObject({ kid: 'kid-1' });
    await Promise.all([first.close(), fallback.close()]);
  });
});

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
      authorities: [{ directoryUrl }],
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
      setTxt: async () => { throw new Error('no order expected'); }, authorities: [{ directoryUrl }], acmeCa,
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
    const first = new ComputerCertificate({ key, domain: 'relay.test', certificateStore, accountStore, setTxt: async () => undefined, authorities: [{ directoryUrl }], acmeCa });
    await first.ensure();
    const status = first.getStatus();
    if (!status) throw new Error('no certificate was issued');
    return { key, certificateStore, accountStore, status, serial: new X509Certificate(certificateStore.value ?? '').serialNumber };
  }

  it('renews with the saved ACME account once a third of the lifetime is left', async () => {
    const { key, certificateStore, accountStore, status, serial } = await issued();
    const account = accountStore.value;
    const later = new ComputerCertificate({
      key, domain: 'relay.test', certificateStore, accountStore, setTxt: async () => undefined, authorities: [{ directoryUrl }], acmeCa,
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
      setTxt: async () => undefined, authorities: [{ directoryUrl }], acmeCa,
    });
    await certificate.ensure();
    expect(certificate.isValid()).toBe(true);
  }, 30_000);

  it('replaces a certificate that expired while the computer was off', async () => {
    const { key, certificateStore, accountStore, status, serial } = await issued();
    const afterExpiry = new ComputerCertificate({
      key, domain: 'relay.test', certificateStore, accountStore, setTxt: async () => undefined, authorities: [{ directoryUrl }], acmeCa,
      now: () => Date.parse(status.notAfter) + 24 * 60 * 60_000,
    });
    await afterExpiry.load();
    expect(afterExpiry.isValid()).toBe(false);
    await afterExpiry.ensure();

    expect(new X509Certificate(certificateStore.value ?? '').serialNumber).not.toBe(serial);
    expect(afterExpiry.secureContext()).not.toBeNull();
  }, 30_000);
});
