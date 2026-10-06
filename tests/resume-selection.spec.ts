import { expect, test } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

declare global {
  interface Window {
    resumeSelectionCalls: { resumed: string[][]; dismissed: string[][] };
  }
}

test('interrupted panes start selected and the user can resume a subset', async ({ page }, testInfo) => {
  await installElectronApiMock(page);
  await page.addInitScript(() => {
    const resumed: string[][] = [];
    const dismissed: string[][] = [];
    window.electronAPI.sessions.getResumable = async () => ({
      success: true,
      data: [
        { sessionId: 'first', sessionName: 'First task', panels: [] },
        { sessionId: 'second', sessionName: 'Second task', panels: [] },
      ],
    });
    window.electronAPI.sessions.resumeInterrupted = async (ids: string[]) => {
      resumed.push(ids);
      return { success: true };
    };
    window.electronAPI.sessions.dismissInterrupted = async (ids: string[]) => {
      dismissed.push(ids);
      return { success: true };
    };
    Object.assign(window, { resumeSelectionCalls: { resumed, dismissed } });
  });
  await page.goto('/');
  const dialog = page.getByRole('dialog', { name: 'Resume Previous Panes' });
  await expect(dialog.getByRole('checkbox', { name: 'First task' })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Second task' })).toBeChecked();
  await dialog.getByRole('checkbox', { name: 'Second task' }).uncheck();
  await page.screenshot({ path: testInfo.outputPath('resume-selected.png') });
  await dialog.getByRole('button', { name: 'Resume Selected (1)' }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(() => page.evaluate(() => window.resumeSelectionCalls)).toEqual({
    resumed: [['first']], dismissed: [['second']],
  });
});
