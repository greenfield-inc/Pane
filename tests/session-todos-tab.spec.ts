import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock, type TodosMockHooks, type TodosMockOptions } from './electronApiMock';
import { DEFAULT_NOTIFY_SETTINGS, type NotifyItem, type NotifySnapshot } from '../shared/types/notify';
import type { JsonObject, JsonValue } from '../shared/validation/boundaryDecoder';
import { emitRemoteHostEvent, openConnectedRemotePwa } from './remotePwaMock';
import type { TodoDetail, TodoListRow, TodoRecord, TodoStatus } from '../shared/types/todos';

declare global {
  interface Window {
    __paneTestElectronMock: TodosMockHooks;
  }
}

// T-23 (D-440, option 1), renderer only with fixture Sessions and to-dos: a To-dos tab next to Overview in a
// Session's split, its list in the To-dos screen's groups, a to-do opened in the tab and back, an approval
// answered from its row, the empty state and a 1000 px window. Stills go to SESSION_TODOS_SHOTS_DIR when set.
const SHOTS = process.env.SESSION_TODOS_SHOTS_DIR;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.now();
const ISO = new Date(NOW - 3 * HOUR).toISOString();
const BILLING = 'billing';
const DOCS = 'docs';
const QUESTION = 'Three dunning reminders or two?';
const DEVBOX = 'devbox';
/** A saved computer the window can switch to (T-37's All machines case). */
const DEVBOX_COMPUTER = { id: DEVBOX, label: 'devbox', routes: [{ id: 'public:https://devbox.example:8443', kind: 'public' as const, source: 'manual' as const, baseUrl: 'https://devbox.example:8443', token: 'paired' }] };

function record(number: number, title: string, extra: Partial<TodoRecord> = {}): TodoRecord {
  return {
    number, ref: `T-${number}`, sessionId: `hidden-${number}`, parentNumber: null, title, summary: '', doneWhen: [], state: 'in_progress',
    requester: { kind: 'orchestrator', name: 'Billing rewrite orchestrator', sessionId: BILLING, panelId: 'billing-claude' }, projectId: 1, agent: 'claude',
    assignee: null, createdBy: 'Billing rewrite orchestrator', createdAt: NOW - 3 * HOUR, startedAt: NOW - 3 * HOUR, updatedAt: NOW - MIN, acceptedAt: null,
    closedAt: null, lastProgressAt: NOW, stuckSince: null, episodeReminders: 0, episodeRestarts: 0, stallsToday: 0, stallsDay: null,
    attachRemindedAt: null, workMs: 0, loadHold: null, loadHoldSince: null, loadOverride: null, stuckCardId: null, ...extra,
  };
}

function row(todo: TodoRecord, status: TodoStatus, subCounts?: TodoListRow['subCounts']): TodoListRow {
  const made: TodoListRow = { todo, status, machine: 'This Mac', projectName: 'billing', sessionName: todo.title };
  if (subCounts) made.subCounts = subCounts;
  return made;
}

const worker = (name: string) => ({ panelId: `${name}-panel`, name });
const waiting: TodoStatus = { status: 'waiting', reason: QUESTION, waitingApprovalId: 'q31', waitingQn: 'Q-31', waitingQuestion: 'Three reminders or two?', waitingCount: 1 };

function rows(answered = false): TodoListRow[] {
  return [
    row(record(15, 'Pick the dunning email cadence', { assignee: worker('planner'), updatedAt: NOW - 12 * MIN }),
      answered ? { status: 'working', reason: 'planner is writing the cadence into the plan' } : waiting),
    row(record(14, 'Ship receipt PDFs', { assignee: worker('implementer'), updatedAt: NOW - 2 * MIN, summary: 'Render every paid invoice as a PDF receipt, attach it to the receipt email and offer it on the billing page.' }),
      { status: 'working', reason: 'PR #7 · QA running, 2 of 3 done' }, { done: 2, total: 5 }),
    row(record(16, 'Onboarding email copy', { assignee: worker('writer'), updatedAt: NOW - 6 * MIN }), { status: 'working', reason: 'drafting the welcome email' }),
    row(record(18, 'Tidy the receipt template', { state: 'todo', agent: null, startedAt: null, sessionId: null, updatedAt: NOW - DAY }), { status: 'idle', reason: 'not started', idleReason: 'not_started' }),
    row(record(19, 'Check how the receipt PDF launch went', {
      state: 'stopped', updatedAt: NOW - 17 * HOUR,
      snooze: { until: NOW + 2 * DAY, zone: 'UTC', note: 'check Sentry and the download rate', action: 'agents', by: 'you', from: 'stopped', reminderCardId: null },
    }), { status: 'snoozed', reason: '' }),
    row(record(12, 'Invoice PDFs', { state: 'done', closedAt: NOW - 2 * DAY, updatedAt: NOW - 2 * DAY }), { status: 'done', reason: 'accepted by you' }),
    row(record(13, 'Bundle the fonts', { state: 'done', closedAt: NOW - 2 * DAY - HOUR, updatedAt: NOW - 2 * DAY }), { status: 'done', reason: 'merged in #6' }),
    row(record(11, 'Tax ID on invoices', { state: 'done', closedAt: NOW - 4 * DAY, updatedAt: NOW - 4 * DAY }), { status: 'done', reason: 'merged in #5' }),
    // Closed ten days ago: on the To-dos screen, not in the tab.
    row(record(5, 'Old invoice layout', { state: 'done', closedAt: NOW - 10 * DAY, updatedAt: NOW - 10 * DAY }), { status: 'done', reason: '' }),
  ];
}

function snapshot(answered = false) {
  const list = rows(answered);
  return { rows: list, gate: { state: 'normal' as const, enabled: true, since: 0 }, machine: 'This Mac', ownSessionIds: list.flatMap(r => (r.todo.sessionId ? [r.todo.sessionId] : [])) };
}

function todos(): TodosMockOptions {
  const details: Record<number, TodoDetail> = {};
  for (const r of rows()) {
    details[r.todo.number] = {
      ...r, subTodos: [], attachments: [{ attachments: [] }], activity: [], approvalIds: r.todo.number === 15 ? ['q31'] : [],
      chatTarget: { panelId: 'orch', name: 'orchestrator', kind: 'orchestrator' }, orchestrator: { panelId: 'orch', name: 'orchestrator', agentId: 'claude' },
      load: { gate: 'normal', canPause: true }, keepMoving: '',
    };
  }
  details[14].todo.doneWhen = [{ text: 'A paid invoice has a PDF within 10 s', met: true }, { text: 'The receipt email carries it', met: true }, { text: 'Totals match the invoice to the cent', met: false }];
  return { snapshot: snapshot(), details };
}

function approvals(answered = false): NotifySnapshot {
  const q31: NotifyItem = {
    id: 'q31', ui: 'options', title: `Q-31: ${QUESTION}`, state: answered ? 'answered' : 'waiting', createdAt: NOW - 12 * MIN,
    context: 'Three catches more late payers; two sends fewer emails. The plan\'s J4 counts the reminders sent.',
    choices: [
      { label: 'Three reminders', detail: 'Day 3, 7 and 14', recommended: true },
      { label: 'Two reminders', detail: 'Day 5 and 14' },
      { label: 'One, then a call', detail: 'Day 7, then account manager' },
    ],
    source: { name: 'planner', agent: 'Claude', session: { id: 'hidden-15', name: 'T-15 · Pick the dunning email cadence' } },
    todo: { number: 15, title: 'Pick the dunning email cadence' },
  };
  return {
    settings: { ...DEFAULT_NOTIFY_SETTINGS }, items: [q31], queue: answered ? [] : ['q31'], hidden: [], strip: null, stripSurface: null,
    pausedUntil: null, shortcutRegistered: true, showOutsideSupported: true, firstRun: false, instructionFiles: [],
  };
}

function sessionRecord(id: string, name: string): JsonObject {
  return {
    id, name, agent: 'claude', internalSessionId: `__orchestration_session_${id}__`,
    panelIds: { claude: `__orchestration_panel_${id}_claude`, codex: `__orchestration_panel_${id}_codex`, cursor: `__orchestration_panel_${id}_cursor` },
    goal: '', context: '', decisions: [], blockers: [], nextAction: '', evidence: [], outputs: [], associations: [],
    activity: [], revision: 1, createdAt: ISO, updatedAt: ISO, archived: false, isPinned: false,
  };
}

/** Billing rewrite (its to-dos above) and Docs refresh (none), Billing selected. */
async function installSessions(page: Page, selected: string) {
  await page.addInitScript(({ records, first }) => {
    type SessionRecord = { id: string; name: string; agent: 'claude'; panelIds: Record<string, string>; internalSessionId: string; createdAt: string; updatedAt: string; revision: number };
    // SAFETY: every seed record is built by sessionRecord above, with these fields.
    const sessions = structuredClone(records) as SessionRecord[];
    const success = <Value>(data: Value) => ({ success: true as const, data: structuredClone(data) });
    let selectedSessionId = first;
    const find = (selector: { sessionId?: string }) => {
      const found = sessions.find(session => session.id === selector.sessionId);
      if (!found) throw new Error(`Session ${selector.sessionId} not found`);
      return found;
    };
    const view = (session: SessionRecord) => ({
      session,
      internalSession: { id: session.internalSessionId, name: session.name, worktreePath: '/tmp/t23-session', prompt: '', status: 'stopped', createdAt: session.createdAt, lastActivity: session.updatedAt, output: [], jsonMessages: [], isRunning: false, permissionMode: 'ignore', toolType: 'none', archived: false, isHidden: true },
      panel: { id: session.panelIds[session.agent], sessionId: session.internalSessionId, type: 'terminal', title: session.name, state: { isActive: true, hasBeenViewed: true, customState: { agentType: session.agent, isCliPanel: true, isInitialized: false } }, metadata: { createdAt: session.createdAt, lastActiveAt: session.updatedAt, position: 0, permanent: true } },
      agent: session.agent, cwd: '/tmp/t23-session', guidePath: '/tmp/t23-session/guide.md', started: false,
    });
    Object.assign(window.electronAPI, {
      orchestrationSessions: {
        runtimes: async () => success({ distributions: [] }),
        list: async () => success({ sessions, selectedSessionId }),
        select: async (selector: { sessionId?: string }) => {
          selectedSessionId = find(selector).id;
          return success({ sessions, selectedSessionId });
        },
        get: async (selector: { sessionId?: string }) => success(view(find(selector))),
        update: async (selector: { sessionId?: string }) => success(find(selector)),
        reorder: async () => success({ sessions, selectedSessionId }),
        overview: async (selector: { sessionId?: string }) => success({ session: find(selector), status: 'active', refreshedAt: new Date().toISOString(), panes: [], activity: [] }),
        archivePreview: async (selector: { sessionId?: string }) => success({ sessionId: find(selector).id, panes: [] }),
      },
    });
  }, { records: [sessionRecord(BILLING, 'Billing rewrite'), sessionRecord(DOCS, 'Docs refresh')], first: selected });
}

interface OpenOptions { dark?: boolean; width?: number; session?: string; createdNumber?: number; notify?: NotifySnapshot; devbox?: boolean }

async function open(page: Page, { dark = false, width = 1440, session = BILLING, createdNumber, notify = approvals(), devbox = false }: OpenOptions = {}) {
  await page.setViewportSize({ width, height: 900 });
  await installElectronApiMock(page, {
    initialProjects: [{ id: 1, name: 'billing', path: '/tmp/billing', active: true, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' }],
    initialSessions: [],
    initialConfig: { theme: dark ? 'dark' : 'light-rounded', appearanceMode: 'fixed' },
    notifySnapshot: notify,
    todos: { ...todos(), createdNumber },
    computers: devbox ? [DEVBOX_COMPUTER] : [],
  });
  await installSessions(page, session);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: `Open Session ${session === BILLING ? 'Billing rewrite' : 'Docs refresh'}` }).click({ timeout: 15_000 });
  await expect(page.locator(`[data-session-content-id="${session}"]`)).toBeVisible({ timeout: 15_000 });
}

const todosTab = (page: Page) => page.getByRole('tab', { name: /^To-dos/ });
const rowOf = (page: Page, number: number) => page.locator(`[data-testid="session-todo-row"][data-todo="${number}"]`);
const group = (page: Page, key: string) => page.locator(`[data-testid="session-todos-group"][data-group="${key}"]`);
const shownRows = (page: Page) => page.getByTestId('session-todo-row').evaluateAll(nodes => nodes.map(node => Number(node.getAttribute('data-todo'))));
const selectedRow = (page: Page) => page.locator('[data-testid="session-todo-row"][data-selected]');

async function showTodos(page: Page) {
  await todosTab(page).click();
  await expect(page.getByTestId('session-todos-tab')).toBeVisible();
}

async function still(page: Page, name: string) {
  if (!SHOTS) return;
  // Let the tab's status rings settle a frame.
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

for (const dark of [false, true]) {
  const theme = dark ? 'dark' : 'light';

  test(`the To-dos tab sits after Overview and lists the Session's to-dos in groups, Snoozed and Done this week folded (${theme})`, async ({ page }) => {
    await open(page, { dark });
    const tabs = page.locator('[data-panel-group-id]').filter({ has: page.getByRole('tab', { name: 'Overview' }) }).getByRole('tab');
    await expect.poll(() => tabs.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))).toEqual(['Overview', 'To-dos, 1 waiting on you']);
    // T-15's question waits on you: the tab's amber count, counted once.
    await expect(todosTab(page)).toHaveAccessibleName('To-dos, 1 waiting on you');
    await expect(todosTab(page).locator('xpath=..').getByTestId('panel-tab-badge')).toHaveText('1');
    await showTodos(page);
    await expect(page.getByTestId('session-todos-open-count')).toHaveText('· 4 open');
    await expect(page.getByTestId('session-todos-group')).toHaveText([/Waiting on you\s*1/, /Working\s*2/, /Idle\s*1/, /Snoozed\s*1/, /Done this week\s*3/]);
    await expect(group(page, 'status:snoozed')).toHaveAttribute('data-folded', 'true');
    await expect(group(page, 'status:snoozed')).toContainText('next wakes');
    await expect(group(page, 'status:done')).toHaveAttribute('data-folded', 'true');
    await expect(group(page, 'status:done')).toContainText('older ones in To-dos');
    expect(await shownRows(page)).toEqual([15, 14, 16, 18]);
    await expect(rowOf(page, 15).getByTestId('session-todo-reason')).toHaveText('Q-31 · Three reminders or two?');
    await expect(rowOf(page, 15).getByTestId('session-todo-answer')).toBeVisible();
    await expect(rowOf(page, 14).getByTestId('session-todo-worker')).toHaveText('implementer');
    await still(page, `option1-main-${theme}`);

    // J/K move, → opens a folded group, ← folds it again (D-432's keys).
    await page.getByTestId('session-todos-list').focus();
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    await expect(group(page, 'status:snoozed')).toHaveAttribute('data-selected', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(selectedRow(page)).toHaveAttribute('data-todo', '19');
    await expect(rowOf(page, 19).getByTestId('session-todo-reason')).toContainText('check Sentry and the download rate');
    await page.keyboard.press('ArrowLeft');
    await expect(group(page, 'status:snoozed')).toHaveAttribute('data-folded', 'true');
    // Done this week opens to its three, newest first; the one closed ten days ago stays on the To-dos screen.
    await group(page, 'status:done').click();
    expect(await shownRows(page)).toEqual([15, 14, 16, 18, 12, 13, 11]);
  });

  test(`a to-do opens in the tab, ↑ ↓ step, and Esc returns with the same row selected (${theme})`, async ({ page }) => {
    await open(page, { dark });
    await showTodos(page);
    await rowOf(page, 14).click();
    const pageView = page.getByTestId('todo-page');
    await expect(pageView).toHaveAttribute('data-todo', '14');
    await expect(page.getByTestId('todo-page-title')).toHaveText('Ship receipt PDFs');
    await expect(page.getByTestId('todo-breadcrumb')).toHaveText(/\/\s*T-14/);
    await expect(page.getByTestId('todo-page-back')).toHaveText('To-dos');
    // In the narrow split column the to-do's own split starts hidden.
    await expect(page.getByTestId('todo-page-split')).toHaveCount(0);
    await still(page, `option1-open-${theme}`);
    await page.keyboard.press('ArrowDown');
    await expect(pageView).toHaveAttribute('data-todo', '16');
    await page.keyboard.press('k');
    await expect(pageView).toHaveAttribute('data-todo', '14');
    await page.getByTestId('session-todo-prev').click();
    await expect(pageView).toHaveAttribute('data-todo', '15');
    await page.getByTestId('session-todo-next').click();
    await expect(pageView).toHaveAttribute('data-todo', '14');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('session-todos-list')).toBeVisible();
    await expect(selectedRow(page)).toHaveAttribute('data-todo', '14');
    // ‹ To-dos does the same.
    await rowOf(page, 16).click();
    await expect(pageView).toHaveAttribute('data-todo', '16');
    await page.getByTestId('todo-page-back').click();
    await expect(selectedRow(page)).toHaveAttribute('data-todo', '16');
    // The tab keeps where it was while another tab shows.
    await rowOf(page, 18).click();
    await expect(pageView).toHaveAttribute('data-todo', '18');
    await page.getByRole('tab', { name: 'Overview' }).click();
    await showTodos(page);
    await expect(pageView).toHaveAttribute('data-todo', '18');
  });

  test(`Answer opens the approval in the tab, and Send clears the count (${theme})`, async ({ page }) => {
    await open(page, { dark });
    await showTodos(page);
    await rowOf(page, 15).getByTestId('session-todo-answer').click();
    const column = page.getByTestId('session-todo-approval');
    await expect(column).toBeVisible();
    await expect(column.getByTestId('approval-tab').first()).toHaveAttribute('aria-selected', 'true');
    await expect(column).toContainText(QUESTION);
    await expect(column.getByTestId('approval-pager')).toHaveText('1 of 1');
    await column.getByText('Three reminders', { exact: true }).click();
    await still(page, `option1-approval-${theme}`);
    // ‹ Back to To-dos leaves it unanswered.
    await page.getByTestId('session-todo-approval-back').click();
    await expect(selectedRow(page)).toHaveAttribute('data-todo', '15');
    await rowOf(page, 15).getByTestId('session-todo-answer').click();
    await column.getByRole('button', { name: /^Send/ }).click();
    await expect.poll(() => page.evaluate(() => window.__paneTestElectronMock.getNotifyCommands().map(command => command.type))).toContain('answer');
    // Back on the list once Send is accepted; main then moves the approval on and T-15 works again.
    await expect(page.getByTestId('session-todos-list')).toBeVisible();
    await page.evaluate(({ notify, list }) => {
      window.__paneTestElectronMock.emitNotifySnapshot(notify);
      window.__paneTestElectronMock.setTodosSnapshot(list);
    }, { notify: approvals(true), list: snapshot(true) });
    await expect(todosTab(page)).toHaveAccessibleName('To-dos');
    await expect(page.getByTestId('panel-tab-badge')).toHaveCount(0);
    await expect(page.getByTestId(`orchestration-session-${BILLING}`).getByTestId('session-approvals-count')).toHaveCount(0);
    await expect(rowOf(page, 15)).toHaveAttribute('data-status', 'working');
    await expect(rowOf(page, 15).getByTestId('session-todo-answer')).toHaveCount(0);
  });

  test(`a Session with no to-dos says so and offers New to-do (${theme})`, async ({ page }) => {
    await open(page, { dark, session: DOCS });
    await expect(todosTab(page)).toHaveAccessibleName('To-dos');
    await showTodos(page);
    await expect(page.getByTestId('session-todos-empty')).toContainText('No to-dos in this Session yet');
    await still(page, `option1-empty-${theme}`);
    await page.getByTestId('session-todos-empty-new').click();
    await expect(page.getByRole('dialog', { name: /New to-do/ })).toBeVisible();
  });

  test(`at a 1000 px window the rows keep the title, reason and time (${theme})`, async ({ page }) => {
    await open(page, { dark, width: 1000 });
    await showTodos(page);
    await expect(page.getByTestId('session-todos-tab')).toHaveAttribute('data-narrow', 'true');
    await expect(rowOf(page, 14)).toContainText('Ship receipt PDFs');
    await expect(rowOf(page, 14).getByTestId('session-todo-reason')).toHaveText('PR #7 · QA running, 2 of 3 done');
    await expect(rowOf(page, 14).getByTestId('session-todo-ref')).toHaveCount(0);
    await expect(rowOf(page, 14).getByTestId('session-todo-worker')).toHaveCount(0);
    await expect(rowOf(page, 15).getByTestId('session-todo-answer')).toBeVisible();
    // Nothing spills past the column.
    const spill = await page.getByTestId('session-todos-tab').evaluate((tab) => {
      const right = tab.getBoundingClientRect().right;
      return [...tab.querySelectorAll<HTMLElement>('*')].filter(node => node.getBoundingClientRect().right > right + 1).length;
    });
    expect(spill).toBe(0);
    await still(page, `option1-narrow-${theme}`);
  });
}

// T-37: the Session's right sidebar has To-dos beside Files and Changes: each requested to-do with its live status,
// sub-to-do progress and approvals waiting on you; a click opens it in the split's To-dos tab.
const sidebar = (page: Page) => page.getByRole('complementary', { name: /^Session / });
const sidebarTodosTab = (page: Page) => sidebar(page).getByRole('tab', { name: /^To-dos/ });
const sidebarRow = (page: Page, number: number) => page.locator(`[data-testid="sidebar-todo-row"][data-todo="${number}"]`);
const sidebarRows = (page: Page) => page.getByTestId('sidebar-todo-row').evaluateAll(nodes => nodes.map(node => [Number(node.getAttribute('data-todo')), node.getAttribute('data-status')]));

async function showSidebarTodos(page: Page) {
  await page.getByRole('button', { name: 'Show details' }).click();
  await sidebarTodosTab(page).click();
  await expect(sidebarTodosTab(page)).toHaveAttribute('aria-selected', 'true');
}

async function sidebarStill(page: Page, name: string) {
  if (!SHOTS) return;
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

for (const dark of [false, true]) {
  const theme = dark ? 'dark' : 'light';

  test(`the sidebar's To-dos lists requested to-dos with status, sub-to-do progress and approvals (${theme})`, async ({ page }) => {
    await open(page, { dark });
    await page.getByRole('button', { name: 'Show details' }).click();
    await expect(sidebar(page).getByRole('tab')).toHaveText(['Files', 'Changes', /^To-dos/]);
    await expect(sidebarTodosTab(page)).toHaveAccessibleName('To-dos, 1 waiting on you');
    await sidebarTodosTab(page).click();
    // Open ones in the To-dos screen's status order, then the ones done this week; the one closed ten days ago is not here.
    expect(await sidebarRows(page)).toEqual([[15, 'waiting'], [14, 'working'], [16, 'working'], [18, 'idle'], [19, 'snoozed'], [12, 'done'], [13, 'done'], [11, 'done']]);
    await expect(sidebarRow(page, 14).getByTestId('sidebar-todo-progress')).toHaveText('2/5');
    await expect(sidebarRow(page, 15).getByTestId('sidebar-todo-progress')).toHaveCount(0);
    await expect(sidebarRow(page, 15).getByTestId('sidebar-todo-waiting')).toHaveText('1');
    await expect(sidebarRow(page, 14).getByTestId('sidebar-todo-waiting')).toHaveCount(0);
    await sidebarStill(page, `t37-sidebar-${theme}`);

    // Live: the question answered, T-15 works again and the counts go.
    await page.evaluate(({ notify, list }) => {
      window.__paneTestElectronMock.emitNotifySnapshot(notify);
      window.__paneTestElectronMock.setTodosSnapshot(list);
    }, { notify: approvals(true), list: snapshot(true) });
    await expect(sidebarRow(page, 15)).toHaveAttribute('data-status', 'working');
    await expect(sidebarRow(page, 15).getByTestId('sidebar-todo-waiting')).toHaveCount(0);
    await expect(sidebarTodosTab(page)).toHaveAccessibleName('To-dos');
  });

  test(`a Session that requested no to-dos says so quietly in the sidebar (${theme})`, async ({ page }) => {
    await open(page, { dark, session: DOCS });
    await showSidebarTodos(page);
    await expect(page.getByTestId('sidebar-todos-empty')).toHaveText('No open or recent to-dos from this Session.');
    await sidebarStill(page, `t37-sidebar-empty-${theme}`);
  });

  test(`at a 1000 px window the sidebar's rows fit (${theme})`, async ({ page }) => {
    await open(page, { dark, width: 1000 });
    await showSidebarTodos(page);
    await expect(sidebarRow(page, 14)).toContainText('Ship receipt PDFs');
    const spill = await page.getByTestId('sidebar-todos').evaluate((list) => {
      const right = list.getBoundingClientRect().right;
      return [...list.querySelectorAll<HTMLElement>('*')].filter(node => node.getBoundingClientRect().right > right + 1).length;
    });
    expect(spill).toBe(0);
    await sidebarStill(page, `t37-sidebar-narrow-${theme}`);
  });
}

test('a to-do clicked in the sidebar opens in the split\'s To-dos tab', async ({ page }) => {
  await open(page);
  // The split shows Overview, so the click has to bring To-dos forward.
  await page.getByRole('tab', { name: 'Overview' }).click();
  await showSidebarTodos(page);
  await sidebarRow(page, 14).click();
  await expect(page.getByTestId('todo-page')).toHaveAttribute('data-todo', '14');
  await expect(page.locator('[data-panel-group-id]').getByRole('tab', { name: /^To-dos/ })).toHaveAttribute('aria-selected', 'true');
  // Back from it, the split's list has the same to-do selected; another click opens that one.
  await page.getByTestId('todo-page-back').click();
  await expect(selectedRow(page)).toHaveAttribute('data-todo', '14');
  await sidebarRow(page, 16).click();
  await expect(page.getByTestId('todo-page')).toHaveAttribute('data-todo', '16');
});

// T-37 review fixes.
const inspectorTab = (page: Page, name: string) => page.getByRole('tablist', { name: 'Session inspector' }).getByRole('tab', { name: new RegExp(`^${name}`) });

/** devbox's to-dos, requested by its own Billing rewrite Session: another T-14, and a T-30 only it has. */
function devboxTodos(): Pick<TodosMockOptions, 'snapshot' | 'details'> {
  const list = [
    row(record(14, 'Deploy the API to staging', { updatedAt: NOW - 3 * MIN }), { status: 'working', reason: 'deploying' }),
    row(record(30, 'Rotate the signing keys', { state: 'todo', startedAt: null, sessionId: null, updatedAt: NOW - HOUR }), { status: 'idle', reason: 'not started', idleReason: 'not_started' }),
  ].map(r => ({ ...r, machine: 'devbox' }));
  const base = todos().details[14];
  const details: Record<number, TodoDetail> = {};
  for (const r of list) details[r.todo.number] = { ...base, ...r, approvalIds: [] };
  return { snapshot: { rows: list, gate: { state: 'normal', enabled: true, since: 0 }, machine: 'devbox', ownSessionIds: [] }, details };
}

/** An approval on devbox linked to devbox's own T-14, as desktop Notify lists another machine's card. */
function devboxApproval(): NotifyItem {
  return {
    id: `${DEVBOX}:q77`, ui: 'options', title: 'Q-77: Which staging region?', state: 'waiting', createdAt: NOW - 5 * MIN, machineId: DEVBOX, machine: 'devbox',
    choices: [{ label: 'us-east', recommended: true }, { label: 'eu-west' }],
    source: { name: 'deployer', agent: 'Claude', session: { id: 'devbox-hidden-14', name: 'T-14 · Deploy the API to staging' } },
    todo: { number: 14, title: 'Deploy the API to staging' },
  };
}

/** This computer's approvals beside devbox's, each marked with its machine. */
function bothMachines(q31: Partial<NotifyItem> = {}): NotifySnapshot {
  const local = approvals();
  const items = [{ ...local.items[0], machineId: 'local', ...q31 }, devboxApproval()];
  return { ...local, items, queue: items.filter(item => item.state === 'waiting').map(item => item.id) };
}

test('switching this window to another computer shows that computer\'s to-dos in the sidebar, with no change event', async ({ page }) => {
  await open(page, { devbox: true });
  await showSidebarTodos(page);
  await expect(sidebarRow(page, 14)).toContainText('Ship receipt PDFs');
  await page.evaluate((remote) => window.__paneTestElectronMock.switchTodosHost('devbox', remote), devboxTodos());
  if (!(await page.getByTestId('sidebar-todos').isVisible())) await showSidebarTodos(page);
  await expect.poll(() => sidebarRows(page)).toEqual([[14, 'working'], [30, 'idle']]);
  await expect(sidebarRow(page, 14)).toContainText('Deploy the API to staging');
  // This computer's T-15 question is not devbox's.
  await expect(sidebarTodosTab(page)).toHaveAccessibleName('To-dos');
  await sidebarRow(page, 14).click();
  await expect(page.getByTestId('todo-page-title')).toHaveText('Deploy the API to staging');
});

test('another computer\'s approval on its own T-14 counts neither in the badges nor in the pager here', async ({ page }) => {
  await open(page, { notify: bothMachines(), devbox: true });
  await expect(todosTab(page)).toHaveAccessibleName('To-dos, 1 waiting on you');
  await showSidebarTodos(page);
  await expect(sidebarTodosTab(page)).toHaveAccessibleName('To-dos, 1 waiting on you');
  await expect(sidebarRow(page, 15).getByTestId('sidebar-todo-waiting')).toHaveText('1');
  await expect(sidebarRow(page, 14).getByTestId('sidebar-todo-waiting')).toHaveCount(0);
  await page.locator('[data-panel-group-id]').getByRole('tab', { name: /^To-dos/ }).click();
  await rowOf(page, 15).getByTestId('session-todo-answer').click();
  await expect(page.getByTestId('session-todo-approval').getByTestId('approval-pager')).toHaveText('1 of 1');
});

for (const [change, patch] of [['dismissed', { dismissedAt: NOW }], ['sent', { state: 'sent' }]] as const) {
  test(`a question ${change} without an answer clears the row badge with the tab badge`, async ({ page }) => {
    await open(page);
    await showSidebarTodos(page);
    await expect(sidebarRow(page, 15).getByTestId('sidebar-todo-waiting')).toHaveText('1');
    // Only Notify changes: the to-do list still says T-15 waits on you, as main's would until it rereads.
    await page.evaluate((notify) => window.__paneTestElectronMock.emitNotifySnapshot(notify), bothMachines(patch));
    await expect(sidebarTodosTab(page)).toHaveAccessibleName('To-dos');
    await expect(sidebarRow(page, 15).getByTestId('sidebar-todo-waiting')).toHaveCount(0);
  });
}

test('← → move focus with the selection across Files, Changes and To-dos', async ({ page }) => {
  await open(page);
  // The conversation's terminal takes focus once it has started; wait for that before the keys.
  await expect(page.locator('.xterm-helper-textarea').first()).toBeFocused({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Show details' }).click();
  await inspectorTab(page, 'Files').click();
  await expect(inspectorTab(page, 'Files')).toBeFocused();
  for (const name of ['Changes', 'To-dos', 'Files']) {
    await page.keyboard.press('ArrowRight');
    await expect(inspectorTab(page, name)).toBeFocused();
    await expect(inspectorTab(page, name)).toHaveAttribute('aria-selected', 'true');
  }
  await page.keyboard.press('ArrowLeft');
  await expect(inspectorTab(page, 'To-dos')).toBeFocused();
});

test('⌘-click on a row opens the to-do on the To-dos screen, and ↗ opens To-dos grouped by Requested by', async ({ page }) => {
  await open(page);
  await showTodos(page);
  await rowOf(page, 14).click({ modifiers: ['ControlOrMeta'] });
  // The To-dos screen's own page, with the Session gone from view.
  await expect(page.getByTestId('todo-page')).toHaveAttribute('data-todo', '14');
  await expect(page.locator(`[data-session-content-id="${BILLING}"]`)).toBeHidden();
  await page.getByTestId('todo-page-back').click();
  await expect(page.getByTestId('todos-view')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator(`[data-session-content-id="${BILLING}"]`)).toBeVisible();
  await showTodos(page);
  await page.getByTestId('session-todos-open-screen').click();
  await expect(page.getByTestId('todos-group')).toHaveAccessibleName('Group by Requested by');
  await expect(page.getByTestId('todos-group-header').first()).toContainText('Billing rewrite');
});

// The web app (no Session split): the open Session's header has To-dos, which opens the same list full screen.
test.describe('the web app', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const REMOTE_SESSION = '__orchestration_session_mock-0__';

  /** The fake host's to-dos and approvals, requested by its one Session. */
  function hostRows(): TodoListRow[] {
    return rows().map(r => ({ ...r, machine: 'devbox', todo: { ...r.todo, requester: { ...r.todo.requester, sessionId: REMOTE_SESSION } } }));
  }

  async function phoneStill(page: Page, name: string) {
    if (!SHOTS) return;
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((dark) => {
        for (const element of [document.documentElement, document.body]) {
          element.classList.remove('light', 'light-rounded', 'dark');
          element.classList.add(...(dark ? ['dark'] : ['light', 'light-rounded']));
        }
      }, theme === 'dark');
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${SHOTS}/${name}-${theme}.png` });
    }
  }

  test('a Session\'s header opens its to-dos full screen; a to-do opens on the phone page, and back returns', async ({ page }) => {
    await openConnectedRemotePwa(page, { orchestrationSessionNames: ['Billing rewrite'] });
    const list = hostRows();
    const details = todos().details;
    await page.route('http://anim-pane.test/**', async (route) => {
      const request = route.request();
      if (request.method() !== 'POST') return route.fallback();
      // SAFETY: the PWA posts the daemon's invoke envelope.
      const body = JSON.parse(request.postData() ?? '{}') as { channel?: string; args?: JsonValue[] };
      const args = body.args ?? [];
      let result: object | null;
      switch (body.channel) {
        case 'todos:snapshot': result = { success: true, data: { rows: list, gate: { state: 'normal', enabled: true, since: 0 }, machine: 'devbox', ownSessionIds: [] } }; break;
        case 'todos:detail': {
          const found = list.find(r => r.todo.number === Number(args[0]));
          result = found ? { success: true, data: { ...details[found.todo.number], ...found } } : { success: false, error: 'No such to-do.' };
          break;
        }
        case 'notify:remote-snapshot': {
          const items = approvals().items;
          result = { machine: 'devbox', epoch: 'e1', revision: 1, enabled: true, items, queue: items.map(item => item.id), hidden: [] };
          break;
        }
        default: return route.fallback();
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, result }) });
    });
    await emitRemoteHostEvent(page, 'todos:changed');
    await emitRemoteHostEvent(page, 'notify:shared-changed', {});
    await page.getByRole('button', { name: 'Open remote panes' }).click();
    await page.getByRole('group', { name: 'Sessions' }).getByRole('button', { name: 'Open Session Billing rewrite' }).click();
    const entry = page.getByTestId('remote-session-todos');
    await expect(entry).toHaveAccessibleName('To-dos, 1 waiting on you');
    await phoneStill(page, 'web-session-header');
    await entry.click();
    const screen = page.getByTestId('phone-session-todos');
    await expect(screen).toBeVisible();
    await expect(page.getByTestId('phone-title')).toHaveText('To-dos · 4 open');
    await expect(page.getByTestId('phone-todos-group')).toHaveText([/Waiting on you\s*1/, /Working\s*2/, /Idle\s*1/, /Snoozed\s*1/, /Done this week\s*3/]);
    await expect(page.locator('[data-testid="phone-todos-group"][data-group="status:done"]')).toHaveAttribute('data-folded', 'true');
    await expect(page.locator('[data-testid="phone-todos-group"][data-group="status:snoozed"]')).toHaveAttribute('data-folded', 'true');
    const overflow = await page.evaluate(() => (document.scrollingElement ?? document.documentElement).scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await phoneStill(page, 'web-session-todos');
    await page.locator('[data-testid="phone-todo-row"][data-todo="14"]').click();
    await expect(page.getByTestId('phone-todo-page')).toBeVisible();
    await expect(page.getByTestId('todo-page-title')).toHaveText('Ship receipt PDFs');
    await phoneStill(page, 'web-session-todo');
    // Back: the Session's list, then the Session.
    await page.getByTestId('phone-back').click();
    await expect(screen).toBeVisible();
    await page.getByTestId('phone-back').click();
    await expect(entry).toBeVisible();
    // The drawer's To-dos is still every to-do.
    await page.getByRole('button', { name: 'Open remote panes' }).click();
    await page.getByRole('button', { name: /^To-dos, 1 waiting on you/ }).click();
    await expect(page.getByTestId('phone-todos-list')).toBeVisible();
  });
});

// Fixes from T-23's QA (round 1).
test('QA F2: Esc right after Answer returns to the list', async ({ page }) => {
  await open(page);
  await showTodos(page);
  await rowOf(page, 15).getByTestId('session-todo-answer').click();
  await expect(page.getByTestId('session-todo-approval')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('session-todos-list')).toBeVisible();
  await expect(selectedRow(page)).toHaveAttribute('data-todo', '15');
});

test('QA F4: an approval answered elsewhere takes the tab back to the list', async ({ page }) => {
  await open(page);
  await showTodos(page);
  await rowOf(page, 15).getByTestId('session-todo-answer').click();
  await expect(page.getByTestId('session-todo-approval')).toBeVisible();
  await page.evaluate((notify) => window.__paneTestElectronMock.emitNotifySnapshot(notify), approvals(true));
  await expect(page.getByTestId('session-todos-list')).toBeVisible();
});

test('QA F1: a to-do made with New in the tab opens there, though it is yours, not the Session\'s', async ({ page }) => {
  await open(page, { session: DOCS, createdNumber: 18 });
  await showTodos(page);
  await page.getByTestId('session-todos-empty-new').click();
  await page.getByTestId('new-todo-title').fill('Tidy the receipt template');
  await page.getByRole('dialog', { name: /New to-do/ }).getByRole('button', { name: /^Create/ }).click();
  await expect(page.getByTestId('todo-page')).toHaveAttribute('data-todo', '18');
  await expect(page.getByTestId('todo-breadcrumb')).toHaveText(/\/\s*T-18/);
});
