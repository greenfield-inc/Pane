import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock, type TodosMockHooks, type TodosMockOptions } from './electronApiMock';
import { DEFAULT_NOTIFY_SETTINGS, type NotifyItem, type NotifySnapshot } from '../shared/types/notify';
import type { TodoAction, TodoActivity, TodoCreateInput, TodoDetail, TodoListRow, TodoRecord, TodoSnooze, TodoStatus } from '../shared/types/todos';

declare global {
  interface Window {
    __paneTestElectronMock: TodosMockHooks;
  }
}

// To-dos round 9 (T-17, D-431, D-432), renderer only with fixture to-dos: folding groups (S18–S22), the snooze menu,
// a snoozed to-do's page, Remind me… and the reminder card (S4, S9, S10, S17). Stills go to TODOS_SHOTS_DIR when set.
const SHOTS = process.env.TODOS_SHOTS_DIR;
const ZONE = 'America/Los_Angeles';
// Tue 17 Nov 2026, 3:11:30 PM PST, as in the mock-up.
const NOW = Date.parse('2026-11-17T15:11:30-08:00');
const WED_9 = Date.parse('2026-11-18T09:00:00-08:00');
const FRI_10 = Date.parse('2026-11-20T10:00:00-08:00');
const MIN = 60_000;

test.use({ timezoneId: ZONE });

function record(number: number, title: string, extra: Partial<TodoRecord> = {}): TodoRecord {
  return {
    number, ref: `T-${number}`, sessionId: `s-${number}`, parentNumber: null, title, summary: '', doneWhen: [], state: 'in_progress',
    requester: { kind: 'person', name: 'you' }, projectId: 1, agent: 'claude', assignee: null, createdBy: 'you', createdAt: NOW - 120 * MIN,
    startedAt: NOW - 120 * MIN, updatedAt: NOW - 2 * MIN, acceptedAt: null, closedAt: null, lastProgressAt: NOW, stuckSince: null, episodeReminders: 0,
    episodeRestarts: 0, stallsToday: 0, stallsDay: null, attachRemindedAt: null, workMs: 0, loadHold: null, loadHoldSince: null, loadOverride: null,
    stuckCardId: null, ...extra,
  };
}

function row(todo: TodoRecord, status: TodoStatus, extra: Partial<TodoListRow> = {}): TodoListRow {
  return { todo, status, machine: 'MacBook Pro', projectName: 'billing', ...extra };
}

const sentry = 'Check Sentry for PDF errors and the receipt download rate since yesterday’s deploy. Post what you find; open a fix PR if errors are above 0.5%.';
const snooze19: TodoSnooze = { until: WED_9, zone: ZONE, note: sentry, action: 'agents', by: 'orchestrator', from: 'in_progress', reminderCardId: null };
const snooze21: TodoSnooze = { until: FRI_10, zone: ZONE, note: 'Check the inbox for a reply from Northwind. If nothing, send the follow-up from the template.', action: 'remind', by: 'you', from: 'todo', reminderCardId: null };

const rows: TodoListRow[] = [
  row(record(15, 'Pick the dunning email cadence', { updatedAt: NOW - 12 * MIN }), { status: 'waiting', reason: 'Q-31 · Three reminders or two?', waitingApprovalId: 'q31', waitingQn: 'Q-31', waitingQuestion: 'Three reminders or two?', waitingCount: 1 }),
  row(record(14, 'Ship receipt PDFs', { requester: { kind: 'orchestrator', name: 'Billing receipts orchestrator', sessionId: 'billing' } }), { status: 'working', reason: '' }, { pr: { number: 7, label: 'PR #7 · checks passing' }, agentId: 'claude' }),
  row(record(16, 'Onboarding email copy', { updatedAt: NOW - 6 * MIN, requester: { kind: 'orchestrator', name: 'Onboarding emails orchestrator', sessionId: 'onboarding' } }), { status: 'working', reason: 'drafting the welcome email' }, { projectName: 'web', agentId: 'codex' }),
  row(record(18, 'Tidy the receipt template', { state: 'todo', sessionId: null, startedAt: null, updatedAt: NOW - 24 * 60 * MIN }), { status: 'idle', reason: 'not started', idleReason: 'not_started' }),
  row(record(19, 'Check how the receipt PDF launch went', { state: 'stopped', snooze: snooze19, requester: { kind: 'orchestrator', name: 'Billing receipts orchestrator', sessionId: 'billing' } }), { status: 'snoozed', reason: 'until Wed 9:00 AM' }),
  row(record(21, 'Check whether Northwind replied about the renewal', { state: 'todo', sessionId: null, startedAt: null, snooze: snooze21 }), { status: 'snoozed', reason: 'until Fri 10:00 AM' }, { projectName: 'web' }),
  row(record(23, 'Renew the Northwind contract', { state: 'todo', sessionId: null, startedAt: null, updatedAt: NOW - 30 * MIN }), { status: 'waiting', reason: 'Reminder: T-23 Renew the Northwind contract', waitingApprovalId: 'r23', waitingCount: 1 }),
];

function activity(number: number): TodoActivity[] {
  const base = { todoNumber: number, createdAt: NOW - 120 * MIN };
  const list: TodoActivity[] = [{ ...base, id: number * 100 + 1, kind: 'event', authorKind: 'pane', authorName: 'Pane', body: 'Started its own Session and orchestrator' }];
  if (number === 19) {
    list.push(
      { ...base, id: 1902, kind: 'message', authorKind: 'agent', authorName: 'orchestrator', authorTab: 'orch', body: 'Deployed receipts to production behind receipts.pdf at 3:40 PM; smoke test passed on 20 invoices.', createdAt: NOW - 120 * MIN },
      { ...base, id: 1903, kind: 'event', authorKind: 'agent', authorName: 'orchestrator', body: 'Snoozed until Wed 9:00 AM by the orchestrator: check Sentry', createdAt: NOW - 41 * MIN },
      { ...base, id: 1904, kind: 'event', authorKind: 'pane', authorName: 'Pane', body: 'Stopped by Pane (the orchestrator finished its step)', createdAt: NOW - 40 * MIN },
      { ...base, id: 1905, kind: 'message', authorKind: 'person', authorName: 'you', toTab: 'orch', toName: 'orchestrator', body: 'Also look at whether anyone opened a ticket about the logo on the PDF.', createdAt: NOW - 5 * MIN },
    );
  }
  return list;
}

function fixture(): TodosMockOptions {
  const details: Record<number, TodoDetail> = {};
  for (const listed of rows) {
    // oxlint-disable-next-line pane/no-bare-todo-number -- this mock serves one machine's to-dos by number, as main does.
    details[listed.todo.number] = {
      ...listed, subTodos: [], attachments: [{ attachments: [] }], activity: activity(listed.todo.number),
      // oxlint-disable-next-line pane/no-bare-todo-number -- this mock serves one machine's to-dos by number, as main does.
      approvalIds: listed.todo.number === 23 ? ['r23'] : listed.todo.number === 15 ? ['q31'] : [],
      chatTarget: { panelId: 'orch', name: 'orchestrator', kind: 'orchestrator' }, orchestrator: { panelId: 'orch', name: 'orchestrator', agentId: 'claude' },
      load: { gate: 'normal', canPause: true }, keepMoving: 'quiet 2m · 0 reminders',
    };
  }
  return { snapshot: { rows, gate: { state: 'normal', enabled: true, since: 0 }, machine: 'MacBook Pro', ownSessionIds: [] }, details, recordActivity: true };
}

function approvals(): NotifySnapshot {
  const reminder: NotifyItem = {
    id: 'r23', ui: 'options', title: 'Reminder: T-23 Renew the Northwind contract', state: 'waiting', createdAt: NOW - MIN,
    context: 'Due Fri 10:00 AM, overdue by 22h: Pane was closed.\n\nCheck the inbox for a reply from Northwind. If nothing, send the follow-up from the template.',
    choices: [{ label: 'Done' }, { label: 'Hand to an agent' }, { label: 'Snooze 1 hour' }, { label: 'Snooze to the next morning' }],
    source: { name: 'T-23', agent: 'Pane' }, todo: { number: 23, title: 'Renew the Northwind contract', kind: 'reminder' },
  };
  return {
    settings: { ...DEFAULT_NOTIFY_SETTINGS }, items: [reminder], queue: ['r23'], hidden: [], strip: null, stripSurface: null,
    pausedUntil: null, shortcutRegistered: true, showOutsideSupported: true, firstRun: false, instructionFiles: [],
  };
}

async function open(page: Page, dark = false) {
  await page.clock.setFixedTime(NOW);
  await page.setViewportSize({ width: 1440, height: 860 });
  await installElectronApiMock(page, {
    initialProjects: [{ id: 1, name: 'billing', path: '/tmp/billing', active: true, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' }],
    initialSessions: [],
    initialConfig: { theme: dark ? 'dark' : 'light-rounded', appearanceMode: 'fixed' },
    notifySnapshot: approvals(),
    todos: fixture(),
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('todos-nav').first().click();
  await expect(page.getByTestId('todos-view')).toBeVisible();
  await expect(page.locator('[data-testid="todo-row"]').first()).toBeVisible();
}

const header = (page: Page, key: string) => page.locator(`[data-testid="todos-group-header"][data-group="${key}"]`);
const todoRow = (page: Page, number: number) => page.locator(`[data-testid="todo-row"][data-todo="${number}"]`);
const selectedKey = (page: Page) => page.evaluate(() => {
  const row = document.querySelector('[data-testid="todo-row"][data-selected]');
  if (row) return `row:${row.getAttribute('data-todo')}`;
  const group = document.querySelector('[data-testid="todos-group-header"][data-selected]');
  return group ? `group:${group.getAttribute('data-group')}` : null;
});
const acts = (page: Page): Promise<TodoAction[]> => page.evaluate(() => window.__paneTestElectronMock.getInvokeCalls('todos:act').map((call) => call.args[0]));
const creates = (page: Page): Promise<TodoCreateInput[]> => page.evaluate(() => window.__paneTestElectronMock.getInvokeCalls('todos:create').map((call) => call.args[0]));
const key = (page: Page, name: string) => page.keyboard.press(name);
/** A reload starts on the app's first view: back to To-dos. */
async function reload(page: Page) {
  await page.reload();
  await page.getByTestId('todos-nav').first().click();
  await expect(page.locator('[data-testid="todo-row"]').first()).toBeVisible();
}

for (const dark of [false, true]) {
  const theme = dark ? 'dark' : 'light';

  test(`S17 S21 list, menu, page and card match the mock-up (${theme})`, async ({ page }) => {
    await open(page, dark);
    // S21: Snoozed starts folded with its count and next wake; its rows are hidden.
    await expect(header(page, 'status:snoozed')).toHaveAttribute('aria-expanded', 'false');
    await expect(header(page, 'status:snoozed').getByTestId('todos-group-count')).toHaveText('2');
    await expect(page.getByTestId('todos-group-next-wake')).toContainText('next wakes Wed 9:00 AM');
    await expect(todoRow(page, 19)).toHaveCount(0);
    await expect(page.getByTestId('todos-tab-snoozed')).toContainText('Snoozed2');
    await expect(page.getByTestId('todos-footer')).toContainText('fold · open group');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/r9-c-list-${theme}.png` });

    // Snoozed opened, soonest first; Idle folded.
    await header(page, 'status:snoozed').click();
    await header(page, 'status:idle').click();
    await expect(todoRow(page, 19).getByTestId('todo-row-reason')).toContainText('until Wed 9:00 AM · Check Sentry for PDF errors');
    await expect(todoRow(page, 19).getByTestId('todo-row-wakes-in')).toHaveText('17h');
    await expect(todoRow(page, 21).getByTestId('todo-row-reminder')).toBeVisible();
    await expect(todoRow(page, 21).getByTestId('todo-row-wakes-in')).toHaveText('2d');
    const order = await page.locator('[data-testid="todo-row"][data-status="snoozed"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-todo')));
    expect(order).toEqual(['19', '21']);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/r9-c-listopen-${theme}.png` });

    // The Z menu on T-14: presets with their times; Esc closes and keys go back to the list.
    await reload(page);
    await expect(todoRow(page, 14)).toBeVisible();
    await key(page, 'j');
    await key(page, 'j');
    expect(await selectedKey(page)).toBe('row:14');
    await key(page, 'z');
    const menu = page.getByTestId('snooze-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId('snooze-pick-hour')).toContainText('Today 4:12 PM');
    await expect(menu.getByTestId('snooze-pick-tomorrow')).toContainText('Wed 18 Nov, 9:00 AM');
    await expect(menu.getByTestId('snooze-pick-monday')).toContainText('Mon 23 Nov, 9:00 AM');
    await expect(menu.getByTestId('snooze-pick-tomorrow')).toHaveAttribute('aria-checked', 'true');
    await expect(menu.getByTestId('snooze-submit')).toContainText('Snooze until Wed 9:00 AM');
    await menu.getByTestId('snooze-note').fill(sentry);
    await menu.getByTestId('snooze-pick-tomorrow').focus();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/r9-c-menu-${theme}.png` });
    await key(page, 'Escape');
    await expect(menu).toHaveCount(0);
    expect(await page.evaluate(() => document.querySelector('[data-testid="todos-view"]')?.contains(document.activeElement))).toBe(true);
    await key(page, 'j');
    expect(await selectedKey(page)).toBe('row:16');

    // The snoozed page: chip, header button, banner, held comment and the composer's hint.
    await page.getByTestId('todos-tab-snoozed').click();
    await todoRow(page, 19).click();
    await expect(page.getByTestId('todo-chip-status')).toContainText('Snoozed until Wed 9:00 AM');
    await expect(page.getByTestId('todo-status-reason')).toHaveText('wakes in 17h · set by the orchestrator');
    await expect(page.getByTestId('todo-page-snoozed')).toContainText('Snoozed · Wed 9:00 AM');
    await expect(page.getByTestId('todo-snooze-banner')).toContainText('Snoozed until Wednesday 18 November, 9:00 AM PST.');
    await expect(page.getByTestId('todo-snooze-note')).toContainText('Check Sentry');
    await expect(page.locator('[data-testid="todo-thread-delivery"][data-held]')).toHaveText('Held: goes to the orchestrator with the wake-up note');
    await expect(page.getByTestId('todo-composer-held')).toContainText('Snoozed: comments are held until it wakes (Wed 9:00 AM).');
    await expect(page.getByTestId('todo-composer-input')).toHaveAttribute('placeholder', 'Comment… held until it wakes');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/r9-c-page-${theme}.png` });

    // The reminder card over the split, with "Snooze to another time…".
    await page.getByTestId('todo-page-back').click();
    await page.getByTestId('todos-tab-open').click();
    await todoRow(page, 23).click();
    await page.getByTestId('todo-chip-status').click();
    await expect(page.getByTestId('approval-reminder-snooze')).toBeVisible();
    await expect(page.getByTestId('approval-choice')).toHaveCount(4);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/r9-c-card-${theme}.png` });
  });
}

test('S17 S21: Z, 2, a note and ⏎ snooze the row; into a folded Snoozed the selection moves on and Show opens it', async ({ page }) => {
  await open(page);
  await key(page, 'j');
  await key(page, 'j');
  expect(await selectedKey(page)).toBe('row:14');
  await key(page, 'z');
  await key(page, '1');
  await expect(page.getByTestId('snooze-pick-hour')).toHaveAttribute('aria-checked', 'true');
  await key(page, '2');
  await page.getByTestId('snooze-note').fill('check Sentry');
  await key(page, 'Enter');
  await expect(page.getByTestId('snooze-menu')).toHaveCount(0);
  const sent = (await acts(page)).at(-1);
  expect(sent).toEqual({ kind: 'snooze', number: 14, until: WED_9, zone: ZONE, note: 'check Sentry', action: 'agents' });
  await expect(page.getByTestId('todos-snoozed-note')).toContainText('Snoozed T-14 until Wed 9:00 AM');
  await expect(header(page, 'status:snoozed').getByTestId('todos-group-count')).toHaveText('3');
  expect(await selectedKey(page)).toBe('row:16');
  await page.getByTestId('todos-snoozed-show').click();
  await expect(header(page, 'status:snoozed')).toHaveAttribute('aria-expanded', 'true');
  expect(await selectedKey(page)).toBe('row:14');
  await expect(todoRow(page, 14)).toHaveAttribute('data-status', 'snoozed');
});

test('S18: every group folds by its header and by ←, →, Enter and Space, under every grouping; counts stay', async ({ page }) => {
  await open(page);
  for (const grouping of ['status', 'requester', 'repo', 'machine']) {
    const headers = page.getByTestId('todos-group-header');
    const keys = await headers.evaluateAll((els) => els.map((el) => el.getAttribute('data-group') ?? ''));
    for (const groupKey of keys) {
      const target = header(page, groupKey);
      const count = await target.getByTestId('todos-group-count').textContent();
      const wasOpen = (await target.getAttribute('aria-expanded')) === 'true';
      await target.click();
      await expect(target).toHaveAttribute('aria-expanded', wasOpen ? 'false' : 'true');
      await expect(target.getByTestId('todos-group-count')).toHaveText(count ?? '');
      await target.click();
      await expect(target).toHaveAttribute('aria-expanded', wasOpen ? 'true' : 'false');
    }
    expect(keys.length, grouping).toBeGreaterThan(0);
    await key(page, 'g');
  }
  // Back on Status: ← on a row folds its group and selects the header; →, Enter and Space open it with its first row.
  await expect(header(page, 'status:working')).toBeVisible();
  for (let step = 0; step < 8; step += 1) await key(page, 'k');
  await key(page, 'j');
  await key(page, 'j');
  expect(await selectedKey(page)).toBe('row:14');
  for (const opener of ['ArrowRight', 'Enter', 'Space']) {
    await key(page, 'ArrowLeft');
    await expect(header(page, 'status:working')).toHaveAttribute('aria-expanded', 'false');
    await expect(todoRow(page, 14)).toHaveCount(0);
    expect(await selectedKey(page)).toBe('group:status:working');
    await key(page, opener);
    await expect(header(page, 'status:working')).toHaveAttribute('aria-expanded', 'true');
    expect(await selectedKey(page)).toBe('row:14');
  }
  if (SHOTS) {
    await key(page, 'ArrowLeft');
    await page.screenshot({ path: `${SHOTS}/r9-c-s18-folded-light.png` });
  }
});

test('S19: J walks every visible row and stops once on each folded header; K walks back', async ({ page }) => {
  await open(page);
  // Folding Idle by its header selects that header.
  await header(page, 'status:idle').click();
  const up: Array<string | null> = [await selectedKey(page)];
  for (let step = 0; step < 5; step += 1) {
    await key(page, 'k');
    up.push(await selectedKey(page));
  }
  expect(up).toEqual(['group:status:idle', 'row:16', 'row:14', 'row:23', 'row:15', 'row:15']);
  const down: Array<string | null> = [];
  for (let step = 0; step < 6; step += 1) {
    await key(page, 'j');
    down.push(await selectedKey(page));
  }
  expect(down).toEqual(['row:23', 'row:14', 'row:16', 'group:status:idle', 'group:status:snoozed', 'group:status:snoozed']);
  // Opening a folded header from the keyboard selects its first row.
  await key(page, 'Enter');
  expect(await selectedKey(page)).toBe('row:19');
});

test('S20: folds are kept per tab × grouping, survive a reload and a trip to a to-do', async ({ page }) => {
  await open(page);
  await header(page, 'status:idle').click();
  await expect(header(page, 'status:idle')).toHaveAttribute('aria-expanded', 'false');
  // Open by repo: its groups are its own.
  await key(page, 'g');
  await key(page, 'g');
  await expect(header(page, 'repo:billing')).toHaveAttribute('aria-expanded', 'true');
  await key(page, 'g');
  await key(page, 'g');
  await expect(header(page, 'status:idle')).toHaveAttribute('aria-expanded', 'false');
  // The All tab by status keeps its own.
  await page.getByTestId('todos-tab-all').click();
  await expect(header(page, 'status:idle')).toHaveAttribute('aria-expanded', 'true');
  await page.getByTestId('todos-tab-open').click();
  await reload(page);
  await expect(header(page, 'status:idle')).toHaveAttribute('aria-expanded', 'false');
  // Open a to-do and come back: still folded; Esc back from a to-do in a folded group selects its header.
  await header(page, 'status:snoozed').click();
  await todoRow(page, 19).click();
  await expect(page.getByTestId('todo-page')).toBeVisible();
  await page.getByTestId('todo-page-back').click();
  await expect(header(page, 'status:idle')).toHaveAttribute('aria-expanded', 'false');
  await expect(header(page, 'status:snoozed')).toHaveAttribute('aria-expanded', 'true');
  await header(page, 'status:snoozed').click();
  expect(await selectedKey(page)).toBe('group:status:snoozed');
});

test('S21: in the Snoozed tab Snoozed starts open; opening it in Open is remembered', async ({ page }) => {
  await open(page);
  await page.getByTestId('todos-tab-snoozed').click();
  await expect(header(page, 'status:snoozed')).toHaveAttribute('aria-expanded', 'true');
  await expect(todoRow(page, 19)).toBeVisible();
  await page.getByTestId('todos-tab-open').click();
  await expect(header(page, 'status:snoozed')).toHaveAttribute('aria-expanded', 'false');
  await header(page, 'status:snoozed').click();
  await reload(page);
  await expect(header(page, 'status:snoozed')).toHaveAttribute('aria-expanded', 'true');
});

test('S22 S10: R wakes a row now; it leaves Snoozed for its group, the selection follows, and a folded destination stays folded', async ({ page }) => {
  await open(page);
  await header(page, 'status:snoozed').click();
  // Opening Snoozed selects its first row, T-19: R, then Wake now.
  expect(await selectedKey(page)).toBe('row:19');
  await key(page, 'r');
  await page.getByTestId('todo-confirm-action').click();
  expect((await acts(page)).at(-1)).toEqual({ kind: 'wake', number: 19 });
  await expect(todoRow(page, 19)).toHaveAttribute('data-status', 'working');
  await expect(header(page, 'status:snoozed').getByTestId('todos-group-count')).toHaveText('1');
  await expect(header(page, 'status:working').getByTestId('todos-group-count')).toHaveText('3');
  expect(await selectedKey(page)).toBe('row:19');
  // The reminder wakes into Waiting on you, which is folded: it stays folded and its count rises.
  await header(page, 'status:waiting').click();
  await todoRow(page, 21).hover();
  await todoRow(page, 21).getByTestId('todo-row-wake').click();
  await page.getByTestId('todo-confirm-action').click();
  await expect(header(page, 'status:waiting').getByTestId('todos-group-count')).toHaveText('3');
  await expect(header(page, 'status:waiting')).toHaveAttribute('aria-expanded', 'false');
  await expect(header(page, 'status:snoozed')).toHaveCount(0);
});

test('S9 S10: a snoozed page holds comments; Wake now and send sends it, then wakes; Change opens the menu', async ({ page }) => {
  await open(page);
  await page.getByTestId('todos-tab-snoozed').click();
  await todoRow(page, 19).click();
  await page.getByTestId('todo-snooze-change').click();
  const menu = page.getByTestId('snooze-menu');
  await expect(menu.getByTestId('snooze-note')).toHaveValue(sentry);
  await expect(menu.getByTestId('snooze-pick-custom')).toHaveAttribute('aria-checked', 'true');
  await expect(menu.getByTestId('snooze-date')).toHaveValue('2026-11-18');
  await expect(menu.getByTestId('snooze-time')).toHaveValue('09:00');
  await key(page, 'Escape');
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId('todo-page')).toBeVisible();
  await page.getByTestId('todo-composer-input').fill('Look at the logo ticket too.');
  await page.getByTestId('todo-composer-wake-send').click();
  await expect.poll(async () => (await acts(page)).map((action) => action.kind)).toEqual(['comment', 'wake']);
  await expect(page.getByTestId('todo-snooze-banner')).toHaveCount(0);
  await expect(page.getByTestId('todo-chip-status')).toContainText('Working');
});

test('S4: New to-do, Remind me…: Fri 10:00 AM with a note creates it snoozed, as a reminder', async ({ page }) => {
  await open(page);
  await page.getByTestId('todos-new').click();
  await page.getByTestId('new-todo-title').fill('Check whether Northwind replied');
  await page.getByTestId('new-todo-status').click();
  await page.getByRole('menuitemradio', { name: /Remind me/ }).click();
  const menu = page.getByTestId('snooze-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByTestId('snooze-action-remind')).toHaveAttribute('aria-checked', 'true');
  await key(page, '4');
  await menu.getByTestId('snooze-date').fill('2026-11-20');
  await menu.getByTestId('snooze-time').fill('10:00');
  await menu.getByTestId('snooze-note').fill('Check the inbox for a reply.');
  await expect(menu.getByTestId('snooze-submit')).toContainText('Remind me until Fri 10:00 AM');
  await key(page, 'Enter');
  await expect(menu).toHaveCount(0);
  await expect(page.getByTestId('new-todo-dialog')).toBeVisible();
  await expect(page.getByTestId('new-todo-status')).toContainText('Remind me · Fri 10:00 AM');
  await page.getByTestId('new-todo-create').click();
  await expect.poll(async () => (await creates(page)).length).toBe(1);
  const [input] = await creates(page);
  expect(input.startNow).toBe(false);
  expect(input.snooze).toEqual({ until: FRI_10, zone: ZONE, note: 'Check the inbox for a reply.', action: 'remind' });
});

test('the reminder card: "Snooze to another time…" opens the to-do with the snooze menu', async ({ page }) => {
  await open(page);
  await todoRow(page, 23).click();
  await page.getByTestId('todo-chip-status').click();
  await page.getByTestId('approval-reminder-snooze').click();
  await expect(page.getByTestId('snooze-menu')).toBeVisible();
  await expect(page.getByTestId('snooze-menu')).toContainText('T-23 Renew the Northwind contract');
});

test('a pure reminder reads as Pane\'s: no orchestrator chip, Pane asks you, comments stay on it (QA round 9 F3)', async ({ page }) => {
  await open(page);
  await todoRow(page, 23).click();
  await expect(page.getByTestId('todo-page')).toHaveAttribute('data-todo', '23');
  await expect(page.getByTestId('todo-chip-agents')).toHaveCount(0);
  await expect(page.getByTestId('todo-composer-to')).toHaveText('Comments stay here: no agent works on this reminder');
  await expect(page.getByTestId('todo-chat')).toContainText('Pane asks you');
  await expect(page.getByTestId('todo-chat')).not.toContainText('T-23 asks you');
});

test('in a narrow page column the snooze banner puts Change and Wake now under its words (QA round 9 F2)', async ({ page }) => {
  await open(page);
  await page.getByTestId('todos-tab-snoozed').click();
  await todoRow(page, 19).click();
  await expect(page.getByTestId('todo-snooze-banner')).toBeVisible();
  // Narrowed while on the page: the split stays beside it and the page column is about 300 px.
  await page.setViewportSize({ width: 900, height: 900 });
  const banner = page.getByTestId('todo-snooze-banner');
  await expect.poll(async () => {
    const words = await banner.locator('p').first().boundingBox();
    const change = await page.getByTestId('todo-snooze-change').boundingBox();
    return words && change ? change.y >= words.y + words.height - 1 : false;
  }).toBe(true);
});
