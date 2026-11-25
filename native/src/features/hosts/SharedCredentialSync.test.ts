import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ profiles: [] as { label: string; id: string; token: string; access?: 'read' }[], calls: [] as string[] }));
vi.mock('react-native', () => ({ AppState: {} }));
vi.mock('@/auth/hostsStore', () => ({ useHostsStore: { getState: () => ({ profiles: state.profiles }) } }));
vi.mock('@/features/notifications/usePushSetup', () => ({ requestPushRegistration: () => undefined }));
vi.mock('@/daemon/createClient', () => ({
  createDaemonClient: (profile: { label: string }) => ({
    invoke: async (channel: string) => {
      state.calls.push(`${profile.label} ${channel}`);
      return {};
    },
  }),
}));

const { requestSharedCredentialSync } = await import('./SharedCredentialSync');

afterEach(() => { vi.useRealTimers(); });

const profile = (label: string, access?: 'read') => ({ id: label, label, token: label, access });

async function sync(...profiles: ReturnType<typeof profile>[]): Promise<string[]> {
  vi.useFakeTimers();
  state.profiles = profiles;
  state.calls.length = 0;
  requestSharedCredentialSync();
  await vi.advanceTimersByTimeAsync(2_000);
  return [...new Set(state.calls)].sort();
}

it('reads keys from the full-access computers and asks a read-only one nothing', async () => {
  const calls = await sync(profile('studio'), profile('devbox'), profile('tyler', 'read'));
  expect(calls).toContain('studio credentials:shared:get');
  expect(calls).toContain('devbox credentials:shared:get');
  expect(calls.filter(call => call.startsWith('tyler'))).toEqual([]);
});

it('does not count a read-only computer as one to sync with', async () => {
  expect(await sync(profile('studio'), profile('tyler', 'read'))).toEqual([]);
});
