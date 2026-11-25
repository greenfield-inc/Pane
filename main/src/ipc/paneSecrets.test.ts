import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { FakeKeychain } from '../test/fakeKeychain';
import { memoryConfig } from '../test/memorySecretStore';
import { keychainSecretBackend, PaneSecretStore } from '../services/paneSecrets';
import { SecretLeaseStore } from '../services/secretLeases';
import { registerPaneSecretHandlers } from './paneSecrets';

const CANARY = 'pane-canary-ipc-7d21';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Config in memory that emits config-updated like ConfigManager. */
function emittingConfig() {
  const inner = memoryConfig();
  const events = new EventEmitter();
  return {
    getConfig: inner.getConfig,
    on: (event: string, listener: () => void) => { events.on(event, listener); return events; },
    updateConfigWith: async (update: Parameters<typeof inner.updateConfigWith>[0]) => {
      const next = await inner.updateConfigWith(update);
      events.emit('config-updated', next);
      return next;
    },
  };
}

function setup() {
  const registry = new PaneCommandRegistry();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-secrets-ipc-'));
  dirs.push(dir);
  const values = keychainSecretBackend(new FakeKeychain(), 'Pane');
  const leases = new SecretLeaseStore({ directory: dir, values });
  const config = emittingConfig();
  const secrets = new PaneSecretStore(config, values, () => 'this-mac', () => new Date(), () => undefined, () => leases);
  registerPaneSecretHandlers({ handle: vi.fn() }, registry, () => secrets, () => leases, () => null, config);
  return { registry, secrets, leases, config };
}

const STRIPE = { name: 'STRIPE_KEY', reference: 'op://Dev/Stripe/credential', value: CANARY };
const push = (overrides: { expiresInMs?: number } = {}) => ({ id: '3f9a2c1b7d4e8f06', project: 'stripe', secrets: [STRIPE], expiresInMs: 60_000, requestedBy: 'test', grantedOn: 'studio', ...overrides });

describe('runpane secrets channels', () => {
  it('sets, lists without values, resolves for exec, and deletes', async () => {
    const { registry } = setup();

    await expect(registry.invoke('runpane:secrets:set', [{ project: 'qa', name: 'STRIPE_KEY', value: CANARY }]))
      .resolves.toMatchObject({ ok: true, replaced: false, secret: { project: 'qa', name: 'STRIPE_KEY', machine: 'this-mac' } });
    const listed = await registry.invoke('runpane:secrets:list', [{ project: 'qa' }]);
    expect(listed).toMatchObject({ ok: true, secrets: [{ project: 'qa', name: 'STRIPE_KEY' }], storage: { kind: 'keychain', encrypted: true } });
    expect(JSON.stringify(listed)).not.toContain(CANARY);

    await expect(registry.invoke('runpane:secrets:resolve', [{ project: 'qa' }])).resolves.toEqual({ ok: true, values: { STRIPE_KEY: CANARY } });
    await expect(registry.invoke('runpane:secrets:resolve', [{ project: 'qa', names: ['MISSING'] }])).rejects.toMatchObject({ code: 'SECRET_NOT_FOUND' });

    await registry.invoke('runpane:secrets:delete', [{ project: 'qa', name: 'STRIPE_KEY' }]);
    await expect(registry.invoke('runpane:secrets:list', [{}])).resolves.toMatchObject({ secrets: [] });
  });

  it('gives a login to no command, and lets no program on this machine make, change or remove one', async () => {
    const { registry, secrets } = setup();
    await secrets.set('bank', 'TOKEN', 'plain');
    await secrets.setLogin('bank', 'PIN', CANARY, ['https://bank.example']);

    // The whole project's environment leaves it out; naming it runs nothing.
    await expect(registry.invoke('runpane:secrets:resolve', [{ project: 'bank' }])).resolves.toEqual({ ok: true, values: { TOKEN: 'plain' } });
    for (const [channel, request] of [
      ['runpane:secrets:resolve', { project: 'bank', names: ['TOKEN', 'PIN'] }],
      ['runpane:secrets:set', { project: 'bank', name: 'PIN', value: 'x', sites: ['https://evil.test'] }],
      ['runpane:secrets:delete', { project: 'bank', name: 'PIN' }],
    ] as const) {
      await expect(registry.invoke(channel, [request])).rejects.toMatchObject({ code: 'SECRET_IS_LOGIN', message: expect.not.stringContaining(CANARY) });
    }
    await registry.invoke('runpane:secrets:set', [{ project: 'bank', name: 'MINE', value: 'x', sites: ['https://evil.test'] }]);
    expect(secrets.sitesOf('bank', 'MINE')).toBeNull();
    // No daemon channel sets sites: only Settings' own renderer channel does.
    await expect(registry.invoke('pane-secrets:set-sites', ['bank', 'TOKEN', ['https://evil.test']])).rejects.toThrow();
    expect(await secrets.readLogin('bank', 'PIN')).toEqual({ value: CANARY, sites: ['https://bank.example'] });
    const listed = await registry.invoke('runpane:secrets:list', [{ project: 'bank' }]);
    expect(listed).toMatchObject({ secrets: expect.arrayContaining([expect.objectContaining({ name: 'PIN', sites: ['https://bank.example'] })]) });
    expect(JSON.stringify(listed)).not.toContain(CANARY);
  });

  it('refuses every remote caller, so no value crosses the network through these channels', async () => {
    const { registry, secrets } = setup();
    await secrets.set('qa', 'STRIPE_KEY', CANARY);

    for (const [channel, request] of [
      ['runpane:secrets:list', {}],
      ['runpane:secrets:resolve', { project: 'qa' }],
      ['runpane:secrets:set', { project: 'qa', name: 'OTHER', value: 'x' }],
      ['runpane:secrets:delete', { project: 'qa', name: 'STRIPE_KEY' }],
    ] as const) {
      await expect(registry.invokeRemote(channel, [request, { clientId: 'tailnet:teammate@example.com' }])).rejects.toMatchObject({ code: 'SECRET_LOCAL_ONLY' });
    }
    expect(secrets.list().map(secret => secret.name)).toEqual(['STRIPE_KEY']);
  });

  it('never echoes a malformed request, which may carry a value', async () => {
    const { registry } = setup();

    await expect(registry.invoke('runpane:secrets:set', [{ project: 'qa', name: 'X', value: 42, note: CANARY }]))
      .rejects.toMatchObject({ code: 'SECRET_INVALID', message: expect.not.stringContaining(CANARY), next: expect.not.stringContaining(CANARY) });
  });

  it('runs nothing when a 1Password secret of the project has no lease, and names the lease command', async () => {
    const { registry, secrets, leases } = setup();
    await secrets.set('stripe', 'TYPED', 'typed-value');
    await secrets.setReference('stripe', 'STRIPE_KEY', 'op://Dev/Stripe/credential');
    await secrets.setReference('stripe', 'SENTRY_TOKEN', 'op://Dev/Sentry/token');

    await expect(registry.invoke('runpane:secrets:resolve', [{ project: 'stripe' }])).rejects.toMatchObject({
      code: 'SECRET_LEASE_ENDED',
      next: 'Run `runpane secrets lease --project stripe SENTRY_TOKEN STRIPE_KEY`, and the person approves it on the card. Or run with `--only` and the typed names you need.',
    });
    await secrets.delete('stripe', 'SENTRY_TOKEN');

    await leases.grant({ project: 'stripe', secrets: [{ name: 'STRIPE_KEY', reference: 'op://Dev/Stripe/credential', value: CANARY }], expiresInMs: 60_000, requestedBy: 'test', grantedOn: 'this-mac' });
    await expect(registry.invoke('runpane:secrets:resolve', [{ project: 'stripe' }])).resolves.toEqual({ ok: true, values: { TYPED: 'typed-value', STRIPE_KEY: CANARY } });
    leases.dispose();
  });

  it('takes a pushed lease only from a paired device, never from a program on this machine', async () => {
    const { registry, leases } = setup();
    const trusted = { clientId: 'desktop-1' };

    await expect(registry.invoke('secrets:lease:push', [push(), trusted])).rejects.toMatchObject({ code: 'SECRET_REMOTE_ONLY' });
    await expect(registry.invoke('secrets:lease:list', [{}, trusted])).rejects.toMatchObject({ code: 'SECRET_REMOTE_ONLY' });
    expect(leases.list()).toEqual([]);

    await expect(registry.invokeRemote('secrets:lease:push', [push({ expiresInMs: 8 * 24 * 60 * 60_000 }), trusted])).rejects.toMatchObject({ code: 'SECRET_INVALID' });
    await expect(registry.invokeRemote('secrets:lease:push', [push(), trusted], { teammate: 'teammate@example.com' })).rejects.toMatchObject({ code: 'SECRET_OWNER_REQUIRED' });
    await expect(registry.invokeRemote('secrets:lease:push', [push(), trusted])).resolves.toMatchObject({ ok: true });
    expect(await leases.read('stripe', 'STRIPE_KEY')).toBe(CANARY);
    leases.dispose();
  });

  it('ends its leases and refuses lease reads once this machine is shared with everyone on the tailnet', async () => {
    const { registry, secrets, leases, config } = setup();
    await registry.invokeRemote('secrets:lease:push', [push(), { clientId: 'desktop-1' }]);
    await secrets.setReference('stripe', 'STRIPE_KEY', 'op://Dev/Stripe/credential');

    await config.updateConfigWith(() => ({ workspaces: { visibility: 'tailnet' } }));
    await vi.waitFor(() => expect(leases.list()).toEqual([]));

    await expect(secrets.read('stripe', 'STRIPE_KEY')).rejects.toMatchObject({ code: 'SECRET_LEASE_REFUSED' });
    await expect(registry.invokeRemote('secrets:lease:push', [push(), { clientId: 'desktop-1' }])).rejects.toMatchObject({ code: 'SECRET_LEASE_REFUSED' });
    leases.dispose();
  });
});
