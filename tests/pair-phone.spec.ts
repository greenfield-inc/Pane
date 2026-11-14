import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import type { RemoteDaemonClientRecord } from '../shared/types/remoteDaemon';
import type { RelayStatus } from '../shared/types/relay';
import { installElectronApiMock, type ElectronApiMockOptions } from './electronApiMock';

type PairTestWindow = Window & {
  __paneTestElectronMock: {
    getInvokeCalls(channel: string): Array<{ args: unknown[] }>;
    emitRelayPaired(clientId: string, label: string): void;
    emitRelayStatus(updates: Partial<RelayStatus>): void;
  };
};

/** Set PANE_QR_SHOTS to a folder to keep a screenshot of each state. */
const SHOTS = process.env.PANE_QR_SHOTS;
const THEMES = { light: 'light-rounded', dark: 'dark' } as const;

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

const calls = (page: Page, channel: string) =>
  // SAFETY: installElectronApiMock installs __paneTestElectronMock before navigation.
  page.evaluate((name) => (window as PairTestWindow).__paneTestElectronMock.getInvokeCalls(name).map((call) => call.args), channel);

async function openHome(page: Page, options: ElectronApiMockOptions = {}, theme: keyof typeof THEMES = 'dark') {
  await installElectronApiMock(page, {
    initialProjects: [],
    initialSessions: [],
    initialPreferences: { hide_discord: 'true' },
    initialConfig: { theme: THEMES[theme], appearanceMode: 'fixed' },
    ...options,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  for (const name of ['No thanks', 'Get Started', 'Skip']) {
    const button = page.getByRole('dialog').getByRole('button', { name, exact: true });
    if (await button.isVisible({ timeout: 1500 }).catch(() => false)) await button.click();
  }
  await expect(page.getByRole('heading', { name: 'Use Pane on your phone' })).toBeVisible();
}

async function openPairDialog(page: Page) {
  await page.getByRole('button', { name: 'Pair a phone' }).click();
  const dialog = page.getByRole('dialog', { name: 'Pair a phone' });
  await expect(dialog).toBeVisible();
  return dialog;
}

const qr = (page: Page) => page.getByRole('dialog', { name: 'Pair a phone' }).getByRole('img', { name: 'Pairing code' });

for (const theme of ['light', 'dark'] as const) {
  test(`Home's card opens Pair a phone, which turns phone access on and shows a code (${theme})`, async ({ page }) => {
    await openHome(page, {}, theme);
    await shot(page, `home-card-${theme}`);
    const dialog = await openPairDialog(page);
    await expect(qr(page)).toHaveAttribute('data-url', 'https://pane.example/pair#s=secret-1&c=k7q2m9&n=devbox');
    await expect(dialog).toContainText(/Expires in (10:00|9:5\d) · works once/);
    expect(await calls(page, 'relay:set-enabled')).toEqual([[true]]);
    await shot(page, `dialog-code-${theme}`);
  });
}

test('a used code shows who paired and a new code', async ({ page }) => {
  await openHome(page);
  const dialog = await openPairDialog(page);
  await expect(qr(page)).toHaveAttribute('data-url', /secret-1/);
  // SAFETY: installElectronApiMock installs __paneTestElectronMock before navigation.
  await page.evaluate(() => (window as PairTestWindow).__paneTestElectronMock.emitRelayPaired('phone-1', "Sam's iPhone"));
  await expect(dialog).toContainText("Paired with Sam's iPhone");
  await expect(qr(page)).toHaveAttribute('data-url', /secret-2/);
  await expect(dialog).toContainText(/New code · expires in/);
  await shot(page, 'dialog-paired-dark');
});

test('an expired code is replaced by a new one', async ({ page }) => {
  await openHome(page, { relay: { codeTtlMs: 2_000 } });
  await openPairDialog(page);
  await expect(qr(page)).toHaveAttribute('data-url', /secret-1/);
  await expect(qr(page)).toHaveAttribute('data-url', /secret-2/, { timeout: 5_000 });
  await expect(page.getByRole('dialog', { name: 'Pair a phone' })).toContainText(/New code · expires in 0:0\d/);
});

test('waits while this computer gets ready, then shows the code', async ({ page }) => {
  await openHome(page, { relay: { phaseWhenOn: 'certificate' } });
  const dialog = await openPairDialog(page);
  await expect(dialog.getByRole('status').filter({ hasText: 'Getting this computer ready…' })).toBeVisible();
  await shot(page, 'dialog-preparing-dark');
  // SAFETY: installElectronApiMock installs __paneTestElectronMock before navigation.
  await page.evaluate(() => (window as PairTestWindow).__paneTestElectronMock.emitRelayStatus({ phase: 'ready' }));
  await expect(qr(page)).toBeVisible();
});

test('a computer that cannot reach the relay says why and retries', async ({ page }) => {
  await openHome(page, { relay: { phaseWhenOn: 'error', lastError: "Pane's servers didn't answer from us.relay.pane.example, so phones can't reach this computer yet." } });
  const dialog = await openPairDialog(page);
  await expect(dialog.getByRole('alert')).toContainText("Pane's servers didn't answer from us.relay.pane.example");
  await shot(page, 'dialog-error-dark');
  await dialog.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(async () => (await calls(page, 'relay:set-enabled')).length).toBe(2);
});

const PHONE: RemoteDaemonClientRecord = { id: 'phone-1', label: "Sam's iPhone", createdAt: '2026-11-01T10:00:00Z', tokenHash: 'h1', phoneId: 'install-1', lastUsedAt: '2026-11-12T10:00:00Z' };
const LAPTOP: RemoteDaemonClientRecord = { id: 'computer-1', label: 'Travel Laptop', createdAt: '2026-11-02T10:00:00Z', tokenHash: 'h2', kind: 'computer', computerId: 'p4x8n2', linkedBy: "Sam's iPhone" };

async function openRemoteAccess(page: Page, options: ElectronApiMockOptions = {}, theme: keyof typeof THEMES = 'dark') {
  await openHome(page, { hostClients: [PHONE, LAPTOP], ...options }, theme);
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Remote Access', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Remote Access', exact: true })).toBeVisible();
}

for (const theme of ['light', 'dark'] as const) {
  test(`Remote Access lists phones and linked computers (${theme})`, async ({ page }) => {
    await openRemoteAccess(page, {}, theme);
    await expect(page.getByText("Sam's iPhone").first()).toBeVisible();
    await expect(page.getByTestId('linked-Travel Laptop')).toContainText("Linked by Sam's iPhone");
    await page.getByRole('heading', { name: 'Devices' }).evaluate((heading) => heading.scrollIntoView({ block: 'start' }));
    await shot(page, `settings-devices-${theme}`);
    await page.getByRole('button', { name: "Remove Sam's iPhone" }).click();
    await expect(page.getByRole('menuitem', { name: /Remove from all your computers/ })).toBeVisible();
    await shot(page, `settings-remove-menu-${theme}`);
  });
}

test('Remove from all your computers removes the phone everywhere and says where it could not', async ({ page }) => {
  await openRemoteAccess(page, { relay: { everywhere: { removed: ['devbox', 'Travel Laptop'], notReached: ['Build Box'] } } });
  await page.getByRole('button', { name: "Remove Sam's iPhone" }).click();
  await page.getByRole('menuitem', { name: /Remove from all your computers/ }).click();
  await expect(page.getByRole('status').filter({ hasText: "Removed Sam's iPhone from devbox and Travel Laptop." })).toContainText("Build Box didn't answer");
  expect(await calls(page, 'relay:remove-phone-everywhere')).toEqual([[{ clientId: 'phone-1' }]]);
  await expect(page.getByRole('button', { name: "Remove Sam's iPhone" })).toHaveCount(0);
  await shot(page, 'settings-removed-dark');
});

test('Unlink from all your computers unlinks the computer', async ({ page }) => {
  await openRemoteAccess(page);
  await page.getByRole('button', { name: 'Unlink Travel Laptop' }).click();
  await page.getByRole('menuitem', { name: /Unlink from all your computers/ }).click();
  await expect.poll(() => calls(page, 'relay:unlink-computer-everywhere')).toEqual([[{ computerId: 'p4x8n2' }]]);
  await expect(page.getByTestId('linked-Travel Laptop')).toHaveCount(0);
});

test('Relay address saves on Enter or leaving the field, and a bad one says how to fix it', async ({ page }) => {
  await openRemoteAccess(page);
  const field = page.getByRole('textbox', { name: 'Relay address' });
  await field.evaluate((input) => input.scrollIntoView({ block: 'center' }));
  await field.fill('not a host!');
  await field.press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: 'is not a relay address' })).toContainText('Enter a host name');
  await shot(page, 'settings-relay-address-error-dark');
  await field.fill('relay.example.com');
  await field.blur();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  expect((await calls(page, 'relay:set-address')).at(-1)).toEqual(['relay.example.com']);
  await shot(page, 'settings-more-dark');
});

test('first run ends on "Take your agents with you", which opens Pair a phone', async ({ page }) => {
  await installElectronApiMock(page, {
    initialProjects: [],
    initialSessions: [],
    initialPreferences: { hide_discord: 'true', onboarding_repo_setup: 'false' },
    initialConfig: { theme: 'dark', appearanceMode: 'fixed' },
  });
  await page.addInitScript(() => {
    window.electronAPI.onboarding.detectEnvironment = async () => ({ success: true, data: { gitInstalled: true } });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('dialog', { name: 'Which agent do you use?' }).getByRole('button', { name: 'Claude Code' }).click();
  await page.getByRole('dialog', { name: 'Open your project' }).getByRole('button', { name: 'Skip', exact: true }).click();
  const step = page.getByRole('dialog', { name: 'Take your agents with you' });
  await expect(step).toBeVisible();
  await shot(page, 'onboarding-phone-step-dark');
  await step.getByRole('button', { name: 'Pair a phone' }).click();
  await expect(qr(page)).toBeVisible();
});
