import { expect, test } from '@playwright/test';
import { dropRemoteConnection, openConnectedRemotePwa, restoreRemoteConnection } from './remotePwaMock';

test('session lifecycle events update the sidebar without refetching on terminal output', async ({ page }, testInfo) => {
  const host = await openConnectedRemotePwa(page);
  await expect(page.getByRole('tab', { name: 'claude', exact: true })).toBeVisible();
  const reads = host.invocations.filter(channel => channel === 'sessions:get-all-with-projects').length;
  const updated = { ...host.project.sessions[0], name: 'Renamed from host', status: 'stopped' };
  const created = { ...updated, id: 'created-on-host', name: 'Created from host' };
  await page.evaluate(({ updated, created }) => {
    window.__paneRemoteEmit?.('session:updated', [updated]);
    window.__paneRemoteEmit?.('session:created', [created]);
    for (let index = 0; index < 20; index++) window.__paneRemoteEmit?.('session:output', [{ sessionId: updated.id, data: 'output', type: 'stdout' }]);
  }, { updated, created });
  await expect(page.getByRole('button', { name: 'Renamed from host', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Created from host', exact: true })).toBeVisible();
  expect(host.invocations.filter(channel => channel === 'sessions:get-all-with-projects')).toHaveLength(reads);
  await page.evaluate(session => window.__paneRemoteEmit?.('session:deleted', [session]), updated);
  await expect(page.getByRole('button', { name: 'Renamed from host', exact: true })).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Select a remote pane' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('lifecycle-events.png') });
});

test('ready after reconnect refreshes changes made while the stream was down', async ({ page }, testInfo) => {
  const host = await openConnectedRemotePwa(page);
  await expect(page.getByRole('tab', { name: 'claude', exact: true })).toBeVisible();
  await dropRemoteConnection(page);
  host.project.sessions[0].name = 'Changed while offline';
  await restoreRemoteConnection(page);
  await expect(page.getByRole('button', { name: 'Changed while offline running', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('reconnected-list.png') });
});

test('native Back stays on the pane chooser through updates and reconnects', async ({ page }) => {
  await page.addInitScript(() => {
    window.Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        SecureStore: {
          get: async args => ({ value: localStorage.getItem(String(args.key)) ?? '' }),
          set: async args => { localStorage.setItem(String(args.key), String(args.value)); return {}; },
          remove: async args => { localStorage.removeItem(String(args.key)); return {}; },
        },
        App: {
          addListener: async (event, listener) => {
            const callback = () => listener({});
            document.addEventListener(`native-${event}`, callback);
            return { remove: async () => document.removeEventListener(`native-${event}`, callback) };
          },
        },
      },
    };
  });
  const host = await openConnectedRemotePwa(page);
  await expect(page.getByRole('tab', { name: 'claude', exact: true })).toBeVisible();
  await page.evaluate(() => document.dispatchEvent(new Event('native-backButton')));
  await page.evaluate(() => document.dispatchEvent(new Event('native-backButton')));
  const chooser = page.getByRole('heading', { name: 'Select a remote pane' });
  await expect(chooser).toBeVisible();
  await page.evaluate(session => window.__paneRemoteEmit?.('session:updated', [session]), host.project.sessions[0]);
  await dropRemoteConnection(page);
  host.project.sessions[0].name = 'Back stays here';
  await restoreRemoteConnection(page);
  await expect(page.getByRole('button', { name: 'Back stays here running', exact: true })).toBeVisible();
  await expect(chooser).toBeVisible();
  await page.getByRole('button', { name: 'Back stays here running', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'claude', exact: true })).toBeVisible();
});
