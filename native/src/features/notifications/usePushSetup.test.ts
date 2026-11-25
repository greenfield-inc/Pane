import { expect, it, vi } from 'vitest';

import { readOnlyToken } from '@shared/types/accessLevel';

const state = vi.hoisted(() => ({ profiles: [] as { label: string; id: string; token: string }[], calls: [] as string[] }));
vi.mock('react-native', () => ({ AppState: {} }));
vi.mock('expo-notifications', () => ({}));
vi.mock('@/auth/secureStore', () => ({ secureStore: { getItem: () => Promise.resolve(null), setItem: () => Promise.resolve() } }));
vi.mock('@/auth/hostsStore', () => ({ useHostsStore: { getState: () => ({ profiles: state.profiles }) } }));
vi.mock('@/features/demo/demoHost', () => ({ isDemoProfile: () => false }));
vi.mock('./device', () => ({
  devicePush: { platform: 'ios', getPermission: async () => 'granted', requestPermission: async () => 'granted', getDeviceToken: async () => 'apns', getInstallationId: async () => 'install' },
  getInstallationId: async () => 'install',
  isLastToken: () => false,
}));
vi.mock('@/daemon/createClient', () => ({ createDaemonClient: (profile: { label: string }) => profile }));
vi.mock('@/daemon', () => ({
  invokeChannel: async (client: { label: string }, channel: string) => {
    state.calls.push(`${client.label} ${channel}`);
    return { platform: 'ios', registration: 'registered', provider: 'ready', code: 'PUSH_READY', message: '', needsInputEnabled: true, completedEnabled: true };
  },
}));

const { requestPushRegistration } = await import('./usePushSetup');

it('registers for alerts with every saved computer except a read-only one', async () => {
  state.profiles = [{ id: 'studio', label: 'studio', token: 't' }, { id: 'tyler', label: 'tyler', token: readOnlyToken('a') }];
  requestPushRegistration(0);
  await vi.waitFor(() => expect(state.calls).toContain('studio mobile:push-register'));
  expect(state.calls.filter(call => call.startsWith('tyler'))).toEqual([]);
});
