import fs from 'fs';
import os from 'os';
import path from 'path';
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

function setup() {
  const registry = new PaneCommandRegistry();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-secrets-ipc-'));
  dirs.push(dir);
  const values = keychainSecretBackend(new FakeKeychain(), 'Pane');
  const leases = new SecretLeaseStore({ directory: dir, values, canEncrypt: () => true });
  const secrets = new PaneSecretStore(memoryConfig(), values, () => 'this-mac', () => new Date(), () => undefined, () => leases);
  registerPaneSecretHandlers({ handle: vi.fn() }, registry, () => secrets, () => leases, () => null);
  return { registry, secrets, leases };
}

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

    await expect(registry.invoke('runpane:secrets:resolve', [{ project: 'stripe' }])).rejects.toMatchObject({
      code: 'SECRET_LEASE_ENDED',
      next: 'Run `runpane secrets lease --project stripe STRIPE_KEY`, and the person approves it on the card.',
    });

    await leases.grant({ project: 'stripe', secrets: [{ name: 'STRIPE_KEY', reference: 'op://Dev/Stripe/credential', value: CANARY }], expiresInMs: 60_000, requestedBy: 'test', grantedOn: 'this-mac' });
    await expect(registry.invoke('runpane:secrets:resolve', [{ project: 'stripe' }])).resolves.toEqual({ ok: true, values: { TYPED: 'typed-value', STRIPE_KEY: CANARY } });
    leases.dispose();
  });
});
