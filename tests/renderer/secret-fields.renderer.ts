import { expect, test, type Page } from '@playwright/test';

declare global {
  interface Window { secretFieldsTest: { saved: () => string[] } }
}

const PEM = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\nkqhkiG9w0BAQEF\n-----END PRIVATE KEY-----\n';
const saved = (page: Page) => page.evaluate(() => window.secretFieldsTest.saved());

/** Pastes text into the focused field the way the clipboard does, as one paste event. */
async function paste(page: Page, text: string) {
  await page.evaluate((value) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', value);
    document.activeElement?.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, text);
}

test('a secret card saves a pasted multi-line key with its line breaks, on Enter, from a password field', async ({ page }) => {
  await page.goto('/renderer-tests/secret-fields.html?surface=card');
  const field = page.getByLabel('Type the secret');
  await expect(field).toHaveAttribute('type', 'password');
  await field.click();
  await paste(page, PEM);
  await page.keyboard.press('Enter');
  expect(await saved(page)).toEqual([PEM]);
});

test('Answer all keeps a pasted value\'s line breaks through typing after it, and saves once on Enter', async ({ page }) => {
  await page.goto('/renderer-tests/secret-fields.html?surface=round');
  await expect(page.getByLabel('The secret')).toBeFocused();
  await paste(page, 'line one\nline two');
  await page.keyboard.type(' end');
  await page.keyboard.press('Enter');
  expect(await saved(page)).toEqual(['line one\nline two end']);
});

test('Settings → Secrets saves a pasted multi-line value with its line breaks, and says how many lines it has', async ({ page }) => {
  await page.goto('/renderer-tests/secret-fields.html?surface=settings');
  await page.getByRole('button', { name: 'Add secret' }).click();
  await page.getByLabel('Secret project').fill('github');
  await page.getByLabel('Secret name').fill('APP_PRIVATE_KEY');
  await page.getByLabel('Secret value').click();
  await paste(page, PEM);
  await expect(page.getByText('4 lines')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect.poll(() => saved(page)).toEqual([PEM]);
});

test('typing inside a pasted multi-line value keeps the line breaks around the caret', async ({ page }) => {
  await page.goto('/renderer-tests/secret-fields.html?surface=card');
  await page.getByLabel('Type the secret').click();
  await paste(page, 'one\ntwo\n');
  for (let step = 0; step < 4; step++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('2');
  await page.keyboard.press('Enter');
  expect(await saved(page)).toEqual(['one\n2two\n']);
});
