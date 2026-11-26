import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import type { RemoteDaemonClientRecord } from '../shared/types/remoteDaemon';
import type { RelayStatus } from '../shared/types/relay';
import { installElectronApiMock, type ElectronApiMockOptions, gotoApp } from './electronApiMock';

type PairTestWindow = Window & {
  __paneTestElectronMock: {
    getInvokeCalls(channel: string): Array<{ args: unknown[] }>;
    emitRelayPaired(clientId: string, label: string): void;
    emitRelayStatus(updates: Partial<RelayStatus>): void;
    emitHostClientsChanged(clients: RemoteDaemonClientRecord[]): void;
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
  await gotoApp(page);
  for (const name of ['No thanks', 'Get Started', 'Skip', 'Skip for now']) {
    const button = page.getByRole('dialog').getByRole('button', { name, exact: true });
    if (await button.isVisible({ timeout: 1500 }).catch(() => false)) await button.click();
  }
  await expect(page.getByRole('heading', { name: 'Use Pane from your phone, another computer, or glasses' })).toBeVisible();
}

/** Home's "Pair a device" opens Add a device on its Phone tab. */
async function openPairDialog(page: Page) {
  await page.getByRole('button', { name: 'Pair a device' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a device' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('tab', { name: 'Phone' })).toHaveAttribute('aria-selected', 'true');
  return dialog;
}

const qr = (page: Page) => page.getByRole('dialog', { name: 'Add a device' }).getByRole('img', { name: 'Pairing code' });

for (const theme of ['light', 'dark'] as const) {
  test(`Home's card opens Add a device on Phone, which turns phone access on and shows a code (${theme})`, async ({ page }) => {
    await openHome(page, {}, theme);
    await shot(page, `home-card-${theme}`);
    const dialog = await openPairDialog(page);
    await expect(qr(page)).toHaveAttribute('data-url', 'https://pane.example/pair#s=secret-1&c=k7q2m9&n=devbox');
    await expect(dialog).toContainText(/Works once · (10:00|9:5\d)/);
    expect(await calls(page, 'relay:set-enabled')).toEqual([[true]]);
    await shot(page, `dialog-code-${theme}`);
    await dialog.getByRole('button', { name: 'Close modal' }).click();
    await expect(dialog).toBeHidden();
    expect(await calls(page, 'relay:set-enabled')).toEqual([[true]]);
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`Read only says what it gives and shows only read-only codes (${theme})`, async ({ page }) => {
    await openHome(page, { relay: { codeDelayMs: 400 } }, theme);
    const dialog = await openPairDialog(page);
    await expect(qr(page)).toHaveAttribute('data-url', /#s=secret-1&/);
    await shot(page, `add-phone-full-${theme}`);
    await dialog.getByRole('radio', { name: 'Read only' }).click();
    // The full code is gone before the read-only one is made.
    await expect(qr(page)).toHaveCount(0);
    await expect(dialog).toContainText("Can’t type, run, approve, open files or see your keys.");
    await expect(dialog).toContainText('any key or password that appears on screen');
    await expect(qr(page)).toHaveAttribute('data-url', /#s=read-secret-2&/);
    await shot(page, `add-phone-read-${theme}`);

    // Back and forth while a code is being made: the code shown is the level chosen last.
    await dialog.getByRole('radio', { name: 'Full access' }).click();
    await dialog.getByRole('radio', { name: 'Read only' }).click();
    await expect(qr(page)).toHaveAttribute('data-url', /#s=read-secret-/);
    await page.waitForTimeout(600);
    await expect(qr(page)).toHaveAttribute('data-url', /#s=read-secret-/);

    await dialog.getByRole('tab', { name: 'Computer' }).click();
    await expect(dialog.getByRole('radio', { name: 'Read only' })).toBeChecked();
    await shot(page, `add-computer-read-${theme}`);
    await dialog.getByRole('button', { name: 'Close modal' }).click();
    await openPairDialog(page);
    await expect(dialog.getByRole('radio', { name: 'Full access' })).toBeChecked();
    await expect(qr(page)).toHaveAttribute('data-url', /#s=secret-/);
    await dialog.getByRole('tab', { name: 'Computer' }).click();
    await shot(page, `add-computer-full-${theme}`);
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
  await expect(dialog).toContainText(/New code · (10:00|9:5\d)/);
  await shot(page, 'dialog-paired-dark');
});

test('an expired code is replaced by a new one', async ({ page }) => {
  await openHome(page, { relay: { codeTtlMs: 2_000 } });
  await openPairDialog(page);
  await expect(qr(page)).toHaveAttribute('data-url', /secret-1/);
  await expect(qr(page)).toHaveAttribute('data-url', /secret-2/, { timeout: 5_000 });
  await expect(page.getByRole('dialog', { name: 'Add a device' })).toContainText(/New code · 0:0\d/);
});

test('waits while this computer gets ready, then shows the code', async ({ page }) => {
  await openHome(page, { relay: { phaseWhenOn: 'certificate' } });
  const dialog = await openPairDialog(page);
  await expect(dialog.getByRole('status').filter({ hasText: 'Getting a certificate…' })).toBeVisible();
  await shot(page, 'dialog-preparing-dark');
  // SAFETY: installElectronApiMock installs __paneTestElectronMock before navigation.
  await page.evaluate(() => (window as PairTestWindow).__paneTestElectronMock.emitRelayStatus({ phase: 'ready' }));
  await expect(qr(page)).toBeVisible();
});

for (const theme of ['light', 'dark'] as const) {
  test(`while both certificate services refuse, relay pairing is grayed out with the reason and Tailscale stays open (${theme})`, async ({ page }) => {
    await openHome(page, { relay: { certificateLimitUntil: '2099-01-02T16:47:00Z' } }, theme);
    const dialog = await openPairDialog(page);
    await expect(dialog.getByText('New pairings through Pane relay are paused until')).toBeVisible();
    await expect(qr(page)).toHaveCount(0);
    const code = dialog.locator('[data-paused]');
    await expect(code).toHaveAttribute('aria-label', /^Not accepting new phone pairings through Pane relay right now: both certificate services are turning away new computers\. Try again after .+, or connect with Tailscale instead\.$/);
    await code.hover();
    await expect(page.getByRole('tooltip')).toContainText('both certificate services are turning away new computers');
    await shot(page, `dialog-limited-${theme}`);
    await dialog.getByRole('tab', { name: 'Computer' }).click();
    await expect(dialog.getByRole('button', { name: 'Copy link' })).toBeDisabled();
    await shot(page, `dialog-limited-computer-${theme}`);
    await dialog.getByRole('button', { name: 'Set up Tailscale' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('tab', { name: 'Tailscale' })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: /Phones and glasses/ }).click();
    await expect(page.getByText('New pairings through Pane relay are paused until')).toBeVisible();
    await shot(page, `remote-access-limited-${theme}`);
  });
}

test('a computer that cannot reach the relay says why and retries', async ({ page }) => {
  await openHome(page, { relay: { phaseWhenOn: 'error', lastError: "Pane's servers didn't answer from us.relay.pane.example, so phones can't reach this computer yet." } });
  const dialog = await openPairDialog(page);
  await expect(dialog.getByRole('alert')).toContainText("Pane's servers didn't answer from us.relay.pane.example");
  await shot(page, 'dialog-error-dark');
  await dialog.getByRole('button', { name: 'Try again' }).click();
  await expect.poll(async () => (await calls(page, 'relay:set-enabled')).length).toBe(2);
  await dialog.getByRole('button', { name: 'Close modal' }).click();
  await expect.poll(() => calls(page, 'relay:set-enabled')).toEqual([[true], [true], [false]]);
});

const PHONE: RemoteDaemonClientRecord = { id: 'phone-1', label: "Sam's iPhone", createdAt: '2026-11-01T10:00:00Z', tokenHash: 'h1', phoneId: 'install-1', lastUsedAt: '2026-11-12T10:00:00Z' };
const LAPTOP: RemoteDaemonClientRecord = { id: 'computer-1', label: 'Travel Laptop', createdAt: '2026-11-02T10:00:00Z', tokenHash: 'h2', kind: 'computer', computerId: 'p4x8n2', linkedBy: "Sam's iPhone" };

async function openRemoteAccess(page: Page, options: ElectronApiMockOptions = {}, theme: keyof typeof THEMES = 'dark') {
  await openHome(page, { hostClients: [PHONE, LAPTOP], ...options }, theme);
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Remote Access', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Remote Access', exact: true })).toBeVisible();
}

const remoteTab = (page: Page, name: string | RegExp) => page.getByRole('tablist', { name: 'Remote Access' }).getByRole('tab', { name });

/** Phones, glasses and the relay address live on Remote Access › Phones and glasses. */
async function openPhonesTab(page: Page) {
  await remoteTab(page, /^Phones and glasses/).click();
  await expect(page.getByRole('heading', { name: 'Devices' })).toBeVisible();
}

for (const theme of ['light', 'dark'] as const) {
  test(`Remote Access lists linked computers under Computers and phones under Phones and glasses (${theme})`, async ({ page }) => {
    await openRemoteAccess(page, {}, theme);
    await expect(remoteTab(page, /^Computers/)).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Also linked' })).toBeVisible();
    await expect(page.getByTestId('linked-Travel Laptop')).toContainText("Linked by Sam's iPhone");
    await expect(page.getByRole('button', { name: "Remove Sam's iPhone" })).toHaveCount(0);
    await shot(page, `settings-computers-${theme}`);
    await expect(remoteTab(page, 'Phones and glasses · 1')).toBeVisible();
    await openPhonesTab(page);
    await expect(page.getByRole('button', { name: "Remove Sam's iPhone" })).toBeVisible();
    await expect(page.getByTestId('linked-Travel Laptop')).toHaveCount(0);
    await shot(page, `settings-devices-${theme}`);
    await page.getByRole('button', { name: "Remove Sam's iPhone" }).click();
    await expect(page.getByRole('menuitem', { name: /Remove from all your computers/ })).toBeVisible();
    await shot(page, `settings-remove-menu-${theme}`);
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`Remote Access names the service that issued this computer's certificate (${theme})`, async ({ page }) => {
    const certificate = { notBefore: '2026-11-20T00:00:00Z', notAfter: '2027-02-18T00:00:00Z', renewAt: '2027-01-19T00:00:00Z', issuer: 'Google Trust Services' };
    await openRemoteAccess(page, { relay: { certificate } }, theme);
    await openPhonesTab(page);
    await expect(page.getByText(/^Issued by Google Trust Services\. Pane renews it on /u)).toBeVisible();
    await expect(page.getByText(/^Valid until /u)).toBeVisible();
    await shot(page, `settings-relay-certificate-${theme}`);
  });
}

test('Remote Access follows changes made from another computer or a phone without reopening Settings', async ({ page }) => {
  await openRemoteAccess(page);
  await expect(page.getByTestId('linked-Travel Laptop')).toBeVisible();
  await openPhonesTab(page);
  await expect(page.getByRole('button', { name: "Remove Sam's iPhone" })).toBeVisible();

  const BUILD_BOX: RemoteDaemonClientRecord = { id: 'computer-2', label: 'Build Box', createdAt: '2026-11-03T10:00:00Z', tokenHash: 'h3', kind: 'computer', computerId: 'b6y1k3', linkedBy: "Ana's Pixel" };
  // SAFETY: installElectronApiMock installs __paneTestElectronMock before navigation.
  await page.evaluate((clients) => (window as PairTestWindow).__paneTestElectronMock.emitHostClientsChanged(clients), [BUILD_BOX]);

  await expect(page.getByRole('button', { name: "Remove Sam's iPhone" })).toHaveCount(0);
  await expect(remoteTab(page, 'Phones and glasses · 0')).toBeVisible();
  await shot(page, 'settings-devices-changed-elsewhere-dark');
  await remoteTab(page, /^Computers/).click();
  await expect(page.getByTestId('linked-Travel Laptop')).toHaveCount(0);
  await expect(page.getByTestId('linked-Build Box')).toContainText("Linked by Ana's Pixel");
  await shot(page, 'settings-computers-changed-elsewhere-dark');
});

test('Remove from all your computers removes the phone everywhere and says where it could not', async ({ page }) => {
  await openRemoteAccess(page, { relay: { everywhere: { removed: ['devbox', 'Travel Laptop'], notReached: ['Build Box'] } } });
  await openPhonesTab(page);
  await page.getByRole('button', { name: "Remove Sam's iPhone" }).click();
  await page.getByRole('menuitem', { name: /Remove from all your computers/ }).click();
  await expect(page.getByRole('status').filter({ hasText: "Removed Sam's iPhone from devbox and Travel Laptop." })).toContainText("Build Box didn't answer");
  expect(await calls(page, 'relay:remove-phone-everywhere')).toEqual([[{ clientId: 'phone-1' }]]);
  await expect(page.getByRole('button', { name: "Remove Sam's iPhone" })).toHaveCount(0);
  await shot(page, 'settings-removed-dark');
});

for (const theme of ['light', 'dark'] as const) {
  test(`Unlink from all your computers unlinks the computer and says where it could not (${theme})`, async ({ page }) => {
    await openRemoteAccess(page, { relay: { everywhere: { removed: ['devbox'], notReached: ['Build Box'] } } }, theme);
    await page.getByRole('button', { name: 'Unlink Travel Laptop' }).click();
    await page.getByRole('menuitem', { name: /Unlink from all your computers/ }).click();
    await expect.poll(() => calls(page, 'relay:unlink-computer-everywhere')).toEqual([[{ computerId: 'p4x8n2' }]]);
    await expect(page.getByTestId('linked-Travel Laptop')).toHaveCount(0);
    const status = page.getByRole('status').filter({ hasText: 'Unlinked Travel Laptop from devbox.' });
    await expect(status).toContainText("Build Box didn't answer and still has it.");
    await status.evaluate((line) => line.scrollIntoView({ block: 'center' }));
    await shot(page, `settings-unlinked-${theme}`);
  });
}

test('Unlinking a computer that is off says to finish on that computer', async ({ page }) => {
  await openRemoteAccess(page, { relay: { everywhere: { removed: ['devbox'], notReached: ['Travel Laptop'] } } });
  await page.getByRole('button', { name: 'Unlink Travel Laptop' }).click();
  await page.getByRole('menuitem', { name: /Unlink from all your computers/ }).click();
  const status = page.getByRole('status').filter({ hasText: 'Unlinked Travel Laptop from devbox.' });
  await expect(status).toContainText("Travel Laptop didn't answer, so it may still list your other computers.");
  await expect(status).not.toContainText('still has it');
});

test('Relay address saves on Enter or leaving the field, and a bad one says how to fix it', async ({ page }) => {
  await openRemoteAccess(page);
  await openPhonesTab(page);
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

test('first run ends on "Take your agents with you", whose Pair a phone opens Add a device on Phone', async ({ page }) => {
  await installElectronApiMock(page, {
    initialProjects: [],
    initialSessions: [],
    initialPreferences: { hide_discord: 'true', onboarding_repo_setup: 'false' },
    initialConfig: { theme: 'dark', appearanceMode: 'fixed' },
  });
  await page.addInitScript(() => {
    window.electronAPI.onboarding.detectEnvironment = async () => ({ success: true, data: { gitInstalled: true } });
  });
  await gotoApp(page);
  await page.getByRole('dialog', { name: 'Which agent do you use?' }).getByRole('button', { name: 'Claude Code' }).click();
  await page.getByRole('dialog', { name: 'Open your project' }).getByRole('button', { name: 'Skip', exact: true }).click();
  const step = page.getByRole('dialog', { name: 'Take your agents with you' });
  await expect(step).toBeVisible();
  await shot(page, 'onboarding-phone-step-dark');
  await step.getByRole('button', { name: 'Pair a phone' }).click();
  await expect(qr(page)).toBeVisible();
});

for (const theme of ['light', 'dark'] as const) {
  test(`read-only devices say so, and a read-only computer is removed, not unlinked (${theme})`, async ({ page }) => {
    const readPhone: RemoteDaemonClientRecord = { ...PHONE, id: 'phone-2', label: "Alex's iPhone", phoneId: 'install-2', access: 'read' };
    const readComputer: RemoteDaemonClientRecord = { ...LAPTOP, id: 'computer-2', label: "Alex's Mac", computerId: 'z9z9z9', access: 'read', linkedBy: undefined };
    await openRemoteAccess(page, { hostClients: [PHONE, LAPTOP, readPhone, readComputer] }, theme);
    const row = page.getByTestId("watching-Alex's Mac");
    await expect(row).toContainText('Read only');
    await shot(page, `settings-computers-${theme}`);
    await row.getByRole('button', { name: "Remove Alex's Mac" }).click();
    await expect.poll(() => calls(page, 'relay:remove-phone-everywhere')).toEqual([[{ clientId: 'computer-2' }]]);
    expect(await calls(page, 'relay:unlink-computer-everywhere')).toEqual([]);
    await openPhonesTab(page);
    await expect(page.getByText('Read only', { exact: true })).toHaveCount(1);
    await page.getByRole('button', { name: "Remove Alex's iPhone" }).click();
    await expect.poll(() => calls(page, 'relay:remove-phone-everywhere')).toEqual([[{ clientId: 'computer-2' }], [{ clientId: 'phone-2' }]]);
    await shot(page, `settings-phones-${theme}`);
  });
}
