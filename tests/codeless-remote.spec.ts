import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';
import type { TailnetMachineList } from '../shared/types/workspaceAccess';

const tailnetMachines: TailnetMachineList = {
  ok: true,
  tailnet: 'parsa.github',
  domain: 'tail1234.ts.net',
  machines: [
    { name: 'studio-mac', dnsName: 'studio-mac.tail1234.ts.net', os: 'macOS', ownerLogin: 'parsa@github', mine: true, state: 'available', visibility: 'owner', paneVersion: '2.5.0' },
    { name: 'old-laptop', dnsName: 'old-laptop.tail1234.ts.net', os: 'macOS', ownerLogin: 'parsa@github', mine: true, state: 'outdated' },
    { name: 'linux-box', dnsName: 'linux-box.tail1234.ts.net', os: 'Linux', ownerLogin: 'parsa@github', mine: true, state: 'offline' },
    { name: 'team-builder', dnsName: 'team-builder.tail1234.ts.net', os: 'Windows', ownerLogin: 'teammate@github', mine: false, state: 'password-required' },
  ],
};

async function openRemoteAccess(page: Page, options: { remoteConnectError?: string } = {}) {
  await installElectronApiMock(page, { tailnetMachines, ...options });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.locator('[data-testid="sidebar"]').first()).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Remote Access', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Remote Access', exact: true })).toBeVisible();
}

test.describe('Codeless remote access', () => {
  test('lists my machines and connects to one without a code', async ({ page }) => {
    await openRemoteAccess(page);
    await expect(page.getByText('On parsa.github')).toBeVisible();
    const studio = page.getByTestId('tailnet-machine-studio-mac');
    await expect(studio).toContainText('Ready');
    await expect(studio.getByRole('img', { name: 'macOS' })).toBeVisible();
    await expect(page.getByTestId('tailnet-machine-team-builder').getByRole('img', { name: 'Windows' })).toBeVisible();
    await expect(page.getByTestId('tailnet-machine-linux-box').getByRole('button', { name: 'Connect' })).toBeDisabled();
    await expect(page.getByTestId('tailnet-machine-team-builder')).toContainText('Needs password · teammate@github');
    await page.screenshot({ path: 'test-results/codeless-remote/01-machines.png', fullPage: true });

    await page.getByRole('button', { name: 'Add with a Code' }).click();
    await expect(page.getByLabel('Connection Code')).toBeVisible();
    await page.screenshot({ path: 'test-results/codeless-remote/07-add-with-code.png', fullPage: true });
    await page.getByRole('button', { name: 'Cancel' }).click();

    await studio.getByRole('button', { name: 'Connect' }).click();
    await expect(studio.getByRole('button', { name: 'Connected' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Use This Computer' })).toBeVisible();
    await page.screenshot({ path: 'test-results/codeless-remote/02-connected.png', fullPage: true });
  });

  test('keeps Connect available when a connection fails, so it can be retried', async ({ page }) => {
    await openRemoteAccess(page, { remoteConnectError: 'studio-mac did not answer.' });
    const studio = page.getByTestId('tailnet-machine-studio-mac');
    await studio.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByText('studio-mac did not answer.')).toBeVisible();
    await expect(studio.getByRole('button', { name: 'Connect' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Use This Computer' })).toBeVisible();
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
    const visibility = page.getByRole('radiogroup', { name: 'Who can connect to this computer' });
    await expect(visibility.getByRole('radio', { name: 'Only me' })).toHaveAttribute('aria-checked', 'true');

    await visibility.getByRole('radio', { name: 'Everyone on tailnet' }).click();
    const warning = page.getByRole('alert').filter({ hasText: 'Anyone on parsa.github can connect' });
    await expect(warning).toBeVisible();
    await warning.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/codeless-remote/04-visibility-warning.png', fullPage: true });

    await warning.getByRole('button', { name: 'Cancel' }).click();
    await expect(visibility.getByRole('radio', { name: 'Only me' })).toHaveAttribute('aria-checked', 'true');

    await visibility.getByRole('radio', { name: 'Everyone on tailnet' }).click();
    await page.getByRole('button', { name: 'Allow Everyone' }).click();
    await expect(visibility.getByRole('radio', { name: 'Everyone on tailnet' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('Anyone on this tailnet.')).toBeVisible();
  });

  test('turns password protection on and off', async ({ page }) => {
    await openRemoteAccess(page);
    await page.getByRole('button', { name: 'Set Password' }).click();
    await page.getByLabel('Password', { exact: true }).fill('short');
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
    await page.getByLabel('Password', { exact: true }).fill('correct horse battery');
    await page.screenshot({ path: 'test-results/codeless-remote/05-set-password.png', fullPage: true });
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('On. Every device enters it to connect.')).toBeVisible();
    await page.screenshot({ path: 'test-results/codeless-remote/06-password-on.png', fullPage: true });

    await page.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByText('Ask every device for a password.')).toBeVisible();
  });
});
