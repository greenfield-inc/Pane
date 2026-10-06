import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RemotePaneConnectionProfile, RemoteMobilePushStatus } from '../../../../shared/types/remoteDaemon';
import { RemoteRuntimeAdapter } from './remoteRuntimeAdapter';

const profile: RemotePaneConnectionProfile = {
  id: 'My Mac:https://host.test:12345678', label: 'My Mac', baseUrl: 'https://host.test', token: 'token', transport: 'http+sse',
};

const pushStatus: RemoteMobilePushStatus = { platform: 'ios', registration: 'registered', provider: 'ready', code: 'ready', message: 'Ready' };

beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function setup() {
  const listeners = new Map<string, (value: { value?: string }) => void>();
  const remove = vi.fn(async () => {});
  const plugin = {
    requestPermissions: vi.fn(async () => ({ receive: 'granted' })),
    register: vi.fn(async () => {}),
    addListener: vi.fn(async (event: string, listener: (value: { value?: string }) => void) => {
      listeners.set(event, listener);
      return { remove };
    }),
  };
  const secureStore = {
    get: vi.fn(async () => ({ value: 'install-1' })),
    set: vi.fn(async () => ({})), remove: vi.fn(async () => ({})),
  };
  vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => true, Plugins: { PushNotifications: plugin, SecureStore: secureStore } } });
  vi.stubGlobal('navigator', { userAgent: 'iPhone' });
  const adapter = new RemoteRuntimeAdapter(profile);
  const invoke = vi.spyOn(adapter, 'invoke').mockResolvedValue(pushStatus);
  return { plugin, listeners, remove, adapter, invoke };
}

it('registers a platform token with the saved profile route', async () => {
  const { plugin, listeners, remove, adapter, invoke } = setup();
  plugin.register.mockImplementation(async () => { listeners.get('registration')?.({ value: 'device-token' }); });
  const { setupNativePush } = await import('./nativePush');
  await expect(setupNativePush(profile, adapter)).resolves.toBeNull();
  expect(invoke).toHaveBeenLastCalledWith('mobile:push-register', [{ platform: 'ios', token: 'device-token', installationId: 'install-1', hostProfileId: profile.id }]);
  expect(remove).toHaveBeenCalledTimes(2);
});

it('times out OS registration, removes listeners, and permits a later retry', async () => {
  const { plugin, listeners, remove, adapter } = setup();
  const { setupNativePush } = await import('./nativePush');
  const pending = setupNativePush(profile, adapter);
  await vi.advanceTimersByTimeAsync(15_000);
  await expect(pending).resolves.toContain('could not register');
  expect(remove).toHaveBeenCalledTimes(2);
  plugin.register.mockImplementation(async () => { listeners.get('registration')?.({ value: 'new-token' }); });
  await expect(setupNativePush(profile, adapter)).resolves.toBeNull();
});

it('installs a single routing listener during concurrent boot and registration', async () => {
  const { plugin } = setup();
  const { installNativePushRouting } = await import('./nativePush');
  await Promise.all([installNativePushRouting(), installNativePushRouting()]);
  expect(plugin.addListener).toHaveBeenCalledTimes(1);
});

it('does not request OS permission when the host has no provider', async () => {
  const { invoke, adapter, plugin } = setup();
  invoke.mockResolvedValue({ ...pushStatus, provider: 'missing-config', message: 'Configure APNs on this host.' });
  const { setupNativePush } = await import('./nativePush');
  await expect(setupNativePush(profile, adapter)).resolves.toBe('Configure APNs on this host.');
  expect(plugin.requestPermissions).not.toHaveBeenCalled();
});
