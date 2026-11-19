import { readFileSync } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileSecretBackend, type SecretEncryption } from './paneSecrets';
import { SecretLeaseStore } from './secretLeases';

const CANARY = 'sk_test_lease_canary_7f3a';
const HOUR = 60 * 60 * 1000;
const dirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

/** Reversible stand-in for safeStorage: a byte rotation, so ciphertext never contains the plain text. */
const rotation: SecretEncryption = {
  available: () => true,
  encrypt: async text => Buffer.from(Buffer.from(text, 'utf8').map(byte => (byte + 1) % 256)),
  decrypt: async data => Buffer.from(data.map(byte => (byte + 255) % 256)).toString('utf8'),
};

async function dataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-leases-'));
  dirs.push(dir);
  return dir;
}

/** A store over the real file backend; `encrypts: false` is a Linux host with no keyring, where that backend writes plain text. */
function storeIn(dir: string, clock: { now: number }, encrypts = true) {
  return new SecretLeaseStore({
    directory: dir,
    values: fileSecretBackend(path.join(dir, 'secrets.json'), { ...rotation, available: () => encrypts }),
    now: () => clock.now,
  });
}

/** Every file under `dir`, read as text: where a value must never be found once a lease ends. */
async function everything(dir: string): Promise<string> {
  const names = await fs.readdir(dir);
  const texts = await Promise.all(names.map(name => fs.readFile(path.join(dir, name), 'utf8')));
  return texts.join('\n');
}

function logLines(text: string): Array<{ event: string; names: string[] }> {
  return text.trim().split('\n').map(line => JSON.parse(line));
}

const grant = (overrides: Partial<Parameters<SecretLeaseStore['grant']>[0]> = {}) => ({
  project: 'stripe',
  secrets: [{ name: 'STRIPE_KEY', reference: 'op://Dev/Stripe/credential', value: CANARY }],
  expiresInMs: 24 * HOUR,
  requestedBy: 'Claude in "billing-sync"',
  grantedOn: 'studio',
  ...overrides,
});

describe('SecretLeaseStore', () => {
  it('serves a leased value, keeps it encrypted at rest, and logs the grant without the value', async () => {
    const dir = await dataDir();
    const store = storeIn(dir, { now: Date.parse('2026-11-18T12:00:00Z') });

    const lease = await store.grant(grant());

    expect(await store.read('stripe', 'STRIPE_KEY')).toBe(CANARY);
    expect(lease).toMatchObject({ project: 'stripe', names: ['STRIPE_KEY'], expiresAt: '2026-11-19T12:00:00.000Z', memoryOnly: false });
    expect(await everything(dir)).not.toContain(CANARY);
    expect(logLines(await fs.readFile(path.join(dir, 'secret-leases.log'), 'utf8'))).toMatchObject([{ event: 'granted', names: ['STRIPE_KEY'] }]);
    store.dispose();
  });

  it('deletes the value on time and then refuses with the lease command as the next step', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const dir = await dataDir();
    const clock = { now: Date.parse('2026-11-18T12:00:00Z') };
    const store = storeIn(dir, clock);
    await store.grant(grant({ expiresInMs: 5 * 60 * 1000 }));

    clock.now += 5 * 60 * 1000;
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    await expect(store.read('stripe', 'STRIPE_KEY')).rejects.toMatchObject({
      code: 'SECRET_LEASE_ENDED',
      message: 'stripe/STRIPE_KEY comes from 1Password, and its lease on this machine ended at 2026-11-18T12:05:00.000Z. Nothing was run.',
      next: 'Run `runpane secrets lease --project stripe STRIPE_KEY`, and the person approves it on the card. Or run with `--only` and the typed names you need.',
    });
    expect(JSON.parse(await fs.readFile(path.join(dir, 'secrets.json'), 'utf8')).values).toEqual({});
    expect(logLines(await fs.readFile(path.join(dir, 'secret-leases.log'), 'utf8')).map(line => line.event)).toEqual(['granted', 'expired']);
    store.dispose();
  });

  it('survives a restart, and a start after expiry deletes the value before any read is answered', async () => {
    const dir = await dataDir();
    const clock = { now: Date.parse('2026-11-18T12:00:00Z') };
    const first = storeIn(dir, clock);
    await first.grant(grant({ expiresInMs: HOUR }));
    first.dispose();

    const restarted = storeIn(dir, clock);
    expect(await restarted.read('stripe', 'STRIPE_KEY')).toBe(CANARY);
    restarted.dispose();

    // Pane was killed, and starts again after the lease ended.
    clock.now += 2 * HOUR;
    const afterCrash = storeIn(dir, clock);
    await expect(afterCrash.read('stripe', 'STRIPE_KEY')).rejects.toMatchObject({ code: 'SECRET_LEASE_ENDED' });
    expect(await everything(dir)).not.toContain(CANARY);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'secret-leases.json'), 'utf8')).leases).toEqual([]);
    expect(logLines(await fs.readFile(path.join(dir, 'secret-leases.log'), 'utf8')).map(line => line.event)).toEqual(['granted', 'swept']);
    afterCrash.dispose();
  });

  it('holds a lease in memory only where it cannot encrypt, so a restart ends it', async () => {
    const dir = await dataDir();
    const clock = { now: Date.parse('2026-11-18T12:00:00Z') };
    const store = storeIn(dir, clock, false);

    const lease = await store.grant(grant());

    expect(lease.memoryOnly).toBe(true);
    expect(await store.read('stripe', 'STRIPE_KEY')).toBe(CANARY);
    expect(await everything(dir)).not.toContain(CANARY);
    store.dispose();
    await expect(storeIn(dir, clock, false).read('stripe', 'STRIPE_KEY')).rejects.toMatchObject({ code: 'SECRET_LEASE_ENDED' });
  });

  it('ends a lease now, and a renewal keeps its id with a new expiry', async () => {
    const dir = await dataDir();
    const clock = { now: Date.parse('2026-11-18T12:00:00Z') };
    const store = storeIn(dir, clock);
    const first = await store.grant(grant({ expiresInMs: HOUR }));

    clock.now += 30 * 60 * 1000;
    const renewed = await store.grant(grant({ id: first.id, expiresInMs: 4 * HOUR, secrets: [{ name: 'STRIPE_KEY', reference: 'op://Dev/Stripe/credential', value: 'rotated' }] }));
    expect(renewed).toMatchObject({ id: first.id, grantedAt: first.grantedAt, expiresAt: '2026-11-18T16:30:00.000Z' });
    expect(await store.read('stripe', 'STRIPE_KEY')).toBe('rotated');

    expect(await store.end(first.id)).toBe(true);
    expect(store.list()).toEqual([]);
    await expect(store.read('stripe', 'STRIPE_KEY')).rejects.toMatchObject({ code: 'SECRET_LEASE_ENDED' });
    expect(logLines(await fs.readFile(path.join(dir, 'secret-leases.log'), 'utf8')).map(line => line.event)).toEqual(['granted', 'renewed', 'ended']);
    store.dispose();
  });

  it('keeps typed secrets working when the start-up sweep fails, and deletes on a later pass', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const dir = await dataDir();
    const clock = { now: Date.parse('2026-11-18T12:00:00Z') };
    const first = storeIn(dir, clock);
    await first.grant(grant({ expiresInMs: HOUR }));
    first.dispose();
    clock.now += 2 * HOUR;
    let failing = true;
    const backend = fileSecretBackend(path.join(dir, 'secrets.json'), rotation);
    const flaky = { ...backend, remove: async (key: string) => { if (failing) throw new Error('EPERM: file is in use'); return backend.remove(key); } };
    const store = new SecretLeaseStore({ directory: dir, values: flaky, now: () => clock.now });

    await expect(store.ready()).resolves.toBeUndefined();
    await expect(store.read('stripe', 'STRIPE_KEY')).rejects.toMatchObject({ code: 'SECRET_LEASE_ENDED' });

    failing = false;
    clock.now += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(JSON.parse(readFileSync(path.join(dir, 'secrets.json'), 'utf8')).values).toEqual({}));
    store.dispose();
  });

  it('retries a value it cannot delete on a backoff, not in a loop, and logs it once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const dir = await dataDir();
    const clock = { now: Date.parse('2026-11-18T12:00:00Z') };
    const backend = fileSecretBackend(path.join(dir, 'secrets.json'), rotation);
    let attempts = 0;
    const stuck = { ...backend, remove: async () => { attempts += 1; throw new Error('the keychain is locked'); } };
    const store = new SecretLeaseStore({ directory: dir, values: stuck, now: () => clock.now });
    const lease = await store.grant(grant());

    await store.end(lease.id);
    clock.now += 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toBe(1);

    clock.now += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(attempts).toBe(2));
    expect(logLines(await fs.readFile(path.join(dir, 'secret-leases.log'), 'utf8')).map(line => line.event)).toEqual(['granted', 'ended']);
    store.dispose();
  });

  it('tells listeners which leases ran out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const dir = await dataDir();
    const clock = { now: Date.parse('2026-11-18T12:00:00Z') };
    const store = storeIn(dir, clock);
    const ended: string[][] = [];
    store.onEnded(ids => ended.push(ids));
    const lease = await store.grant(grant({ expiresInMs: 60_000 }));

    clock.now += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);

    await vi.waitFor(() => expect(ended).toEqual([[lease.id]]));
    store.dispose();
  });
});
