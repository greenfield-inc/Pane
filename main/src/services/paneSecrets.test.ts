import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryConfig } from '../test/memorySecretStore';
import { fileSecretBackend, PaneSecretStore, type SecretEncryption } from './paneSecrets';

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
