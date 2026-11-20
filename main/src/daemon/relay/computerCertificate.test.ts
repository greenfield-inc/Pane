import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { generateKeyPairSync, X509Certificate } from 'crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import net from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadComputerKey, type KeyStore } from './computerKey';
import { CertificateRateLimited, ComputerCertificate, type CertificateAuthority } from './computerCertificate';
import { integrationEnvSet } from './__fixtures__/integrationEnv';
import { startIssuingCa } from './__fixtures__/issuingCa';
import { letsEncryptLimit, startRefusingCa } from './__fixtures__/refusingCa';

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

function letsEncrypt(directoryUrl: string, accountStore: KeyStore = memory()): CertificateAuthority {
  return { name: "Let's Encrypt", directoryUrl, accountStore };
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
      key, domain: 'relay.test', certificateStore: memory('not a certificate'), authorities: [], setTxt: async () => undefined,
    });

    await certificate.load();

    expect(certificate.getStatus()).toBeNull();
    expect(certificate.needsRenewal()).toBe(true);
  });
});

describe('a certificate authority that refuses for its rate limits', () => {
  it('fails the order at once, saying when the CA takes new orders again, instead of waiting for it', async () => {
    const ca = await startRefusingCa(letsEncryptLimit(new Date('2026-11-20T22:16:39Z')));
    try {
      const certificate = new ComputerCertificate({
        key: await loadComputerKey(memory()), domain: 'runpane.net', certificateStore: memory(), authorities: [letsEncrypt(ca.directoryUrl)],
        setTxt: async () => undefined,
      });

      const started = Date.now();
      const failure = await certificate.ensure().then(() => null, (error: Error) => error);

      expect(failure).toBeInstanceOf(CertificateRateLimited);
      expect(failure).toMatchObject({ retryAt: Date.parse('2026-11-20T22:16:39Z') });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(certificate.isValid()).toBe(false);
    } finally {
      await ca.close();
    }
  });
});

describe('falling back to Google Trust Services', () => {
  const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf8');
  // The computer key the fake CA's certificate names (75rnqtlvttepjja3.relay.test).
  const computerKey = () => loadComputerKey(memory(fixture('computer.key')));
  const refusedUntil = new Date('2099-11-20T22:16:39Z');

  /** Google Trust Services as Pane asks it: a separate account, registered with a one-time key from the relay. */
  function googleTrustServices(directoryUrl: string, keys: (() => Promise<{ keyId: string; hmacKey: string }>)[], accountStore = memory()) {
    let asked = 0;
    const authority: CertificateAuthority = {
      name: 'Google Trust Services',
      directoryUrl,
      accountStore,
      externalAccountKey: () => {
        const next = keys[asked] ?? (() => Promise.reject(new Error('no more keys')));
        asked += 1;
        return next();
      },
    };
    return { authority, asked: () => asked };
  }

  it('orders from Google Trust Services with a one-time EAB key once Let\'s Encrypt refuses, and renews there with the same account', async () => {
    const letsEncryptCa = await startRefusingCa(letsEncryptLimit(refusedUntil));
    const gtsCa = await startIssuingCa({ certificate: fixture('gts-computer.pem'), externalAccountKeys: [{ keyId: 'kid-1', hmacKey: 'c2VjcmV0LTE=' }] });
    try {
      const key = await computerKey();
      const certificateStore = memory();
      const gts = googleTrustServices(gtsCa.directoryUrl, [async () => ({ keyId: 'kid-1', hmacKey: 'c2VjcmV0LTE=' })]);
      const txt: string[][] = [];
      const options = { key, domain: 'relay.test', certificateStore, setTxt: async (values: string[]) => { txt.push(values); } };
      const certificate = new ComputerCertificate({ ...options, authorities: [letsEncrypt(letsEncryptCa.directoryUrl), gts.authority] });

      await certificate.ensure();

      expect(certificate.isValid()).toBe(true);
      expect(certificate.getStatus()?.issuer).toBe('Google Trust Services');
      expect(gtsCa.accounts()).toEqual([{ eabKeyId: 'kid-1' }]);
      // The name and its wildcard, each proven over DNS-01 through the relay.
      expect(gtsCa.challenges()).toBe(2);
      expect(Math.max(...txt.map((values) => values.length))).toBeGreaterThanOrEqual(1);
      expect(letsEncryptCa.orders()).toBe(1);

      // At renewal time the order goes to Google Trust Services, which issued it, on the account it already has.
      const status = certificate.getStatus();
      const renewing = new ComputerCertificate({
        ...options, authorities: [letsEncrypt(letsEncryptCa.directoryUrl), gts.authority],
        now: () => Date.parse(status?.renewAt ?? '') + 1_000,
      });
      await renewing.load();
      expect(renewing.needsRenewal()).toBe(true);
      await renewing.ensure();

      expect(gtsCa.orders()).toBe(2);
      expect(letsEncryptCa.orders()).toBe(1);
      expect(gts.asked()).toBe(1);
      expect(gtsCa.accounts()).toHaveLength(1);
    } finally {
      await letsEncryptCa.close();
      await gtsCa.close();
    }
  });

  it('says when Let\'s Encrypt takes orders again when Google Trust Services refuses too', async () => {
    const letsEncryptCa = await startRefusingCa(letsEncryptLimit(refusedUntil));
    const gtsCa = await startRefusingCa('Quota exceeded for new orders');
    try {
      const gts = googleTrustServices(gtsCa.directoryUrl, [async () => ({ keyId: 'kid-1', hmacKey: 'c2VjcmV0LTE=' })]);
      const certificate = new ComputerCertificate({
        key: await computerKey(), domain: 'relay.test', certificateStore: memory(), setTxt: async () => undefined,
        authorities: [letsEncrypt(letsEncryptCa.directoryUrl), gts.authority],
      });

      const failure = await certificate.ensure().then(() => null, (error: Error) => error);

      expect(failure).toBeInstanceOf(CertificateRateLimited);
      expect(failure).toMatchObject({ retryAt: refusedUntil.getTime() });
      expect(failure?.message).toMatch(/^Let's Encrypt: too many certificates.* Google Trust Services: Quota exceeded/u);
      expect(gtsCa.orders()).toBe(1);
    } finally {
      await letsEncryptCa.close();
      await gtsCa.close();
    }
  });

  it('counts a relay with no key to give as Google Trust Services refusing', async () => {
    const letsEncryptCa = await startRefusingCa(letsEncryptLimit(refusedUntil));
    const gtsCa = await startIssuingCa({ certificate: fixture('gts-computer.pem'), externalAccountKeys: [] });
    try {
      const gts = googleTrustServices(gtsCa.directoryUrl, [() => Promise.reject(new CertificateRateLimited('This relay does not hand out Google Trust Services keys.', null))]);
      const certificate = new ComputerCertificate({
        key: await computerKey(), domain: 'relay.test', certificateStore: memory(), setTxt: async () => undefined,
        authorities: [letsEncrypt(letsEncryptCa.directoryUrl), gts.authority],
      });

      const failure = await certificate.ensure().then(() => null, (error: Error) => error);

      expect(failure).toBeInstanceOf(CertificateRateLimited);
      expect(failure).toMatchObject({ retryAt: refusedUntil.getTime() });
      expect(gtsCa.accounts()).toEqual([]);
    } finally {
      await letsEncryptCa.close();
      await gtsCa.close();
    }
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
      authorities: [letsEncrypt(directoryUrl)],
      setTxt: async (values) => { txtCalls.push(values); },
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
      key, domain: 'relay.test', certificateStore, authorities: [letsEncrypt(directoryUrl)],
      setTxt: async () => { throw new Error('no order expected'); }, acmeCa,
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
    const first = new ComputerCertificate({ key, domain: 'relay.test', certificateStore, authorities: [letsEncrypt(directoryUrl, accountStore)], setTxt: async () => undefined, acmeCa });
    await first.ensure();
    const status = first.getStatus();
    if (!status) throw new Error('no certificate was issued');
    return { key, certificateStore, accountStore, status, serial: new X509Certificate(certificateStore.value ?? '').serialNumber };
  }

  it('renews with the saved ACME account once a third of the lifetime is left', async () => {
    const { key, certificateStore, accountStore, status, serial } = await issued();
    const account = accountStore.value;
    const later = new ComputerCertificate({
      key, domain: 'relay.test', certificateStore, authorities: [letsEncrypt(directoryUrl, accountStore)], setTxt: async () => undefined, acmeCa,
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
      key, domain: 'relay.test', certificateStore: memory(),
      authorities: [letsEncrypt(directoryUrl, memory(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()))],
      setTxt: async () => undefined, acmeCa,
    });
    await certificate.ensure();
    expect(certificate.isValid()).toBe(true);
  }, 30_000);

  it('replaces a certificate that expired while the computer was off', async () => {
    const { key, certificateStore, accountStore, status, serial } = await issued();
    const afterExpiry = new ComputerCertificate({
      key, domain: 'relay.test', certificateStore, authorities: [letsEncrypt(directoryUrl, accountStore)], setTxt: async () => undefined, acmeCa,
      now: () => Date.parse(status.notAfter) + 24 * 60 * 60_000,
    });
    await afterExpiry.load();
    expect(afterExpiry.isValid()).toBe(false);
    await afterExpiry.ensure();

    expect(new X509Certificate(certificateStore.value ?? '').serialNumber).not.toBe(serial);
    expect(afterExpiry.secureContext()).not.toBeNull();
  }, 30_000);
});
