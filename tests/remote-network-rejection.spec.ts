import { expect, test } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

async function rejectUnhandled(page: import('@playwright/test').Page, message: string) {
  await page.evaluate((message) => {
    void Promise.reject(new Error(message));
  }, message);
  // Let the unhandledrejection event fire.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)));
}

test('losing the remote host after sleep does not raise the crash dialog', async ({ page }) => {
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await installElectronApiMock(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Collapse sidebar', exact: true })).toBeVisible();

  await rejectUnhandled(page, "Error invoking remote method 'daemon:invoke': Error: connect ENETUNREACH 100.115.240.77:443");
  expect(dialogs).toEqual([]);

  await rejectUnhandled(page, 'Something else broke');
  expect(dialogs).toHaveLength(1);
  expect(dialogs[0]).toContain('Something else broke');
});
