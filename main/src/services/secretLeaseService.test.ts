import { readFileSync } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryConfig } from '../test/memorySecretStore';
import { fileSecretBackend, PaneSecretStore, type SecretEncryption } from './paneSecrets';
import { OnePassword, type OpRunner } from './onePassword';
import { SecretLeaseStore } from './secretLeases';
import { leaseEndSchema, leasePushSchema, pushedSecrets, SecretLeaseService, type LeaseMachineLink } from './secretLeaseService';
import { decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import type { PaneCommandValue } from '../daemon/commandRegistry';
import type { AppConfig } from '../types/config';

const HOUR = 60 * 60 * 1000;
const dirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true, maxRetries: 3 })));
});

const plain: SecretEncryption = { available: () => true, encrypt: async text => Buffer.from(text), decrypt: async data => data.toString() };

/** A stand-in `op`: answers `inject` from `items`, counting each call as one 1Password prompt. */
function fakeOp(items: Record<string, string>) {
  const calls: string[][] = [];
  const run: OpRunner = async (args, stdin) => {
    calls.push([...args]);
    const stdout = stdin.replace(/\{\{ (op:\/\/[^}]+) \}\}/g, (_match, reference: string) => items[reference] ?? '');
    return { code: 0, stdout, stderr: '' };
  };
  return { calls, onePassword: new OnePassword(run) };
}

/** A saved machine that keeps what the desktop pushes in its own lease store. */
async function fakeHost(name: string, clock: { now: number }, options: { online?: boolean; refuse?: string; memoryOnly?: boolean } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-lease-host-'));
  dirs.push(dir);
  const store = new SecretLeaseStore({ directory: dir, values: fileSecretBackend(path.join(dir, 'secrets.json'), plain), now: () => clock.now });
  const received: Array<{ channel: string; arg: PaneCommandValue }> = [];
  const link: LeaseMachineLink = {
    id: `${name}-id`,
    name,
    online: options.online ?? true,
    invoke: async (channel, args) => {
      received.push({ channel, arg: args[0] });
      if (options.refuse) throw Object.assign(new Error(options.refuse), { code: 'ERR_UNKNOWN_CHANNEL' });
      if (channel === 'secrets:lease:push') {
        const pushed = decodeBoundary(args[0], leasePushSchema);
        return { ok: true, lease: await store.grant({ ...pushed, secrets: pushedSecrets(pushed) }) };
      }
      if (channel === 'secrets:lease:end') return { ok: true, ended: await store.end(decodeBoundary(args[0], leaseEndSchema).id) };
      if (channel === 'secrets:lease:list') return { leases: store.list(), memoryOnly: options.memoryOnly ?? false, refusal: null };
      throw new Error(`unexpected ${channel}`);
    },
  };
  return { link, store, received };
}

async function desktop(clock: { now: number }, machines: LeaseMachineLink[], items: Record<string, string>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-lease-desktop-'));
  dirs.push(dir);
  const config = memoryConfig();
  const values = fileSecretBackend(path.join(dir, 'secrets.json'), plain);
  const store = new SecretLeaseStore({ directory: dir, values, now: () => clock.now });
  const secrets = new PaneSecretStore(config, values, () => 'studio', () => new Date(clock.now), () => undefined, () => store);
  const op = fakeOp(items);
  const reminders: string[] = [];
  const closed: string[] = [];
  const service = new SecretLeaseService({
    store,
    secrets: () => secrets,
    onePassword: () => op.onePassword,
    config: () => config.getConfig(),
    updateConfig: update => config.updateConfigWith(update),
    machines: () => machines,
    hostLabel: () => 'studio',
    now: () => clock.now,
    postReminder: lease => reminders.push(lease.id),
    closeReminder: id => closed.push(id),
  });
  return { service, secrets, store, op, reminders, closed, config, dir };
}

const ITEMS = {
  'op://Dev/Stripe/credential': 'sk_live_canary_1',
  'op://Dev/Neon/url': 'postgres://user:canary@db/neon\nsecond-line',
};

describe('SecretLeaseService', () => {
  it('reads every reference in one 1Password call, keeps the lease here and pushes it with the time remaining', async () => {
    const clock = { now: Date.parse('2026-11-18T12:00:00Z') };
    const devbox = await fakeHost('devbox', clock);
    const { service, secrets, store, op } = await desktop(clock, [devbox.link], ITEMS);
    await secrets.setReference('stripe', 'STRIPE_KEY', 'op://Dev/Stripe/credential');
    await secrets.setReference('stripe', 'DATABASE_URL', 'op://Dev/Neon/url');

    const started = await service.start({ project: 'stripe', names: ['STRIPE_KEY', 'DATABASE_URL'], machines: ['devbox-id'], requestedBy: 'Claude in "billing-sync"' });

    expect(op.calls).toEqual([['inject']]);
    expect(started).toMatchObject({ expiresAt: '2026-11-19T12:00:00.000Z', machines: ['studio', 'devbox'], refused: [] });
    expect(await secrets.read('stripe', 'DATABASE_URL')).toBe('postgres://user:canary@db/neon\nsecond-line');
    expect(await devbox.store.read('stripe', 'STRIPE_KEY')).toBe('sk_live_canary_1');
    expect(devbox.received[0].arg).toMatchObject({ id: started.leaseId, expiresInMs: 24 * HOUR });
    expect(store.get(started.leaseId)?.pushedTo).toEqual(['devbox-id']);
    service.dispose();
  });

  it('pushes a login with its sites, in a field a machine from before logins drops, and renews it with the sites of then', async () => {
    const clock = { now: Date.parse('2026-11-18T12:00:00Z') };
    const devbox = await fakeHost('devbox', clock);
    const { service, secrets } = await desktop(clock, [devbox.link], ITEMS);
    await secrets.setReference('stripe', 'STRIPE_KEY', 'op://Dev/Stripe/credential', ['https://dashboard.stripe.com']);

    const started = await service.start({ project: 'stripe', names: ['STRIPE_KEY'], machines: ['devbox-id'], requestedBy: 'Settings' });

    expect(await devbox.store.readLogin('stripe', 'STRIPE_KEY')).toEqual({ value: 'sk_live_canary_1', sites: ['https://dashboard.stripe.com'] });
    await expect(devbox.store.read('stripe', 'STRIPE_KEY')).rejects.toMatchObject({ code: 'SECRET_IS_LOGIN' });
    const push = decodeBoundary(devbox.received[0].arg, leasePushSchema);
    expect(push.secrets).toEqual([]);

    await secrets.setSites('stripe', 'STRIPE_KEY', ['https://connect.stripe.com']);
    await service.start({ project: 'stripe', names: ['STRIPE_KEY'], machines: [], requestedBy: 'Settings', renews: started.leaseId });
    expect((await devbox.store.readLogin('stripe', 'STRIPE_KEY'))?.sites).toEqual(['https://connect.stripe.com']);
    service.dispose();
  });

  it('leases only what the person was shown: not other sites, no sites, or another item', async () => {
    const clock = { now: Date.parse('2026-11-18T12:00:00Z') };
    const { service, secrets, store, op, config } = await desktop(clock, [], ITEMS);
    const reference = 'op://Dev/Stripe/credential';
    await secrets.setReference('stripe', 'PIN', reference, ['https://bank.example']);
    const request = { project: 'stripe', names: ['PIN'], machines: [], requestedBy: 'Claude', approved: { PIN: 'op://Dev/Stripe/credential (login for https://bank.example)' } };
    const { leaseId } = await service.start(request);

    const meta = { updatedAt: '2026-11-18T12:00:00.000Z', source: 'studio', reference };
    for (const edited of [{ ...meta, sites: ['https://evil.test'] }, meta, { ...meta, reference: 'op://Dev/Neon/url', sites: ['https://bank.example'] }]) {
      await config.updateConfigWith(() => ({ paneSecretReferences: { 'stripe/PIN': edited } }));
      // Start lease and Extend alike, before 1Password is asked.
      for (const renews of [undefined, leaseId]) {
        await expect(service.start({ ...request, renews })).rejects.toMatchObject({ code: 'SECRET_LEASE_CHANGED' });
      }
    }
    expect(op.calls).toHaveLength(1);
    expect(await store.readLogin('stripe', 'PIN')).toEqual({ value: 'sk_live_canary_1', sites: ['https://bank.example'] });
    service.dispose();
  });

  it('refuses a name that is not a 1Password reference here, before reading 1Password', async () => {
    const clock = { now: Date.parse('2026-11-18T12:00:00Z') };
    const { service, secrets, op } = await desktop(clock, [], ITEMS);
    await secrets.set('stripe', 'TYPED', 'typed-value');

    await expect(service.start({ project: 'stripe', names: ['TYPED'], machines: [], requestedBy: 'Settings' })).rejects.toMatchObject({
      code: 'SECRET_NOT_REFERENCE',
      next: 'Add it in Settings → Secrets with Add from 1Password, then start the lease again.',
    });
    expect(op.calls).toEqual([]);
  });

  it('lists an offline machine and one too old for leases as refused, and sends them nothing', async () => {
    const clock = { now: Date.parse('2026-11-18T12:00:00Z') };
    const laptop = await fakeHost('laptop', clock, { online: false });
    const old = await fakeHost('old-host', clock, { refuse: 'Unknown channel' });
    const { service, secrets } = await desktop(clock, [laptop.link, old.link], ITEMS);
    await secrets.setReference('stripe', 'STRIPE_KEY', 'op://Dev/Stripe/credential');

    const started = await service.start({ project: 'stripe', names: ['STRIPE_KEY'], machines: ['laptop-id', 'old-host-id'], requestedBy: 'Settings' });

    expect(started.machines).toEqual(['studio']);
    expect(started.refused).toEqual(expect.arrayContaining([
      { machine: 'laptop', reason: 'laptop is offline' },
      { machine: 'old-host', reason: 'Pane on old-host needs an update for leases' },
    ]));
    expect(laptop.received).toEqual([]);
    service.dispose();
  });

  it('refuses to lease on a desktop shared with everyone on the tailnet', async () => {
    const clock = { now: Date.parse('2026-11-18T12:00:00Z') };
    const { service, secrets, config, op } = await desktop(clock, [], ITEMS);
    await secrets.setReference('stripe', 'STRIPE_KEY', 'op://Dev/Stripe/credential');
    await config.updateConfigWith(() => ({ workspaces: { visibility: 'tailnet' } } satisfies Partial<AppConfig>));

    await expect(service.start({ project: 'stripe', names: ['STRIPE_KEY'], machines: [], requestedBy: 'Settings' })).rejects.toMatchObject({ code: 'SECRET_LEASE_REFUSED' });
    expect(op.calls).toEqual([]);
  });

  it('ends a lease here and on every online machine', async () => {
    const clock = { now: Date.parse('2026-11-18T12:00:00Z') };
    const devbox = await fakeHost('devbox', clock);
    const { service, secrets } = await desktop(clock, [devbox.link], ITEMS);
    await secrets.setReference('stripe', 'STRIPE_KEY', 'op://Dev/Stripe/credential');
    const { leaseId } = await service.start({ project: 'stripe', names: ['STRIPE_KEY'], machines: ['devbox-id'], requestedBy: 'Settings' });

    expect(await service.end(leaseId)).toBe(true);

    await expect(secrets.read('stripe', 'STRIPE_KEY')).rejects.toMatchObject({ code: 'SECRET_LEASE_ENDED' });
    await expect(devbox.store.read('stripe', 'STRIPE_KEY')).rejects.toMatchObject({ code: 'SECRET_LEASE_ENDED' });
    service.dispose();
  });

  it('pushes a lease again to a memory-only machine that lost it, with only the time left', async () => {
    const clock = { now: Date.parse('2026-11-18T12:00:00Z') };
    const devbox = await fakeHost('devbox', clock, { memoryOnly: true });
    const { service, secrets } = await desktop(clock, [devbox.link], ITEMS);
    await secrets.setReference('stripe', 'STRIPE_KEY', 'op://Dev/Stripe/credential');
    const { leaseId } = await service.start({ project: 'stripe', names: ['STRIPE_KEY'], machines: ['devbox-id'], requestedBy: 'Settings' });
    // The devbox restarted and lost its memory-only copy.
    await devbox.store.end(leaseId);
    clock.now += 4 * HOUR;

    await service.repushTo('devbox-id');

    expect(await devbox.store.read('stripe', 'STRIPE_KEY')).toBe('sk_live_canary_1');
    expect(devbox.received.filter(entry => entry.channel === 'secrets:lease:push').at(-1)?.arg).toMatchObject({ id: leaseId, expiresInMs: 20 * HOUR });
    service.dispose();
  });

  it('leaves a lease an agent ended on a host ended, and brings a host that slept through Extend up to date', async () => {
    const clock = { now: Date.parse('2026-11-18T12:00:00Z') };
    const devbox = await fakeHost('devbox', clock);
    const links = [devbox.link];
    const { service, secrets } = await desktop(clock, links, ITEMS);
    await secrets.setReference('stripe', 'STRIPE_KEY', 'op://Dev/Stripe/credential');
    const { leaseId } = await service.start({ project: 'stripe', names: ['STRIPE_KEY'], machines: ['devbox-id'], requestedBy: 'Settings' });

    // The devbox sleeps while the person extends; it keeps the old expiry.
    links[0] = { ...devbox.link, online: false };
    clock.now += 23 * HOUR;
    await service.start({ project: 'stripe', names: ['STRIPE_KEY'], machines: [], requestedBy: 'Settings', renews: leaseId });
    links[0] = devbox.link;
    await service.repushTo('devbox-id');
    expect(devbox.store.list()[0]?.expiresAt).toBe('2026-11-20T11:00:00.000Z');

    // An agent there ends it on purpose: a reconnect does not bring it back.
    await devbox.store.end(leaseId);
    await service.repushTo('devbox-id');
    expect(devbox.store.list()).toEqual([]);
    service.dispose();
  });

  it('sends the renewal to a host that slept past the old end and swept the lease', async () => {
    const clock = { now: Date.parse('2026-11-18T12:00:00Z') };
    const devbox = await fakeHost('devbox', clock);
    const links = [devbox.link];
    const { service, secrets } = await desktop(clock, links, ITEMS);
    await secrets.setReference('stripe', 'STRIPE_KEY', 'op://Dev/Stripe/credential');
    const { leaseId } = await service.start({ project: 'stripe', names: ['STRIPE_KEY'], machines: ['devbox-id'], requestedBy: 'Settings' });

    links[0] = { ...devbox.link, online: false };
    clock.now += 23 * HOUR;
    await service.start({ project: 'stripe', names: ['STRIPE_KEY'], machines: [], requestedBy: 'Settings', renews: leaseId });
    // Still asleep at the old end: the devbox sweeps its copy when it wakes.
    clock.now += 2 * HOUR;
    await devbox.store.end(leaseId);
    links[0] = devbox.link;

    await service.repushTo('devbox-id');

    expect(await devbox.store.read('stripe', 'STRIPE_KEY')).toBe('sk_live_canary_1');
    expect(devbox.store.list()[0]?.expiresAt).toBe('2026-11-20T11:00:00.000Z');
    service.dispose();
  });

  it('ends the leases pushed to a machine being removed', async () => {
    const clock = { now: Date.parse('2026-11-18T12:00:00Z') };
    const devbox = await fakeHost('devbox', clock);
    const { service, secrets, store } = await desktop(clock, [devbox.link], ITEMS);
    await secrets.setReference('stripe', 'STRIPE_KEY', 'op://Dev/Stripe/credential');
    const { leaseId } = await service.start({ project: 'stripe', names: ['STRIPE_KEY'], machines: ['devbox-id'], requestedBy: 'Settings' });

    expect(await service.releaseMachine('devbox-id')).toBe(0);

    expect(devbox.store.list()).toEqual([]);
    expect(store.get(leaseId)?.pushedTo).toEqual([]);
    service.dispose();
  });

  it('posts the Extend card an hour before the end, a quarter of the way from the end for a short lease, and closes it when the lease runs out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const clock = { now: Date.parse('2026-11-18T12:00:00Z') };
    const { service, secrets, reminders, closed, config, dir } = await desktop(clock, [], ITEMS);
    await secrets.setReference('stripe', 'STRIPE_KEY', 'op://Dev/Stripe/credential');
    await config.updateConfigWith(() => ({ secretLeaseLengths: { stripe: HOUR } }));
    const { leaseId } = await service.start({ project: 'stripe', names: ['STRIPE_KEY'], machines: [], requestedBy: 'Settings' });
    const settle = (check: () => void) => vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(0);
      check();
    });

    clock.now += 30 * 60_000;
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(reminders).toEqual([]);

    clock.now += 15 * 60_000;
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await settle(() => expect(reminders).toEqual([leaseId]));

    clock.now += 15 * 60_000;
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await settle(() => expect(closed).toContain(leaseId));
    // The store logs the expiry after telling listeners; wait for it so cleanup finds no write in flight.
    await settle(() => expect(readFileSync(path.join(dir, 'secret-leases.log'), 'utf8')).toContain('"expired"'));
    service.dispose();
  });
});
