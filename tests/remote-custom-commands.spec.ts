import { expect, test } from '@playwright/test';
import { emitRemoteHostEvent, openConnectedRemotePwa, setRemoteHostCustomCommands } from './remotePwaMock';

// `runpane custom-commands` (or the host's desktop) changes the host's launch commands while a
// phone is connected: the host sends the value-free `remote:settings-changed`, and the phone
// refetches its Add tool choices without reconnecting.

test('a phone shows the host\'s custom commands after the host changes them', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openConnectedRemotePwa(page);
  const addTool = page.getByRole('button', { name: 'Add tool' });
  const menuItems = page.getByRole('menuitem');

  await addTool.click();
  await expect(menuItems.filter({ hasText: 'Codex' }).first()).toBeVisible();
  await expect(menuItems.filter({ hasText: 'Build all' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  setRemoteHostCustomCommands(page, [
    { name: 'Build all', command: 'pnpm build' },
    { name: 'Codex', command: 'codex' },
  ]);
  await emitRemoteHostEvent(page, 'remote:settings-changed');

  await addTool.click();
  await expect(menuItems.filter({ hasText: 'Build all' })).toContainText('pnpm build');
});
