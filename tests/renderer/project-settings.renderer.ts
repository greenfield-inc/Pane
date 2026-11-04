import { expect, test } from '@playwright/test';

declare global {
  interface Window { projectSettingsTest: { show: (key: 'a' | 'b') => void; updates: () => Array<{ projectId: string; updates: object }> } }
}

test('an open Project Settings dialog that switches project drops the edit made for the first one', async ({ page }) => {
  await page.goto('/renderer-tests/project-settings.html');
  const runScript = page.getByPlaceholder('npm run dev');
  await expect(runScript).toHaveValue('pnpm dev');
  await expect(page.getByText('main-a')).toBeVisible();
  await runScript.fill('pnpm dev --edited-for-a');

  await page.evaluate(() => window.projectSettingsTest.show('b'));
  await expect(runScript).toHaveValue('cargo run');
  await expect(page.getByText('main-b')).toBeVisible();

  await page.getByRole('button', { name: 'Save Changes' }).first().click();
  expect(await page.evaluate(() => window.projectSettingsTest.updates())).toEqual([]);
});
