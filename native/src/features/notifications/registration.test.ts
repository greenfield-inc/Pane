import { describe, expect, it, vi } from 'vitest';

import type { RemoteMobilePushStatus } from '@shared/types/remoteDaemon';

import { RemoteAuthError } from '@shared/remoteClient';

import { createWriteGate, preferencesFrom, registerEverywhere, registerForPush, type PushDeps, type PushHost } from './registration';

const ready: RemoteMobilePushStatus = { platform: 'ios', registration: 'not-registered', provider: 'ready', code: 'PUSH_READY', message: 'APNs delivery is configured.' };
const notConfigured: RemoteMobilePushStatus = { platform: 'ios', registration: 'not-registered', provider: 'missing-config', code: 'ERR_APNS_NOT_CONFIGURED', message: 'This host has no valid APNs configuration.' };
const registered: RemoteMobilePushStatus = { ...ready, registration: 'registered', needsInputEnabled: true, completedEnabled: true };
const allOn = { needsInputEnabled: true, completedEnabled: true };

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
    await expect(registerForPush(deps, 'host-1', allOn)).resolves.toEqual({ state: 'registered', status: registered });
    expect(request).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith('mobile:push-register', [{ platform: 'ios', token: 'apns-token', installationId: 'install-1', hostProfileId: 'host-1', notifyButtons: true, needsInputEnabled: true, completedEnabled: true }]);
  });

  it('does not ask for permission when the host cannot deliver notifications', async () => {
    const { deps, invoke, request } = fakeDeps({ status: notConfigured });
    await expect(registerForPush(deps, 'host-1', allOn))
      .resolves.toEqual({ state: 'host-not-ready', provider: 'missing-config', message: 'This host has no valid APNs configuration.' });
    expect(request).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith('mobile:push-register', expect.anything());
  });

  it('stops when the user turned notifications off', async () => {
    const { deps, invoke, request } = fakeDeps({ permission: 'denied' });
    await expect(registerForPush(deps, 'host-1', allOn)).resolves.toEqual({ state: 'denied' });
    expect(request).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith('mobile:push-register', expect.anything());
  });

  it('re-registers silently once permission is granted, so a rotated token reaches the host', async () => {
    const { deps, invoke, request } = fakeDeps({ permission: 'granted', getDeviceToken: async () => 'rotated-token' });
    await expect(registerForPush(deps, 'host-1', allOn)).resolves.toMatchObject({ state: 'registered' });
    expect(request).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith('mobile:push-register', [expect.objectContaining({ token: 'rotated-token' })]);
  });

  it('reports a device that cannot get a push token', async () => {
    const { deps } = fakeDeps({ permission: 'granted', getDeviceToken: () => Promise.reject(new Error('no aps-environment entitlement')) });
    await expect(registerForPush(deps, 'host-1', allOn))
      .resolves.toEqual({ state: 'error', message: 'This device could not register for notifications: no aps-environment entitlement' });
  });

  it('reports a host that rejects the registration', async () => {
    const { deps } = fakeDeps({ permission: 'granted' });
    deps.invoke = (async (channel: string) => {
      if (channel === 'mobile:push-status') return ready;
      throw new Error('Invalid mobile notification registration');
    }) as PushDeps['invoke'];
    await expect(registerForPush(deps, 'host-1', allOn))
      .resolves.toEqual({ state: 'error', message: 'Invalid mobile notification registration' });
  });
});

describe('registerEverywhere', () => {
  function host(profileId: string, status: RemoteMobilePushStatus = ready) {
    const { invoke } = fakeDeps({ status });
    const computer: PushHost = { profileId, invoke: invoke as PushDeps['invoke'] };
    return { computer, invoke };
  }
  function device(token = 'apns-token') {
    const request = vi.fn(async () => 'granted' as const);
    const deps: Omit<PushDeps, 'invoke'> = {
      platform: 'ios',
      getPermission: async () => 'undetermined',
      requestPermission: request,
      getDeviceToken: async () => token,
      getInstallationId: async () => 'install-1',
    };
    return { deps, request };
  }

  it('registers with every saved computer, sending the phone-wide switches, behind one permission prompt', async () => {
    const mac = host('mac');
    const pc = host('pc');
    const { deps, request } = device();
    const results = await registerEverywhere(deps, [mac.computer, pc.computer], { needsInputEnabled: false, completedEnabled: true });
    expect(results).toEqual({ mac: { state: 'registered', status: registered }, pc: { state: 'registered', status: registered } });
    expect(request).toHaveBeenCalledOnce();
    for (const [computer, profileId] of [[mac, 'mac'], [pc, 'pc']] as const) {
      expect(computer.invoke).toHaveBeenCalledWith('mobile:push-register', [
        { platform: 'ios', token: 'apns-token', installationId: 'install-1', hostProfileId: profileId, notifyButtons: true, needsInputEnabled: false, completedEnabled: true },
      ]);
    }
  });

  it('registers the reachable computers when one cannot be reached or refuses the phone', async () => {
    const mac = host('mac');
    const offline: PushHost = { profileId: 'offline', invoke: () => Promise.reject(new Error('Network request failed')) };
    const refused: PushHost = { profileId: 'teammate', invoke: () => Promise.reject(new RemoteAuthError('Only this computer\'s owner can get its alerts on a phone.', 'ERR_MOBILE_PUSH_OWNER_REQUIRED')) };
    const reported: string[] = [];
    const results = await registerEverywhere(device().deps, [offline, refused, mac.computer], allOn, id => reported.push(id));
    expect(results).toEqual({
      offline: { state: 'unreachable', message: 'Network request failed' },
      teammate: { state: 'error', message: 'Only this computer\'s owner can get its alerts on a phone.', code: 'ERR_MOBILE_PUSH_OWNER_REQUIRED' },
      mac: { state: 'registered', status: registered },
    });
    expect(reported.sort()).toEqual(['mac', 'offline', 'teammate']);
  });

  it('sends a rotated token to every computer on the next pass', async () => {
    const mac = host('mac');
    const pc = host('pc');
    await registerEverywhere(device('old-token').deps, [mac.computer, pc.computer], allOn);
    await registerEverywhere(device('rotated-token').deps, [mac.computer, pc.computer], allOn);
    for (const computer of [mac, pc]) {
      expect(computer.invoke).toHaveBeenLastCalledWith('mobile:push-register', [expect.objectContaining({ token: 'rotated-token' })]);
    }
  });


  it('sends no switch values until the phone has its own, so a computer\'s Off stays off', async () => {
    const mac = host('mac', { ...ready, registration: 'registered', needsInputEnabled: false, completedEnabled: false });
    await registerEverywhere(device().deps, [mac.computer], null);
    expect(mac.invoke).toHaveBeenCalledWith('mobile:push-register', [
      { platform: 'ios', token: 'apns-token', installationId: 'install-1', hostProfileId: 'mac', notifyButtons: true },
    ]);
  });

  it('starts the phone\'s switches off for any kind a computer already had off', () => {
    const off = (needsInputEnabled: boolean, completedEnabled: boolean) => ({ state: 'registered' as const, status: { ...registered, needsInputEnabled, completedEnabled } });
    expect(preferencesFrom({ mac: off(true, false), pc: off(false, true), down: { state: 'unreachable', message: 'offline' } }))
      .toEqual({ needsInputEnabled: false, completedEnabled: false });
    expect(preferencesFrom({ down: { state: 'unreachable', message: 'offline' } })).toEqual({ needsInputEnabled: true, completedEnabled: true });
  });

  it('never lands a registration on a computer after signing out of it', async () => {
    const calls: string[] = [];
    let releaseToken!: (token: string) => void;
    const invoke = (async (channel: string) => {
      calls.push(channel);
      return channel === 'mobile:push-status' ? ready : registered;
    }) as PushDeps['invoke'];
    const gate = createWriteGate();
    let saved = true;
    const { deps } = device();
    const pass = registerEverywhere({ ...deps, getDeviceToken: () => new Promise(resolve => { releaseToken = resolve; }) }, [gate.host('mac', invoke, () => saved)], allOn);
    await vi.waitFor(() => expect(releaseToken).toBeDefined());

    const signedOut = gate.close('mac', async () => { calls.push('mobile:push-revoke'); }, () => { saved = false; });
    releaseToken('apns-token');
    await Promise.all([pass, signedOut]);

    expect(calls).toEqual(['mobile:push-status', 'mobile:push-revoke']);
  });

  it('revokes only after a registration already on its way has landed', async () => {
    const calls: string[] = [];
    let landRegistration!: () => void;
    const invoke = ((channel: string) => {
      if (channel === 'mobile:push-status') return Promise.resolve(ready);
      calls.push('register sent');
      return new Promise<unknown>(resolve => { landRegistration = () => { calls.push('register landed'); resolve(registered); }; });
    }) as PushDeps['invoke'];
    const gate = createWriteGate();
    const pass = registerEverywhere(device().deps, [gate.host('mac', invoke)], allOn);
    await vi.waitFor(() => expect(landRegistration).toBeDefined());

    const signedOut = gate.close('mac', async () => { calls.push('revoke'); });
    await Promise.resolve();
    landRegistration();
    await Promise.all([pass, signedOut]);

    expect(calls).toEqual(['register sent', 'register landed', 'revoke']);
  });

});
