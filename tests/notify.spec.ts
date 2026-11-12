import { expect, test, type Page } from '@playwright/test';
import type { NotifyCommand, NotifySnapshot } from '../shared/types/notify';
import type { JsonObject, JsonValue } from '../shared/validation/boundaryDecoder';
import type { MachineState } from '../shared/types/machineConnections';
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
  initialPanels: JsonObject[] = [],
  initialLayout: JsonObject | null = null,
  machineConnections?: { machines: MachineState[]; reads: Record<string, Record<string, JsonValue>> },
) {
  await installElectronApiMock(page, {
    machineConnections,
    initialConfig,
    paneSecrets,
    initialPanels,
    initialLayout,
    rememberPaneLayouts: initialLayout !== null,
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
  test('the sidebar row counts what waits, Panes and Sessions say Waiting, and nothing covers the work', async ({ page }) => {
    // Main says the strip would show inside Pane: Approvals draws no strip or docked card there.
    await boot(page, { ...notifyFixture(), stripSurface: 'pane' });
    const badge = page.getByTestId('approvals-nav');
    await expect(badge).toHaveAccessibleName('Approvals, 3 waiting');
    await expect(badge).toContainText('3');
    // The row sits in the sidebar's top list, below Loops (below Autopilot when it is on); the title bar keeps only the machine pill.
    await expect(page.locator('[data-testid="loops-nav"] + [data-testid="approvals-nav"]')).toHaveCount(1);
    await expect(page.getByTestId('notify-nav')).toHaveCount(0);
    await expect(page.getByTestId('notify-in-pane-strip')).toHaveCount(0);
    await expect(page.getByTestId('notify-dock')).toHaveCount(0);

    const row = (name: string) => page.locator('.group\\/session', { hasText: name });
    await expect(row('auth-refactor')).toContainText('Waiting');
    await expect(row('billing-migration')).toContainText('Waiting');
    await expect(row('sms-retry')).not.toContainText('Waiting');
  });

  test('Approvals lists newest first, groups by Session, opens the selected item in the column beside the list, and answers it', async ({ page }) => {
    await boot(page);
    await page.getByTestId('approvals-nav').click();
    const queue = page.getByTestId('approvals-queue');
    await expect(queue.getByRole('heading', { name: 'Approvals' })).toBeVisible();
    await expect(queue.getByRole('tab', { name: 'Waiting 3' })).toHaveAttribute('aria-selected', 'true');
    await expect(queue.getByTestId('approvals-group')).toHaveCount(0);
    await queue.getByTestId('approvals-sort').click();
    await page.getByRole('menuitemradio', { name: 'By Session' }).click();
    await expect(queue.getByTestId('approvals-group')).toHaveText([/Launch\s*1/, /Not in a Session\s*2/]);

    // The first waiting item opens in the column beside the list (P4); the list stays compact rows.
    await expect(queue.getByTestId('approvals-selected')).toHaveCount(0);
    const column = page.getByTestId('approval-column');
    await expect(column.getByTestId('approval-title')).toHaveText('Which session store should the refactor use?');
    await expect(column.getByTestId('approval-pager')).toHaveText('1 of 3');
    // Decide first, then Summary, each reference, and the chat where it was asked (D-224).
    await expect(column.getByTestId('approval-tab')).toHaveText(['Decide', 'Summary', 'plan.html', 'PR #812', "auth-refactor's tab"]);
    await column.getByRole('radio', { name: /Keep Redis/ }).click();
    await column.getByTestId('approval-send').click();

    await queue.getByTestId('approvals-row').filter({ hasText: 'Apply migration 0042' }).click();
    await expect(column.getByTestId('approval-title')).toHaveText('Apply migration 0042 to staging?');
    await column.getByRole('radio', { name: /Approve/ }).click();
    await column.getByTestId('approval-send').click();
    await expect.poll(() => commands(page)).toEqual([
      { type: 'answer', id: 'q-options', answer: { picks: ['Keep Redis'] } },
      { type: 'answer', id: 'q-approve', answer: { picks: ['Approve'] } },
    ]);

    await queue.getByRole('tab', { name: /Answered/ }).click();
    const rows = queue.getByTestId('approvals-row');
    await expect(rows.filter({ hasText: 'Retry backoff' })).toContainText('→ Exponential');
    await expect(rows.filter({ hasText: 'Lint rule question' })).toContainText('Expired');
    await expect(rows.filter({ hasText: 'PR #812 checks passed' })).toContainText('Update');
  });

  test("an Autopilot answer is overridden with a click on a choice, and its notes don't hide Send behind Details", async ({ page }) => {
    const fixture = notifyFixture();
    const [options] = fixture.items;
    await boot(page, {
      ...fixture,
      items: [...fixture.items, { ...options, id: 'q-overridable', title: 'Which cache should staging use?', state: 'answered', answerSummary: 'Postgres table', answeredBy: { by: 'autopilot', because: 'D-22' } }],
    });
    await page.getByTestId('approvals-nav').click();
    const queue = page.getByTestId('approvals-queue');
    await queue.getByRole('tab', { name: /Answered/ }).click();
    await queue.getByTestId('approvals-row').filter({ hasText: 'Which cache should staging use?' }).click();
    const selected = page.getByTestId('approval-column');
    await selected.getByRole('button', { name: 'Override' }).click();
    await expect(selected.getByRole('button', { name: 'Details' })).toHaveCount(0);
    await expect(selected.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await selected.getByRole('button', { name: /Keep Redis/ }).click();
    await expect.poll(() => commands(page)).toContainEqual({ type: 'override', id: 'q-overridable', answer: { choice: 'Keep Redis' } });
  });

  test('a worker item shows its Pane in the column\'s origin tab', async ({ page }) => {
    await boot(page);
    await page.getByTestId('approvals-nav').click();
    await page.getByTestId('approval-tab').filter({ hasText: "auth-refactor's tab" }).click();
    const beside = page.getByTestId('approvals-origin');
    await expect(beside).toContainText('Pane');
    await expect(beside).toContainText('auth-refactor');
  });

  test("a worker item shows its Pane on the asking tab, not the tab the Pane last showed", async ({ page }) => {
    const tab = (id: string, title: string, active: boolean) => ({
      id, sessionId: 'pane-auth', type: 'logs', title,
      state: { isActive: active, hasBeenViewed: true },
      metadata: { createdAt: '2026-01-01T00:00:00.000Z', lastActiveAt: '2026-01-01T00:00:00.000Z', position: active ? 1 : 0 },
    });
    // panel-auth asked (the fixture's source); panel-other is the tab this Pane remembers as shown.
    const remembered = { version: 1, root: { type: 'group', id: 'g1', panelIds: ['panel-auth', 'panel-other'], activePanelId: 'panel-other' }, focusedGroupId: 'g1' };
    await boot(page, notifyFixture(), {}, undefined, [tab('panel-auth', 'Asking tab', false), tab('panel-other', 'Other tab', true)], remembered);
    // Visit the Pane and leave it on the other tab, so this desktop remembers that tab.
    await page.locator('.group\\/session', { hasText: 'auth-refactor' }).first().click();
    await page.getByRole('tab', { name: /Other tab/ }).click();
    await expect(page.getByRole('tab', { name: /Other tab/ })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: 'Home' }).first().click();

    await page.getByTestId('approvals-nav').click();
    await page.getByTestId('approval-tab').filter({ hasText: "auth-refactor's tab" }).click();
    const beside = page.getByTestId('approvals-origin');
    await expect(beside.getByRole('tab', { name: /Asking tab/ })).toHaveAttribute('aria-selected', 'true');
  });

  test('a suggestion fills the one reply box and waits for Send; typed text goes as a reply', async ({ page }) => {
    await boot(page);
    await page.getByTestId('approvals-nav').click();
    await page.getByTestId('approvals-row').filter({ hasText: 'release headline' }).click();
    const column = page.getByTestId('approval-column');
    await column.getByRole('button', { name: /Notify is here/ }).click();
    const field = column.getByTestId('approval-reply-box');
    await expect(field).toHaveValue('Notify is here');
    expect(await commands(page)).toEqual([]);

    await field.press('End');
    await field.pressSequentially(' in 2.5');
    await column.getByTestId('approval-send').click();
    await expect.poll(() => commands(page)).toEqual([{ type: 'answer', id: 'q-ask', answer: { picks: [], text: 'Notify is here in 2.5' } }]);
  });

  test('says nothing waits in one line, and main can open it', async ({ page }) => {
    const empty = { ...notifyFixture(), items: [], queue: [], strip: null, stripSurface: null };
    await boot(page, empty);
    await expect(page.getByTestId('approvals-nav')).toHaveAccessibleName('Approvals');
    await expect(page.getByTestId('approvals-nav')).toHaveText('Approvals');
    // SAFETY: installElectronApiMock installs these test-only IPC controls on the page.
    await page.evaluate(() => (window as MockWindow).__paneTestElectronMock.emitNotifyNavigate('inbox'));
    await expect(page.getByTestId('notify-empty')).toHaveText('Nothing is waiting on you.');
  });

  test('the Approvals row clicked again returns to the view you left', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Loops' }).first().click();
    await page.getByTestId('approvals-nav').click();
    await expect(page.getByTestId('approvals-queue')).toBeVisible();
    await expect(page.getByTestId('approvals-nav')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('approvals-nav').click();
    await expect(page.getByTestId('approvals-queue')).toHaveCount(0);
    await expect(page.getByTestId('approvals-nav')).toHaveAttribute('aria-pressed', 'false');
  });

  test('F-15: words typed while Send is pending stay in the box once the send is accepted; only what was sent is cleared', async ({ page }) => {
    const snapshot = notifyFixture();
    snapshot.items = snapshot.items.filter(item => item.id === 'q-options');
    snapshot.queue = ['q-options'];
    await boot(page, snapshot);
    await page.getByTestId('approvals-nav').click();
    const column = page.getByTestId('approval-column');
    const reply = column.getByTestId('approval-reply-box');
    await reply.fill('Send only the first sentence.');
    // A slow Send: main takes the command and answers only when the test says so.
    await page.evaluate(() => {
      // SAFETY: test-only fields this test sets on the page's window, read back below.
      const held = window as typeof window & { heldCommand?: unknown; acceptSend?: () => void };
      window.electronAPI.notify.run = async (command) => {
        held.heldCommand = command;
        await new Promise<void>(resolve => { held.acceptSend = resolve; });
      };
    });
    await column.getByTestId('approval-send').click();
    await expect(column.getByTestId('approval-send')).toBeDisabled();
    await reply.fill('These words were never sent.');
    // SAFETY: heldCommand is set by the held notify.run above.
    expect(await page.evaluate(() => (window as typeof window & { heldCommand?: unknown }).heldCommand)).toMatchObject({ type: 'answer', answer: { text: 'Send only the first sentence.' } });
    // SAFETY: acceptSend is set by the held notify.run above.
    await page.evaluate(() => (window as typeof window & { acceptSend?: () => void }).acceptSend?.());
    await expect(reply).toHaveValue('These words were never sent.');
    await expect(column.getByTestId('approval-send')).toBeEnabled();
  });

  test('F-15: with nothing changed while Send was pending, an accepted send clears the box', async ({ page }) => {
    const snapshot = notifyFixture();
    snapshot.items = snapshot.items.filter(item => item.id === 'q-options');
    snapshot.queue = ['q-options'];
    await boot(page, snapshot);
    await page.getByTestId('approvals-nav').click();
    const column = page.getByTestId('approval-column');
    const reply = column.getByTestId('approval-reply-box');
    await reply.fill('Keep Redis, but only for now.');
    await column.getByTestId('approval-send').click();
    await expect.poll(() => commands(page)).toEqual([{ type: 'answer', id: 'q-options', answer: { picks: [''], text: 'Keep Redis, but only for now.' } }]);
    await expect(reply).toHaveValue('');
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

  test('Show cards on lists this computer and each saved machine that answered, and saves the pick for every machine', async ({ page }) => {
    const machines: MachineState[] = [
      { id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null, installId: '6f1c2a40-0000-4000-8000-00000000mac1' },
      { id: 'profile-box', label: 'build-box', kind: 'remote', status: 'online', offlineSince: null, installId: '9a7e5c21-0000-4000-8000-0000000b0x01' },
      { id: 'profile-old', label: 'old-laptop', kind: 'remote', status: 'online', offlineSince: null },
    ];
    await boot(page, notifyFixture(), {}, undefined, [], null, { machines, reads: {} });
    await openApprovalsSettings(page);
    const picker = page.getByRole('combobox', { name: 'Show cards on' });
    await expect(picker).toContainText('Whichever computer is in use');
    await expect(page.getByTestId('notify-cards-on-note')).toHaveCount(0);

    await picker.click();
    await expect(page.getByRole('option')).toHaveText(['Whichever computer is in use', 'This computer (qa-macbook)', 'build-box']);
    await page.getByRole('option', { name: 'build-box' }).click();
    await expect.poll(() => configUpdates(page)).toEqual([
      { notify: { cardsOn: { id: '9a7e5c21-0000-4000-8000-0000000b0x01', name: 'build-box' } } },
    ]);
  });

  test('Show cards on says why this computer still pops up cards, or doesn\'t', async ({ page }) => {
    const pickedElsewhere = { id: 'c3d4-0000-4000-8000-000000000b00', name: 'qa-mini' };
    const snapshot = notifyFixture();
    snapshot.settings.cardsOn = pickedElsewhere;
    await boot(page, snapshot);
    await openApprovalsSettings(page);
    // A machine picked on another computer and not saved here shows by the name it was picked with.
    await expect(page.getByRole('combobox', { name: 'Show cards on' })).toContainText('qa-mini');
    const note = page.getByTestId('notify-cards-on-note');
    const lines: Array<[NotifySnapshot['cardsOn'], string]> = [
      [{ kind: 'elsewhere', name: 'qa-mini' }, "Cards pop up on qa-mini. They're still listed here."],
      [{ kind: 'not-added', name: 'qa-mini' }, "qa-mini hasn't added this computer, so this computer's cards still pop up here. Add this computer on qa-mini to move them."],
      [{ kind: 'not-connected', name: 'qa-mini' }, "qa-mini isn't connected, so cards pop up here for now."],
    ];
    for (const [cardsOn, text] of lines) {
      // SAFETY: installElectronApiMock installs these test-only IPC controls on the page.
      await page.evaluate((next) => (window as MockWindow).__paneTestElectronMock.emitNotifySnapshot(next), { ...snapshot, cardsOn });
      await expect(note).toHaveText(text);
    }
  });

  test('says when the shortcut is taken or floating cards are unavailable', async ({ page }) => {
    await boot(page, { ...notifyFixture(), shortcutRegistered: false, showOutsideSupported: false });
    await openApprovalsSettings(page);
    await expect(page.getByRole('alert')).toContainText('Another app is using');
    await expect(page.getByText('Unavailable on native Wayland')).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Show outside Pane' })).toBeDisabled();
  });
});
