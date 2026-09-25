import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { secureStore } from '@/auth/secureStore';

import type { PermissionState, PushDeps } from './registration';

const INSTALLATION_KEY = 'pane.mobile.installationId';
const TOKEN_TIMEOUT_MS = 15_000;

// Show a host's alert even while Pane is open: the pane that needs input is
// usually not the one on screen.
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

export const devicePush: Omit<PushDeps, 'invoke'> = {
  platform: Platform.OS === 'android' ? 'android' : 'ios',
  getPermission: async () => permissionState(await Notifications.getPermissionsAsync()),
  requestPermission: async () => permissionState(await Notifications.requestPermissionsAsync()),
  getDeviceToken: () => withTimeout(Notifications.getDevicePushTokenAsync().then(token => String(token.data)), TOKEN_TIMEOUT_MS),
  getInstallationId,
};

let installationId: Promise<string> | null = null;

/** A random ID per install, shared by every host, so re-registering replaces this phone's old token. */
export function getInstallationId(): Promise<string> {
  installationId ??= loadInstallationId().catch(error => {
    installationId = null;
    throw error;
  });
  return installationId;
}

async function loadInstallationId(): Promise<string> {
  const existing = await secureStore.getItem(INSTALLATION_KEY);
  if (existing) return existing;
  const created = `pane-native-${Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')}`;
  await secureStore.setItem(INSTALLATION_KEY, created);
  return created;
}

function permissionState(status: Notifications.NotificationPermissionsStatus): PermissionState {
  if (status.granted || status.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL) return 'granted';
  return status.canAskAgain ? 'undetermined' : 'denied';
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the system did not return a push token in time')), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
