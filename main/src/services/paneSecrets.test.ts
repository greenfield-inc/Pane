import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryConfig } from '../test/memorySecretStore';
import { paneSecretReferenceProblem } from '../../../shared/types/paneSecrets';
import { LoginUseLog } from './paneLogins';
import { SecretLeaseStore } from './secretLeases';
import { macKeychain, type SecurityRunner } from './keychain';
import { fileSecretBackend, keychainSecretBackend, PaneSecretStore, type SecretEncryption } from './paneSecrets';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

/** Reversible stand-in for safeStorage: a byte rotation, so ciphertext never contains the plain text. */
function fakeEncryption(available: boolean): SecretEncryption {
  return {
    available: () => available,
    encrypt: async text => Buffer.from(Buffer.from(text, 'utf8').map(byte => (byte + 1) % 256)),
    decrypt: async data => Buffer.from(data.map(byte => (byte + 255) % 256)).toString('utf8'),
  };
}

async function fileStore(encrypted: boolean) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-secrets-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'secrets.json');
  const store = new PaneSecretStore(memoryConfig(), fileSecretBackend(file, fakeEncryption(encrypted)), () => 'linux-box', () => new Date('2026-11-04T12:00:00.000Z'));
  return { store, file };
}

describe('PaneSecretStore on the file backend', () => {
  it('encrypts each value in a 0600 file when the OS offers encryption', async () => {
    const { store, file } = await fileStore(true);

    await store.set('stripe', 'STRIPE_KEY', 'sk_test_canary_value');

    expect(store.storage()).toEqual({ kind: 'file', encrypted: true });
    expect(await store.read('stripe', 'STRIPE_KEY')).toBe('sk_test_canary_value');
    expect(await fs.readFile(file, 'utf8')).not.toContain('sk_test_canary_value');
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it('keeps values as plain text in the 0600 file, and says so, when no keyring is available', async () => {
    const { store, file } = await fileStore(false);

    await store.set('qa', 'TOKEN', 'plain-on-headless');

    expect(store.storage()).toEqual({ kind: 'file', encrypted: false });
    expect(await store.read('qa', 'TOKEN')).toBe('plain-on-headless');
    expect(JSON.parse(await fs.readFile(file, 'utf8')).values['qa/TOKEN']).toEqual({ encrypted: false, data: 'plain-on-headless' });
  });

  it('lists names, times and machines only, and reports whether a set replaced a value', async () => {
    const { store } = await fileStore(true);

    expect((await store.set('stripe', 'STRIPE_KEY', 'one')).replaced).toBe(false);
    expect((await store.set('stripe', 'STRIPE_KEY', 'two')).replaced).toBe(true);
    await store.set('alpha', 'API_KEY', 'three');

    expect(store.list()).toEqual([
      { project: 'alpha', name: 'API_KEY', updatedAt: '2026-11-04T12:00:00.000Z', machine: 'linux-box' },
      { project: 'stripe', name: 'STRIPE_KEY', updatedAt: '2026-11-04T12:00:00.000Z', machine: 'linux-box' },
    ]);
    expect(store.list('stripe').map(secret => secret.name)).toEqual(['STRIPE_KEY']);
    expect(await store.read('stripe', 'STRIPE_KEY')).toBe('two');
  });

  it('deletes a secret, and names the missing secret and the next step without any value', async () => {
    const { store, file } = await fileStore(true);
    await store.set('qa', 'GONE', 'value-to-delete');

    await store.delete('qa', 'GONE');

    expect(store.list()).toEqual([]);
    expect(JSON.parse(await fs.readFile(file, 'utf8')).values).toEqual({});
    await expect(store.read('qa', 'GONE')).rejects.toMatchObject({
      code: 'SECRET_NOT_FOUND',
      message: 'No secret qa/GONE on this machine yet.',
      next: expect.stringContaining('runpane secrets request'),
    });
    await expect(store.delete('qa', 'GONE')).rejects.toMatchObject({ code: 'SECRET_NOT_FOUND' });
  });

  it('announces a change made here, so connected desktops sync it, and stays quiet for changes that arrived by sync', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-secrets-'));
    tempDirs.push(dir);
    const changes: string[] = [];
    const store = new PaneSecretStore(memoryConfig(), fileSecretBackend(path.join(dir, 'secrets.json'), fakeEncryption(true)), () => 'linux-box', () => new Date(), () => changes.push('changed'));

    await store.set('qa', 'HOST_SET', 'v');
    await store.delete('qa', 'HOST_SET');
    expect(changes).toEqual(['changed', 'changed']);

    await store.applyFromSync({ 'qa/FROM_MAC': { value: 'm', updatedAt: '2026-01-01T00:00:00.000Z', source: 'mac' } });
    expect(changes).toHaveLength(2);
  });

  it('refuses names exec could not inject, and bad projects', async () => {
    const { store } = await fileStore(true);

    await expect(store.set('qa', 'PATH', 'x')).rejects.toMatchObject({ code: 'SECRET_INVALID' });
    await expect(store.set('qa', 'PANE_TOKEN', 'x')).rejects.toMatchObject({ code: 'SECRET_INVALID' });
    await expect(store.set('qa', '1BAD', 'x')).rejects.toMatchObject({ code: 'SECRET_INVALID' });
    await expect(store.set('has space', 'OK', 'x')).rejects.toMatchObject({ code: 'SECRET_INVALID' });
    await expect(store.set('qa', 'EMPTY', '')).rejects.toMatchObject({ code: 'SECRET_INVALID' });
    expect(store.list()).toEqual([]);
  });
});

/**
 * `/usr/bin/security` as observed: `-i` reads at most 4,095 bytes of a line as one command,
 * runs the rest as another (`unknown command "…"`), and `-g` prints the password as hex.
 */
function fakeSecurity() {
  const items = new Map<string, string>();
  /** Calls the keychain refuses, as a locked keychain or a denied prompt does. */
  let refuses: (args: readonly string[], stdin: string) => boolean = () => false;
  const run: SecurityRunner = async (args, stdin = '') => {
    if (refuses(args, stdin)) return { code: 51, stdout: '', stderr: 'security: User interaction is not allowed.\n' };
    if (args[0] === '-i') {
      const line = stdin.replace(/\n$/, '');
      const [command, rest] = [line.slice(0, 4095), line.slice(4095)];
      const match = /^add-generic-password -U -s "(.*)" -a "(.*)" -X ([0-9a-f]*)$/.exec(command);
      if (match) items.set(`${match[1]}|${match[2]}`, Buffer.from(match[3], 'hex').toString('utf8'));
      return rest ? { code: 1, stdout: '', stderr: `security: unknown command "${rest}"\n` } : { code: 0, stdout: '', stderr: '' };
    }
    const key = `${args[args.indexOf('-s') + 1]}|${args[args.indexOf('-a') + 1]}`;
    const value = items.get(key);
    if (value === undefined) return { code: 44, stdout: '', stderr: 'security: The specified item could not be found in the keychain.\n' };
    if (args[0] === 'delete-generic-password') items.delete(key);
    return { code: 0, stdout: '', stderr: `password: 0x${Buffer.from(value).toString('hex').toUpperCase()}  "…"\n` };
  };
  return { items, run, refuse: (when: typeof refuses) => { refuses = when; } };
}

describe('Pane secrets in the macOS keychain', () => {
  // A 2,303-character service-account JSON with line breaks and non-ASCII text, as a person pastes it.
  const longValue = `{"type":"service_account","private_key":"-----BEGIN PRIVATE KEY-----\n${'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'.repeat(70)}\n-----END PRIVATE KEY-----\n","note":"café"}`;

  it('keeps a value longer than one keychain item whole, replaces it, and removes every part', async () => {
    const security = fakeSecurity();
    const store = new PaneSecretStore(memoryConfig(), keychainSecretBackend(macKeychain(security.run), 'Pane'), () => 'this-mac');

    await store.set('gcp', 'SERVICE_ACCOUNT', longValue);
    expect(await store.read('gcp', 'SERVICE_ACCOUNT')).toBe(longValue);
    expect(security.items.size).toBeGreaterThan(1);

    await store.set('gcp', 'SERVICE_ACCOUNT', 'short');
    expect(await store.read('gcp', 'SERVICE_ACCOUNT')).toBe('short');
    expect([...security.items.keys()]).toEqual(['Pane|secret:gcp/SERVICE_ACCOUNT']);

    await store.set('gcp', 'SERVICE_ACCOUNT', longValue);
    await store.delete('gcp', 'SERVICE_ACCOUNT');
    expect(security.items.size).toBe(0);
  });

  it('keeps the earlier value and leaves no parts when the keychain refuses the last write of a long value', async () => {
    const security = fakeSecurity();
    const store = new PaneSecretStore(memoryConfig(), keychainSecretBackend(macKeychain(security.run), 'Pane'), () => 'this-mac');
    await store.set('gcp', 'SERVICE_ACCOUNT', 'earlier');
    // The main item's line is the one that names no part.
    security.refuse((args, stdin) => args[0] === '-i' && stdin.includes('-a "secret:gcp/SERVICE_ACCOUNT" '));

    await expect(store.set('gcp', 'SERVICE_ACCOUNT', longValue)).rejects.toMatchObject({ code: 'SECRET_WRITE_FAILED' });

    expect([...security.items.keys()]).toEqual(['Pane|secret:gcp/SERVICE_ACCOUNT']);
    expect(await store.read('gcp', 'SERVICE_ACCOUNT')).toBe('earlier');
  });

  it('keeps a long secret listed when the keychain refuses its delete, and removes every item on retry', async () => {
    const security = fakeSecurity();
    const store = new PaneSecretStore(memoryConfig(), keychainSecretBackend(macKeychain(security.run), 'Pane'), () => 'this-mac');
    await store.set('gcp', 'SERVICE_ACCOUNT', longValue);
    security.refuse(args => args[0] === 'find-generic-password');

    const failure = await store.delete('gcp', 'SERVICE_ACCOUNT').catch((error: Error) => error);

    expect(failure).toMatchObject({ code: 'SECRET_WRITE_FAILED' });
    expect(String(failure)).not.toContain('MIIEvQIBADAN');
    expect(store.has('gcp', 'SERVICE_ACCOUNT')).toBe(true);
    security.refuse(() => false);
    await store.delete('gcp', 'SERVICE_ACCOUNT');
    expect(security.items.size).toBe(0);
  });

  it('never puts the value in a failed write\'s error', async () => {
    const run: SecurityRunner = async (args, stdin = '') => ({ code: 1, stdout: '', stderr: `security: unknown command "${stdin}"\n` });

    const failure = await keychainSecretBackend(macKeychain(run), 'Pane').write('gcp/KEY', 'sk-canary-value').catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain(Buffer.from('sk-canary-value').toString('hex'));
    expect(String(failure)).not.toContain('sk-canary-value');
  });
});

describe('PaneSecretStore 1Password references', () => {
  async function storeWithReference() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-secrets-'));
    tempDirs.push(dir);
    const store = new PaneSecretStore(memoryConfig(), fileSecretBackend(path.join(dir, 'secrets.json'), fakeEncryption(true)), () => 'studio', () => new Date('2026-11-18T12:00:00.000Z'));
    return { store, file: path.join(dir, 'secrets.json') };
  }

  it('replaces a typed secret of the same name, so its value is deleted here and the deletion syncs', async () => {
    const { store, file } = await storeWithReference();
    await store.set('stripe', 'STRIPE_KEY', 'typed-canary');

    expect(await store.setReference('stripe', 'STRIPE_KEY', 'op://Dev/Stripe/credential')).toEqual({ replacedTyped: true });

    expect(JSON.parse(await fs.readFile(file, 'utf8')).values).toEqual({});
    expect((await store.exportForSync())['stripe/STRIPE_KEY']).toMatchObject({ value: null });
    expect(store.exportReferencesForSync()['stripe/STRIPE_KEY']).toMatchObject({ value: 'op://Dev/Stripe/credential' });
    expect(store.listReferences()).toEqual([{ project: 'stripe', name: 'STRIPE_KEY', reference: 'op://Dev/Stripe/credential', updatedAt: '2026-11-18T12:00:00.000Z', machine: 'studio' }]);
  });

  it('has no value without a lease, refuses a typed value, and rejects text that is not a reference', async () => {
    const { store } = await storeWithReference();
    await store.setReference('stripe', 'STRIPE_KEY', 'op://Dev/Stripe/credential');

    await expect(store.read('stripe', 'STRIPE_KEY')).rejects.toMatchObject({ code: 'SECRET_NOT_FOUND' });
    await expect(store.set('stripe', 'STRIPE_KEY', 'typed')).rejects.toMatchObject({
      code: 'SECRET_IS_REFERENCE',
      next: 'Run `runpane secrets lease --project stripe STRIPE_KEY` to use it, or remove the reference in Settings → Secrets first.',
    });
    await expect(store.setReference('stripe', 'OTHER', 'sk_live_not_a_reference')).rejects.toMatchObject({ code: 'SECRET_INVALID' });
  });

  it('ignores a reference in config.json that would not pass when set', async () => {
    const config = memoryConfig();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-secrets-'));
    tempDirs.push(dir);
    const store = new PaneSecretStore(config, fileSecretBackend(path.join(dir, 'secrets.json'), fakeEncryption(true)), () => 'studio');
    await config.updateConfigWith(() => ({ paneSecretReferences: {
      'stripe/EDITED': { reference: 'op://$VAULT/Bank/password', updatedAt: '2026-11-18T12:00:00.000Z', source: 'studio' },
      'stripe/STRIPE_KEY': { reference: 'op://Dev/Stripe/credential', updatedAt: '2026-11-18T12:00:00.000Z', source: 'studio' },
    } }));

    expect(store.referenceOf('stripe', 'EDITED')).toBeNull();
    expect(store.listReferences().map(reference => reference.name)).toEqual(['STRIPE_KEY']);
  });
});

describe('PaneSecretStore logins', () => {
  const VALUE = 'canary-login-5c2e';
  const SITE = 'https://bank.example';

  async function loginStore() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-logins-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'secrets.json');
    const config = memoryConfig();
    const values = fileSecretBackend(file, fakeEncryption(true));
    const clock = { now: Date.parse('2026-11-25T12:00:00Z') };
    const leases = new SecretLeaseStore({ directory: dir, values, now: () => clock.now });
    const store = new PaneSecretStore(config, values, () => 'studio', () => new Date(clock.now), () => undefined, () => leases);
    return { store, config, file, leases, clock };
  }

  it('moves a plain secret onto its sites: filled there, in no command, and listed with no value', async () => {
    const { store, config, file } = await loginStore();
    await store.set('bank', 'PIN', VALUE);
    await expect(store.readLogin('bank', 'PIN')).rejects.toMatchObject({ code: 'SECRET_NOT_LOGIN' });

    await store.setSites('bank', 'PIN', [SITE]);

    expect(await store.readLogin('bank', 'PIN')).toEqual({ value: VALUE, sites: [SITE] });
    await expect(store.read('bank', 'PIN')).rejects.toMatchObject({ code: 'SECRET_IS_LOGIN' });
    expect(store.list()).toEqual([{ project: 'bank', name: 'PIN', sites: [SITE], updatedAt: '2026-11-25T12:00:00.000Z', machine: 'studio' }]);
    expect(JSON.stringify(config.getConfig())).not.toContain(VALUE);
    // The plain copy is gone, here and (by its tombstone) everywhere it synced.
    expect(Object.keys(JSON.parse(await fs.readFile(file, 'utf8')).values)).toEqual(['login:bank/PIN']);
    expect((await store.exportForSync())['bank/PIN'].value).toBeNull();
  });

  it('keeps the sites whatever an agent does: set is refused, and a new value typed by the person changes only the value', async () => {
    const { store } = await loginStore();
    await store.setLogin('bank', 'PIN', VALUE, [SITE]);
    await expect(store.set('bank', 'PIN', 'agent-value')).rejects.toMatchObject({ code: 'SECRET_IS_LOGIN' });
    await store.replaceValue('bank', 'PIN', 'new-by-person');
    expect(await store.readLogin('bank', 'PIN')).toEqual({ value: 'new-by-person', sites: [SITE] });
  });

  it('gains no site, and becomes no login, from an edit of config.json', async () => {
    const { store, config } = await loginStore();
    await store.setLogin('bank', 'PIN', VALUE, [SITE]);
    await store.set('bank', 'PLAIN', 'plain-value');
    const meta = { updatedAt: '2026-11-25T12:00:00.000Z', source: 'studio' };
    await config.updateConfigWith(() => ({ paneLogins: {
      'bank/PIN': { ...meta, sites: [SITE, 'https://evil.test'] },
      'bank/PLAIN': { ...meta, sites: ['https://evil.test'] },
    } }));

    expect((await store.readLogin('bank', 'PIN')).sites).toEqual([SITE]);
    await expect(store.readLogin('bank', 'PLAIN')).rejects.toMatchObject({ code: 'SECRET_UNREADABLE' });
    // Nor does the edit travel to another machine.
    expect(await store.exportLoginsForSync()).toEqual({});
    // Editing the login away makes it a secret with no value, not a plain one.
    await config.updateConfigWith(() => ({ paneLogins: {}, paneSecrets: { 'bank/PIN': meta } }));
    await expect(store.read('bank', 'PIN')).rejects.toMatchObject({ code: 'SECRET_UNREADABLE' });
  });

  it('refuses sites that are not exact web origins', async () => {
    const { store } = await loginStore();
    for (const site of ['http://bank.example', 'https://*.bank.example', 'https://bank.example/login', 'bank.example', 'file:///etc', 'https://user@bank.example', 'https://BANK.example', '']) {
      await expect(store.setLogin('bank', 'PIN', VALUE, [site]), site).rejects.toMatchObject({ code: 'SECRET_INVALID' });
    }
    await expect(store.setLogin('bank', 'PIN', VALUE, [])).rejects.toMatchObject({ code: 'SECRET_INVALID' });
    await store.setLogin('bank', 'PIN', VALUE, ['http://localhost:3000', 'https://bank.example:8443']);
    expect(store.sitesOf('bank', 'PIN')).toEqual(['http://localhost:3000', 'https://bank.example:8443']);
  });

  it('reaches another machine whole, and its deletion does too', async () => {
    const one = await loginStore();
    const two = await loginStore();
    await one.store.setLogin('bank', 'PIN', VALUE, [SITE]);
    expect(await two.store.applyLoginsFromSync(await one.store.exportLoginsForSync())).toEqual(['bank/PIN']);
    expect(await two.store.readLogin('bank', 'PIN')).toEqual({ value: VALUE, sites: [SITE] });
    // A forged record with a site a login can't have is dropped.
    expect(await two.store.applyLoginsFromSync({ 'bank/X': { value: JSON.stringify({ sites: ['http://evil.test'], value: 'x' }), updatedAt: '2026-11-25T12:01:00.000Z', source: 'x' } })).toEqual([]);

    one.clock.now += 60_000;
    two.clock.now += 60_000;
    await one.store.delete('bank', 'PIN');
    await two.store.applyLoginsFromSync(await one.store.exportLoginsForSync());
    expect(two.store.list()).toEqual([]);
    await expect(two.store.readLogin('bank', 'PIN')).rejects.toMatchObject({ code: 'SECRET_NOT_FOUND' });
  });

  it('from 1Password, has a value only during its lease, on the sites the lease was approved with', async () => {
    const { store, config, leases, clock } = await loginStore();
    const reference = 'op://Private/Bank/pin';
    await store.setReference('bank', 'PIN', reference, [SITE]);
    await expect(store.readLogin('bank', 'PIN')).rejects.toMatchObject({ code: 'SECRET_LEASE_ENDED' });

    await leases.grant({ project: 'bank', secrets: [{ name: 'PIN', reference, value: VALUE, sites: [SITE] }], expiresInMs: 60_000, requestedBy: 'test', grantedOn: 'studio' });
    expect(await store.readLogin('bank', 'PIN')).toEqual({ value: VALUE, sites: [SITE] });
    await expect(store.read('bank', 'PIN')).rejects.toMatchObject({ code: 'SECRET_IS_LOGIN' });
    await expect(leases.read('bank', 'PIN')).rejects.toMatchObject({ code: 'SECRET_IS_LOGIN' });

    const meta = { updatedAt: '2026-11-25T12:00:00.000Z', source: 'studio', reference };
    await config.updateConfigWith(() => ({ paneSecretReferences: { 'bank/PIN': { ...meta, sites: [SITE, 'https://evil.test'] } } }));
    expect((await store.readLogin('bank', 'PIN')).sites).toEqual([SITE]);
    // Editing the sites away doesn't free the leased value either.
    await config.updateConfigWith(() => ({ paneSecretReferences: { 'bank/PIN': meta } }));
    await expect(store.read('bank', 'PIN')).rejects.toMatchObject({ code: 'SECRET_IS_LOGIN' });
    await config.updateConfigWith(() => ({ paneSecretReferences: { 'bank/PIN': { ...meta, sites: [SITE] } } }));

    clock.now += 61_000;
    await expect(store.readLogin('bank', 'PIN')).rejects.toMatchObject({ code: 'SECRET_LEASE_ENDED' });
    leases.dispose();
  });

  it('from 1Password, loses a removed site at once, and is filled no more once removed or replaced, though its lease lives', async () => {
    const { store, leases } = await loginStore();
    const reference = 'op://Private/Bank/pin';
    const other = 'https://card.example';
    const lease = { project: 'bank', secrets: [{ name: 'PIN', reference, value: VALUE, sites: [SITE, other] }], expiresInMs: 60_000, requestedBy: 'test', grantedOn: 'studio' };
    // A lease pushed before the reference has synced here answers.
    await leases.grant(lease);
    expect(await store.readLogin('bank', 'PIN')).toEqual({ value: VALUE, sites: [SITE, other] });

    await store.setReference('bank', 'PIN', reference, [SITE, other]);
    await store.setSites('bank', 'PIN', [SITE]);
    expect((await store.readLogin('bank', 'PIN')).sites).toEqual([SITE]);

    await store.delete('bank', 'PIN');
    await expect(store.readLogin('bank', 'PIN')).rejects.toMatchObject({ code: 'SECRET_NOT_FOUND' });
    await store.setLogin('bank', 'PIN', 'typed-since', [other]);
    expect(await store.readLogin('bank', 'PIN')).toEqual({ value: 'typed-since', sites: [other] });
    leases.dispose();
  });

  it('stays a login when its 1Password reference changes, or its value moves to 1Password', async () => {
    const { store } = await loginStore();
    await store.setReference('bank', 'PIN', 'op://Private/Bank/pin', [SITE]);
    await store.setReference('bank', 'PIN', 'op://Private/Bank/new-pin');
    expect(store.sitesOf('bank', 'PIN')).toEqual([SITE]);
    await store.setLogin('bank', 'PASSWORD', VALUE, [SITE]);
    await store.setReference('bank', 'PASSWORD', 'op://Private/Bank/password');
    expect(store.sitesOf('bank', 'PASSWORD')).toEqual([SITE]);
  });

  it('keeps the newer login when an older copy arrives by sync', async () => {
    const one = await loginStore();
    const two = await loginStore();
    await one.store.setLogin('bank', 'PIN', 'old', [SITE]);
    const old = await one.store.exportLoginsForSync();
    two.clock.now += 60_000;
    await two.store.setLogin('bank', 'PIN', 'new', [SITE]);
    expect(await two.store.applyLoginsFromSync(old)).toEqual([]);
    expect((await two.store.readLogin('bank', 'PIN')).value).toBe('new');
  });

  it('syncs a login reference so an older machine reads no reference in it', async () => {
    const one = await loginStore();
    const two = await loginStore();
    await one.store.setReference('bank', 'PIN', 'op://Private/Bank/pin', [SITE]);
    const exported = one.store.exportReferencesForSync();
    expect(paneSecretReferenceProblem(exported['bank/PIN'].value ?? '')).not.toBeNull();
    await two.store.applyReferencesFromSync(exported);
    expect(two.store.sitesOf('bank', 'PIN')).toEqual([SITE]);
    expect(two.store.referenceOf('bank', 'PIN')).toBe('op://Private/Bank/pin');
  });
});

describe('LoginUseLog', () => {
  it('keeps every use on disk and lists the newest first, skipping lines it cannot read', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-login-uses-'));
    tempDirs.push(dir);
    const use = (at: string) => ({ project: 'bank', name: 'PIN', site: 'https://bank.example', agent: 'Claude Code', pane: 'billing', at });
    await new LoginUseLog(dir).record(use('2026-11-25T12:00:00.000Z'));
    await fs.appendFile(path.join(dir, 'login-uses.log'), 'not json\n');
    await new LoginUseLog(dir).record(use('2026-11-25T12:05:00.000Z'));
    expect((await new LoginUseLog(dir).recent()).map(entry => entry.at)).toEqual(['2026-11-25T12:05:00.000Z', '2026-11-25T12:00:00.000Z']);
  });
});
