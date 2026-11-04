import { describe, expect, it, vi } from 'vitest';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { FakeKeychain } from '../test/fakeKeychain';
import { memorySecretStore } from '../test/memorySecretStore';
import { registerPaneSecretHandlers } from './paneSecrets';

const CANARY = 'pane-canary-ipc-7d21';

function setup() {
  const registry = new PaneCommandRegistry();
  const secrets = memorySecretStore(new FakeKeychain());
  registerPaneSecretHandlers({ handle: vi.fn() }, registry, () => secrets);
  return { registry, secrets };
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
});
