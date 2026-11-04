import { execFile } from 'child_process';
import { Notification, shell, type IpcMain } from 'electron';
import { PaneError, reasonOf } from '../../../shared/paneError';
import type { TestNotificationResult } from '../../../shared/types/notifications';
import { rejectWithPaneErrorText } from '../daemon/commandRegistry';
import type { WorkspaceWatchLeases } from '../services/workspaceWatchLeases';
import type { AppServices } from './types';

/**
 * Dictate shows Pane's "needs your input" and "finished" alerts on its pill. It follows
 * Pane with `runpane watch --follow --as dictate`; while that watcher is attached, Pane
 * skips its own desktop notification so each event alerts once.
 */
const DESKTOP_ALERT_CONSUMER = 'dictate';
// Covers the gap between a follow watcher's polls; after it, Pane's own alerts return.
const DESKTOP_ALERT_CONSUMER_GRACE_MS = 30_000;
// Neither `show` nor `failed` arrived (some Linux notification daemons stay silent).
const TEST_NOTIFICATION_TIMEOUT_MS = 5_000;
// UNErrorCodeNotificationsNotAllowed: the person turned Pane off in System Settings → Notifications.
const MAC_NOT_ALLOWED = /UNErrorDomain error 1\.|not allowed/i;

const notificationSettingsUrl = (): string | undefined =>
  process.platform === 'darwin' ? 'x-apple.systempreferences:com.apple.Notifications-Settings.extension'
    : process.platform === 'win32' ? 'ms-settings:notifications'
      : undefined;

export function isDesktopAlertHandedOff(leases: WorkspaceWatchLeases | undefined): boolean {
  return leases?.isAttached(DESKTOP_ALERT_CONSUMER, DESKTOP_ALERT_CONSUMER_GRACE_MS) ?? false;
}

// Held until the OS answers; an unreferenced Electron Notification can be collected before `show`/`failed`.
let pendingTest: Notification | null = null;

/** Shows a native notification and reports what the OS did with it. */
function sendTestNotification(): Promise<TestNotificationResult> {
  if (!Notification.isSupported()) return Promise.resolve({ status: 'unsupported' });
  const canOpenSettings = notificationSettingsUrl() !== undefined;
  return new Promise((resolve) => {
    const notification = new Notification({
      title: 'Pane is ready to ping you',
      body: 'You will see notifications like this when a terminal panel finishes.',
    });
    pendingTest = notification;
    const settle = (result: TestNotificationResult) => {
      clearTimeout(timer);
      if (pendingTest === notification) pendingTest = null;
      resolve(result);
    };
    const timer = setTimeout(() => settle({ status: 'unconfirmed', canOpenSettings }), TEST_NOTIFICATION_TIMEOUT_MS);
    notification.once('show', () => settle({ status: 'shown' }));
    notification.once('failed', (_event, error) => {
      settle(process.platform === 'darwin' && MAC_NOT_ALLOWED.test(error)
        ? { status: 'blocked', canOpenSettings }
        : { status: 'failed', error, canOpenSettings });
    });
    notification.show();
  });
}

async function openNotificationSettings(): Promise<void> {
  const url = notificationSettingsUrl();
  if (!url) return;
  try {
    // Matches openExternalUrl: shell.openExternal can fail silently on macOS.
    if (process.platform === 'darwin') {
      await new Promise<void>((resolve, reject) => {
        execFile('open', [url], (error) => (error ? reject(error) : resolve()));
      });
    } else {
      await shell.openExternal(url);
    }
  } catch (cause) {
    throw new PaneError(
      'ERR_NOTIFICATION_SETTINGS_OPEN',
      `Pane couldn't open your system's notification settings: ${reasonOf(cause)}. Nothing was changed.`,
      process.platform === 'darwin'
        ? 'Open System Settings → Notifications yourself and allow Pane.'
        : 'Open Settings → System → Notifications yourself and allow Pane.',
    );
  }
}

export function registerDesktopAlertHandlers(ipcMain: IpcMain, services: AppServices): void {
  ipcMain.handle('notifications:handed-off', () => isDesktopAlertHandedOff(services.workspaceWatchLeases));
  ipcMain.handle('notifications:test', () => sendTestNotification());
  ipcMain.handle('notifications:open-settings', () => rejectWithPaneErrorText(openNotificationSettings()));
}
