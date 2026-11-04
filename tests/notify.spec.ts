import { expect, test, type Page } from '@playwright/test';
import type { NotifyCommand, NotifySnapshot } from '../shared/types/notify';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import { installElectronApiMock } from './electronApiMock';
import { notifyFixture, secretFixture } from './fixtures/notifySnapshot';
import type { PaneSecretStorage, PaneSecretSummary } from '../shared/types/paneSecrets';

const project = {
  id: 1,
  name: 'bloom-mono',
  path: '/tmp/bloom-mono',
  active: true,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const pane = (id: string, name: string) => ({
  id,
  name,
  projectId: 1,
  worktreePath: `/tmp/${name}`,
  prompt: '',
  status: 'stopped',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastActivity: '2026-01-01T00:00:00.000Z',
  output: [],
  jsonMessages: [],
  permissionMode: 'ignore',
  toolType: 'none',
  archived: false,
  isHidden: false,
  isFavorite: false,
});

interface NotifyMock {
  getNotifyCommands(): NotifyCommand[];
  getConfigUpdates(): JsonObject[];
  emitNotifySnapshot(snapshot: NotifySnapshot): void;
  emitNotifyNavigate(target: 'inbox' | 'settings' | { approval: string }): void;
}

async function boot(
  page: Page,
  snapshot: NotifySnapshot = notifyFixture(),
  initialConfig: JsonObject = {},
  paneSecrets?: { secrets: PaneSecretSummary[]; storage: PaneSecretStorage },
) {
  await installElectronApiMock(page, {
    initialConfig,
    paneSecrets,
    initialProjects: [project],
    initialSessions: [pane('pane-auth', 'auth-refactor'), pane('pane-billing', 'billing-migration'), pane('pane-sms', 'sms-retry')],
    initialUiState: { expandedProjects: [1], repositoriesSectionExpanded: true },
    notifySnapshot: snapshot,
  });
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await expect(page.getByTestId('sidebar').first()).toBeVisible({ timeout: 30_000 });
}

type MockWindow = typeof window & { __paneTestElectronMock: NotifyMock };

// SAFETY: installElectronApiMock installs these test-only IPC controls on the page.
const commands = (page: Page) => page.evaluate(() => (window as MockWindow).__paneTestElectronMock.getNotifyCommands());
// SAFETY: installElectronApiMock installs these test-only IPC controls on the page.
const configUpdates = (page: Page) => page.evaluate(() => (window as MockWindow).__paneTestElectronMock.getConfigUpdates());

test.describe('Approvals in the main window', () => {
  test('the badge counts what waits, Panes and Sessions say Waiting, and nothing covers the work', async ({ page }) => {
    // Main says the strip would show inside Pane: Approvals draws no strip or docked card there.
    await boot(page, { ...notifyFixture(), stripSurface: 'pane' });
    const badge = page.getByTestId('approvals-badge');
    await expect(badge).toHaveAccessibleName('Approvals, 3 waiting');
    await expect(badge).toContainText('3');
    await expect(page.getByTestId('notify-nav')).toHaveCount(0);
    await expect(page.getByTestId('notify-in-pane-strip')).toHaveCount(0);
    await expect(page.getByTestId('notify-dock')).toHaveCount(0);

    const row = (name: string) => page.locator('.group\\/session', { hasText: name });
    await expect(row('auth-refactor')).toContainText('Waiting');
    await expect(row('billing-migration')).toContainText('Waiting');
    await expect(row('sms-retry')).not.toContainText('Waiting');
  });

  test('Approvals groups by Session, opens the selected item in place, and answers it', async ({ page }) => {
    await boot(page);
    await page.getByTestId('approvals-badge').click();
    const queue = page.getByTestId('approvals-queue');
    await expect(queue.getByRole('heading', { name: 'Approvals' })).toBeVisible();
    await expect(queue.getByRole('tab', { name: 'Waiting 3' })).toHaveAttribute('aria-selected', 'true');
    await expect(queue.getByTestId('approvals-group')).toHaveText([/Launch\s*1/, /Not in a Session\s*2/]);

    // The oldest waiting item is selected first; others are rows.
    const selected = queue.getByTestId('approvals-selected');
    await expect(selected).toContainText('Which session store should the refactor use?');
    await expect(selected.getByTestId('approvals-related').getByRole('button')).toHaveText(['plan.html', 'PR #812']);
    await selected.getByTestId('approvals-related').getByRole('button', { name: 'PR #812' }).click();
    await selected.getByRole('button', { name: /Keep Redis/ }).click();

    await queue.getByTestId('approvals-row').filter({ hasText: 'Apply migration 0042' }).click();
    await queue.getByTestId('approvals-selected').getByRole('button', { name: /Approve/ }).click();
    await expect.poll(() => commands(page)).toEqual([
      { type: 'open-link', id: 'q-options', index: 1, paneId: 'pane-auth' },
      { type: 'answer', id: 'q-options', answer: { choice: 'Keep Redis' } },
      { type: 'answer', id: 'q-approve', answer: { approved: true } },
    ]);

    await queue.getByRole('tab', { name: /Answered/ }).click();
    const rows = queue.getByTestId('approvals-row');
    await expect(rows.filter({ hasText: 'Retry backoff' })).toContainText('→ Exponential');
    await expect(rows.filter({ hasText: 'Lint rule question' })).toContainText('Expired');
    await expect(rows.filter({ hasText: 'PR #812 checks passed' })).toContainText('Update');
  });

  test('a worker item shows its Pane beside it', async ({ page }) => {
    await boot(page);
    await page.getByTestId('approvals-badge').click();
    const beside = page.getByTestId('approvals-beside');
    await expect(beside).toContainText('Pane');
    await expect(beside).toContainText('auth-refactor');
  });

  test('a suggestion fills the answer field and waits for Enter', async ({ page }) => {
    await boot(page);
    await page.getByTestId('approvals-badge').click();
    await page.getByTestId('approvals-row').filter({ hasText: 'release headline' }).click();
    const card = page.getByTestId('approvals-selected');
    await card.getByRole('button', { name: /Notify is here/ }).click();
    const field = card.getByPlaceholder('Type your answer');
    await expect(field).toHaveValue('Notify is here');
    await expect(field).toBeFocused();
    expect(await commands(page)).toEqual([]);

    await field.press('End');
    await field.pressSequentially(' in 2.5');
    await field.press('Enter');
    await expect.poll(() => commands(page)).toEqual([{ type: 'answer', id: 'q-ask', answer: { text: 'Notify is here in 2.5' } }]);
  });

  test('says nothing waits in one line, and main can open it', async ({ page }) => {
    const empty = { ...notifyFixture(), items: [], queue: [], strip: null, stripSurface: null };
    await boot(page, empty);
    await expect(page.getByTestId('approvals-badge')).toHaveAccessibleName('Approvals');
    // SAFETY: installElectronApiMock installs these test-only IPC controls on the page.
    await page.evaluate(() => (window as MockWindow).__paneTestElectronMock.emitNotifyNavigate('inbox'));
    await expect(page.getByTestId('notify-empty')).toHaveText('Nothing is waiting on you.');
  });

  test('the badge clicked again returns to the view you left', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Loops' }).first().click();
    await page.getByTestId('approvals-badge').click();
    await expect(page.getByTestId('approvals-queue')).toBeVisible();
    await page.getByTestId('approvals-badge').click();
    await expect(page.getByTestId('approvals-queue')).toHaveCount(0);
    await expect(page.getByTestId('approvals-badge')).toHaveAttribute('aria-pressed', 'false');
  });
});

test.describe('Notify secret requests', () => {
  test('a secret is typed masked, saved once, and cleared from the card; Decline declines', async ({ page }) => {
    await boot(page, secretFixture(true));
    const strip = page.getByTestId('notify-in-pane-strip');
    await expect(strip).toContainText('Asking for a secret');
    await expect(strip).toContainText("Run the webhook integration tests against Stripe's test mode.");
    await expect(strip).toContainText('Saves as Pane secret stripe/STRIPE_SECRET_KEY · replaces the saved value');
    const field = strip.getByPlaceholder('Click to type the secret');
    await expect(field).toHaveAttribute('type', 'password');
    await expect(strip.getByRole('button', { name: 'Save securely' })).toBeDisabled();

    // Digits go into the field; the card has no number-key shortcuts.
    await field.click();
    await field.pressSequentially('sk_test_123');
    await expect(strip.getByRole('button', { name: 'Save securely' })).toBeEnabled();
    expect(await commands(page)).toEqual([]);
    await strip.getByRole('button', { name: 'Save securely' }).click();
    await expect.poll(() => commands(page)).toEqual([{ type: 'answer', id: 'q-secret', answer: { text: 'sk_test_123' } }]);
    await expect(field).toHaveValue('');

    // The host couldn't save it: the card keeps waiting and says why where the destination was.
    const failed = secretFixture(true);
    failed.items[0] = { ...failed.items[0], secretError: 'The login keychain is locked. Nothing was saved. Unlock it and save again.' };
    // SAFETY: installElectronApiMock installs these test-only IPC controls on the page.
    await page.evaluate((snapshot) => (window as MockWindow).__paneTestElectronMock.emitNotifySnapshot(snapshot), failed);
    await expect(strip.getByRole('alert')).toHaveText('The login keychain is locked. Nothing was saved. Unlock it and save again.');
    await expect(strip).not.toContainText('Saves as Pane secret');
    await expect(field).toHaveValue('');

    await field.pressSequentially('typed then declined');
    await strip.getByRole('button', { name: 'Decline' }).click();
    await expect.poll(async () => (await commands(page)).at(-1)).toEqual({ type: 'answer', id: 'q-secret', answer: { approved: false } });
    await expect(field).toHaveValue('');
  });

  test('the inbox history says where a secret was saved, never its value', async ({ page }) => {
    const snapshot = secretFixture();
    snapshot.items[0] = { ...snapshot.items[0], state: 'answered', answerSummary: 'Saved as stripe/STRIPE_SECRET_KEY', resolvedAt: Date.now() };
    snapshot.queue.shift();
    snapshot.strip = null;
    await boot(page, snapshot);
    await page.getByTestId('notify-nav').click();
    await expect(page.getByTestId('notify-history-row').filter({ hasText: 'Stripe test secret key' })).toContainText('→ Saved as stripe/STRIPE_SECRET_KEY');
  });
});

test.describe('Settings → Secrets', () => {
  const secrets: PaneSecretSummary[] = [
    { project: 'stripe', name: 'STRIPE_SECRET_KEY', updatedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), machine: 'mac-studio' },
    { project: 'qa', name: 'UIVERIFY', updatedAt: new Date(Date.now() - 3_600_000).toISOString(), machine: 'parsa-devbox' },
  ];
  const openSecrets = async (page: Page) => {
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await expect(page.getByTestId('settings-page')).toBeVisible();
    await page.getByRole('button', { name: 'Secrets', exact: true }).click();
  };
  // SAFETY: installElectronApiMock installs these test-only IPC controls on the page.
  const secretCalls = (page: Page) => page.evaluate(() => (window as typeof window & { __paneTestElectronMock: { getPaneSecretCalls(): JsonObject[] } }).__paneTestElectronMock.getPaneSecretCalls());

  test('lists secrets by project, and adds, replaces and deletes them', async ({ page }) => {
    await boot(page, notifyFixture(), {}, { secrets, storage: { kind: 'keychain', encrypted: true } });
    await openSecrets(page);
    await expect(page.getByText('Any agent on your machines can use these with runpane secrets exec. Values are never shown again.')).toBeVisible();
    await expect(page.getByTestId('pane-secrets-unencrypted')).toHaveCount(0);
    const row = (address: string) => page.locator(`[data-secret="${address}"]`);
    await expect(row('stripe/STRIPE_SECRET_KEY')).toContainText('Set on mac-studio 2 days ago');
    await expect(row('qa/UIVERIFY')).toContainText('Set on parsa-devbox 1 hour ago');

    await row('qa/UIVERIFY').getByRole('button', { name: 'Replace' }).click();
    await row('qa/UIVERIFY').getByLabel('New value for qa/UIVERIFY').fill('new-value');
    await row('qa/UIVERIFY').getByRole('button', { name: 'Save' }).click();
    await expect(row('qa/UIVERIFY')).toContainText('Set on this-mac');

    await row('stripe/STRIPE_SECRET_KEY').getByRole('button', { name: 'Delete' }).click();
    await expect(row('stripe/STRIPE_SECRET_KEY')).toContainText('Delete stripe/STRIPE_SECRET_KEY from all your machines?');
    await row('stripe/STRIPE_SECRET_KEY').getByRole('group').getByRole('button', { name: 'Delete' }).click();
    await expect(row('stripe/STRIPE_SECRET_KEY')).toHaveCount(0);

    await page.getByRole('button', { name: 'Add secret' }).click();
    await page.getByLabel('Secret project').fill('openai');
    await page.getByLabel('Secret name').fill('OPENAI_API_KEY');
    await page.getByLabel('Secret value').fill('sk-proj');
    await page.getByRole('button', { name: 'Save securely' }).click();
    await expect(row('openai/OPENAI_API_KEY')).toBeVisible();
    expect(await secretCalls(page)).toEqual([
      { action: 'set', project: 'qa', name: 'UIVERIFY' },
      { action: 'delete', project: 'stripe', name: 'STRIPE_SECRET_KEY' },
      { action: 'set', project: 'openai', name: 'OPENAI_API_KEY' },
    ]);
  });

  test('says when this host stores values unencrypted', async ({ page }) => {
    await boot(page, notifyFixture(), {}, { secrets: [], storage: { kind: 'file', encrypted: false } });
    await openSecrets(page);
    await expect(page.getByTestId('pane-secrets-unencrypted')).toHaveText('Stored unencrypted on this host (no OS keyring).');
    await expect(page.getByText('No secrets yet.')).toBeVisible();
  });
});

test.describe('Settings → Approvals', () => {
  const openApprovalsSettings = async (page: Page) => {
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await expect(page.getByTestId('settings-page')).toBeVisible();
    await page.getByRole('button', { name: 'Approvals', exact: true }).click();
  };

  test('shows the defaults and saves Show outside Pane', async ({ page }) => {
    await boot(page);
    await openApprovalsSettings(page);
    await expect(page.getByRole('switch', { name: 'Approvals' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('switch', { name: 'Show outside Pane' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('radio', { name: 'Bottom center' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('switch', { name: 'Sound' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('combobox', { name: 'Updates hide after' })).toContainText('6 seconds');
    const instructionFiles = page.getByTestId('notify-instructions-file');
    await expect(instructionFiles.filter({ hasText: 'Claude Code' })).toContainText('Written');
    await expect(instructionFiles.filter({ hasText: 'Codex' })).toContainText('Not found');

    await page.getByRole('switch', { name: 'Show outside Pane' }).click();
    await expect(page.getByRole('switch', { name: 'Show outside Pane' })).toHaveAttribute('aria-checked', 'false');
    await page.getByRole('radio', { name: 'Top right' }).click();
    await expect.poll(() => configUpdates(page)).toEqual([
      { notify: { showOutsidePane: false } },
      { notify: { position: 'top-right' } },
    ]);
  });

  test('shows a change made from the tray and saves only the edited setting', async ({ page }) => {
    await boot(page);
    await openApprovalsSettings(page);
    const fromTray = notifyFixture();
    fromTray.settings.showOutsidePane = false;
    // SAFETY: installElectronApiMock installs these test-only IPC controls on the page.
    await page.evaluate((snapshot) => (window as MockWindow).__paneTestElectronMock.emitNotifySnapshot(snapshot), fromTray);
    await expect(page.getByRole('switch', { name: 'Show outside Pane' })).toHaveAttribute('aria-checked', 'false');

    await page.getByRole('radio', { name: 'Top right' }).click();
    await expect.poll(() => configUpdates(page)).toEqual([{ notify: { position: 'top-right' } }]);
  });

  test('greys out every child setting while Approvals are off', async ({ page }) => {
    await boot(page, notifyFixture(), { notify: { enabled: false } });
    await openApprovalsSettings(page);
    await expect(page.getByRole('switch', { name: 'Approvals' })).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('switch', { name: 'Show outside Pane' })).toBeDisabled();
    await expect(page.getByRole('radio', { name: 'Top right' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Change' })).toBeDisabled();
    await expect(page.getByRole('combobox', { name: 'Updates hide after' })).toBeDisabled();
    await expect(page.getByRole('switch', { name: 'Sound' })).toBeDisabled();
  });

  test('says when the shortcut is taken or floating cards are unavailable', async ({ page }) => {
    await boot(page, { ...notifyFixture(), shortcutRegistered: false, showOutsideSupported: false });
    await openApprovalsSettings(page);
    await expect(page.getByRole('alert')).toContainText('Another app is using');
    await expect(page.getByText('Unavailable on native Wayland')).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Show outside Pane' })).toBeDisabled();
  });
});
