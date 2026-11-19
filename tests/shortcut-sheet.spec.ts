import { expect, test, type Page } from '@playwright/test';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import { gotoApp, installElectronApiMock } from './electronApiMock';

// The keyboard shortcut sheet (⌘/, Ctrl+K Ctrl+/ elsewhere): journeys 1–4 of the
// keyboard-approvals plan, against the Vite renderer with the Electron mock.

const MAC = process.platform === 'darwin';

async function open(page: Page, initialConfig: JsonObject = {}) {
  await installElectronApiMock(page, { initialConfig: { keyboardShortcutOverrides: { 'cycle-tab-next-d': 'mod+alt+]', 'cycle-tab-prev-a': 'mod+alt+[' }, ...initialConfig } });
  await gotoApp(page);
  await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible({ timeout: 10_000 });
}

/** ⌘/ on macOS; Windows and Linux leave Ctrl+/ to terminal programs and use Ctrl+K Ctrl+/. */
async function pressSheetKey(page: Page) {
  if (MAC) return page.keyboard.press('Meta+/');
  await page.keyboard.press('Control+k');
  await page.keyboard.press('Control+/');
}

const sheet = (page: Page) => page.getByRole('dialog', { name: 'Keyboard Shortcuts' });
const tab = (page: Page, name: string) => sheet(page).getByRole('tab', { name: new RegExp(`^${name}\\s*\\d+$`) });

test('the sheet key opens the sheet on the last group viewed, and the key or Esc closes it back to where focus was', async ({ page }) => {
  await open(page);
  const opener = page.getByRole('button', { name: 'Settings' }).first();
  await opener.focus();
  await pressSheetKey(page);
  await expect(sheet(page)).toBeVisible();
  await expect(tab(page, 'Navigation')).toHaveAttribute('aria-selected', 'true');
  await expect(sheet(page).getByRole('textbox', { name: 'Search shortcuts' })).toBeFocused();

  await tab(page, 'Approvals').click();
  const approvals = sheet(page).getByRole('region', { name: 'Approvals' });
  await expect(approvals).toContainText('Open or close Approvals');
  await expect(approvals).toContainText('Answer all, from any app');
  // The person's own tab keys show on the rows that follow them, with the changed dot.
  const tabsRow = approvals.locator('[data-shortcut-id="reference-approval-tabs"]');
  await expect(tabsRow).toContainText(MAC ? '⌘⌥]' : 'Ctrl+Alt+]');
  await expect(tabsRow.getByLabel('Changed by you')).toBeVisible();

  await pressSheetKey(page);
  await expect(sheet(page)).toHaveCount(0);
  await expect(opener).toBeFocused();

  await pressSheetKey(page);
  await expect(tab(page, 'Approvals')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toHaveCount(0);
});

test('search lists matches from every group with counts, finds keys by chord, and says when nothing matches', async ({ page }) => {
  await open(page);
  await pressSheetKey(page);
  const search = sheet(page).getByRole('textbox', { name: 'Search shortcuts' });

  await search.fill('approv');
  await expect(sheet(page).getByRole('region', { name: 'Find' })).toContainText('Find in the focused tab, chat or approval');
  await expect(sheet(page).getByRole('region', { name: 'Chat' })).toContainText('Open this Session’s approval');
  await expect(sheet(page).locator('mark').first()).toHaveText(/approv/i);
  await expect(tab(page, 'Navigation')).toContainText('0');
  await expect(tab(page, 'Find')).toContainText('1');

  await search.fill(MAC ? '⌘⇧' : 'ctrl+shift');
  await expect(sheet(page).locator('[data-shortcut-id]').filter({ hasText: 'Open Search' })).toBeVisible();
  await expect(sheet(page).locator('[data-shortcut-id]').filter({ hasText: 'Toggle Sidebar' })).toHaveCount(0);

  await search.fill('zzq');
  await expect(sheet(page).getByText('No shortcut matches.')).toBeVisible();
});

test('↑↓ on the rail switch groups, and Change keys opens Settings › Shortcuts', async ({ page }) => {
  await open(page);
  await pressSheetKey(page);
  await tab(page, 'Approvals').click();
  await page.keyboard.press('ArrowDown');
  await expect(tab(page, 'Panes and Sessions')).toHaveAttribute('aria-selected', 'true');
  await expect(tab(page, 'Panes and Sessions')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(tab(page, 'Approvals')).toHaveAttribute('aria-selected', 'true');

  await sheet(page).getByRole('button', { name: /Change keys/ }).click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.locator('[data-setting-id="keyboard-shortcut-map"]')).toBeVisible();
});

test('the palette and the sidebar menu open the sheet', async ({ page }) => {
  await open(page);
  await page.keyboard.press('ControlOrMeta+Shift+P');
  await page.keyboard.type('Show Keyboard Shortcuts');
  await page.getByRole('option', { name: /Show Keyboard Shortcuts/ }).first().click();
  await expect(sheet(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toHaveCount(0);
});

test('on Windows and Linux, Ctrl+/ stays with the focused program and Ctrl+K Ctrl+/ opens the sheet', async ({ page }) => {
  // The keymap follows navigator.platform, so pin Windows on every runner.
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, 'platform', { get: () => 'Win32' });
  });
  await open(page);
  await page.keyboard.press('Control+/');
  await expect(sheet(page)).toHaveCount(0);
  await page.keyboard.press('Control+k');
  await page.keyboard.press('Control+/');
  await expect(sheet(page)).toBeVisible();
  await sheet(page).getByRole('textbox', { name: 'Search shortcuts' }).fill('this sheet');
  await expect(sheet(page).locator('[data-shortcut-id]').filter({ hasText: 'this sheet' })).toContainText('Ctrl+KCtrl+/');
});
