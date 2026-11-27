import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { secureStore } from '@/auth/secureStore';
import { isPushForPane, parseNotifyPush, type NotifyPush } from '@/features/links/links';

import type { PermissionState, PushDeps } from './registration';

const INSTALLATION_KEY = 'pane.mobile.installationId';
const TOKEN_TIMEOUT_MS = 15_000;

/** Marks a local alert that still slides in while Pane is open: a button's answer that didn't surely send. */
export const LOUD_NOTICE = 'paneNotice';

// While Pane is open, a host's alert goes to Notification Center or the shade without a banner or a
// sound: Home's "+N" shows what is new. The OS calls this only in the foreground; in the background
// alerts show as usual. Android Notify messages carry data only (the app draws their alert itself),
// so anything without text stays hidden.
Notifications.setNotificationHandler({
  handleNotification: async notification => {
    const { title, body, data } = notification.request.content;
    const show = Boolean(title || body);
    const loud = show && data?.[LOUD_NOTICE] === '1';
    return { shouldShowBanner: loud, shouldShowList: show, shouldPlaySound: loud, shouldSetBadge: false };
  },
});

let lastToken: string | null = null;

export const devicePush: Omit<PushDeps, 'invoke'> = {
  platform: Platform.OS === 'android' ? 'android' : 'ios',
  getPermission: async () => permissionState(await Notifications.getPermissionsAsync()),
  requestPermission: async () => permissionState(await Notifications.requestPermissionsAsync()),
  getDeviceToken: () => withTimeout(Notifications.getDevicePushTokenAsync().then(token => {
    lastToken = String(token.data);
    return lastToken;
  }), TOKEN_TIMEOUT_MS),
  getInstallationId,
};

/** Whether `token` is the one this phone last registered. Asking for the token can report it again unchanged. */
export function isLastToken(token: string): boolean {
  return token === lastToken;
}

/**
 * Removes a Pane's delivered "is blocked" and "finished" alerts, and its workers' when it is a
 * Session, from Notification Center or the shade. Notify questions keep theirs until answered. Best effort.
 */
export async function clearPaneNotifications(paneId: string): Promise<void> {
  await dismissPresented(request => isPushForPane(request, paneId) && !parseNotifyPush(request));
}

/** Removes the delivered Notify alerts `matches` picks, such as questions answered elsewhere. Best effort. */
export async function dismissNotifyAlerts(matches: (push: NotifyPush) => boolean): Promise<void> {
  await dismissPresented(request => {
    const push = parseNotifyPush(request);
    return push !== null && matches(push);
  });
}

async function dismissPresented(matches: (request: Notifications.NotificationRequest) => boolean): Promise<void> {
  const presented = await Notifications.getPresentedNotificationsAsync().catch(() => []);
  await Promise.all(presented
    .filter(notification => matches(notification.request))
    .map(notification => Notifications.dismissNotificationAsync(notification.request.identifier).catch(() => undefined)));
}

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
