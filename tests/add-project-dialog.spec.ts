import { expect, test } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

for (const transportFailure of [false, true]) {
  test(`repository creation failure stays visible with the form: transport=${transportFailure}`, async ({ page }, testInfo) => {
    await installElectronApiMock(page, { initialProjects: [], initialSessions: [] });
    await page.addInitScript((reject) => {
      window.electronAPI.projects.detectBranch = async () => ({ success: true, data: 'main' });
      window.electronAPI.projects.create = async () => {
        if (reject) throw new Error('Repository path is not accessible');
        return { success: false, error: 'Repository path is not accessible' };
      };
    }, transportFailure);
    await page.goto('/');
    await page.getByRole('button', { name: 'Add repository', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByPlaceholder('Enter project name').fill('My repository');
    await dialog.getByPlaceholder('/path/to/your/repository').fill('/tmp/my-repository');
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Repository path is not accessible');
    await expect(dialog.getByPlaceholder('Enter project name')).toHaveValue('My repository');
    await expect(dialog.getByPlaceholder('/path/to/your/repository')).toHaveValue('/tmp/my-repository');
    await page.screenshot({ path: testInfo.outputPath('creation-error.png') });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Add repository', exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
  });
}

for (const staleFailure of [false, true]) {
  test(`branch detection keeps the latest path result: stale failure=${staleFailure}`, async ({ page }, testInfo) => {
    await installElectronApiMock(page, { initialProjects: [], initialSessions: [] });
    await page.addInitScript((rejectOld) => {
      window.electronAPI.projects.detectBranch = async (path) => {
        if (path === '/tmp/old') {
          await new Promise<void>(resolve => window.addEventListener('finish-old-branch', () => resolve(), { once: true }));
          if (rejectOld) throw new Error('Old path not found');
          return { success: true, data: 'old-branch' };
        }
        return { success: true, data: 'current-branch' };
      };
    }, staleFailure);
    await page.goto('/');
    await page.getByRole('button', { name: 'Add repository', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const path = dialog.getByPlaceholder('/path/to/your/repository');
    await path.fill('/tmp/old');
    await expect(dialog.getByText('Detecting...', { exact: true })).toBeVisible();
    await path.fill('/tmp/current');
    await expect(dialog.getByText('current-branch', { exact: true })).toBeVisible();
    await page.evaluate(async () => {
      window.dispatchEvent(new Event('finish-old-branch'));
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    await expect(dialog.getByText('current-branch', { exact: true })).toBeVisible();
    await expect(dialog.getByText('old-branch', { exact: true })).toHaveCount(0);
    await expect(dialog.getByText('Could not detect a git branch', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('latest-path-branch.png') });
  });
}

test('a failed creation from a closed dialog does not appear in the next dialog', async ({ page }) => {
  await installElectronApiMock(page, { initialProjects: [], initialSessions: [] });
  await page.addInitScript(() => {
    window.electronAPI.projects.create = async () => {
      await new Promise<void>(resolve => window.addEventListener('finish-old-create', () => resolve(), { once: true }));
      return { success: false, error: 'Old repository creation failed' };
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Add repository', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder('Enter project name').fill('Old repository');
  await dialog.getByPlaceholder('/path/to/your/repository').fill('/tmp/old');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Add repository', exact: true }).click();
  await dialog.getByPlaceholder('Enter project name').fill('New repository');
  await page.evaluate(async () => {
    window.dispatchEvent(new Event('finish-old-create'));
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await expect(dialog.getByPlaceholder('Enter project name')).toHaveValue('New repository');
});
