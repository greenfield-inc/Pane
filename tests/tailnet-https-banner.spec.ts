import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

async function openedExternalUrls(page: Page): Promise<string[]> {
  // SAFETY: installElectronApiMock defines this test-only API before navigation.
  return page.evaluate(() => (
    window as typeof window & {
      __paneTestElectronMock: { getOpenedExternalUrls: () => string[] };
    }
  ).__paneTestElectronMock.getOpenedExternalUrls());
}

const notice = 'Remote access between your machines is off because HTTPS Certificates are turned off for your Tailscale network.';

test('explains that the tailnet has HTTPS Certificates off, links to the setting, and dismisses', async ({ page }) => {
  await installElectronApiMock(page, {
    initialPreferences: { hide_discord: 'true', hide_welcome: 'true' },
    workspaceAccess: {
      state: 'off',
      reason: 'this tailnet has HTTPS certificates turned off',
      fix: 'Turn on HTTPS Certificates at https://login.tailscale.com/admin/dns.',
      machineName: undefined,
      url: undefined,
    },
  });
  await page.goto('/');

  await expect(page.getByText(notice)).toBeVisible();
  await expect(page.getByText('public Certificate Transparency log')).toBeVisible();
  if (process.env.PANE_SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.PANE_SCREENSHOT_DIR}/tailnet-https-banner.png` });
  }

  await page.getByRole('button', { name: 'Open Tailscale DNS settings' }).click();
  await expect.poll(() => openedExternalUrls(page)).toContain('https://login.tailscale.com/admin/dns');

  await page.getByRole('button', { name: 'Dismiss HTTPS Certificates notice' }).click();
  await expect(page.getByText(notice)).toBeHidden();
});

test('stays hidden while workspaces are on', async ({ page }) => {
  await installElectronApiMock(page, {
    initialPreferences: { hide_discord: 'true', hide_welcome: 'true' },
  });
  await page.goto('/');

  await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible();
  await expect(page.getByText(notice)).toBeHidden();
});
