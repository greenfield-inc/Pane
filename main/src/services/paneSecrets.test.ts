import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryConfig } from '../test/memorySecretStore';
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
    encrypt: text => Buffer.from(Buffer.from(text, 'utf8').map(byte => (byte + 1) % 256)),
    decrypt: data => Buffer.from(data.map(byte => (byte + 255) % 256)).toString('utf8'),
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
