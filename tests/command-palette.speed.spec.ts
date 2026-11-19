import { expect, test } from '@playwright/test';
import { bootLarge, openSearch, results, selectedOption } from './commandPaletteFixture';

// Out of CI (NOT_IN_CI in scripts/ci-test-inventory.mjs): speed budgets a 4-vCPU CI
// runner misses, so there they measure the machine more than the code. Run them by
// hand. Moved unchanged from command-palette.spec.ts (D-40).

test('2,500 Panes with tracked agents rank within a frame and list quickly', async ({ page }) => {
  await bootLarge(page);
  const input = await openSearch(page);
  const box = await input.boundingBox();
  await page.evaluate(() => performance.clearMeasures('pane:search'));
  await input.pressSequentially('runpane upd', { delay: 30 });
  const durations = await page.evaluate(() => performance.getEntriesByName('pane:search').map(entry => entry.duration));
  expect(durations.length).toBeGreaterThan(5);
  expect(Math.max(...durations)).toBeLessThan(16);
  expect(await input.boundingBox()).toEqual(box);

  // The broad Panes view: from the key press to the painted list.
  await input.fill('b');
  const listMs = await page.evaluate(() => new Promise<number>(resolve => {
    const field = document.querySelector<HTMLInputElement>('[role="combobox"][aria-label="Search"]');
    const start = performance.now();
    field?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - start)));
  }));
  await expect(page.getByRole('button', { name: 'Panes', pressed: true })).toBeVisible();
  console.log(`[search] broad Panes view rendered in ${listMs.toFixed(1)} ms`);
  expect(listMs).toBeLessThan(250);
});

test('a long list stays windowed wherever the selection goes', async ({ page }) => {
  await bootLarge(page);
  const input = await openSearch(page);
  await page.keyboard.type('bulk');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Panes', pressed: true })).toBeVisible();
  const mountedOptions = () => results(page).getByRole('option').count();
  expect(await mountedOptions()).toBeLessThan(60);

  // The reviewer's repro: wrap to the last row, then edit the query and return to it.
  await page.keyboard.press('ArrowUp');
  // The least recently viewed match sorts last.
  await expect(selectedOption(page)).toHaveAttribute('aria-label', /^bulk-loops-2499,/);
  // Only a window is mounted, so the last row states its place in the whole list.
  await expect(selectedOption(page)).toHaveAttribute('aria-posinset', '2500');
  await expect(selectedOption(page)).toHaveAttribute('aria-setsize', '2500');
  expect(await mountedOptions()).toBeLessThan(60);
  await page.keyboard.type('-');
  const keystrokeMs = await page.evaluate(() => new Promise<number>(resolve => {
    const field = document.querySelector<HTMLInputElement>('[role="combobox"][aria-label="Search"]');
    if (!field) throw new Error('Search input missing');
    const start = performance.now();
    // The same input event typing Backspace produces, timed to the next painted frame.
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setValue?.call(field, 'bulk');
    field.dispatchEvent(new Event('input', { bubbles: true }));
    requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - start)));
  }));
  await expect(input).toHaveValue('bulk');
  console.log(`[search] Backspace back to "bulk" painted in ${keystrokeMs.toFixed(1)} ms`);
  expect(await mountedOptions()).toBeLessThan(60);
  expect(keystrokeMs).toBeLessThan(100);

  // Scrolling to the end mounts the rows there, still a bounded window, and every match stays reachable.
  await results(page).evaluate(list => { list.scrollTop = list.scrollHeight; });
  await expect(results(page).getByRole('option', { name: /^bulk-loops-2499,/ })).toBeVisible();
  expect(await mountedOptions()).toBeLessThan(60);
});
