import { expect, test } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

async function openPalette(page: import('@playwright/test').Page) {
  await installElectronApiMock(page, {});
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Control+Shift+P');
  const input = page.getByRole('combobox', { name: 'Search commands' });
  await expect(input).toBeVisible();
  return input;
}

test('keeps every result row under its header while typing a search', async ({ page }) => {
  await openPalette(page);
  // Type character by character: the incremental re-renders are what corrupted
  // the list when the enabled and unavailable passes shared a header key.
  await page.keyboard.type('pane', { delay: 60 });

  const listbox = page.getByRole('listbox', { name: 'Commands' });
  await expect(listbox.getByRole('option', { name: /New Pane/ })).toBeVisible();
  await expect(listbox.getByRole('option', { name: /Next Pane/ }).first()).toBeVisible();
  // Every rendered header is directly followed by at least one command row —
  // no orphaned category headers, no duplicated header runs.
  const orphanedHeaders = await listbox.evaluate((element) => {
    const children = [...element.children];
    return children.filter((child, index) => {
      if (child.getAttribute('role') === 'option') return false;
      const next = children[index + 1];
      return !next || next.getAttribute('role') !== 'option';
    }).length;
  });
  expect(orphanedHeaders).toBe(0);
});

test('shows only the empty state when nothing matches', async ({ page }) => {
  await openPalette(page);
  await page.keyboard.type('panezzzznothing', { delay: 40 });
  const listbox = page.getByRole('listbox', { name: 'Commands' });
  await expect(listbox.getByText('No commands found')).toBeVisible();
  await expect(listbox.getByRole('option')).toHaveCount(0);
  // The stale-category-header corruption left header text behind the empty state.
  await expect(listbox.getByText('Projects')).toHaveCount(0);
  await expect(listbox.getByText('View')).toHaveCount(0);
});
