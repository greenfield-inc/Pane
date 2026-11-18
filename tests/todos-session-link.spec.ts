import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock, type TodosMockOptions } from './electronApiMock';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import type { TodoAttachment, TodoDetail, TodoListRow, TodoRecord, TodoShownStatus } from '../shared/types/todos';

// Round 8, T-4 (renderer only, fixture to-dos and Sessions): a to-do opens its Session, the Session's
// breadcrumb returns to the same to-do, and the to-do's split has the Session's Overview tab.
// Stills land in R8_SHOTS_DIR when it is set.
const SHOTS = process.env.R8_SHOTS_DIR;
const HOUR = 3_600_000;
const NOW = Date.now();
const ISO = new Date(NOW - 3 * HOUR).toISOString();

function record(number: number, title: string, extra: Partial<TodoRecord> = {}): TodoRecord {
  return {
    number, ref: `T-${number}`, sessionId: `s-${number}`, parentNumber: null, title, summary: '', doneWhen: [], state: 'in_progress',
    requester: { kind: 'person', name: 'you' }, projectId: 1, agent: 'claude', assignee: null,
    createdBy: 'you', createdAt: NOW - 3 * HOUR, startedAt: NOW - 3 * HOUR, updatedAt: NOW, acceptedAt: null, closedAt: null,
    lastProgressAt: NOW, stuckSince: null, episodeReminders: 0, episodeRestarts: 0, stallsToday: 0, stallsDay: null, attachRemindedAt: null,
    workMs: 0, loadHold: null, loadHoldSince: null, loadOverride: null, stuckCardId: null, ...extra,
  };
}

function row(todo: TodoRecord, status: TodoShownStatus, extra: Partial<TodoListRow> = {}): TodoListRow {
  return { todo, status: { status, reason: '' }, sessionName: todo.title, projectName: 'billing', machine: 'devbox', ...extra };
}

const plan: TodoAttachment = { id: 1, todoNumber: 12, kind: 'plan', label: 'Cover sheet r1', target: '/tmp/r8/plan.md', addedBy: 'planner', source: 'attached', addedAt: NOW - 2 * HOUR };
const findings: TodoAttachment = { id: 2, todoNumber: 12, kind: 'findings', label: 'QA findings', target: '/tmp/r8/findings.md', addedBy: 'qa', source: 'attached', addedAt: NOW - HOUR };

const t12 = row(record(12, 'Invoice PDFs'), 'working', { subCounts: { done: 0, total: 1 } });
const t14 = row(record(14, 'Attach PDF to the receipt email', { parentNumber: 12, sessionId: null }), 'working');
const t20 = row(record(20, 'Tax ID on invoices', { sessionId: null, state: 'todo' }), 'idle');

function todos(): TodosMockOptions {
  const base = (r: TodoListRow, extra: Partial<TodoDetail>): TodoDetail => ({
    ...r, subTodos: [], attachments: [{ attachments: [] }], activity: [], approvalIds: [],
    chatTarget: { panelId: 'orch', name: 'orchestrator', kind: 'orchestrator' }, orchestrator: { panelId: 'orch', name: 'orchestrator', agentId: 'claude' },
    load: { gate: 'normal', canPause: true }, keepMoving: 'quiet 2m · 0 reminders', ...extra,
  });
  return {
    snapshot: { rows: [t12, t14, t20], gate: { state: 'normal', enabled: true, since: 0 }, machine: 'devbox', ownSessionIds: ['s-12'] },
    details: {
      12: base(t12, { subTodos: [t14], attachments: [{ attachments: [plan, findings] }] }),
      14: base(t14, { parent: t12, attachments: [{ attachments: [] }, { from: { number: 12, relation: 'parent' }, attachments: [plan, findings] }] }),
      20: base(t20, {}),
    },
    docs: { '/tmp/r8/plan.md': { kind: 'text', path: '/tmp/r8/plan.md', text: '# Invoice PDFs: plan\n\nRender, store, email.\n' } },
  };
}

function sessionRecord(id: string, name: string, extra: JsonObject = {}): JsonObject {
  return {
    id, name, agent: 'claude', internalSessionId: `__orchestration_session_${id}__`,
    panelIds: { claude: `__orchestration_panel_${id}_claude`, codex: `__orchestration_panel_${id}_codex`, cursor: `__orchestration_panel_${id}_cursor` },
    goal: '', context: '', decisions: [], blockers: [], nextAction: '', evidence: [], outputs: [], associations: [],
    activity: [], revision: 1, createdAt: ISO, updatedAt: ISO, archived: false, isPinned: false, ...extra,
  };
}

/** This machine's Sessions: Billing (a Session of its own) and T-12's, with its overview. */
async function installSessions(page: Page) {
  const seed = [
    sessionRecord('billing', 'Billing rewrite'),
    sessionRecord('s-12', 'Invoice PDFs', {
      todoNumber: 12, goal: 'Every paid invoice has a PDF on the receipt email.', nextAction: 'Wire the PDF into the receipt email (T-14).',
      decisions: ['Render with the bundled fonts', 'EUR and USD at launch'],
    }),
  ];
  await page.addInitScript((records) => {
    type SessionRecord = { id: string; name: string; agent: 'claude'; panelIds: Record<string, string>; internalSessionId: string; createdAt: string; updatedAt: string; revision: number };
    // SAFETY: every seed record is built by sessionRecord above, with these fields.
    const sessions = structuredClone(records) as SessionRecord[];
    const success = <Value>(data: Value) => ({ success: true as const, data: structuredClone(data) });
    let selectedSessionId: string | undefined = 'billing';
    const find = (selector: { sessionId?: string }) => {
      const found = sessions.find(session => session.id === selector.sessionId);
      if (!found) throw new Error(`Session ${selector.sessionId} not found`);
      return found;
    };
    const view = (session: SessionRecord) => ({
      session,
      internalSession: { id: session.internalSessionId, name: session.name, worktreePath: '/tmp/r8-session', prompt: '', status: 'stopped', createdAt: session.createdAt, lastActivity: session.updatedAt, output: [], jsonMessages: [], isRunning: false, permissionMode: 'ignore', toolType: 'none', archived: false, isHidden: true },
      panel: { id: session.panelIds[session.agent], sessionId: session.internalSessionId, type: 'terminal', title: session.name, state: { isActive: true, hasBeenViewed: true, customState: { agentType: session.agent, isCliPanel: true, isInitialized: false } }, metadata: { createdAt: session.createdAt, lastActiveAt: session.updatedAt, position: 0, permanent: true } },
      agent: session.agent, cwd: '/tmp/r8-session', guidePath: '/tmp/r8-session/guide.md', started: false,
    });
    const overview = (session: SessionRecord) => ({
      session, status: 'active', refreshedAt: new Date().toISOString(),
      panes: [{ paneId: 'p-impl', name: 'invoice-pdfs', branch: 'invoice-pdfs', missing: false, archived: false, panels: [], git: { hasUncommittedChanges: true, hasUntrackedFiles: false, ahead: 2, behind: 0 } }],
      activity: [{ id: 'a1', kind: 'decision', message: 'Render with the bundled fonts', at: session.updatedAt, source: 'orchestrator' }],
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
        update: async (selector: { sessionId?: string }, input: JsonObject) => {
          const found = find(selector);
          Object.assign(found, input, { revision: found.revision + 1 });
          return success(found);
        },
        reorder: async () => success({ sessions, selectedSessionId }),
        overview: async (selector: { sessionId?: string }) => success(overview(find(selector))),
        archivePreview: async (selector: { sessionId?: string }) => success({ sessionId: find(selector).id, panes: [] }),
      },
    });
  }, seed);
}

async function open(page: Page, dark = false) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const initialConfig: JsonObject = { theme: dark ? 'dark' : 'light-rounded', appearanceMode: 'fixed' };
  await installElectronApiMock(page, {
    initialProjects: [{ id: 1, name: 'billing', path: '/tmp/billing', active: true, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' }],
    initialSessions: [],
    initialConfig,
    todos: todos(),
  });
  await installSessions(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
}

async function openTodo(page: Page, number: number) {
  if (!(await page.getByTestId('todos-list').isVisible())) await page.getByTestId('todos-nav').first().click();
  await expect(page.getByTestId('todos-view')).toBeVisible();
  await page.locator(`[data-testid="todo-row"][data-todo="${number}"]`).first().click();
  await expect(page.getByTestId('todo-page')).toHaveAttribute('data-todo', String(number));
}

const tabs = (page: Page) => page.getByTestId('todo-split-tab');
const crumb = (page: Page) => page.getByTestId('session-todo-crumb');

test('the agents chip opens the Session, whose breadcrumb returns to the same to-do', async ({ page }) => {
  await open(page);
  await openTodo(page, 12);
  await page.getByTestId('todo-chip-agents').click();
  await expect(page.locator('[data-session-content-id="s-12"]')).toBeVisible();
  await expect(crumb(page)).toHaveText(/T-12\s*· Invoice PDFs/);
  await expect(crumb(page)).toHaveAttribute('data-came-from', 'true');
  await expect(crumb(page)).toHaveAttribute('aria-label', 'Back to T-12 · Invoice PDFs');
  // A focusable button with a visible focus ring; no key is bound for it in the Session.
  await crumb(page).focus();
  await expect(crumb(page)).toBeFocused();
  await crumb(page).click();
  await expect(page.getByTestId('todo-page')).toHaveAttribute('data-todo', '12');
  await expect(page.getByTestId('todo-page-title')).toHaveText('Invoice PDFs');
});

test('back from the Session, the to-do shows the tab and scroll you left it on', async ({ page }) => {
  await open(page);
  await page.setViewportSize({ width: 1440, height: 420 });
  await openTodo(page, 12);
  await tabs(page).nth(1).click();
  await expect(tabs(page).nth(1)).toHaveAttribute('aria-selected', 'true');
  const scroll = page.getByTestId('todo-page-scroll');
  const top = await scroll.evaluate((node) => { node.scrollTop = 120; return node.scrollTop; });
  expect(top).toBeGreaterThan(0);
  await page.getByTestId('todo-chip-agents').click();
  await expect(page.locator('[data-session-content-id="s-12"]')).toBeVisible();
  await crumb(page).click();
  await expect(page.getByTestId('todo-page')).toHaveAttribute('data-todo', '12');
  await expect(tabs(page).nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBe(top);
});

test('a sub-to-do opens its parent’s Session and comes back to itself', async ({ page }) => {
  await open(page);
  await openTodo(page, 12);
  await page.getByTestId('todo-sub-todos').getByRole('button', { name: /Attach PDF/ }).first().click();
  await expect(page.getByTestId('todo-page')).toHaveAttribute('data-todo', '14');
  await page.getByTestId('todo-chip-agents').click();
  await expect(page.locator('[data-session-content-id="s-12"]')).toBeVisible();
  await expect(crumb(page)).toHaveText(/T-14\s*· Attach PDF/);
  await crumb(page).click();
  await expect(page.getByTestId('todo-page')).toHaveAttribute('data-todo', '14');
});

test('a Session of its own has no breadcrumb', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Open Session Billing rewrite' }).click();
  await expect(page.locator('[data-session-content-id="billing"]')).toBeVisible();
  await expect(crumb(page)).toHaveCount(0);
});

test('the split offers the Session’s Overview after the plan, never selected first', async ({ page }) => {
  await open(page);
  await openTodo(page, 12);
  await expect(tabs(page)).toHaveText(['Plan', 'Overview', 'QA findings']);
  await expect(tabs(page).first()).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('todo-chip-agents')).toBeVisible();
  await tabs(page).nth(1).click();
  const overview = page.getByTestId('session-overview-of');
  await expect(overview).toBeVisible();
  await expect(overview).toContainText('Every paid invoice has a PDF on the receipt email.');
  await expect(overview).toContainText('Wire the PDF into the receipt email (T-14).');
  await expect(overview).toContainText('invoice-pdfs');
  // A sub-to-do shows its parent's Session's Overview too; a to-do with no Session has none.
  await page.getByTestId('todo-page-back').click();
  await openTodo(page, 20);
  await expect(page.locator('[data-testid="todo-split-tab"][data-key^="overview:"]')).toHaveCount(0);
});

for (const dark of [false, true]) {
  const theme = dark ? 'dark' : 'light';
  test(`stills: the breadcrumb and the Overview tab (${theme})`, async ({ page }) => {
    test.skip(!SHOTS, 'stills only with R8_SHOTS_DIR');
    await open(page, dark);
    await openTodo(page, 12);
    await tabs(page).nth(1).click();
    await expect(page.getByTestId('session-overview-of')).toContainText('invoice-pdfs');
    await page.screenshot({ path: `${SHOTS}/T4-overview-tab-${theme}.png` });
    await page.getByTestId('todo-chip-agents').click();
    await expect(crumb(page)).toBeVisible();
    await crumb(page).focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await page.screenshot({ path: `${SHOTS}/T4-breadcrumb-${theme}.png` });
  });
}
