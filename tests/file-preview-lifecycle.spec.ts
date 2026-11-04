import { expect, test } from '@playwright/test';
import { bundleFixture } from './fixtures/bundle';

let fixture: string;
test.beforeAll(async () => {
  fixture = await bundleFixture('file-preview-lifecycle');
});
test.beforeEach(async ({ page }) => {
  await page.route('https://preview.test/**', route => route.fulfill({ status: 200, body: '', contentType: 'video/mp4' }));
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: fixture });
  await expect(page.getByLabel('Pending grants')).toHaveText('1');
});

test('releases a late capability when the preview unmounts before IPC resolves', async ({ page }) => {
  await page.getByRole('button', { name: 'Unmount preview' }).click();
  await page.getByRole('button', { name: 'Resolve grant' }).click();
  await expect(page.getByLabel('Released grants')).toHaveText('["https://preview.test/grant-1"]');
  await expect(page.locator('video')).toHaveCount(0);
});

test('keeps a remounted preview independent from its predecessors pending grant', async ({ page }) => {
  await page.getByRole('button', { name: 'Unmount preview' }).click();
  await page.getByRole('button', { name: 'Mount preview', exact: true }).click();
  await expect(page.getByLabel('Pending grants')).toHaveText('2');
  await page.getByRole('button', { name: 'Resolve grant' }).click();
  await expect(page.getByLabel('Released grants')).toHaveText('["https://preview.test/grant-1"]');
  await expect(page.getByText('Loading media…')).toBeVisible();
  await page.getByRole('button', { name: 'Resolve grant' }).click();
  await expect(page.getByLabel('Pending grants')).toHaveText('0');
  await expect(page.getByText('Loading media…')).toHaveCount(0);
  await page.getByRole('button', { name: 'Unmount preview' }).click();
  await expect(page.getByLabel('Released grants')).toHaveText('["https://preview.test/grant-1","https://preview.test/grant-2"]');
});
