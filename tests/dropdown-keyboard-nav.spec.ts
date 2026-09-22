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
  await expect(page.getByTestId('sidebar').first()).toBeVisible({ timeout: 30000 });
  const analyticsDecline = page.locator('button:has-text("No thanks")');
  if (await analyticsDecline.isVisible({ timeout: 3000 }).catch(() => false)) {
    await analyticsDecline.click();
    await expect(analyticsDecline).toBeHidden();
  }
  const getStartedButton = page.locator('button:has-text("Get Started")');
  if (await getStartedButton.isVisible({ timeout: 2000 }).catch(() => false)) {
    await getStartedButton.click();
    await expect(getStartedButton).toBeHidden();
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

    const footerAction = page.getByRole('menu').getByRole('menuitem', { name: 'Add Repository' });
    await expect(footerAction).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page.getByText('Add New Repository')).toBeVisible();
    await expect(page.getByRole('menu')).toHaveCount(0);
  });

  test('theme dropdown is navigable with arrow keys and Enter', async ({ page }, testInfo) => {
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
    const screenshotPath = testInfo.outputPath('theme-dropdown.png');
    await menu.screenshot({ path: screenshotPath });
    await testInfo.attach('theme-dropdown', { path: screenshotPath, contentType: 'image/png' });

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
    await expect(trigger).toBeFocused();
    // Highlighting another item then pressing Escape must NOT commit the theme:
    // the document still carries the original light-rounded theme classes.
    const themeClasses = await page.evaluate(() => ({
      lightRounded: document.documentElement.classList.contains('light-rounded'),
    }));
    expect(themeClasses.lightRounded).toBe(true);
  });
});

async function renderDropdown(page: Page, options: Parameters<typeof import('../frontend/src/test-fixtures/dropdown').renderDropdown>[0] = {}) {
  await page.goto('/');
  await dismissStartupDialogs(page);
  await page.evaluate(async ({ fixturePath, options }) => {
    const fixture: typeof import('../frontend/src/test-fixtures/dropdown') = await import(fixturePath);
    fixture.renderDropdown(options);
  }, { fixturePath: '/src/test-fixtures/dropdown.ts', options });
}

test.describe('Dropdown disabled and selected items', () => {
  test('opens on the selected enabled row, skips disabled rows and includes footer actions', async ({ page }) => {
    await renderDropdown(page);
    const trigger = page.getByRole('button', { name: 'Choose option' });
    await trigger.click();
    const selected = page.getByRole('menuitemradio', { name: 'Charlie' });
    const bravo = page.getByRole('menuitemradio', { name: 'Bravo' });
    const footer = page.getByRole('menuitem', { name: 'Configure' });
    await expect(selected).toBeFocused();
    await expect(selected).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('menuitemradio', { name: 'Unavailable' })).toBeDisabled();
    await page.keyboard.press('ArrowDown');
    await expect(footer).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(bravo).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(footer).toBeFocused();
    await page.keyboard.press('Home');
    await expect(bravo).toBeFocused();
    await page.keyboard.press('End');
    await expect(footer).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Last action')).toHaveText('footer');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('pointer hover and keyboard selection follow the same row when the menu stays open', async ({ page }) => {
    await renderDropdown(page, { closeOnSelect: false });
    const trigger = page.getByRole('button', { name: 'Choose option' });
    await trigger.focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitemradio', { name: 'Charlie' })).toBeFocused();
    const bravo = page.getByRole('menuitemradio', { name: 'Bravo' });
    await bravo.hover();
    await expect(bravo).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.getByLabel('Last action')).toHaveText('b');
    await expect(bravo).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('a disabled selection falls back to the first enabled item and outside clicks keep their focus', async ({ page }) => {
    await renderDropdown(page, { selectedId: 'a', width: 'full' });
    const trigger = page.getByRole('button', { name: 'Choose option' });
    await trigger.click();
    await expect(page.getByRole('menuitemradio', { name: 'Bravo' })).toBeFocused();
    await expect(page.getByRole('menu')).toHaveCSS('width', '180px');
    const outside = page.getByRole('button', { name: 'Outside control' });
    await outside.click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(outside).toBeFocused();
  });
});
