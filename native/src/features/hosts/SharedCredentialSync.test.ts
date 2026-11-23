import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SharedCredentials } from '@shared/types/sharedCredentials';

// The phone relays keys between the computers it saved; each host answers from memory here.
const phone = vi.hoisted(() => ({
  hosts: new Map<string, { held: SharedCredentials; applied: SharedCredentials[] }>(),
}));

vi.mock('react', () => ({ useEffect: () => undefined }));
vi.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove: () => undefined }) } }));
vi.mock('@/auth/hostsStore', () => ({
  useHostsStore: { getState: () => ({ profiles: [...phone.hosts.keys()].map(id => ({ id })) }) },
}));
vi.mock('@/daemon/createClient', () => ({
  createDaemonClient: (profile: { id: string }) => ({
    invoke: async (channel: string, args: unknown[]) => {
      const host = phone.hosts.get(profile.id);
      if (!host) throw new Error('unknown host');
      if (channel === 'credentials:shared:get') return JSON.parse(JSON.stringify(host.held));
      // SAFETY: syncSharedCredentials passes one SharedCredentials to apply.
      host.applied.push(JSON.parse(JSON.stringify(args[0])) as SharedCredentials);
      return {};
    },
  }),
}));
vi.mock('@/features/notifications/usePushSetup', () => ({ requestPushRegistration: () => undefined }));

const at = '2026-11-22T10:00:00.000Z';
const choice = { value: JSON.stringify({ excludedSecrets: ['billing/STRIPE_LIVE_KEY'], excludedMachines: [] }), updatedAt: at, source: 'laptop' };

describe('the phone relaying keys to a cloud VM', () => {
  afterEach(() => {
    vi.useRealTimers();
    phone.hosts.clear();
  });

  it('writes the VM only the Pane secrets the person chose, never a turned-off one, an integration key or a 1Password reference', async () => {
    phone.hosts.set('laptop', {
      held: {
        anthropicApiKey: { value: 'sk-ant-laptop', updatedAt: at, source: 'laptop' },
        paneSecrets: {
          'web/NPM_TOKEN': { value: 'npm-laptop', updatedAt: at, source: 'laptop' },
          'billing/STRIPE_LIVE_KEY': { value: 'sk_live_laptop', updatedAt: at, source: 'laptop' },
        },
        paneSecretReferences: { 'vault/OP_KEY': { value: 'op://Private/Item/field', updatedAt: at, source: 'laptop' } },
        paneCloudSecretChoice: choice,
      },
      applied: [],
    });
    phone.hosts.set('cloud-vm', { held: { cloudVm: true, paneSecrets: {} }, applied: [] });
    vi.useFakeTimers();
    const { requestSharedCredentialSync } = await import('./SharedCredentialSync');

    requestSharedCredentialSync();
    await vi.advanceTimersByTimeAsync(600);
    await vi.waitFor(() => expect(phone.hosts.get('cloud-vm')?.applied).toHaveLength(1));

    const written = JSON.stringify(phone.hosts.get('cloud-vm')?.applied);
    expect(written).toContain('npm-laptop');
    expect(written).not.toMatch(/sk_live_laptop|sk-ant-laptop|op:\/\/Private/);
  });
});
