import { RemoteAuthError, RemoteRequestError } from '@shared/remoteClient';
import type { RemoteMobilePlatform, RemoteMobilePushStatus } from '@shared/types/remoteDaemon';

export type PermissionState = 'granted' | 'denied' | 'undetermined';

/** What registration needs from the OS and the host, injected so the flow is testable. */
export interface PushDeps {
  platform: RemoteMobilePlatform;
  invoke<T>(channel: string, args: unknown[]): Promise<T>;
  getPermission(): Promise<PermissionState>;
  requestPermission(): Promise<PermissionState>;
  /** The raw APNs or FCM token: the host sends to the providers directly. */
  getDeviceToken(): Promise<string>;
  getInstallationId(): Promise<string>;
}

/** The phone-wide alert switches. Every computer gets the same values. */
export interface PushPreferences {
  needsInputEnabled: boolean;
  completedEnabled: boolean;
}

export type PushSetupResult =
  | { state: 'registered'; status: RemoteMobilePushStatus }
  /** The host has no APNs/FCM credentials, so the phone is never asked. */
  | { state: 'host-not-ready'; provider: RemoteMobilePushStatus['provider']; message: string }
  | { state: 'denied' }
  /** The phone could not connect to the computer. */
  | { state: 'unreachable'; message: string }
  /** `code` is the host's error code when it sent one. */
  | { state: 'error'; message: string; code?: string };

/**
 * Registers this device for the host's "needs input" and "finished" alerts.
 * Run it on every connect: the host upserts the token, so a rotated APNs/FCM
 * token replaces the old one. The system permission prompt shows only once,
 * and only for a host that can deliver.
 */
export async function registerForPush(deps: PushDeps, hostProfileId: string, preferences: PushPreferences): Promise<PushSetupResult> {
  const installationId = await deps.getInstallationId();
  try {
    const status = await deps.invoke<RemoteMobilePushStatus>('mobile:push-status', [{ platform: deps.platform, installationId }]);
    if (status.provider !== 'ready') return { state: 'host-not-ready', provider: status.provider, message: status.message };
  } catch (error) {
    // A host that answered says why; anything else means the phone never reached it.
    if (!(error instanceof RemoteAuthError || error instanceof RemoteRequestError)) return { state: 'unreachable', message: messageOf(error) };
    return error.code ? { state: 'error', message: error.message, code: error.code } : { state: 'error', message: error.message };
  }

  let permission = await deps.getPermission();
  if (permission === 'undetermined') permission = await deps.requestPermission();
  if (permission !== 'granted') return { state: 'denied' };

  let token: string;
  try {
    token = await deps.getDeviceToken();
  } catch (error) {
    return { state: 'error', message: `This device could not register for notifications: ${messageOf(error)}` };
  }

  try {
    // notifyButtons: this build draws Notify's answer buttons (Pane app 1.1+).
    const status = await deps.invoke<RemoteMobilePushStatus>('mobile:push-register', [
      { platform: deps.platform, token, installationId, hostProfileId, notifyButtons: true, ...preferences },
    ]);
    return status.provider === 'ready'
      ? { state: 'registered', status }
      : { state: 'host-not-ready', provider: status.provider, message: status.message };
  } catch (error) {
    return { state: 'error', message: messageOf(error) };
  }
}

/** One saved computer. */
export interface PushHost {
  profileId: string;
  invoke: PushDeps['invoke'];
}

/**
 * Registers this phone with every saved computer at once, with the same
 * switch values. One permission prompt and one device token serve the whole
 * pass, and a computer that can't be reached doesn't hold up the others.
 * `onResult` reports each computer as it finishes.
 */
export async function registerEverywhere(
  deps: Omit<PushDeps, 'invoke'>,
  hosts: PushHost[],
  preferences: PushPreferences,
  onResult: (profileId: string, result: PushSetupResult) => void = () => undefined,
): Promise<Record<string, PushSetupResult>> {
  const shared = { ...deps, requestPermission: once(deps.requestPermission), getDeviceToken: once(deps.getDeviceToken) };
  const results: Record<string, PushSetupResult> = {};
  await Promise.all(hosts.map(async host => {
    const result = await registerHost(shared, host, preferences);
    results[host.profileId] = result;
    onResult(host.profileId, result);
  }));
  return results;
}

async function registerHost(deps: Omit<PushDeps, 'invoke'>, host: PushHost, preferences: PushPreferences): Promise<PushSetupResult> {
  try {
    return await registerForPush({ ...deps, invoke: host.invoke }, host.profileId, preferences);
  } catch (error) {
    return { state: 'error', message: messageOf(error) };
  }
}

/** Shares one call between concurrent and later callers; a failure lets the next caller try again. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= load().catch(error => {
      pending = null;
      throw error;
    });
    return pending;
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
