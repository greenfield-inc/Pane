import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';

/** Calls a Pane Cloud control on the mock: approvePaneCloud, joinPaneCloudTailnet or setPaneCloudCpuUsed. */
async function mock(page: Page, run: string) {
  await page.evaluate(`(window.__paneTestElectronMock).${run}`);
}

async function openCloudSandboxes(page: Page, theme = 'light-rounded') {
  await installElectronApiMock(page, { initialConfig: { theme, appearanceMode: 'fixed' }, workspaceAccess: { machineName: 'laptop' } });
  await page.goto('/');
  await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Remote Access', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Cloud sandboxes (experimental)' })).toBeVisible();
}

async function signIn(page: Page, access: 'invited' | 'waitlisted') {
  await page.getByRole('button', { name: 'Sign In with GitHub' }).click();
  await expect(page.getByLabel('One-time code')).toHaveText('WDJB-MJHT');
  await mock(page, `approvePaneCloud('alice', '${access}')`);
}

test.describe.configure({ timeout: 90_000 });

test('Pane Cloud is the first provider in Add cloud sandbox, and an invited account creates a machine that joins its tailnet', async ({ page }, testInfo) => {
  await openCloudSandboxes(page);
  const provider = page.getByRole('radiogroup', { name: 'Provider' });
  await expect(provider.getByRole('radio', { name: 'Pane Cloud' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('heading', { name: 'Cloud sandboxes (experimental)' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('pane-cloud-signed-out.png') });

  await page.getByRole('button', { name: 'Sign In with GitHub' }).click();
  await expect(page.getByLabel('One-time code')).toHaveText('WDJB-MJHT');
  await page.screenshot({ path: testInfo.outputPath('pane-cloud-device-code.png') });
  await mock(page, "approvePaneCloud('alice', 'invited')");
  await expect(page.getByText('Signed in as alice.')).toBeVisible();

  await page.getByLabel('Machine name').fill('dev');
  await page.getByRole('button', { name: 'Create Machine' }).click();
  const machine = page.getByRole('group', { name: 'Pane Cloud machine dev' });
  await expect(machine.getByText('Running')).toBeVisible();
  await expect(machine.getByRole('button', { name: 'Open Tailscale Login' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('pane-cloud-join-tailnet.png') });

  await mock(page, 'joinPaneCloudTailnet()');
  await expect(machine.getByRole('button', { name: 'Open Tailscale Login' })).toHaveCount(0);
  await expect(machine.getByText(/pane-mach-1\.tail1234\.ts\.net/)).toBeVisible();
  // The joined machine is a saved host like any other: it shows in the machine switcher.
  const saved = await page.evaluate(() => window.electronAPI.remoteDaemon.getConfig().then((response) => response.data?.client.profiles.map((profile) => profile.paneCloud?.machineId)));
  expect(saved).toEqual(['mach_1']);
});

test('a waitlisted account is told it is on the list and offered no machine', async ({ page }) => {
  await openCloudSandboxes(page);
  await signIn(page, 'waitlisted');
  await expect(page.getByText("You're on the list.", { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create Machine' })).toHaveCount(0);
});

test('the machine page shows the daily CPU budget and every operation with who asked and why', async ({ page }, testInfo) => {
  await openCloudSandboxes(page);
  await signIn(page, 'invited');
  await page.getByRole('button', { name: 'Create Machine' }).click();
  await mock(page, 'joinPaneCloudTailnet()');
  await mock(page, 'setPaneCloudCpuUsed(43200)');

  await page.getByRole('group', { name: 'Pane Cloud machine dev' }).getByRole('button', { name: 'Details' }).click();
  await expect(page.getByRole('heading', { name: 'pane-mach-1' })).toBeVisible();
  await expect(page.getByText('12 of 12 vCPU-hours today')).toBeVisible();
  await expect(page.getByText(/Daily CPU budget used/)).toBeVisible();

  await page.getByRole('button', { name: 'Stop' }).click();
  const actions = page.getByRole('list', { name: 'Recent actions' }).getByRole('listitem');
  await expect(actions.first()).toContainText('Stopped');
  await expect(actions.first()).toContainText('By you');
  await expect(actions).toHaveCount(3);
  await expect(actions.nth(1)).toContainText('By Pane Cloud');
  await page.screenshot({ path: testInfo.outputPath('pane-cloud-machine-page.png'), fullPage: true });
});

for (const theme of ['light-rounded', 'dark']) {
  test(`screenshots: Pane Cloud in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await openCloudSandboxes(page, theme);
    await signIn(page, 'invited');
    await page.getByRole('button', { name: 'Create Machine' }).click();
    await page.getByRole('heading', { name: 'Cloud sandboxes (experimental)' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`pane-cloud-settings-${theme}.png`) });
    await mock(page, 'joinPaneCloudTailnet()');
    await mock(page, 'setPaneCloudCpuUsed(12600)');
    await page.getByRole('group', { name: 'Pane Cloud machine dev' }).getByRole('button', { name: 'Details' }).click();
    await expect(page.getByText('3.5 of 12 vCPU-hours today')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`pane-cloud-machine-${theme}.png`), fullPage: true });
  });
}
