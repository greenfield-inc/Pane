import { expect, test } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

test('asking for the host\'s GitHub settings opens Settings at Remote Access', async ({ page }) => {
  await installElectronApiMock(page);
  await page.goto('/');
  await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible();

  // What a clone sign-in error's button does for a host whose sign-in lives in Settings.
  await page.evaluate(() => window.dispatchEvent(new Event('pane:open-host-github-settings')));

  await expect(page.getByRole('heading', { name: 'Remote Access' })).toBeVisible();
});
