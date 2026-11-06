import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';
import type { JsonObject } from '../shared/validation/boundaryDecoder';

// D-196: Settings › Autopilot › Your instructions.
const autopilotSnapshot = (state: 'stopped' | 'running'): JsonObject => ({
  enabled: true, chatTabsEnabled: true, entitlement: { entitled: true }, run: null, panelId: null, ownerPaneId: null,
  state, sentinel: false, stack: { entries: [], shownId: null }, walk: { sessions: [] },
});

const saves = (page: Page) => page.evaluate(() => {
  // SAFETY: installElectronApiMock defines this test-only object before the app loads.
  return (window as typeof window & { __paneTestElectronMock: { getAutopilotInstructionSaves: () => string[] } }).__paneTestElectronMock.getAutopilotInstructionSaves();
});

async function openAutopilotSettings(page: Page, state: 'stopped' | 'running', colorScheme: 'light' | 'dark' = 'light') {
  await page.emulateMedia({ colorScheme });
  await installElectronApiMock(page, { autopilotSnapshot: autopilotSnapshot(state), initialConfig: { appearanceMode: 'system' } });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await expect(page.getByTestId('settings-page')).toBeVisible();
  await page.getByRole('button', { name: 'Autopilot', exact: true }).click();
}

test('saving instructions while Autopilot is stopped says they apply on the next Start; Reset clears them', async ({ page }) => {
  await openAutopilotSettings(page, 'stopped');
  const status = page.getByTestId('autopilot-instructions-status');
  await expect(status).toHaveText('None yet');
  await expect(page.getByText(/can't override its hard limits/)).toBeVisible();
  await page.getByTestId('autopilot-instructions-text').fill('Group things by repo.\nBe brief.');
  await expect(status).toHaveText('Not saved');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(status).toHaveText('Applies on next Start');
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(status).toHaveText('None yet');
  await expect(page.getByTestId('autopilot-instructions-text')).toHaveValue('');
  expect(await saves(page)).toEqual(['Group things by repo.\nBe brief.', '']);
});

for (const scheme of ['light', 'dark'] as const) test(`while Autopilot runs a save is applied at once, and the built-in instructions show read-only (${scheme})`, async ({ page }, testInfo) => {
  await openAutopilotSettings(page, 'running', scheme);
  await page.getByTestId('autopilot-instructions-text').fill('Always ask before closing anything.\nFocus on Bloom first.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByTestId('autopilot-instructions-status')).toHaveText('Applied');
  await page.getByTestId('autopilot-builtin-toggle').click();
  await expect(page.getByTestId('autopilot-builtin')).toContainText('## Never');
  await page.screenshot({ path: testInfo.outputPath(`autopilot-settings-${scheme}.png`) });
});

test('Settings › Autopilot is not listed while Autopilot is off', async ({ page }) => {
  await installElectronApiMock(page, { autopilotSnapshot: { ...autopilotSnapshot('stopped'), enabled: false } });
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await expect(page.getByTestId('settings-page')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approvals', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Autopilot', exact: true })).toHaveCount(0);
});
