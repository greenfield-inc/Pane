import { expect, test, type Page } from '@playwright/test';
import type { NotifyCommand, NotifySnapshot } from '../shared/types/notify';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import { installElectronApiMock } from './electronApiMock';
import { notifyFixture } from './fixtures/notifySnapshot';

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
  emitNotifyNavigate(target: 'inbox' | 'settings'): void;
}

async function boot(page: Page, snapshot: NotifySnapshot = notifyFixture(), initialConfig: JsonObject = {}) {
  await installElectronApiMock(page, {
    initialConfig,
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

test.describe('Pane Notify in the main window', () => {
  test('the sidebar counts waiting questions and marks each waiting Pane', async ({ page }) => {
    await boot(page);
    await expect(page.getByTestId('notify-nav')).toContainText('Notify');
    // Three questions wait; the update never adds to the count.
    await expect(page.getByTestId('notify-nav').getByLabel('3 questions waiting')).toHaveText('3');

    const row = (name: string) => page.locator('.group\\/session', { hasText: name });
    await expect(row('auth-refactor')).toContainText('Waiting');
    await expect(row('billing-migration')).toContainText('Waiting');
    await expect(row('sms-retry')).not.toContainText('Waiting');
  });

  test('the inbox answers in one click and lists updates and history', async ({ page }) => {
    await boot(page);
    await page.getByTestId('notify-nav').click();
    const inbox = page.getByTestId('notify-inbox');
    await expect(inbox.getByRole('heading', { name: 'Notify' })).toBeVisible();
    await expect(inbox.getByRole('tab', { name: 'Waiting 3' })).toHaveAttribute('aria-selected', 'true');
    await expect(inbox.getByTestId('notify-card')).toHaveCount(3);

    await inbox.getByRole('button', { name: /Keep Redis/ }).click();
    await inbox.getByRole('button', { name: /Approve/ }).click();
    await inbox.getByPlaceholder('Type your answer').fill('Answer your agents from anywhere');
    await inbox.getByPlaceholder('Type your answer').press('Enter');
    await inbox.getByRole('button', { name: 'Answer all' }).click();
    await expect.poll(() => commands(page)).toEqual([
      { type: 'answer', id: 'q-options', answer: { choice: 'Keep Redis' } },
      { type: 'answer', id: 'q-approve', answer: { approved: true } },
      { type: 'answer', id: 'q-ask', answer: { text: 'Answer your agents from anywhere' } },
      { type: 'open-round' },
    ]);

    await expect(inbox.getByText('For your information')).toBeVisible();
    await expect(inbox.getByText('PR #812 checks passed')).toBeVisible();
    const history = inbox.getByTestId('notify-history-row');
    await expect(history.filter({ hasText: 'Retry backoff' })).toContainText('→ Exponential');
    await expect(history.filter({ hasText: 'Lint rule question' })).toContainText('Expired');
  });

  test('a suggestion fills the answer field and waits for Enter', async ({ page }) => {
    await boot(page);
    await page.getByTestId('notify-nav').click();
    const card = page.getByTestId('notify-inbox').getByTestId('notify-card').filter({ hasText: 'release headline' });
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

  test('the inbox explains Notify when nothing waits, and main can open it', async ({ page }) => {
    const empty = { ...notifyFixture(), items: [], queue: [], strip: null, stripSurface: null };
    await boot(page, empty);
    await expect(page.getByTestId('notify-nav').getByLabel(/waiting/)).toHaveCount(0);
    // SAFETY: installElectronApiMock installs these test-only IPC controls on the page.
    await page.evaluate(() => (window as MockWindow).__paneTestElectronMock.emitNotifyNavigate('inbox'));
    await expect(page.getByTestId('notify-empty')).toContainText('notify');
  });

  test('the in-Pane strip answers, hides, and offers a reminder', async ({ page }) => {
    await boot(page);
    const strip = page.getByTestId('notify-in-pane-strip');
    await expect(strip.getByText('Which session store should the refactor use?')).toBeVisible();
    await expect(strip).toContainText('1 is recommended');
    await expect(strip).toContainText('Next: Apply migration 0042 to staging? · billing-migration');

    await strip.getByRole('button', { name: /Postgres table/ }).click();
    await strip.getByRole('button', { name: 'Close' }).click({ button: 'right' });
    await strip.getByRole('menuitem', { name: 'In 1 hour' }).click();
    await strip.getByRole('button', { name: 'Close' }).click();
    await expect.poll(() => commands(page)).toEqual([
      { type: 'answer', id: 'q-options', answer: { choice: 'Postgres table' } },
      { type: 'remind', id: 'q-options', after: '1h' },
      { type: 'dismiss', id: 'q-options' },
    ]);

    // Details: a click selects, Send confirms with the note.
    await strip.getByRole('button', { name: 'Details' }).click();
    await strip.getByRole('button', { name: /Stateless JWT/ }).click();
    await strip.getByPlaceholder('Add a note for Claude (optional)').fill('Keep sign-out working');
    await strip.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(async () => (await commands(page)).at(-1)).toEqual(
      { type: 'answer', id: 'q-options', answer: { choice: 'Stateless JWT', note: 'Keep sign-out working' } },
    );

    const sent = notifyFixture();
    sent.items[0] = { ...sent.items[0], state: 'sent', answerSummary: 'Stateless JWT' };
    sent.strip = { kind: 'sent', itemId: 'q-options' };
    // SAFETY: installElectronApiMock installs these test-only IPC controls on the page.
    await page.evaluate((snapshot) => (window as MockWindow).__paneTestElectronMock.emitNotifySnapshot(snapshot), sent);
    await expect(strip).toContainText('Sent to Claude');
    await strip.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await commands(page)).at(-1)).toEqual({ type: 'undo', id: 'q-options' });
  });
});

test.describe('Settings → Notify', () => {
  const openNotifySettings = async (page: Page) => {
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await expect(page.getByTestId('settings-page')).toBeVisible();
    await page.getByRole('button', { name: 'Notify', exact: true }).click();
  };

  test('shows the defaults and saves Show outside Pane', async ({ page }) => {
    await boot(page);
    await openNotifySettings(page);
    await expect(page.getByRole('switch', { name: 'Notify' })).toHaveAttribute('aria-checked', 'true');
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
    await openNotifySettings(page);
    const fromTray = notifyFixture();
    fromTray.settings.showOutsidePane = false;
    // SAFETY: installElectronApiMock installs these test-only IPC controls on the page.
    await page.evaluate((snapshot) => (window as MockWindow).__paneTestElectronMock.emitNotifySnapshot(snapshot), fromTray);
    await expect(page.getByRole('switch', { name: 'Show outside Pane' })).toHaveAttribute('aria-checked', 'false');

    await page.getByRole('radio', { name: 'Top right' }).click();
    await expect.poll(() => configUpdates(page)).toEqual([{ notify: { position: 'top-right' } }]);
  });

  test('greys out every child setting while Notify is off', async ({ page }) => {
    await boot(page, notifyFixture(), { notify: { enabled: false } });
    await openNotifySettings(page);
    await expect(page.getByRole('switch', { name: 'Notify' })).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('switch', { name: 'Show outside Pane' })).toBeDisabled();
    await expect(page.getByRole('radio', { name: 'Top right' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Change' })).toBeDisabled();
    await expect(page.getByRole('combobox', { name: 'Updates hide after' })).toBeDisabled();
    await expect(page.getByRole('switch', { name: 'Sound' })).toBeDisabled();
  });

  test('says when the shortcut is taken or floating cards are unavailable', async ({ page }) => {
    await boot(page, { ...notifyFixture(), shortcutRegistered: false, showOutsideSupported: false });
    await openNotifySettings(page);
    await expect(page.getByRole('alert')).toContainText('Another app is using');
    await expect(page.getByText('Unavailable on native Wayland')).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Show outside Pane' })).toBeDisabled();
  });
});
