import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import net from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { RelayService, privateAddresses } from './relayService';
import { RELAY_HOST, startFakeRelay } from './__fixtures__/fakeRelay';
import { startIssuingCa } from './__fixtures__/issuingCa';
import { letsEncryptLimit, startRefusingCa } from './__fixtures__/refusingCa';

afterEach(() => { vi.useRealTimers(); });

describe('relay service', () => {
  it('names the file and the next step when the relay key Pane Cloud\'s host wrote before boot does not read', async () => {
    const secretsDir = mkdtempSync(join(tmpdir(), 'pane-relay-preboot-'));
    mkdirSync(join(secretsDir, 'relay'));
    writeFileSync(join(secretsDir, 'relay', 'computer-key.pem'), 'not a key');
    const service = new RelayService({
      settings: () => ({ enabled: true, relayAddress: `${RELAY_HOST}:1` }),
      onSettingsChanged: () => () => {},
      secrets: { read: async () => null, write: async () => {} },
      dataDir: mkdtempSync(join(tmpdir(), 'pane-relay-service-')),
      pairingListener: () => ({ port: 1 }),
      previewPort: () => null,
      displayName: () => 'Cloud Session',
      addClient: async () => {},
      env: { PANE_SECRETS_DIR: secretsDir, PANE_DIRECT_BIN: join(tmpdir(), 'no-pane-direct-here') },
    });
    try {
      service.start();
      await vi.waitFor(() => expect(service.getStatus().lastError).toContain(join(secretsDir, 'relay', 'computer-key.pem')), { timeout: 10_000 });
      expect(service.getStatus().lastError).toContain('Restart the Session from Pane Cloud');
    } finally {
      await service.stop();
    }
  });

  it('a computer Let\'s Encrypt turns away says until when, asks again only then, and Try again asks at once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    const relay = await startFakeRelay();
    // Let's Encrypt names the time to the second.
    const caTime = new Date(Math.floor((Date.now() + 30 * 60_000) / 1000) * 1000);
    const ca = await startRefusingCa(letsEncryptLimit(caTime));
    const service = new RelayService({
      settings: () => ({ enabled: true, relayAddress: `${RELAY_HOST}:${relay.controlPort}` }),
      onSettingsChanged: () => () => {},
      secrets: { read: async () => null, write: async () => {} },
      dataDir: mkdtempSync(join(tmpdir(), 'pane-relay-service-')),
      pairingListener: () => ({ port: 1 }),
      previewPort: () => null,
      displayName: () => 'Studio Mac',
      addClient: async () => {},
      // No pane-direct, even where CI built one: it would first ask the fake relay for its direct relays.
      env: {
        PANE_RELAY_CONNECT_HOST: '127.0.0.1', PANE_RELAY_CA: join(__dirname, '__fixtures__', 'ca.pem'), PANE_ACME_DIRECTORY: ca.directoryUrl,
        PANE_DIRECT_BIN: join(tmpdir(), 'no-pane-direct-here'),
      },
    });
    try {
      service.start();
      await vi.waitFor(() => expect(service.getStatus().lastError).toMatch(/Let's Encrypt, which issues them, is turning away new computers until .+\. Keep Add a device open/u), { timeout: 10_000 });
      expect(service.getStatus()).toMatchObject({ phase: 'error', certificateLimit: { until: caTime.toISOString() } });
      expect(ca.orders()).toBe(1);

      // Waking the computer doesn't order before the CA's time.
      service.resume();
      await vi.advanceTimersByTimeAsync(29 * 60_000);
      expect(ca.orders()).toBe(1);

      // Pane asks again within 5 minutes after the CA's time.
      await vi.advanceTimersByTimeAsync(7 * 60_000);
      await vi.waitFor(() => expect(ca.orders()).toBe(2), { timeout: 10_000 });

      // Try again clears the old reason while it asks.
      await vi.waitFor(() => expect(service.getStatus().lastError).toMatch(/turning away/u), { timeout: 10_000 });
      service.retryNow();
      expect(service.getStatus()).toMatchObject({ phase: 'certificate', lastError: null, certificateLimit: null });
      await vi.waitFor(() => expect(ca.orders()).toBe(3), { timeout: 10_000 });
    } finally {
      await service.stop();
      relay.close();
      await ca.close();
    }
  }, 30_000);

  it('gets a Google Trust Services certificate with a staging key from the relay when Let\'s Encrypt turns the computer away', async () => {
    const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf8');
    const key = { keyId: 'kid-1', hmacKey: 'c2VjcmV0LTE=' };
    const relay = await startFakeRelay({ externalAccountKey: { ...key, email: 'certificates@pane.example' } });
    const letsEncrypt = await startRefusingCa(letsEncryptLimit(new Date(Date.now() + 30 * 60_000)));
    const gts = await startIssuingCa({ certificate: fixture('gts-computer.pem'), externalAccountKeys: [key] });
    // The computer key the fake CA's certificate names.
    const secrets = new Map([['relay/computer-key', fixture('computer.key')]]);
    const service = new RelayService({
      settings: () => ({ enabled: true, relayAddress: `${RELAY_HOST}:${relay.controlPort}` }),
      onSettingsChanged: () => () => {},
      secrets: { read: async (name) => secrets.get(name) ?? null, write: async (name, value) => { secrets.set(name, value); } },
      dataDir: mkdtempSync(join(tmpdir(), 'pane-relay-service-')),
      pairingListener: () => ({ port: 1 }),
      previewPort: () => null,
      displayName: () => 'Studio Mac',
      addClient: async () => {},
      env: {
        PANE_RELAY_CONNECT_HOST: '127.0.0.1', PANE_RELAY_CA: join(__dirname, '__fixtures__', 'ca.pem'),
        PANE_ACME_DIRECTORY: letsEncrypt.directoryUrl, PANE_ACME_FALLBACK_DIRECTORY: gts.directoryUrl,
        PANE_DIRECT_BIN: join(tmpdir(), 'no-pane-direct-here'),
      },
    });
    try {
      service.start();
      await vi.waitFor(() => expect(service.getStatus().phase).toBe('ready'), { timeout: 10_000 });
      expect(service.getStatus()).toMatchObject({ lastError: null, certificate: { issuer: 'Google Trust Services' } });
      expect(letsEncrypt.orders()).toBe(1);
      // Only the trusted Google Trust Services directory gets a production key.
      expect(relay.eabRequests).toEqual([true]);
      expect(gts.accounts()).toEqual([{ eabKeyId: 'kid-1' }]);
    } finally {
      await service.stop();
      relay.close();
      await letsEncrypt.close();
      await gts.close();
    }
  }, 30_000);

  it('names only Let\'s Encrypt when the relay has no Google Trust Services keys to give', async () => {
    const relay = await startFakeRelay();
    const letsEncrypt = await startRefusingCa(letsEncryptLimit(new Date(Date.now() + 30 * 60_000)));
    const gts = await startIssuingCa({ certificate: '', externalAccountKeys: [] });
    const service = new RelayService({
      settings: () => ({ enabled: true, relayAddress: `${RELAY_HOST}:${relay.controlPort}` }),
      onSettingsChanged: () => () => {},
      secrets: { read: async () => null, write: async () => {} },
      dataDir: mkdtempSync(join(tmpdir(), 'pane-relay-service-')),
      pairingListener: () => ({ port: 1 }),
      previewPort: () => null,
      displayName: () => 'Studio Mac',
      addClient: async () => {},
      env: {
        PANE_RELAY_CONNECT_HOST: '127.0.0.1', PANE_RELAY_CA: join(__dirname, '__fixtures__', 'ca.pem'),
        PANE_ACME_DIRECTORY: letsEncrypt.directoryUrl, PANE_ACME_FALLBACK_DIRECTORY: gts.directoryUrl,
        PANE_DIRECT_BIN: join(tmpdir(), 'no-pane-direct-here'),
      },
    });
    try {
      service.start();
      await vi.waitFor(() => expect(service.getStatus().lastError).toMatch(/and Let's Encrypt, which issues them, is turning away new computers until /u), { timeout: 10_000 });
      expect(service.getStatus().phase).toBe('error');
      expect(relay.eabRequests).toEqual([true]);
      expect(gts.orders()).toBe(0);
    } finally {
      await service.stop();
      relay.close();
      await letsEncrypt.close();
      await gts.close();
    }
  }, 30_000);

  it('names both certificate services and asks again within minutes when the relay has no keys left for today', async () => {
    const relay = await startFakeRelay({ externalAccountKey: 'throttled' });
    const letsEncrypt = await startRefusingCa(letsEncryptLimit(new Date(Date.now() + 5 * 24 * 60 * 60_000)));
    const gts = await startIssuingCa({ certificate: '', externalAccountKeys: [] });
    const service = new RelayService({
      settings: () => ({ enabled: true, relayAddress: `${RELAY_HOST}:${relay.controlPort}` }),
      onSettingsChanged: () => () => {},
      secrets: { read: async () => null, write: async () => {} },
      dataDir: mkdtempSync(join(tmpdir(), 'pane-relay-service-')),
      pairingListener: () => ({ port: 1 }),
      previewPort: () => null,
      displayName: () => 'Studio Mac',
      addClient: async () => {},
      env: {
        PANE_RELAY_CONNECT_HOST: '127.0.0.1', PANE_RELAY_CA: join(__dirname, '__fixtures__', 'ca.pem'),
        PANE_ACME_DIRECTORY: letsEncrypt.directoryUrl, PANE_ACME_FALLBACK_DIRECTORY: gts.directoryUrl,
        PANE_DIRECT_BIN: join(tmpdir(), 'no-pane-direct-here'),
      },
    });
    try {
      service.start();
      await vi.waitFor(() => expect(service.getStatus().lastError).toMatch(/Let's Encrypt and Google Trust Services, which issue them, are turning away new computers until /u), { timeout: 10_000 });
      // The pause ends at the usual backoff (at most 30 minutes), not Let's Encrypt's date 5 days out.
      const until = Date.parse(service.getStatus().certificateLimit?.until ?? '');
      expect(until - Date.now()).toBeLessThan(31 * 60_000);
    } finally {
      await service.stop();
      relay.close();
      await letsEncrypt.close();
      await gts.close();
    }
  }, 30_000);

  it('starts phone access again after it failed at launch, as with a locked keychain', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] });
    let locked = true;
    const service = new RelayService({
      // Nothing listens on port 9, so the computer stays connecting; the key is what this checks.
      settings: () => ({ enabled: true, relayAddress: '127.0.0.1:9' }),
      onSettingsChanged: () => () => {},
      secrets: {
        read: async () => {
          if (locked) throw new Error('The keychain is locked.');
          return null;
        },
        write: async () => {},
      },
      dataDir: mkdtempSync(join(tmpdir(), 'pane-relay-service-')),
      pairingListener: () => ({ port: 1 }),
      previewPort: () => null,
      displayName: () => 'Studio Mac',
      addClient: async () => {},
      env: {},
    });
    service.start();
    await vi.waitFor(() => expect(service.getStatus()).toMatchObject({ phase: 'error', lastError: 'The keychain is locked. Pane tries again by itself; choose Try again to try now.', id: null }));

    locked = false;
    await vi.advanceTimersByTimeAsync(5_000);

    await vi.waitFor(() => expect(service.getStatus().id).toMatch(/^[a-z0-9]{16}$/u));
    await service.stop();
  });

  it('says why phones cannot connect while the pairing listener is down, and clears it once the listener is up', async () => {
    let listener: { port: number } | { error: string } = { error: 'listen EADDRINUSE: address already in use 127.0.0.1:42137' };
    let changed = () => {};
    const service = new RelayService({
      // Nothing listens on port 9, so the computer stays connecting.
      settings: () => ({ enabled: true, relayAddress: '127.0.0.1:9' }),
      onSettingsChanged: (onChange) => { changed = onChange; return () => {}; },
      secrets: { read: async () => null, write: async () => {} },
      dataDir: mkdtempSync(join(tmpdir(), 'pane-relay-service-')),
      pairingListener: () => listener,
      previewPort: () => null,
      displayName: () => 'Studio Mac',
      addClient: async () => {},
      env: {},
    });
    service.start();

    await vi.waitFor(() => expect(service.getStatus()).toMatchObject({
      phase: 'error',
      lastError: expect.stringMatching(/^Phones can't connect: this computer's phone listener isn't running \(listen EADDRINUSE.*Settings › Remote Access/u),
    }));
    expect(() => service.createPairingCode()).toThrow(/EADDRINUSE/u);

    listener = { port: 42137 };
    changed();
    await vi.waitFor(() => expect(service.getStatus().lastError ?? '').not.toMatch(/listener/u));
    await service.stop();
  });

  it("keeps Pane's own relay running through unrelated config changes", async () => {
    // Every probe of Pane's relays goes to a closed local port, so the nearest-relay pick stays offline.
    const connect = net.connect.bind(net);
    const probe = vi.spyOn(net, 'connect').mockImplementation(() => connect({ host: '127.0.0.1', port: 9 }));
    let changed = () => {};
    const service = new RelayService({
      settings: () => ({ enabled: true }),
      onSettingsChanged: (onChange) => { changed = onChange; return () => {}; },
      secrets: { read: async () => null, write: async () => {} },
      dataDir: mkdtempSync(join(tmpdir(), 'pane-relay-service-')),
      pairingListener: () => ({ port: 1 }),
      previewPort: () => null,
      displayName: () => 'Studio Mac',
      addClient: async () => {},
      env: { PANE_RELAY_CONNECT_HOST: '127.0.0.1' },
    });
    service.start();
    await vi.waitFor(() => expect(service.getStatus().relay).toBe('us.relay.runpane.net'));
    const probesAtStart = probe.mock.calls.length;

    for (let i = 0; i < 3; i += 1) {
      changed();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(probesAtStart).toBe(4);
    expect(probe.mock.calls.length).toBe(probesAtStart);
    await service.stop();
    probe.mockRestore();
  });

  it('reports only the addresses another computer on the network can reach', () => {
    const v4 = (address: string) => [{ address, netmask: '255.255.240.0', family: 'IPv4' as const, mac: '00:00:00:00:00:00', internal: false, cidr: null }];
    // A Windows computer with WSL and Hyper-V, as `Get-NetIPAddress` lists it.
    expect(privateAddresses({
      'vEthernet (WSL (Hyper-V firewall))': v4('172.19.0.1'),
      'vEthernet (Default Switch)': v4('172.21.144.1'),
      'Wi-Fi 4': v4('169.254.101.22'),
      'Wi-Fi': v4('192.168.1.192'),
      Tailscale: v4('100.65.125.102'),
      docker0: v4('172.17.0.1'),
      'vEthernet (External)': v4('10.0.0.5'),
    })).toEqual(['192.168.1.192', '10.0.0.5']);
  });
});
