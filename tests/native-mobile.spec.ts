import { expect, test, type Page } from '@playwright/test';
import { openConnectedRemotePwa } from './remotePwaMock';
import type { JsonObject } from '../shared/validation/boundaryDecoder';

async function installNativeBridge(page: Page, permissionFails = false) {
  await page.addInitScript(({ permissionFails }) => {
    Object.defineProperty(window, 'Capacitor', { value: {
      isNativePlatform: () => true,
      Plugins: {
        SecureStore: {
          get: async ({ key }: { key: string }) => ({ value: localStorage.getItem(key) }),
          set: async ({ key, value }: { key: string; value: string }) => { localStorage.setItem(key, value); },
          remove: async ({ key }: { key: string }) => { localStorage.removeItem(key); },
        },
        App: { addListener: async () => ({ remove: async () => {} }) },
        PushNotifications: {
          requestPermissions: () => new Promise((resolve, reject) => {
            document.documentElement.dataset.permissionPending = 'true';
            window.addEventListener('test-native-permission', () => {
              if (permissionFails) reject(new Error('OS notification permission unavailable'));
              else resolve({ receive: 'granted' });
            }, { once: true });
          }),
          register: async () => { window.dispatchEvent(new CustomEvent('test-native-registration', { detail: { value: 'device-token' } })); },
          addListener: async (name: string, listener: (value: JsonObject) => void) => {
            const eventName = name === 'registration' ? 'test-native-registration' : `test-native-${name}`;
            // SAFETY: This test bridge emits CustomEvents with JSON object payloads.
            const handler = (event: Event) => listener((event as CustomEvent<JsonObject>).detail);
            window.addEventListener(eventName, handler);
            return { remove: async () => { window.removeEventListener(eventName, handler); } };
          },
        },
      },
    } });
  }, { permissionFails });
}

async function releasePermission(page: Page) {
  await expect(page.locator('html')).toHaveAttribute('data-permission-pending', 'true');
  await page.evaluate(() => window.dispatchEvent(new Event('test-native-permission')));
}

async function tapNotification(page: Page, paneId = 'anim-remote-0') {
  await page.evaluate(paneId => window.dispatchEvent(new CustomEvent('test-native-pushNotificationActionPerformed', {
    detail: { notification: { data: { eventId: crypto.randomUUID(), hostProfileId: 'anim-host', paneId, panelId: 'anim-panel-1' } } },
  })), paneId);
}

test('native registration refreshes status and repeated notification taps select the notified panel', async ({ page }) => {
  await installNativeBridge(page);
  await openConnectedRemotePwa(page);
  let registered = false;
  await page.route('http://anim-pane.test/**', async route => {
    // SAFETY: The RemoteRuntimeAdapter emits the invoke envelope intercepted here.
    const body = route.request().postDataJSON() as { channel?: string } | null;
    if (!body?.channel?.startsWith('mobile:push-')) return route.fallback();
    if (body.channel === 'mobile:push-register') registered = true;
    await route.fulfill({ json: { ok: true, result: {
      registration: registered ? 'registered' : 'not-registered', provider: 'ready', message: 'APNs delivery is configured.',
      needsInputEnabled: true, completedEnabled: false,
    } } });
  });
  await expect(page.getByRole('tab', { name: 'claude', exact: true })).toHaveAttribute('aria-selected', 'true');
  await releasePermission(page);
  await expect(page.locator('summary')).toHaveText('Notifications enabled');
  await tapNotification(page);
  await expect(page.getByRole('tab', { name: 'shell', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'claude', exact: true }).click();
  await tapNotification(page);
  await expect(page.getByRole('tab', { name: 'shell', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(await page.evaluate(() => localStorage.getItem('pane.mobile.pendingPushRoute'))).toBeNull();
  await page.locator('summary').click();
  await expect(page.getByRole('checkbox', { name: 'Alert when a turn completes' })).not.toBeChecked();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible();
  await tapNotification(page);
  await expect(page.getByRole('tab', { name: 'shell', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('an OS permission failure leaves the remote terminal connected', async ({ page }) => {
  await installNativeBridge(page, true);
  await openConnectedRemotePwa(page);
  await releasePermission(page);
  await expect(page.getByText('OS notification permission unavailable')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'shell', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible();
});

test('a notification for a deleted pane reports the missing target', async ({ page }) => {
  await installNativeBridge(page);
  await openConnectedRemotePwa(page);
  await expect(page.getByRole('tab', { name: 'claude', exact: true })).toBeVisible();
  await tapNotification(page, 'deleted-pane');
  await expect(page.getByText('The notified pane is no longer available on this Pane host.')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'claude', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('a secure-storage read failure does not overwrite the saved profiles', async ({ page }) => {
  await installNativeBridge(page);
  await page.addInitScript(() => {
    localStorage.setItem('pane.remotePwa.savedProfiles', 'existing encrypted profiles');
    const store = window.Capacitor?.Plugins?.SecureStore;
    if (!store) throw new Error('Native bridge fixture missing');
    store.get = async () => { throw new Error('Secure storage is locked'); };
  });
  // The first remote.html in a shard compiles it cold, as openConnectedRemotePwa allows for.
  await page.goto('/remote.html', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.getByText('Secure storage is locked')).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => localStorage.getItem('pane.remotePwa.savedProfiles'))).toBe('existing encrypted profiles');
});
