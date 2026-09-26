import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

async function openAdvanced(page: Page) {
  await installElectronApiMock(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Remote Access', exact: true }).click();
  await page.getByTestId('settings-content').getByRole('button', { name: 'Advanced', exact: true }).click();
}

async function savePort(page: Page, port: string) {
  await page.getByLabel('Listen Port', { exact: true }).fill(port);
  await page.getByRole('button', { name: 'Apply Host Settings', exact: true }).click();
  await expect(page.getByText('Host settings saved.', { exact: true })).toBeVisible();
}

test('untouched base URLs follow repeated host saves without creating unsaved edits', async ({ page }, testInfo) => {
  await openAdvanced(page);
  await savePort(page, '43001');
  await expect(page.getByLabel('Remote Base URL', { exact: true })).toHaveValue('http://127.0.0.1:43001');
  await savePort(page, '43002');
  await expect(page.getByLabel('Remote Base URL', { exact: true })).toHaveValue('http://127.0.0.1:43002');
  await expect(page.getByLabel('Existing Remote Base URL', { exact: true })).toHaveValue('http://127.0.0.1:43002');
  await page.screenshot({ path: testInfo.outputPath('second-port-save.png') });
  await page.getByLabel('Existing Remote Base URL', { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('updated-base-urls.png') });
  await page.getByRole('button', { name: 'Back to Remote Access' }).click();
  await expect(page.getByRole('heading', { name: 'Remote Access', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Discard unsaved changes?' })).toBeHidden();
});

test('an explicitly edited URL survives later host saves, including a value equal to the original default', async ({ page }) => {
  await openAdvanced(page);
  await page.getByLabel('Remote Base URL', { exact: true }).fill('https://custom.example');
  // Fill with another value first so the second edit is a deliberate return to the default.
  await page.getByLabel('Existing Remote Base URL', { exact: true }).fill('https://temporary.example');
  await page.getByLabel('Existing Remote Base URL', { exact: true }).fill('http://127.0.0.1:42137');
  await savePort(page, '43003');
  await expect(page.getByLabel('Remote Base URL', { exact: true })).toHaveValue('https://custom.example');
  await expect(page.getByLabel('Existing Remote Base URL', { exact: true })).toHaveValue('http://127.0.0.1:42137');
  await page.getByRole('button', { name: 'Back to Remote Access' }).click();
  await expect(page.getByRole('dialog', { name: 'Discard unsaved changes?' })).toBeVisible();
  await page.getByRole('button', { name: 'Discard Changes', exact: true }).click();
  await page.getByTestId('settings-content').getByRole('button', { name: 'Advanced', exact: true }).click();
  await expect(page.getByLabel('Remote Base URL', { exact: true })).toHaveValue('http://127.0.0.1:43003');
});

test('a setup port deliberately restored to the default survives an unrelated host action', async ({ page }) => {
  await installElectronApiMock(page);
  await page.goto('/');
  await page.evaluate(() => window.electronAPI.remoteDaemon.updateHostConfig({ listenPort: 43004, enabled: true }));
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Remote Access', exact: true }).click();
  await page.getByTestId('settings-content').getByRole('button', { name: 'Set Up Host', exact: true }).click();
  await expect(page.getByLabel('Listen Port', { exact: true })).toHaveValue('43004');
  await page.getByLabel('Listen Port', { exact: true }).fill('42137');
  await page.getByRole('button', { name: 'Stop Host', exact: true }).click();
  await expect(page.getByText('Remote host stopped.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Listen Port', { exact: true })).toHaveValue('42137');
  await page.getByRole('button', { name: 'Back to Remote Access' }).click();
  await expect(page.getByRole('dialog', { name: 'Discard unsaved changes?' })).toBeVisible();
});
