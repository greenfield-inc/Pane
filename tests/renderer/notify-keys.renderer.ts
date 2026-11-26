import { expect, test, type Page } from '@playwright/test';

declare global {
  interface Window { notifyKeysTest: { commands: () => Array<{ type: string; id?: string; answer?: { answer?: string; choice?: string; text?: string } }> } }
}

const commands = (page: Page) => page.evaluate(() => window.notifyKeysTest.commands().filter((command) => command.type === 'answer'));
const highlighted = (page: Page) => page.locator('[data-highlighted="true"]');

test.describe('the strip card (T-113)', () => {
  test('J/K move the highlight from the recommended choice, stop at the ends, and Enter sends it', async ({ page }) => {
    await page.goto('/renderer-tests/notify-keys.html?surface=strip');
    const card = page.getByTestId('notify-card');
    // The card's keys work while the pointer is on it.
    await card.hover();
    await expect(highlighted(page)).toContainText('Redis');
    await expect(page.getByTestId('notify-choice-keys')).toContainText(/J\s*K move · ↩ sends · 2 is recommended/);
    await page.keyboard.press('j');
    await expect(highlighted(page)).toContainText('In memory');
    await page.keyboard.press('j');
    await expect(highlighted(page)).toContainText('In memory');
    for (let at = 0; at < 3; at += 1) await page.keyboard.press('k');
    await expect(highlighted(page)).toContainText('Postgres table');
    await expect(highlighted(page)).toHaveAttribute('aria-current', 'true');
    expect(await commands(page)).toEqual([]);
    await page.keyboard.press('Enter');
    await expect.poll(() => commands(page)).toHaveLength(1);
    expect(JSON.stringify((await commands(page))[0])).toContain('Postgres table');
  });

  test('with details shown, J/K and Enter work the same, and the note field keeps its keys', async ({ page }) => {
    await page.goto('/renderer-tests/notify-keys.html?surface=strip&details');
    await page.getByTestId('notify-card').hover();
    await expect(highlighted(page)).toContainText('Redis');
    await page.keyboard.press('k');
    await expect(highlighted(page)).toContainText('Postgres table');
    // Nothing is picked by J/K (D-385).
    await expect(page.locator('[aria-pressed="true"]')).toHaveCount(0);
    const note = page.getByPlaceholder(/Add a note/);
    await note.click();
    await page.keyboard.type('jk');
    await expect(note).toHaveValue('jk');
    await expect(highlighted(page)).toContainText('Postgres table');
  });

  test('⌘ or Ctrl with J/K does nothing of theirs', async ({ page }) => {
    await page.goto('/renderer-tests/notify-keys.html?surface=strip');
    await page.getByTestId('notify-card').hover();
    await page.keyboard.press('Control+j');
    await page.keyboard.press('Meta+j');
    await expect(highlighted(page)).toContainText('Redis');
  });
});

test.describe('Answer all (T-113)', () => {
  test('J/K move the highlight, stop at the ends, and Enter sends it; with nothing moved Enter sends the recommended one', async ({ page }) => {
    await page.goto('/renderer-tests/notify-keys.html?surface=round');
    const round = page.getByTestId('notify-round');
    await expect(round.locator('[data-highlighted="true"]')).toContainText('Redis');
    await expect(round.getByRole('option', { selected: true })).toHaveCount(0);
    await expect(page.getByTestId('notify-round-jk')).toBeVisible();
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    await expect(round.locator('[data-highlighted="true"]')).toContainText('In memory');
    await page.keyboard.press('k');
    await page.keyboard.press('k');
    await page.keyboard.press('k');
    await expect(round.locator('[data-highlighted="true"]')).toContainText('Postgres table');
    await page.keyboard.press('Enter');
    await expect.poll(() => commands(page)).toHaveLength(1);
    expect(JSON.stringify((await commands(page))[0])).toContain('Postgres table');
  });

  test('Enter with no J/K sends the recommended choice, as ⇧↩ would', async ({ page }) => {
    await page.goto('/renderer-tests/notify-keys.html?surface=round');
    await expect(page.getByTestId('notify-round')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect.poll(() => commands(page)).toHaveLength(1);
    expect(JSON.stringify((await commands(page))[0])).toContain('Redis');
  });

  test('J/K typed in the note are the note\'s', async ({ page }) => {
    await page.goto('/renderer-tests/notify-keys.html?surface=round');
    await expect(page.getByTestId('notify-round')).toBeVisible();
    await page.keyboard.press('Tab');
    const note = page.getByLabel('Note');
    await expect(note).toBeFocused();
    await page.keyboard.type('jk');
    await expect(note).toHaveValue('jk');
    await expect(page.getByTestId('notify-round').locator('[data-highlighted="true"]')).toContainText('Redis');
  });
});
