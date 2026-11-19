import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock, type TodosMockOptions } from './electronApiMock';
import { DEFAULT_NOTIFY_SETTINGS, type NotifyItem, type NotifySnapshot } from '../shared/types/notify';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import type { TodoAttachment, TodoDetail, TodoListRow, TodoRecord, TodoStatus } from '../shared/types/todos';

// T-38 (D-448), renderer only with fixture Sessions and to-dos: the main area shows at most two splits. A to-do
// in a Session's split (the chat is the other) never splits further: its page, files and approvals are tabs in
// that one column. On the full To-dos page the page and one file are the two splits, and opening another file
// lands as a tab. Stills go to T38_SHOTS_DIR when set.
const SHOTS = process.env.T38_SHOTS_DIR;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.now();
const ISO = new Date(NOW - 3 * HOUR).toISOString();
const BILLING = 'billing';

function record(number: number, title: string, extra: Partial<TodoRecord> = {}): TodoRecord {
  return {
    number, ref: `T-${number}`, sessionId: `hidden-${number}`, parentNumber: null, title, summary: '', doneWhen: [], state: 'in_progress',
    requester: { kind: 'orchestrator', name: 'Billing rewrite orchestrator', sessionId: BILLING, panelId: 'billing-claude' }, projectId: 1, agent: 'claude',
    assignee: null, createdBy: 'Billing rewrite orchestrator', createdAt: NOW - 3 * HOUR, startedAt: NOW - 3 * HOUR, updatedAt: NOW - MIN, acceptedAt: null,
    closedAt: null, lastProgressAt: NOW, stuckSince: null, episodeReminders: 0, episodeRestarts: 0, stallsToday: 0, stallsDay: null,
    attachRemindedAt: null, workMs: 0, loadHold: null, loadHoldSince: null, loadOverride: null, stuckCardId: null, ...extra,
  };
}

let nextId = 1;
function attachment(kind: TodoAttachment['kind'], label: string, target: string, ageHours: number): TodoAttachment {
  return { id: nextId++, todoNumber: 14, kind, label, target, addedBy: 'planner', source: 'attached', addedAt: NOW - ageHours * HOUR };
}

const waiting: TodoStatus = { status: 'waiting', reason: 'Q-31 · Three reminders or two?', waitingApprovalId: 'q31', waitingQn: 'Q-31', waitingQuestion: 'Three reminders or two?', waitingCount: 1 };
const t14: TodoListRow = { todo: record(14, 'Ship receipt PDFs', { summary: 'Render every paid invoice as a PDF receipt and attach it to the receipt email.' }), status: waiting, machine: 'This Mac', projectName: 'billing', sessionName: 'Ship receipt PDFs' };
const files = [
  attachment('plan', 'Receipt PDFs plan', '/tmp/t38/plan.md', 3),
  attachment('design', 'cover-sheet.html', '/tmp/t38/cover-sheet.html', 2),
  attachment('design', 'p5-p8.html', '/tmp/t38/p5-p8.html', 1),
];

function todos(): TodosMockOptions {
  const detail: TodoDetail = {
    ...t14, subTodos: [], attachments: [{ attachments: files }], activity: [], approvalIds: ['q31'],
    chatTarget: { panelId: 'orch', name: 'orchestrator', kind: 'orchestrator' }, orchestrator: { panelId: 'orch', name: 'orchestrator', agentId: 'claude' },
    load: { gate: 'normal', canPause: true }, keepMoving: '',
  };
  return {
    snapshot: { rows: [t14], gate: { state: 'normal', enabled: true, since: 0 }, machine: 'This Mac', ownSessionIds: ['hidden-14'] },
    details: { 14: detail },
    docs: {
      '/tmp/t38/plan.md': { kind: 'text', path: '/tmp/t38/plan.md', text: '# Receipt PDFs: plan\n\nRender, store, email.\n' },
      '/tmp/t38/cover-sheet.html': { kind: 'text', path: '/tmp/t38/cover-sheet.html', text: 'Cover sheet: receipt PDFs, round 2.' },
      '/tmp/t38/p5-p8.html': { kind: 'text', path: '/tmp/t38/p5-p8.html', text: 'Pages 5 to 8: totals, tax and the footer.' },
    },
  };
}

function approvals(): NotifySnapshot {
  const q31: NotifyItem = {
    id: 'q31', ui: 'options', title: 'Q-31: Three dunning reminders or two?', state: 'waiting', createdAt: NOW - 12 * MIN,
    context: 'Three catches more late payers; two sends fewer emails.',
    choices: [{ label: 'Three reminders', recommended: true }, { label: 'Two reminders' }],
    source: { name: 'planner', agent: 'Claude', session: { id: 'hidden-14', name: 'T-14 · Ship receipt PDFs' } },
    todo: { number: 14, title: 'Ship receipt PDFs' },
  };
  return {
    settings: { ...DEFAULT_NOTIFY_SETTINGS }, items: [q31], queue: ['q31'], hidden: [], strip: null, stripSurface: null,
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

/** The Billing rewrite Session, selected, whose orchestrator requested T-14. */
async function installSessions(page: Page) {
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
      internalSession: { id: session.internalSessionId, name: session.name, worktreePath: '/tmp/t38-session', prompt: '', status: 'stopped', createdAt: session.createdAt, lastActivity: session.updatedAt, output: [], jsonMessages: [], isRunning: false, permissionMode: 'ignore', toolType: 'none', archived: false, isHidden: true },
      panel: { id: session.panelIds[session.agent], sessionId: session.internalSessionId, type: 'terminal', title: session.name, state: { isActive: true, hasBeenViewed: true, customState: { agentType: session.agent, isCliPanel: true, isInitialized: false } }, metadata: { createdAt: session.createdAt, lastActiveAt: session.updatedAt, position: 0, permanent: true } },
      agent: session.agent, cwd: '/tmp/t38-session', guidePath: '/tmp/t38-session/guide.md', started: false,
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
  }, { records: [sessionRecord(BILLING, 'Billing rewrite')], first: BILLING });
}

async function boot(page: Page, dark: boolean, width = 1500) {
  await page.setViewportSize({ width, height: 900 });
  await installElectronApiMock(page, {
    initialProjects: [{ id: 1, name: 'billing', path: '/tmp/billing', active: true, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' }],
    initialSessions: [],
    initialConfig: { theme: dark ? 'dark' : 'light-rounded', appearanceMode: 'fixed' },
    notifySnapshot: approvals(),
    todos: todos(),
  });
  await installSessions(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
}

/** T-14 opened from the Session's To-dos tab, beside the Session's chat. */
async function openInSession(page: Page) {
  await page.getByRole('button', { name: 'Open Session Billing rewrite' }).click({ timeout: 15_000 });
  await expect(page.locator(`[data-session-content-id="${BILLING}"]`)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('tab', { name: /^To-dos/ }).click();
  await page.locator('[data-testid="session-todo-row"][data-todo="14"]').click();
  await expect(page.getByTestId('todo-page')).toHaveAttribute('data-todo', '14');
}

/** T-14 on the full To-dos page. */
async function openOnTodosPage(page: Page) {
  if (!(await page.getByTestId('todos-list').isVisible())) await page.getByTestId('todos-nav').first().click();
  await page.locator('[data-testid="todo-row"][data-todo="14"]').first().click();
  await expect(page.getByTestId('todo-page')).toHaveAttribute('data-todo', '14');
}

const strip = (page: Page) => page.getByTestId('todo-tabs').getByRole('tab');
const stripTab = (page: Page, name: RegExp) => page.getByTestId('todo-tabs').getByRole('tab', { name });
const stripSelected = (page: Page) => page.getByTestId('todo-tabs').locator('[role="tab"][aria-selected="true"]');
const splitSelected = (page: Page) => page.locator('[data-testid="todo-split-tab"][aria-selected="true"]');

async function still(page: Page, name: string) {
  if (!SHOTS) return;
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

for (const dark of [false, true]) {
  const theme = dark ? 'dark' : 'light';

  test(`in a Session's split a to-do never splits further: its page, files and approval are tabs (${theme})`, async ({ page }) => {
    await boot(page, dark);
    await openInSession(page);
    await expect(page.getByTestId('todo-page-body')).toHaveAttribute('data-layout', 'tabs');
    await expect(page.getByTestId('todo-page-split')).toHaveCount(0);
    await expect(strip(page)).toHaveText([/^To-do$/, /^Plan/, /^cover-sheet\.html/, /^p5-p8\.html/]);
    await expect(stripSelected(page)).toHaveText('To-do');
    // To-do is first and never closes; the way back to the list stays.
    await expect(stripTab(page, /^To-do$/).getByTestId('todo-split-tab-close')).toHaveCount(0);
    await expect(page.getByTestId('todo-page-back')).toContainText('To-dos');
    await still(page, `1-session-todo-${theme}`);
    // A file's tab takes the page's place, in the same column.
    await stripTab(page, /cover-sheet/).click();
    await expect(page.getByTestId('todo-page-main')).toBeHidden();
    await expect(page.getByTestId('todo-page-split')).toBeVisible();
    await expect(page.getByTestId('todo-split-filebar')).toContainText('cover-sheet.html');
    await still(page, `1-session-file-${theme}`);
    // ← → walk the strip, To-do included; ✕ closes a file tab and the last one returns to To-do.
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(stripSelected(page)).toHaveText('To-do');
    await expect(page.getByTestId('todo-page-main')).toBeVisible();
    // An approval opened from the page is a tab of its own; ✕ returns to the tab it covered.
    await page.getByTestId('todo-chip-status').click();
    await expect(page.getByTestId('todo-tab-approval')).toHaveText(/Q-31/);
    await expect(page.getByTestId('todo-tab-approval')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('todo-approval-over-split')).toBeVisible();
    await still(page, `1-session-approval-${theme}`);
    await page.getByTestId('todo-tab-approval').getByTestId('todo-split-tab-close').click();
    await expect(page.getByTestId('todo-tab-approval')).toHaveCount(0);
    await expect(stripSelected(page)).toHaveText('To-do');
    // The files chip opens the plan's tab; closing every file tab comes back to To-do.
    await page.getByTestId('todo-chip-plan').click();
    await expect(stripSelected(page)).toHaveText(/^Plan/);
    for (let left = 3; left > 0; left -= 1) await stripTab(page, /^(Plan|cover-sheet|p5-p8)/).first().getByTestId('todo-split-tab-close').click();
    await expect(strip(page)).toHaveText([/^To-do$/]);
    await expect(stripSelected(page)).toHaveText('To-do');
  });

  test(`the full To-dos page: the page and one file are the two splits; another file lands as a tab (${theme})`, async ({ page }) => {
    await boot(page, dark);
    await openOnTodosPage(page);
    await expect(page.getByTestId('todo-page-body')).toHaveAttribute('data-layout', 'split');
    await expect(page.getByTestId('todo-tabs')).toHaveCount(0);
    await expect(page.getByTestId('todo-page-main')).toBeVisible();
    await expect(page.getByTestId('todo-page-split')).toBeVisible();
    await expect(splitSelected(page)).toContainText('Plan');
    await still(page, `2-todos-page-two-splits-${theme}`);
    // A third split is refused: opening another file selects its tab in the split, never a new column.
    await page.locator('[data-testid="todo-split-tab"]').filter({ hasText: 'p5-p8.html' }).click();
    await expect(splitSelected(page)).toContainText('p5-p8.html');
    await expect(page.getByTestId('todo-page-split')).toHaveCount(1);
    await expect(page.getByTestId('todo-page-body').locator(':scope > div:not([hidden])').filter({ visible: true })).toHaveCount(2);
    await page.getByTestId('todo-details-toggle').click();
    await page.getByTestId('todo-details-tab-files').click();
    await page.getByTestId('todo-file').filter({ hasText: 'cover-sheet.html' }).click();
    await expect(splitSelected(page)).toContainText('cover-sheet.html');
    await expect(page.getByTestId('todo-page-split')).toHaveCount(1);
    await page.getByTestId('todo-details-toggle').click();
    await still(page, `3-third-split-refused-${theme}`);
  });
}

test('going between the Session and the To-dos page keeps the open tabs and the one shown', async ({ page }) => {
  await boot(page, false);
  await openInSession(page);
  await stripTab(page, /^p5-p8/).getByTestId('todo-split-tab-close').click();
  await stripTab(page, /cover-sheet/).click();
  await page.getByTestId('todos-nav').first().click();
  await openOnTodosPage(page);
  await expect(page.locator('[data-testid="todo-split-tab"]')).toHaveText([/^Plan/, /^cover-sheet\.html/]);
  await expect(splitSelected(page)).toContainText('cover-sheet.html');
});
