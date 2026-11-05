import { expect, test, type Page } from '@playwright/test';

declare global {
  interface Window { secretFieldsTest: { saved: () => string[] } }
}

const PEM = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\nkqhkiG9w0BAQEF\n-----END PRIVATE KEY-----\n';
const saved = (page: Page) => page.evaluate(() => window.secretFieldsTest.saved());

/** Pastes text the way a clipboard does, as one insertion. */
async function paste(page: Page, text: string) {
  await page.evaluate((value) => document.execCommand('insertText', false, value), text);
}

test('a secret card saves a pasted multi-line key with its line breaks, on Enter', async ({ page }) => {
  await page.goto('/renderer-tests/secret-fields.html?surface=card');
  await page.getByLabel('Type the secret').click();
  await paste(page, PEM);
  await page.keyboard.press('Enter');
  expect(await saved(page)).toEqual([PEM]);
});

test('Answer all adds a line break on Shift+Enter and saves on Enter', async ({ page }) => {
  await page.goto('/renderer-tests/secret-fields.html?surface=round');
  await expect(page.getByLabel('The secret')).toBeFocused();
  await page.keyboard.type('line one');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('line two');
  await page.keyboard.press('Enter');
  expect(await saved(page)).toEqual(['line one\nline two']);
});

test('Settings → Secrets saves a pasted multi-line value with its line breaks', async ({ page }) => {
  await page.goto('/renderer-tests/secret-fields.html?surface=settings');
  await page.getByRole('button', { name: 'Add secret' }).click();
  await page.getByLabel('Secret project').fill('github');
  await page.getByLabel('Secret name').fill('APP_PRIVATE_KEY');
  await page.getByLabel('Secret value').click();
  await paste(page, PEM);
  await page.keyboard.press('Enter');
  await expect.poll(() => saved(page)).toEqual([PEM]);
});

test('a multi-line value shows the whole line the caret is on', async ({ page }) => {
  await page.goto('/renderer-tests/secret-fields.html?surface=settings');
  await page.getByRole('button', { name: 'Add secret' }).click();
  const field = page.getByLabel('Secret value');
  await field.click();
  await paste(page, `${'MIIEvQIBADANBgkqhkiG9w0BAQEF\n'.repeat(40)}END`);
  // The caret is on line 41 of 41: the field scrolls by exactly 40 line heights.
  await expect.poll(() => field.evaluate((element) => element.scrollTop / parseFloat(getComputedStyle(element).lineHeight))).toBe(40);
});
