import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

const inviteUrl = 'https://discord.gg/BdMyubeAZn';

async function openedExternalUrls(page: Page): Promise<string[]> {
  // SAFETY: installElectronApiMock defines this test-only API before navigation.
  return page.evaluate(() => (
    window as typeof window & {
      __paneTestElectronMock: { getOpenedExternalUrls: () => string[] };
    }
  ).__paneTestElectronMock.getOpenedExternalUrls());
}

test('Home menu Discord action opens the community invite', async ({ page }) => {
  await installElectronApiMock(page, {
    initialPreferences: { hide_discord: 'true', hide_welcome: 'true' },
  });
  await page.goto('/');

  await page.getByRole('button', { name: 'Home menu' }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Feedback', exact: true })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Discord', exact: true }).click();

  await expect.poll(() => openedExternalUrls(page)).toContain(inviteUrl);
});

test('sidebar footer keeps utility controls reachable at minimum width', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pane-sidebar-width', '200'));
  await installElectronApiMock(page, {
    initialPreferences: { hide_discord: 'true', hide_welcome: 'true' },
  });
  await page.goto('/');

  const sidebarBounds = await page.getByTestId('sidebar').boundingBox();
  if (!sidebarBounds) throw new Error('Sidebar has no visible bounds');
  for (const name of ['New project', 'Home menu', 'Settings']) {
    const button = page.getByRole('button', { name, exact: true }).first();
    await expect(button).toBeVisible();
    const buttonBounds = await button.boundingBox();
    if (!buttonBounds) throw new Error(`${name} has no visible bounds`);
    expect(buttonBounds.x).toBeGreaterThanOrEqual(sidebarBounds.x);
    expect(buttonBounds.x + buttonBounds.width).toBeLessThanOrEqual(sidebarBounds.x + sidebarBounds.width);
  }
});

test('home Discord banner persists dismissal', async ({ page }) => {
  await installElectronApiMock(page, {
    initialPreferences: {
      hide_discord: 'false',
      hide_welcome: 'true',
      welcome_shown: 'true',
    },
  });
  await page.goto('/');

  const banner = page.getByRole('region', { name: 'Pane Discord community' });
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: 'Dismiss Discord invitation' }).click();
  await expect(banner).toHaveCount(0);

  await expect.poll(() => page.evaluate(() => {
    // SAFETY: installElectronApiMock defines this test-only API before navigation.
    return (
    window as typeof window & {
      __paneTestElectronMock: { getPreferences: () => Record<string, string> };
    }
    ).__paneTestElectronMock.getPreferences().hide_discord;
  })).toBe('true');
});

test('home Discord join opens the invite and dismisses the banner', async ({ page }) => {
  await installElectronApiMock(page, {
    initialPreferences: {
      hide_discord: 'false',
      hide_welcome: 'true',
      welcome_shown: 'true',
    },
  });
  await page.goto('/');

  const banner = page.getByRole('region', { name: 'Pane Discord community' });
  await banner.getByRole('button', { name: 'Join', exact: true }).click();

  await expect(banner).toHaveCount(0);
  await expect.poll(() => openedExternalUrls(page)).toContain(inviteUrl);
});

test('home Discord banner remains available when the invite cannot open', async ({ page }) => {
  await installElectronApiMock(page, {
    initialPreferences: {
      hide_discord: 'false',
      hide_welcome: 'true',
      welcome_shown: 'true',
    },
    openExternalOutcome: 'failure',
  });
  await page.goto('/');

  const banner = page.getByRole('region', { name: 'Pane Discord community' });
  await banner.getByRole('button', { name: 'Join', exact: true }).click();

  await expect(banner).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    // SAFETY: installElectronApiMock defines this test-only API before navigation.
    return (
      window as typeof window & {
        __paneTestElectronMock: { getPreferences: () => Record<string, string> };
      }
    ).__paneTestElectronMock.getPreferences().hide_discord;
  })).toBe('false');
});
