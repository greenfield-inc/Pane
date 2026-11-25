import { expect, test, type Page } from '@playwright/test';
import type { NotifyCommand, NotifySnapshot } from '../shared/types/notify';
import type { JsonObject, JsonValue } from '../shared/validation/boundaryDecoder';
import type { MachineState } from '../shared/types/machineConnections';
import { installElectronApiMock, gotoApp } from './electronApiMock';
import { notifyFixture, secretFixture } from './fixtures/notifySnapshot';
import type { PaneSecretsOverview, PaneSecretSummary } from '../shared/types/paneSecrets';

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
  paneSecrets?: Partial<PaneSecretsOverview>,
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
  await gotoApp(page);
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

  test('Approvals groups by Session by default, opens the selected item in the column beside the list, and answers it', async ({ page }) => {
    await boot(page);
    await page.getByTestId('approvals-nav').click();
    const queue = page.getByTestId('approvals-queue');
    await expect(queue.getByRole('heading', { name: 'Approvals' })).toBeVisible();
    await expect(queue.getByRole('tab', { name: 'Waiting 3' })).toHaveAttribute('aria-selected', 'true');
    // By Session until the person picks another sort.
    await expect(queue.getByTestId('approvals-group')).toHaveText([/Launch\s*1/, /Not in a Session\s*Archive all\s*2/]);
    await queue.getByTestId('approvals-sort').click();
    const bySession = page.getByRole('menuitemradio', { name: 'By Session' });
    await expect(bySession).toHaveAttribute('aria-checked', 'true');
    await bySession.click();

    // The first waiting item opens in the column beside the list (P4); the list stays compact rows.
    await expect(queue.getByTestId('approvals-selected')).toHaveCount(0);
    const column = page.getByTestId('approval-column');
    await expect(column.getByTestId('approval-title')).toHaveText('Which session store should the refactor use?');
    await expect(column.getByTestId('approval-pager')).toHaveText('1 of 3');
    // Decide first, then Summary, each reference, and the chat where it was asked (D-224).
    await expect(column.getByTestId('approval-tab')).toHaveText(['Decide', 'Summary', 'plan.html', 'PR #812', "auth-refactor's tab"]);
    // Nothing starts picked, recommended or not, and Send waits for a pick (D-385).
    await expect(column.locator('[role="radio"][aria-checked="true"]')).toHaveCount(0);
    await expect(column.getByTestId('approval-send')).toBeDisabled();
    if (process.env.PANE_VERIFY_DIR) await column.screenshot({ path: `${process.env.PANE_VERIFY_DIR}/approval-column-open.png` });
    await column.getByRole('radio', { name: /Keep Redis/ }).click();
    // The person's own pick survives paging away and back.
    await queue.getByTestId('approvals-row').filter({ hasText: 'Apply migration 0042' }).click();
    await expect(column.getByTestId('approval-title')).toHaveText('Apply migration 0042 to staging?');
    await expect(column.locator('[role="radio"][aria-checked="true"]')).toHaveCount(0);
    await queue.getByTestId('approvals-row').filter({ hasText: 'Which session store' }).click();
    await expect(column.getByRole('radio', { name: /Keep Redis/ })).toHaveAttribute('aria-checked', 'true');
    if (process.env.PANE_VERIFY_DIR) await column.screenshot({ path: `${process.env.PANE_VERIFY_DIR}/approval-column-restored.png` });
    await column.getByTestId('approval-send').click();

    await queue.getByTestId('approvals-row').filter({ hasText: 'Apply migration 0042' }).click();
    await expect(column.getByTestId('approval-title')).toHaveText('Apply migration 0042 to staging?');
    await column.getByRole('radio', { name: /Approve/ }).click();
    await column.getByTestId('approval-send').click();
    await expect.poll(() => commands(page)).toEqual([
      { type: 'answer', id: 'q-options', answer: { picks: ['Keep Redis'] } },
      { type: 'answer', id: 'q-approve', answer: { picks: ['Approve'] } },
    ]);

    await queue.getByRole('tab', { name: /Done today/ }).click();
    const rows = queue.getByTestId('approvals-row');
    await expect(rows.filter({ hasText: 'Retry backoff' })).toContainText('→ Exponential');
    await expect(rows.filter({ hasText: 'Lint rule question' })).toContainText('Expired');
    await expect(rows.filter({ hasText: 'PR #812 checks passed' })).toContainText('Update');
  });

  test('Dismiss closes the open approval without answering it, and it stays in the list', async ({ page }) => {
    await boot(page);
    await page.getByTestId('approvals-nav').click();
    const queue = page.getByTestId('approvals-queue');
    const column = page.getByTestId('approval-column');
    await expect(column.getByTestId('approval-title')).toHaveText('Which session store should the refactor use?');
    const dismiss = column.getByRole('button', { name: 'Dismiss' });
    await expect(dismiss).toBeVisible();
    await expect(dismiss).toHaveText('Dismiss');
    await dismiss.click();

    // Nothing answered: it only leaves the floating strip, and no other item takes its place.
    await expect(column).toHaveCount(0);
    await expect.poll(() => commands(page)).toEqual([{ type: 'dismiss', id: 'q-options' }]);
    await expect(queue.getByRole('tab', { name: 'Waiting 3' })).toHaveAttribute('aria-selected', 'true');
    await expect(queue.getByTestId('approvals-row').filter({ hasText: 'Which session store' })).toHaveCount(1);

    // Picking a row opens it again.
    await queue.getByTestId('approvals-row').filter({ hasText: 'Which session store' }).click();
    await expect(column.getByTestId('approval-title')).toHaveText('Which session store should the refactor use?');
  });

  test("Dismiss with the keyboard returns focus to the approval's row in the list", async ({ page }) => {
    await boot(page);
    await page.getByTestId('approvals-nav').click();
    const column = page.getByTestId('approval-column');
    await expect(column.getByTestId('approval-title')).toHaveText('Which session store should the refactor use?');
    await column.getByRole('button', { name: 'Dismiss' }).focus();
    await page.keyboard.press('Enter');
    await expect(column).toHaveCount(0);
    await expect(page.getByTestId('approvals-queue').getByTestId('approvals-row').filter({ hasText: 'Which session store' })).toBeFocused();
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
    await queue.getByRole('tab', { name: /Done today/ }).click();
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

  const remoteApproval = () => {
    const fixture = notifyFixture();
    const [options] = fixture.items;
    const remote = { ...options, id: 'mini:q-remote', machineId: 'mini', machine: 'qa-mini', title: 'Approve the plan draft?', links: [{ label: 'Plan draft', path: '/work/bundle/plan.html' }] };
    const machines: MachineState[] = [
      { id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null },
      { id: 'mini', label: 'qa-mini', kind: 'remote', status: 'online', offlineSince: null },
    ];
    return { snapshot: { ...fixture, items: [remote, ...fixture.items.slice(1)] }, machines };
  };

  test('another machine\'s approval opens its linked file here, "on <machine>"', async ({ page }) => {
    const { snapshot, machines } = remoteApproval();
    const plan = { kind: 'html', path: '/work/bundle/plan.html', html: '<!doctype html><body style="font:15px system-ui;padding:24px"><h1>Plan draft</h1><p>Served by qa-mini.</p></body>' };
    await boot(page, snapshot, {}, undefined, [], null, { machines, reads: { mini: { 'autopilot:read-doc': plan } } });
    await page.getByTestId('approvals-nav').click();
    const column = page.getByTestId('approval-column');
    await expect(column.getByTestId('approval-title')).toHaveText('Approve the plan draft?');
    await column.getByTestId('approval-tab').filter({ hasText: 'Plan draft' }).click();
    const file = column.getByTestId('approval-machine-file');
    await expect(file).toContainText('Plan draft· on qa-mini');
    await expect(file.getByTestId('approvals-machine-page')).toHaveAttribute('srcdoc', /Served by qa-mini/);
    await expect(column).not.toContainText('open it there');
  });

  /** Q-1 in this card's own Session, in another Session, and on a saved machine (T-56). */
  const sharedQ1 = (withOwn: boolean) => {
    const fixture = notifyFixture();
    const [options] = fixture.items;
    const launch = options.source.session;
    const grain = { id: 'session-grain', name: 'Firecracker Grain', paneId: 'session-grain-pane' };
    const linking = { ...options, id: 'q-link', title: 'Q-2: Ship the refactor after the store change?', links: [{ label: 'Q-1', approval: 'Q-1' }] };
    const otherSession = { ...options, id: 'q-grain', title: 'Q-1: Merge the Grain fix first?', source: { ...options.source, paneId: 'pane-sms', panelId: 'panel-sms', name: 'sms-retry', session: grain }, links: [] };
    const otherMachine = { ...options, id: 'mini:q-1', machineId: 'mini', machine: 'qa-mini', title: 'Q-1: Turn on phone-number accounts?', source: { ...options.source, session: launch }, links: [] };
    const own = { ...options, id: 'q-own', title: 'Q-1: Which database for the session store?', links: [] };
    const machines: MachineState[] = [
      { id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null },
      { id: 'mini', label: 'qa-mini', kind: 'remote', status: 'online', offlineSince: null },
    ];
    const items = [linking, otherSession, otherMachine, ...(withOwn ? [own] : [])];
    return { snapshot: { ...fixture, items }, machines };
  };

  for (const todosEnabled of [true, false]) {
    test(`a Q-1 link opens the linking card's own Q-1, not another Session's or machine's (To-dos ${todosEnabled ? 'on' : 'off'})`, async ({ page }) => {
      const { snapshot, machines } = sharedQ1(true);
      await boot(page, snapshot, { todosEnabled }, undefined, [], null, { machines, reads: {} });
      await page.getByTestId('approvals-nav').click();
      const column = page.getByTestId('approval-column');
      await page.getByTestId('approvals-queue').getByTestId('approvals-row').filter({ hasText: 'Q-2: Ship the refactor' }).click();
      await expect(column.getByTestId('approval-title')).toHaveText('Q-2: Ship the refactor after the store change?');
      await column.getByTestId('approval-tab').filter({ hasText: /^Q-1$/ }).click();
      await column.getByRole('button', { name: 'Open it here' }).click();
      await expect(column.getByTestId('approval-back')).toBeVisible();
      await expect(column.getByTestId('approval-title')).toHaveText('Q-1: Which database for the session store?');
      if (process.env.PANE_VERIFY_DIR) await column.screenshot({ path: `${process.env.PANE_VERIFY_DIR}/qn-link-own-${todosEnabled ? 'on' : 'off'}.png` });
    });
  }

  test("a Q-1 link says so when only another Session and another machine have a Q-1", async ({ page }) => {
    const { snapshot, machines } = sharedQ1(false);
    await boot(page, snapshot, {}, undefined, [], null, { machines, reads: {} });
    await page.getByTestId('approvals-nav').click();
    const column = page.getByTestId('approval-column');
    await page.getByTestId('approvals-queue').getByTestId('approvals-row').filter({ hasText: 'Q-2: Ship the refactor' }).click();
    await column.getByTestId('approval-tab').filter({ hasText: /^Q-1$/ }).click();
    await expect(column.getByTestId('approval-link-missing')).toContainText("Q-1 isn't here any more. Pane looks for Q-1 only among this Session's approvals");
    await expect(column.getByRole('button', { name: 'Open it here' })).toHaveCount(0);
    if (process.env.PANE_VERIFY_DIR) await column.screenshot({ path: `${process.env.PANE_VERIFY_DIR}/qn-link-missing.png` });
  });

  test('another machine\'s file says so with Retry when that machine doesn\'t answer, and Retry reads again', async ({ page }) => {
    const { snapshot, machines } = remoteApproval();
    // No document comes back: what an unreachable machine looks like to the column.
    await boot(page, snapshot, {}, undefined, [], null, { machines, reads: { mini: { 'autopilot:read-doc': { success: false } } } });
    await page.getByTestId('approvals-nav').click();
    const column = page.getByTestId('approval-column');
    await column.getByTestId('approval-tab').filter({ hasText: 'Plan draft' }).click();
    await expect(column.getByTestId('approvals-doc-failed')).toContainText("Couldn't reach qa-mini");
    // SAFETY: installElectronApiMock installs these test-only IPC controls on the page.
    const docReads = () => page.evaluate(() => (window as typeof window & { __paneTestElectronMock: { getMachineReads(): Array<{ machineId: string; channel: string }> } })
      .__paneTestElectronMock.getMachineReads().filter((read) => read.channel === 'autopilot:read-doc'));
    const before = (await docReads()).length;
    expect(before).toBeGreaterThan(0);
    await column.getByTestId('approvals-doc-retry').click();
    // Retry asks the same machine again.
    await expect.poll(async () => (await docReads()).length).toBeGreaterThan(before);
    expect((await docReads()).every((read) => read.machineId === 'mini')).toBe(true);
    await expect(column.getByTestId('approvals-doc-failed')).toContainText("Couldn't reach qa-mini");
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
    // The secret waits first, so Approvals opens it in the column beside the list.
    await page.getByTestId('approvals-nav').click();
    const column = page.getByTestId('approval-column');
    // The column names the request by its title; the masked field and the kept-out line make it a secret.
    await expect(column.getByTestId('approval-title')).toHaveText('Stripe test secret key');
    await expect(column).toContainText('Kept out of chat.');
    await expect(column).toContainText("Run the webhook integration tests against Stripe's test mode.");
    await expect(column).toContainText('Saves as Pane secret stripe/STRIPE_SECRET_KEY · replaces the saved value');
    const field = column.getByPlaceholder('Type the secret');
    await expect(field).toHaveAttribute('type', 'password');
    await expect(column.getByRole('button', { name: 'Save securely' })).toBeDisabled();

    // Digits go into the field; the card has no number-key shortcuts.
    await field.click();
    await field.pressSequentially('sk_test_123');
    await expect(column.getByRole('button', { name: 'Save securely' })).toBeEnabled();
    expect(await commands(page)).toEqual([]);
    await column.getByRole('button', { name: 'Save securely' }).click();
    await expect.poll(() => commands(page)).toEqual([{ type: 'answer', id: 'q-secret', answer: { text: 'sk_test_123' } }]);
    await expect(field).toHaveValue('');

    // The host couldn't save it: the card keeps waiting and says why where the destination was.
    const failed = secretFixture(true);
    failed.items[0] = { ...failed.items[0], secretError: 'The login keychain is locked. Nothing was saved. Unlock it and save again.' };
    // SAFETY: installElectronApiMock installs these test-only IPC controls on the page.
    await page.evaluate((snapshot) => (window as MockWindow).__paneTestElectronMock.emitNotifySnapshot(snapshot), failed);
    await expect(column.getByRole('alert')).toHaveText('The login keychain is locked. Nothing was saved. Unlock it and save again.');
    await expect(column).not.toContainText('Saves as Pane secret');
    await expect(field).toHaveValue('');

    await field.pressSequentially('typed then declined');
    await column.getByRole('button', { name: 'Decline' }).click();
    await expect.poll(async () => (await commands(page)).at(-1)).toEqual({ type: 'answer', id: 'q-secret', answer: { approved: false } });
    await expect(field).toHaveValue('');
  });

  test('the inbox history says where a secret was saved, never its value', async ({ page }) => {
    const snapshot = secretFixture();
    snapshot.items[0] = { ...snapshot.items[0], state: 'answered', answerSummary: 'Saved as stripe/STRIPE_SECRET_KEY', resolvedAt: Date.now() };
    snapshot.queue.shift();
    snapshot.strip = null;
    await boot(page, snapshot);
    await page.getByTestId('approvals-nav').click();
    const queue = page.getByTestId('approvals-queue');
    await queue.getByRole('tab', { name: /Done today/ }).click();
    await expect(queue.getByTestId('approvals-row').filter({ hasText: 'Stripe test secret key' })).toContainText('→ Saved as stripe/STRIPE_SECRET_KEY');
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

  test('makes a login for exact sites only, edits them, and shows who filled it, where and when', async ({ page }) => {
    const now = Date.now();
    await boot(page, notifyFixture(), {}, {
      secrets: [
        { project: 'bank', name: 'PIN', updatedAt: new Date(now - 3_600_000).toISOString(), machine: 'mac-studio', sites: ['https://bank.example'] },
        { project: 'bank', name: 'PASSWORD', updatedAt: new Date(now - 3_600_000).toISOString(), machine: 'mac-studio' },
      ],
      loginUses: [{ project: 'bank', name: 'PIN', site: 'https://bank.example', agent: 'Claude', pane: 'billing', at: new Date(now - 300_000).toISOString(), machine: 'parsa-devbox' }],
    });
    await openSecrets(page);
    const row = (address: string) => page.locator(`[data-secret="${address}"]`);
    await expect(row('bank/PIN').getByTestId('pane-secret-login')).toHaveText('Login for https://bank.exampleClaude in billing filled it on https://bank.example on parsa-devbox 5 minutes ago');
    // A login is never written into 1Password from here, and never shown as a plain secret.
    await expect(row('bank/PIN').getByRole('button', { name: 'Move to 1Password' })).toHaveCount(0);

    await row('bank/PASSWORD').getByRole('button', { name: 'Use as a login' }).click();
    const sites = page.getByLabel('Sign-in sites for bank/PASSWORD');
    const save = row('bank/PASSWORD').getByRole('form').getByRole('button', { name: 'Use as a login' });
    await sites.fill('http://bank.example');
    await expect(row('bank/PASSWORD')).toContainText('"http://bank.example" can\'t be a login\'s site.');
    await expect(save).toBeDisabled();
    await sites.fill('b\u0430nk.example');
    // A lookalike shows as the address it really is.
    await expect(row('bank/PASSWORD')).toContainText('https://xn--bnk-6cd.example');
    await sites.fill('bank.example/login https://bank.example:8443');
    await expect(row('bank/PASSWORD')).toContainText('Agents can fill it on https://bank.example, https://bank.example:8443 and nowhere else');
    await save.click();
    await expect(row('bank/PASSWORD').getByTestId('pane-secret-login')).toContainText('No recent fills.');

    await row('bank/PIN').getByRole('button', { name: 'Edit sites' }).click();
    await page.getByLabel('Sign-in sites for bank/PIN').fill('https://login.bank.example');
    await row('bank/PIN').getByRole('button', { name: 'Save sites' }).click();

    await page.getByRole('button', { name: 'Add secret' }).click();
    await page.getByLabel('Secret project').fill('shop');
    await page.getByLabel('Secret name').fill('PIN');
    await page.getByLabel('Secret value').fill('0000');
    await page.getByLabel('Secret sign-in site').fill('shop.example');
    await page.getByRole('button', { name: 'Save securely' }).click();
    await expect(row('shop/PIN').getByTestId('pane-secret-login')).toContainText('Login for https://shop.example');
    expect(await secretCalls(page)).toEqual([
      { action: 'setSites', project: 'bank', name: 'PASSWORD', sites: ['https://bank.example', 'https://bank.example:8443'] },
      { action: 'setSites', project: 'bank', name: 'PIN', sites: ['https://login.bank.example'] },
      { action: 'set', project: 'shop', name: 'PIN', sites: ['https://shop.example'] },
    ]);
  });

  test('adds a 1Password reference over a typed secret, leases it to the machines picked, and ends the lease', async ({ page }) => {
    const now = new Date().toISOString();
    await boot(page, notifyFixture(), {}, {
      secrets: [{ project: 'stripe', name: 'STRIPE_SECRET_KEY', updatedAt: now, machine: 'mac-studio' }],
      references: [{ project: 'stripe', name: 'DATABASE_URL', reference: 'op://Dev/Neon/url', updatedAt: now, machine: 'mac-studio' }],
      machines: [
        { id: 'local', name: 'This computer', online: true, refusal: null, memoryOnly: false },
        { id: 'devbox', name: 'parsa-devbox', online: true, refusal: null, memoryOnly: true },
        { id: 'old-mac', name: 'old-mac', online: true, refusal: 'old-mac runs a Pane too old for leases. Update Pane there.', memoryOnly: false },
      ],
    });
    await openSecrets(page);
    const reference = (address: string) => page.locator(`[data-testid="pane-secret-reference-row"][data-secret="${address}"]`);
    await expect(reference('stripe/DATABASE_URL')).toContainText('from 1Password');
    await expect(reference('stripe/DATABASE_URL')).toContainText('no lease');
    await expect(page.locator('[data-secret="stripe/STRIPE_SECRET_KEY"]').getByRole('button', { name: 'Move to 1Password' })).toBeDisabled();

    await page.getByRole('button', { name: 'Add from 1Password' }).click();
    await page.getByLabel('Reference project').fill('stripe');
    await page.getByLabel('Reference name').fill('STRIPE_SECRET_KEY');
    await page.getByLabel('1Password reference').fill('Dev/Stripe/credential');
    await expect(page.getByText('A 1Password reference looks like op://vault/item/field.', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add reference' })).toBeDisabled();
    await page.getByLabel('1Password reference').fill('op://Dev/Stripe/credential');
    await page.getByRole('button', { name: 'Add reference' }).click();
    // The name is a typed secret: adding the reference deletes it everywhere, so it asks first.
    const replace = page.getByRole('group', { name: 'Replace stripe/STRIPE_SECRET_KEY' });
    await expect(replace).toContainText('stripe/STRIPE_SECRET_KEY is a typed secret. Adding this reference deletes the typed value on every machine.');
    await replace.getByRole('button', { name: 'Replace' }).click();
    await expect(reference('stripe/STRIPE_SECRET_KEY')).toContainText('op://Dev/Stripe/credential');

    await page.getByRole('button', { name: 'Start lease' }).click();
    const form = page.getByRole('form', { name: 'Start lease for stripe' });
    await expect(form.getByLabel('This computer')).toBeChecked();
    await expect(form.getByLabel('old-mac')).toBeDisabled();
    await expect(form).toContainText('old-mac runs a Pane too old for leases. Update Pane there.');
    await expect(form).toContainText('Held in memory: ends if Pane restarts there.');
    await expect(form).toContainText('Lasts 24 hours');
    await form.getByLabel('DATABASE_URL').uncheck();
    await form.getByLabel('parsa-devbox').check();
    await form.getByRole('button', { name: 'Start lease' }).click();
    await expect(page.getByTestId('pane-secrets-lease-result')).toContainText('on This computer, parsa-devbox.');
    await expect(reference('stripe/STRIPE_SECRET_KEY')).toContainText('leased until');
    await expect(reference('stripe/DATABASE_URL')).toContainText('no lease');

    const lease = page.getByTestId('pane-secret-lease');
    await expect(lease).toContainText('On This computer, parsa-devbox (in memory)');
    await expect(page.getByText('A command already running keeps the values it started with.')).toBeVisible();
    await lease.getByRole('button', { name: 'End now' }).click();
    await expect(lease).toHaveCount(0);
    expect(await secretCalls(page)).toEqual([
      { action: 'setReference', project: 'stripe', name: 'STRIPE_SECRET_KEY', reference: 'op://Dev/Stripe/credential' },
      { action: 'startLease', request: { project: 'stripe', names: ['STRIPE_SECRET_KEY'], references: { STRIPE_SECRET_KEY: 'op://Dev/Stripe/credential', DATABASE_URL: 'op://Dev/Neon/url' }, machines: ['local', 'devbox'] } },
      { action: 'endLease', leaseId: 'lease-1' },
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
    await expect(page.getByRole('option')).toHaveText(['Whichever computer is in use', 'This computer (qa-macbook)', 'build-box', 'old-laptop (needs a newer Pane)']);
    await expect(page.getByRole('option', { name: 'old-laptop (needs a newer Pane)' })).toHaveAttribute('aria-disabled', 'true');
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
