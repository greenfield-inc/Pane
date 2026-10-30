import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock } from './electronApiMock';
import type { TailnetMachineList } from '../shared/types/workspaceAccess';

const tailnetMachines: TailnetMachineList = {
  ok: true,
  tailnet: 'parsa.github',
  domain: 'tail1234.ts.net',
  machines: [
    { name: 'studio-mac', dnsName: 'studio-mac.tail1234.ts.net', url: 'https://studio-mac.tail1234.ts.net:8443', os: 'macOS', ownerLogin: 'parsa@github', mine: true, state: 'available', visibility: 'owner', paneVersion: '2.5.0' },
    { name: 'old-laptop', dnsName: 'old-laptop.tail1234.ts.net', url: 'https://old-laptop.tail1234.ts.net:8443', os: 'macOS', ownerLogin: 'parsa@github', mine: true, state: 'outdated' },
    { name: 'linux-box', dnsName: 'linux-box.tail1234.ts.net', url: 'https://linux-box.tail1234.ts.net:8443', os: 'Linux', ownerLogin: 'parsa@github', mine: true, state: 'offline' },
    { name: 'team-builder', dnsName: 'team-builder.tail1234.ts.net', url: 'https://team-builder.tail1234.ts.net:8443', os: 'Windows', ownerLogin: 'teammate@github', mine: false, state: 'password-required' },
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

test.describe('Remote Access', () => {
  test('lists every machine and connects to one without a code', async ({ page }) => {
    await openRemoteAccess(page);
    await expect(page.getByTestId('active-machine')).toContainText('devbox');
    await expect(page.getByTestId('active-machine')).toContainText('Linux · This computer · Agents run here');
    await expect(page.getByText('On parsa.github')).toBeVisible();
    const studio = page.getByTestId('machine-studio-mac');
    await expect(studio).toContainText('macOS · Ready · Never connected');
    await expect(page.getByTestId('machine-linux-box').getByRole('button', { name: /^Switch/ })).toHaveCount(0);
    await expect(page.getByTestId('machine-team-builder')).toContainText('Needs password · Never connected · teammate@github');
    await page.screenshot({ path: 'test-results/codeless-remote/01-machines.png', fullPage: true });

    await page.getByRole('button', { name: 'Add a machine' }).click();
    await expect(page.getByLabel('Connection Code')).toBeVisible();
    await page.screenshot({ path: 'test-results/codeless-remote/07-add-with-code.png', fullPage: true });
    await page.getByRole('button', { name: 'Cancel' }).click();

    await studio.getByRole('button', { name: 'Switch to studio-mac' }).click();
    const active = page.getByTestId('active-machine');
    await expect(active).toContainText('studio-mac');
    await expect(active).toContainText('macOS · Agents run here · Connected over Tailscale');
    await page.screenshot({ path: 'test-results/codeless-remote/02-connected.png', fullPage: true });

    await active.getByRole('button', { name: 'Switch back to devbox' }).click();
    await expect(active).toContainText('Linux · This computer · Agents run here');
    await expect(page.getByTestId('machine-studio-mac')).toContainText('macOS · Ready');
    await expect(page.getByTestId('machine-studio-mac')).not.toContainText('Never connected');
  });

  test('keeps a failed connection retryable', async ({ page }) => {
    await openRemoteAccess(page, { remoteConnectError: 'studio-mac did not answer.' });
    await page.getByTestId('machine-studio-mac').getByRole('button', { name: 'Switch to studio-mac' }).click();
    const active = page.getByTestId('active-machine');
    await expect(active).toContainText('studio-mac did not answer.');
    await expect(active).toContainText('Connection failed · Retry');
    await expect(active.getByRole('button', { name: 'Retry' })).toBeEnabled();
    await expect(active.getByRole('button', { name: 'Switch back to devbox' })).toBeVisible();
  });

  test('asks for the password of a protected machine', async ({ page }) => {
    await openRemoteAccess(page);
    const builder = page.getByTestId('machine-team-builder');
    await builder.getByRole('button', { name: 'Switch to team-builder' }).click();
    await builder.getByLabel('Password for team-builder').fill('correct horse');
    await page.screenshot({ path: 'test-results/codeless-remote/03-password-prompt.png', fullPage: true });
    await builder.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByTestId('active-machine')).toContainText('Windows · Agents run here');
  });

  test('repairs the active machine\'s password from its card', async ({ page }) => {
    await openRemoteAccess(page, { remoteConnectError: 'team-builder refused the password.' });
    const builder = page.getByTestId('machine-team-builder');
    await builder.getByRole('button', { name: 'Switch to team-builder' }).click();
    await builder.getByLabel('Password for team-builder').fill('wrong horse');
    await builder.getByRole('button', { name: 'Connect' }).click();

    const active = page.getByTestId('active-machine');
    await expect(active).toContainText('Windows · Needs password');
    await active.getByRole('button', { name: 'Enter password' }).click();
    const field = active.getByLabel('Password for team-builder');
    await expect(field).toBeFocused();
    await field.fill('correct horse');
    await page.screenshot({ path: 'test-results/codeless-remote/09-active-password.png', fullPage: true });
    await active.getByRole('button', { name: 'Connect' }).click();
    await expect(active).toContainText('team-builder refused the password.');
  });

  test('shows a machine\'s details and forgets a saved one', async ({ page }) => {
    await openRemoteAccess(page);
    await page.getByTestId('machine-studio-mac').getByRole('button', { name: 'Switch to studio-mac' }).click();
    await page.getByTestId('active-machine').getByRole('button', { name: 'studio-mac details' }).click();
    await expect(page.getByRole('heading', { name: 'studio-mac' })).toBeVisible();
    await expect(page.getByText('studio-mac.tail1234.ts.net', { exact: true })).toBeVisible();
    await expect(page.getByText('2.5.0', { exact: true })).toBeVisible();
    await expect(page.getByText('Marks studio-mac everywhere in Pane, on this computer and your phone.')).toBeVisible();
    await page.screenshot({ path: 'test-results/codeless-remote/08-machine-details.png', fullPage: true });

    await page.getByRole('button', { name: 'Forget studio-mac' }).click();
    await expect(page.getByRole('heading', { name: 'Remote Access', exact: true })).toBeVisible();
    await expect(page.getByTestId('machine-studio-mac')).toContainText('Never connected');
  });

  test('defaults to "Only me" and warns before widening to the whole tailnet', async ({ page }) => {
    await openRemoteAccess(page);
    await expect(page.getByRole('heading', { name: /^Access/ })).toHaveText('Accesson devbox');
    const visibility = page.getByRole('radiogroup', { name: 'Who can connect to this computer' });
    await expect(visibility.getByRole('radio', { name: 'Only me' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText('devbox.tail1234.ts.net', { exact: true })).toBeVisible();

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
    await expect(page.getByText('Off. Your own devices connect without one.')).toBeVisible();
  });

  test('allows a refused glasses origin only when it is clicked', async ({ page }) => {
    await installElectronApiMock(page, {
      tailnetMachines,
      glasses: {
        devices: [{ id: 'g2', label: 'Even G2', createdAt: '2026-10-29T08:00:00.000Z', lastUsedAt: '2026-10-29T09:14:00.000Z' }],
        allowedOrigins: [],
        refusedOrigins: [{ origin: 'https://even.example', at: '2026-10-29T09:00:00.000Z' }],
      },
    });
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await page.getByRole('button', { name: 'Remote Access', exact: true }).click();
    const glasses = page.locator('[data-setting-id="remote-glasses"]');
    await expect(glasses).toContainText('Even G2');
    await expect(glasses).toContainText('Refused');
    await glasses.getByRole('button', { name: 'Allow' }).click();
    await expect(glasses).toContainText('Allowed for glasses on this computer.');
    await glasses.getByRole('button', { name: 'Revoke Even G2' }).click();
    await expect(glasses.getByRole('button', { name: 'Revoke Even G2' })).toHaveCount(0);
  });

  test('revokes glasses on all my computers and names the ones it did not reach', async ({ page }) => {
    await installElectronApiMock(page, {
      tailnetMachines,
      glasses: {
        devices: [{ id: 'g2', label: 'Even G2 · Parsa\'s iPhone', phoneId: 'pane-native-a', createdAt: '2026-10-29T08:00:00.000Z', lastUsedAt: '2026-10-29T09:14:00.000Z' }],
        allowedOrigins: [],
        refusedOrigins: [],
      },
      glassesRevokeEverywhere: { revoked: ['Mac', 'devbox'], notReached: [{ name: 'laptop', reason: 'offline' }] },
    });
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await page.getByRole('button', { name: 'Remote Access', exact: true }).click();
    const glasses = page.locator('[data-setting-id="remote-glasses"]');
    await glasses.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/codeless-remote/glasses-revoke-everywhere-before.png', fullPage: true });
    await glasses.getByRole('button', { name: 'Revoke Even G2 · Parsa\'s iPhone on all my computers' }).click();
    await expect(glasses.getByRole('status')).toHaveText('Revoked on Mac, devbox. Not reached: laptop (offline); revoke there when it is back.');
    await expect(glasses).toContainText('Pair from the Pane phone app');
    await expect(glasses.getByRole('button', { name: 'Retry on my other computers' })).toBeVisible();
    await page.screenshot({ path: 'test-results/codeless-remote/glasses-revoke-everywhere-after.png', fullPage: true });
  });
});
