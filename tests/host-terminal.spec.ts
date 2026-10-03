import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';
import type { RemoteHostKind } from '../shared/types/remoteDaemon';

async function saveHosts(page: Page, activeProfileId: string | null, hostKind?: RemoteHostKind) {
  await page.evaluate(async ({ activeProfileId, hostKind }) => {
    await window.electronAPI.remoteDaemon.upsertConnectionProfile({
      id: 'devbox', label: 'devbox', baseUrl: 'https://devbox.example.ts.net',
      token: 'synthetic', transport: 'http+sse', hostKind,
    });
    await window.electronAPI.remoteDaemon.upsertConnectionProfile({
      id: 'spare', label: 'spare', baseUrl: 'https://spare.example.ts.net', token: 'synthetic', transport: 'http+sse',
    });
    await window.electronAPI.remoteDaemon.updateClientState(activeProfileId
      ? { mode: 'remote', activeProfileId }
      : { mode: 'local', activeProfileId: null });
  }, { activeProfileId, hostKind });
}

async function hostTerminalOpenCalls(page: Page) {
  return page.evaluate(() => {
    // SAFETY: installElectronApiMock defines __paneTestElectronMock with getInvokeCalls.
    const mock = (window as typeof window & { __paneTestElectronMock: {
      getInvokeCalls: (channel: string) => Array<{ args: unknown[] }>;
    } }).__paneTestElectronMock;
    return mock.getInvokeCalls('host-terminal:open').map((call) => call.args[0] ?? null);
  });
}

test('only the active remote host offers its terminal in the switcher', async ({ page }, testInfo) => {
  await installElectronApiMock(page);
  await page.goto('/');
  await saveHosts(page, null);

  await page.getByRole('button', { name: 'Agents run on This computer. Switch host' }).click();
  await expect(page.getByRole('menuitemradio', { name: /This computer/ })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('menuitem', { name: /^Open terminal on/ })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await saveHosts(page, 'devbox');
  await page.getByRole('button', { name: 'Agents run on devbox. Switch host' }).click();
  await expect(page.getByRole('menuitem', { name: 'Open terminal on devbox' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Open terminal on spare' })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('switcher-terminal-button.png') });

  await page.getByRole('menuitem', { name: 'Open terminal on devbox' }).click();
  const tab = page.getByRole('tab', { name: 'devbox · Terminal' });
  await expect(tab).toBeVisible();
  await expect(tab.locator('..').locator('svg.lucide-server')).toHaveCount(1);
  await expect(page.getByRole('tablist', { name: 'Terminal on devbox' })).toBeVisible();
  expect(await hostTerminalOpenCalls(page)).toEqual([null]);
  // It is not a project or a Pane, so nothing about it lands in the sidebar.
  await expect(page.getByRole('navigation').getByText('Terminal', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('host-terminal-tab.png') });

  await page.getByRole('button', { name: 'Close devbox · Terminal' }).click();
  await expect(tab).toHaveCount(0);
});

test('a host saved with a cloud kind shows a cloud on its terminal tab', async ({ page }) => {
  await installElectronApiMock(page);
  await page.goto('/');
  await saveHosts(page, 'devbox', { label: 'cloud sandbox', icon: 'cloud' });

  await page.getByRole('button', { name: 'Agents run on devbox. Switch host' }).click();
  await page.getByRole('menuitem', { name: 'Open terminal on devbox' }).click();

  const tab = page.getByRole('tab', { name: 'devbox · Terminal' });
  await expect(tab).toBeVisible();
  await expect(tab.locator('..').locator('svg.lucide-cloud')).toHaveCount(1);
});
