import { describe, expect, it, vi } from 'vitest';

import type { RemoteMobilePushStatus } from '@shared/types/remoteDaemon';

import { registerForPush, type PushDeps } from './registration';

const ready: RemoteMobilePushStatus = { platform: 'ios', registration: 'not-registered', provider: 'ready', code: 'PUSH_READY', message: 'APNs delivery is configured.' };
const notConfigured: RemoteMobilePushStatus = { platform: 'ios', registration: 'not-registered', provider: 'missing-config', code: 'ERR_APNS_NOT_CONFIGURED', message: 'This host has no valid APNs configuration.' };
const registered: RemoteMobilePushStatus = { ...ready, registration: 'registered', needsInputEnabled: true, completedEnabled: true };

function fakeDeps(overrides: Partial<PushDeps> & { status?: RemoteMobilePushStatus; permission?: 'granted' | 'denied' | 'undetermined' } = {}) {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'mobile:push-status') return overrides.status ?? ready;
    if (channel === 'mobile:push-register') return registered;
    throw new Error(`unexpected ${channel}`);
  });
  const request = vi.fn(async () => 'granted' as const);
  const deps: PushDeps = {
    platform: 'ios',
    invoke: invoke as PushDeps['invoke'],
    getPermission: async () => overrides.permission ?? 'undetermined',
    requestPermission: request,
    getDeviceToken: async () => 'apns-token',
    getInstallationId: async () => 'install-1',
    ...overrides,
  };
  return { deps, invoke, request };
}

describe('registerForPush', () => {
  it('asks for permission, then registers the device token with the host', async () => {
    const { deps, invoke, request } = fakeDeps();
    await expect(registerForPush(deps, 'host-1')).resolves.toEqual({ state: 'registered', status: registered });
    expect(request).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith('mobile:push-register', [{ platform: 'ios', token: 'apns-token', installationId: 'install-1', hostProfileId: 'host-1' }]);
  });

  it('does not ask for permission when the host cannot deliver notifications', async () => {
    const { deps, invoke, request } = fakeDeps({ status: notConfigured });
    await expect(registerForPush(deps, 'host-1'))
      .resolves.toEqual({ state: 'host-not-ready', message: 'This host has no valid APNs configuration.' });
    expect(request).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith('mobile:push-register', expect.anything());
  });

  it('stops when the user turned notifications off', async () => {
    const { deps, invoke, request } = fakeDeps({ permission: 'denied' });
    await expect(registerForPush(deps, 'host-1')).resolves.toEqual({ state: 'denied' });
    expect(request).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith('mobile:push-register', expect.anything());
  });


  it('re-registers silently once permission is granted, so a rotated token reaches the host', async () => {
    const { deps, invoke, request } = fakeDeps({ permission: 'granted', getDeviceToken: async () => 'rotated-token' });
    await expect(registerForPush(deps, 'host-1')).resolves.toMatchObject({ state: 'registered' });
    expect(request).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('mobile:push-register', [expect.objectContaining({ token: 'rotated-token' })]);
  });

  it('reports a device that cannot get a push token', async () => {
    const { deps } = fakeDeps({ permission: 'granted', getDeviceToken: () => Promise.reject(new Error('no aps-environment entitlement')) });
    await expect(registerForPush(deps, 'host-1'))
      .resolves.toEqual({ state: 'error', message: 'This device could not register for notifications: no aps-environment entitlement' });
  });

  it('reports a host that rejects the registration', async () => {
    const { deps } = fakeDeps({ permission: 'granted' });
    deps.invoke = (async (channel: string) => {
      if (channel === 'mobile:push-status') return ready;
      throw new Error('Invalid mobile notification registration');
    }) as PushDeps['invoke'];
    await expect(registerForPush(deps, 'host-1'))
      .resolves.toEqual({ state: 'error', message: 'Invalid mobile notification registration' });
  });
});
