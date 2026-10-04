import { test, expect, Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

test.beforeEach(async ({ page }) => {
  await installElectronApiMock(page, {
    initialConfig: { theme: 'light-rounded', appearanceMode: 'fixed' },
  });
  // Pin a known starting theme so arrow-key movement is deterministic.
  await page.addInitScript(() => {
    localStorage.setItem('theme', 'light-rounded');
  });
});

async function dismissStartupDialogs(page: Page) {
  const analyticsDecline = page.locator('button:has-text("No thanks")');
  if (await analyticsDecline.isVisible({ timeout: 3000 }).catch(() => false)) {
    await analyticsDecline.click();
    await page.waitForTimeout(500);
  }
  const getStartedButton = page.locator('button:has-text("Get Started")');
  if (await getStartedButton.isVisible({ timeout: 2000 }).catch(() => false)) {
    await getStartedButton.click();
    await page.waitForTimeout(500);
  }
}

test.describe('Dropdown keyboard navigation', () => {
  test('footer-only dropdown focuses and activates its footer action', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissStartupDialogs(page);

    const trigger = page
      .locator('[aria-haspopup="menu"]')
      .filter({ hasText: 'Open Project' });
    await expect(trigger).toBeVisible({ timeout: 5000 });
    await trigger.click();

    const footerAction = page.getByRole('menu').getByRole('button', { name: 'Add Repository' });
    await expect(footerAction).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page.getByRole('heading', { name: 'Open Repository' })).toBeVisible();
    await expect(page.getByRole('menu')).toHaveCount(0);
  });

  test('theme dropdown is navigable with arrow keys and Enter', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissStartupDialogs(page);

    const trigger = page
      .locator('[aria-haspopup="menu"]')
      .filter({ hasText: 'Light (rounded)' });
    await expect(trigger).toBeVisible({ timeout: 5000 });
    await trigger.focus();
    await page.keyboard.press('Enter');

    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible({ timeout: 5000 });

    // On open, focus lands on the currently selected item (Light (rounded)).
    // The theme menu is single-select (it passes selectedId), so its items are radios.
    const focusedItem = page.locator('[role="menuitemradio"]:focus');
    await expect(focusedItem).toHaveText(/Light \(rounded\)/);

    // ArrowDown moves to the next item (Light (sharp)), ArrowUp moves back.
    // Item order comes from THEME_OPTIONS in frontend/src/utils/themeOptions.ts.
    await page.keyboard.press('ArrowDown');
    await expect(focusedItem).toHaveText(/Light \(sharp\)/);
    await page.keyboard.press('ArrowUp');
    await expect(focusedItem).toHaveText(/Light \(rounded\)/);

    // Navigate to Forge (third item) and select it with Enter.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(focusedItem).toHaveText(/Forge/);
    await page.keyboard.press('Enter');

    // Menu closes and the theme is applied.
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /Forge/ }),
    ).toBeVisible();
    await expect.poll(async () =>
      page.evaluate(() => document.documentElement.classList.contains('forge')),
    ).toBe(true);

    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });

  test('Escape closes the dropdown without changing the theme', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await dismissStartupDialogs(page);

    const trigger = page
      .locator('[aria-haspopup="menu"]')
      .filter({ hasText: 'Light (rounded)' });
    await expect(trigger).toBeVisible({ timeout: 5000 });
    await trigger.focus();
    await page.keyboard.press('Enter');

    await expect(page.getByRole('menu')).toBeVisible({ timeout: 5000 });

    await page.keyboard.press('ArrowDown'); // move highlight to Light (sharp)
    await page.keyboard.press('Escape');

    await expect(page.getByRole('menu')).toHaveCount(0);
    // Highlighting another item then pressing Escape must NOT commit the theme:
    // the document still carries the original light-rounded theme classes.
    const themeClasses = await page.evaluate(() => ({
      lightRounded: document.documentElement.classList.contains('light-rounded'),
    }));
    expect(themeClasses.lightRounded).toBe(true);
  });
});
