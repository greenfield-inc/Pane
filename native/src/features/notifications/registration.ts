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

export type PushSetupResult =
  | { state: 'registered'; status: RemoteMobilePushStatus }
  /** The host has no APNs/FCM credentials, so the phone is never asked. */
  | { state: 'host-not-ready'; message: string }
  | { state: 'denied' }
  | { state: 'error'; message: string };

/**
 * Registers this device for the host's "needs input" and "finished" alerts.
 * Run it on every connect: the host upserts the token, so a rotated APNs/FCM
 * token replaces the old one and alert preferences are kept. The system
 * permission prompt shows only once, and only for a host that can deliver.
 */
export async function registerForPush(deps: PushDeps, hostProfileId: string): Promise<PushSetupResult> {
  const installationId = await deps.getInstallationId();
  try {
    const status = await deps.invoke<RemoteMobilePushStatus>('mobile:push-status', [{ platform: deps.platform, installationId }]);
    if (status.provider !== 'ready') return { state: 'host-not-ready', message: status.message };
  } catch (error) {
    return { state: 'error', message: messageOf(error) };
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
    const status = await deps.invoke<RemoteMobilePushStatus>('mobile:push-register', [{ platform: deps.platform, token, installationId, hostProfileId }]);
    return status.provider === 'ready' ? { state: 'registered', status } : { state: 'host-not-ready', message: status.message };
  } catch (error) {
    return { state: 'error', message: messageOf(error) };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
