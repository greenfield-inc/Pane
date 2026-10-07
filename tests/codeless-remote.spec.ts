import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';
import type { TailnetMachineList } from '../shared/types/workspaceAccess';

const tailnetMachines: TailnetMachineList = {
  ok: true,
  tailnet: 'parsa.github',
  machines: [
    { name: 'studio-mac', dnsName: 'studio-mac.tail1234.ts.net', os: 'macOS', ownerLogin: 'parsa@github', mine: true, state: 'available', visibility: 'owner', paneVersion: '2.5.0' },
    { name: 'old-laptop', dnsName: 'old-laptop.tail1234.ts.net', os: 'macOS', ownerLogin: 'parsa@github', mine: true, state: 'outdated' },
    { name: 'linux-box', dnsName: 'linux-box.tail1234.ts.net', os: 'Linux', ownerLogin: 'parsa@github', mine: true, state: 'offline' },
    { name: 'team-builder', dnsName: 'team-builder.tail1234.ts.net', os: 'Windows', ownerLogin: 'teammate@github', mine: false, state: 'password-required' },
  ],
};

async function openRemoteAccess(page: Page) {
  await installElectronApiMock(page, { tailnetMachines });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Remote Access', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Remote Access', exact: true })).toBeVisible();
}

test.describe('Codeless remote access', () => {
  test('lists my machines and connects to one without a code', async ({ page }) => {
    await openRemoteAccess(page);
    await expect(page.getByText('Machines on parsa.github')).toBeVisible();
    const studio = page.getByTestId('tailnet-machine-studio-mac');
    await expect(studio).toContainText('Visible to its owner only');
    await expect(page.getByTestId('tailnet-machine-linux-box').getByRole('button', { name: 'Connect' })).toBeDisabled();
    await expect(page.getByTestId('tailnet-machine-team-builder')).toContainText("teammate@github's machine");
    await page.screenshot({ path: 'test-results/codeless-remote/01-machines.png', fullPage: true });

    await studio.getByRole('button', { name: 'Connect' }).click();
    await expect(studio.getByRole('button', { name: 'Connected' })).toBeVisible();
    await page.screenshot({ path: 'test-results/codeless-remote/02-connected.png', fullPage: true });
  });

  test('asks for the password of a protected machine', async ({ page }) => {
    await openRemoteAccess(page);
    const builder = page.getByTestId('tailnet-machine-team-builder');
    await builder.getByRole('button', { name: 'Connect' }).click();
    await builder.getByLabel('Password for team-builder').fill('correct horse');
    await page.screenshot({ path: 'test-results/codeless-remote/03-password-prompt.png', fullPage: true });
    await builder.getByRole('button', { name: 'Connect' }).click();
    await expect(builder.getByRole('button', { name: 'Connected' })).toBeVisible();
  });

  test('defaults to "Only me" and warns before widening to the whole tailnet', async ({ page }) => {
    await openRemoteAccess(page);
    const visibility = page.getByRole('radiogroup', { name: 'Who can connect to this machine' });
    await expect(visibility.getByRole('radio', { name: 'Only me' })).toHaveAttribute('aria-checked', 'true');

    await visibility.getByRole('radio', { name: 'Everyone on this tailnet' }).click();
    const warning = page.getByRole('alert').filter({ hasText: 'Everyone on parsa.github will be able to connect' });
    await expect(warning).toBeVisible();
    await warning.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/codeless-remote/04-visibility-warning.png', fullPage: true });

    await warning.getByRole('button', { name: 'Cancel' }).click();
    await expect(visibility.getByRole('radio', { name: 'Only me' })).toHaveAttribute('aria-checked', 'true');

    await visibility.getByRole('radio', { name: 'Everyone on this tailnet' }).click();
    await page.getByRole('button', { name: 'Make Visible to Everyone' }).click();
    await expect(visibility.getByRole('radio', { name: 'Everyone on this tailnet' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('Everyone on this tailnet can connect to devbox.')).toBeVisible();
  });

  test('turns password protection on and off', async ({ page }) => {
    await openRemoteAccess(page);
    await page.getByRole('button', { name: 'Set Password' }).click();
    await page.getByLabel('New password').fill('short');
    await expect(page.getByRole('button', { name: 'Save Password' })).toBeDisabled();
    await page.getByLabel('New password').fill('correct horse battery');
    await page.screenshot({ path: 'test-results/codeless-remote/05-set-password.png', fullPage: true });
    await page.getByRole('button', { name: 'Save Password' }).click();
    await expect(page.getByText('Password protection is on')).toBeVisible();
    await page.screenshot({ path: 'test-results/codeless-remote/06-password-on.png', fullPage: true });

    await page.getByRole('button', { name: 'Turn Off' }).click();
    await expect(page.getByText('Password protection is on')).toHaveCount(0);
  });
});
