import { expect, test, type Locator, type Page } from '@playwright/test';
import { installElectronApiMock, type TodosMockOptions } from './electronApiMock';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import { DEFAULT_NOTIFY_SETTINGS, type NotifyItem, type NotifySnapshot } from '../shared/types/notify';
import type { TodoActivity, TodoAttachment, TodoDetail, TodoListRow, TodoRecord, TodoShownStatus } from '../shared/types/todos';

// T-25 and T-26 (renderer only, fixture to-dos): every tab in a to-do's split closes (✕ and the close-tab key),
// closed tabs are remembered per to-do and reopen from the Files browser, a chip or a thread card; the details
// sidebar's Files tab lists the to-do's files grouped by kind, with search, sub-to-dos' files and live updates.
// Stills land in T25_SHOTS_DIR when it is set.
const SHOTS = process.env.T25_SHOTS_DIR;
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

let nextId = 1;
function attachment(todoNumber: number, kind: TodoAttachment['kind'], label: string, target: string, ageHours: number, extra: Partial<TodoAttachment> = {}): TodoAttachment {
  return { id: nextId++, todoNumber, kind, label, target, addedBy: 'planner', source: 'attached', addedAt: NOW - ageHours * HOUR, ...extra };
}

const plan = attachment(12, 'plan', 'Cover sheet r1', '/tmp/t25/plan.md', 3);
const mockup = attachment(12, 'mockup', 'Receipt mock-up', '/tmp/t25/receipt.md', 2, { addedBy: 'Pane', source: 'opened', note: 'the empty state' });
const pr = attachment(12, 'pr', 'PR #7', 'https://github.com/acme/billing/pull/7', 1, { addedBy: 'Pane', source: 'pr' });
const findings = attachment(12, 'findings', 'QA findings', '/tmp/t25/findings.md', 0.5, { addedBy: 'qa' });
const decisions = attachment(12, 'decision', 'Decisions', '/tmp/t25/decisions.md', 2, { addedBy: 'Pane', source: 'approval' });
const subPr = attachment(14, 'pr', 'PR #8', 'https://github.com/acme/billing/pull/8', 0.2, { addedBy: 'implementer' });
const remotePlan = attachment(30, 'plan', 'Key rotation plan', '/home/dev/keys/plan.md', 4, { machine: 'devbox' });

const t12 = row(record(12, 'Invoice PDFs'), 'waiting', { subCounts: { done: 0, total: 1 } });
t12.status = { status: 'waiting', reason: 'Q-11 · Which currencies at launch?', waitingApprovalId: 'q11', waitingQuestion: 'Which currencies at launch?', waitingQn: 'Q-11', waitingCount: 1 };
const t14 = row(record(14, 'Attach PDF to the receipt email', { parentNumber: 12, sessionId: null }), 'working');
const t30 = row(record(30, 'Rotate the deploy keys', { sessionId: null }), 'working');

function activity(): TodoActivity[] {
  return [{ id: 1201, todoNumber: 12, kind: 'event', authorKind: 'agent', authorName: 'qa', body: 'qa attached findings: QA findings', createdAt: NOW - 0.5 * HOUR }];
}

function todos(): TodosMockOptions {
  const base = (r: TodoListRow, extra: Partial<TodoDetail>): TodoDetail => ({
    ...r, subTodos: [], attachments: [{ attachments: [] }], activity: [], approvalIds: [],
    chatTarget: { panelId: 'orch', name: 'orchestrator', kind: 'orchestrator' }, orchestrator: { panelId: 'orch', name: 'orchestrator', agentId: 'claude' },
    load: { gate: 'normal', canPause: true }, keepMoving: 'quiet 2m · 0 reminders', ...extra,
  });
  return {
    snapshot: { rows: [t12, t14, t30], gate: { state: 'normal', enabled: true, since: 0 }, machine: 'devbox', ownSessionIds: ['s-12'] },
    details: {
      12: base(t12, {
        subTodos: [t14], approvalIds: ['q11'], activity: activity(),
        attachments: [{ attachments: [plan, mockup, pr, findings, decisions] }, { from: { number: 14, relation: 'sub' }, attachments: [subPr] }],
      }),
      14: base(t14, { parent: t12, attachments: [{ attachments: [subPr] }, { from: { number: 12, relation: 'parent' }, attachments: [plan, mockup, pr, findings, decisions] }] }),
      // A to-do on another machine, read through it: its files are on devbox.
      30: base(t30, { machineId: 'devbox', machine: 'devbox', attachments: [{ attachments: [remotePlan] }] }),
    },
    docs: {
      '/tmp/t25/plan.md': { kind: 'text', path: '/tmp/t25/plan.md', text: '# Invoice PDFs: plan\n\nRender, store, email.\n' },
      // Its worker's Pane was archived: main finds no file there (D-442).
      '/tmp/t25/decisions.md': { kind: 'missing', path: '/tmp/t25/decisions.md', message: 'There is no file at /tmp/t25/decisions.md any more.' },
    },
  };
}

function approvals(): NotifySnapshot {
  const q11: NotifyItem = {
    id: 'q11', ui: 'options', title: 'Q-11: Which currencies at launch?', context: 'J3 checks totals to the cent.',
    choices: [{ label: 'EUR and USD', recommended: true }, { label: 'Every Stripe currency' }],
    source: { name: 'T-12 orchestrator', agent: 'Claude', session: { id: 's-12', name: 'Invoice PDFs', paneId: 'p-12' } }, state: 'waiting', createdAt: NOW - 300_000,
  };
  return {
    settings: { ...DEFAULT_NOTIFY_SETTINGS }, items: [q11], queue: ['q11'], hidden: [], strip: null, stripSurface: null,
    pausedUntil: null, shortcutRegistered: true, showOutsideSupported: true, firstRun: false, instructionFiles: [],
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

/** T-12's Session on this machine, so its split has an Overview tab. */
async function installSessions(page: Page) {
  const seed = [sessionRecord('s-12', 'Invoice PDFs', { todoNumber: 12, goal: 'Every paid invoice has a PDF on the receipt email.' })];
  await page.addInitScript((records) => {
    type SessionRecord = { id: string; name: string; agent: 'claude'; panelIds: Record<string, string>; internalSessionId: string; createdAt: string; updatedAt: string; revision: number };
    // SAFETY: every seed record is built by sessionRecord above, with these fields.
    const sessions = structuredClone(records) as SessionRecord[];
    const success = <Value>(data: Value) => ({ success: true as const, data: structuredClone(data) });
    const find = (selector: { sessionId?: string }) => {
      const found = sessions.find(session => session.id === selector.sessionId);
      if (!found) throw new Error(`Session ${selector.sessionId} not found`);
      return found;
    };
    Object.assign(window.electronAPI, {
      orchestrationSessions: {
        runtimes: async () => success({ distributions: [] }),
        list: async () => success({ sessions, selectedSessionId: undefined }),
        select: async () => success({ sessions, selectedSessionId: undefined }),
        get: async (selector: { sessionId?: string }) => success({ session: find(selector) }),
        update: async (selector: { sessionId?: string }) => success(find(selector)),
        reorder: async () => success({ sessions, selectedSessionId: undefined }),
        overview: async (selector: { sessionId?: string }) => success({ session: find(selector), status: 'active', refreshedAt: new Date().toISOString(), panes: [], activity: [] }),
        archivePreview: async (selector: { sessionId?: string }) => success({ sessionId: find(selector).id, panes: [] }),
      },
    });
  }, seed);
}

async function open(page: Page, dark = false, extra: Partial<Parameters<typeof installElectronApiMock>[1]> = {}) {
  await page.setViewportSize({ width: 1500, height: 900 });
  const initialConfig: JsonObject = { theme: dark ? 'dark' : 'light-rounded', appearanceMode: 'fixed' };
  await installElectronApiMock(page, {
    initialProjects: [{ id: 1, name: 'billing', path: '/tmp/billing', active: true, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' }],
    initialSessions: [],
    initialConfig,
    notifySnapshot: approvals(),
    todos: todos(),
    ...extra,
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
const tab = (page: Page, name: string) => tabs(page).filter({ hasText: name });
/** A tab's ✕ sits beside the tab, not inside it (its own button, T-38). */
const closeOf = (tabLocator: Locator) => tabLocator.locator('xpath=..').getByTestId('todo-split-tab-close');
const selected = (page: Page) => page.locator('[data-testid="todo-split-tab"][aria-selected="true"]');
const closeKey = 'ControlOrMeta+KeyW';

async function openFiles(page: Page) {
  if (!(await page.getByTestId('todo-page-details').isVisible())) await page.getByTestId('todo-details-toggle').click();
  await page.getByTestId('todo-details-tab-files').click();
  await expect(page.getByTestId('todo-files')).toBeVisible();
}

const fileRow = (page: Page, label: string) => page.getByTestId('todo-file').filter({ hasText: label });

for (const dark of [false, true]) {
  const theme = dark ? 'dark' : 'light';

  test(`T-25: every tab kind closes by ✕ and by the close-tab key (${theme})`, async ({ page }) => {
    await open(page, dark);
    await openTodo(page, 12);
    await expect(tabs(page)).toHaveText(['Plan', 'Overview', 'Receipt mock-up', 'PR #7', 'QA findings', 'Decisions']);
    // ✕ shows on the shown tab, and on another tab under the pointer.
    await expect(closeOf(selected(page))).toBeVisible();
    await expect(closeOf(tab(page, 'PR #7'))).toHaveCSS('opacity', '0');
    await tab(page, 'PR #7').hover();
    await expect(closeOf(tab(page, 'PR #7'))).toHaveCSS('opacity', '1');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/close-hover-${theme}.png` });
    // An attachment by ✕.
    await closeOf(tab(page, 'PR #7')).click();
    await expect(tab(page, 'PR #7')).toHaveCount(0);
    // The Overview by ✕.
    await closeOf(tab(page, 'Overview')).click();
    await expect(tab(page, 'Overview')).toHaveCount(0);
    // An attachment by the key: the shown one.
    await tab(page, 'Decisions').click();
    await page.keyboard.press(closeKey);
    await expect(tab(page, 'Decisions')).toHaveCount(0);
    await expect(selected(page)).toHaveText('QA findings');
    // An approval over the split: the key closes it, back to the tab.
    await page.getByTestId('todo-chip-status').click();
    await expect(page.getByTestId('todo-approval-over-split')).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/approval-over-split-${theme}.png` });
    await page.keyboard.press(closeKey);
    await expect(page.getByTestId('todo-approval-over-split')).toHaveCount(0);
    await expect(selected(page)).toHaveText('QA findings');
    // Its own ✕ still closes it as before.
    await page.getByTestId('todo-chip-status').click();
    await page.getByTestId('approval-column-close').click();
    await expect(page.getByTestId('todo-approval-over-split')).toHaveCount(0);
    await expect(tabs(page)).toHaveText(['Plan', 'Receipt mock-up', 'QA findings']);
  });

  test(`T-25: closing the last tab hides the split; showing it reopens the plan; remembered after a reload (${theme})`, async ({ page }) => {
    await open(page, dark);
    await openTodo(page, 12);
    await closeOf(tab(page, 'QA findings')).click();
    await page.reload();
    await openTodo(page, 12);
    await expect(tab(page, 'QA findings')).toHaveCount(0);
    await expect(tabs(page)).toHaveCount(5);
    for (let left = 5; left > 0; left -= 1) await page.keyboard.press(closeKey);
    await expect(page.getByTestId('todo-page-split')).toHaveCount(0);
    // "Plan · N files" still counts every file; with every tab closed it opens Files.
    await expect(page.getByTestId('todo-chip-plan')).toHaveText(/Plan\s*· 5 files/);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/all-closed-${theme}.png` });
    await page.getByTestId('todo-chip-plan').click();
    await expect(page.getByTestId('todo-files')).toBeVisible();
    await expect(page.getByTestId('todo-file-closed')).toHaveCount(5);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/files-closed-${theme}.png` });
    await page.getByTestId('todo-details-toggle').click();
    await page.reload();
    await openTodo(page, 12);
    await expect(page.getByTestId('todo-page-split')).toHaveCount(0);
    // The split button (and ⌘\) still shows it, with the plan back.
    await expect(page.getByTestId('todo-split-toggle')).toBeEnabled();
    await page.keyboard.press('ControlOrMeta+Backslash');
    await expect(page.getByTestId('todo-page-split')).toBeVisible();
    await expect(tabs(page)).toHaveText(['Plan']);
    // Another to-do (its sub-to-do) keeps its own tabs.
    await page.locator('[data-testid="todo-sub-row"][data-todo="14"]').first().click();
    await expect(page.getByTestId('todo-page')).toHaveAttribute('data-todo', '14');
    // Its own PR, its parent's five files and the parent's Overview.
    await expect(tabs(page)).toHaveCount(7);
  });
}

test('T-25: a closed tab reopens from the files list, a chip and a thread card, and forgets it was closed', async ({ page }) => {
  await open(page);
  await openTodo(page, 12);
  await closeOf(tab(page, 'QA findings')).click();
  await closeOf(tab(page, 'PR #7')).click();
  await closeOf(tab(page, 'Decisions')).click();
  // A thread card.
  await page.getByTestId('todo-thread-attachment-link').filter({ hasText: 'QA findings' }).click();
  await expect(selected(page)).toHaveText('QA findings');
  // A chip: the PR's tab comes back in its place.
  await page.getByTestId('todo-chip-pr').click();
  await expect(selected(page)).toHaveText('PR #7');
  await expect(tabs(page)).toHaveText(['Plan', 'Overview', 'Receipt mock-up', 'PR #7', 'QA findings']);
  // The files list.
  await openFiles(page);
  await expect(fileRow(page, 'Decisions')).toHaveAttribute('data-closed', 'true');
  await fileRow(page, 'Decisions').click();
  // The file shows in the split, which the details give back (two splits at most, D-448).
  await expect(selected(page)).toHaveText('Decisions');
  await openFiles(page);
  await expect(fileRow(page, 'Decisions')).not.toHaveAttribute('data-closed', 'true');
  await page.reload();
  await openTodo(page, 12);
  await expect(tabs(page)).toHaveCount(6);
});

for (const dark of [false, true]) {
  const theme = dark ? 'dark' : 'light';

  test(`T-26: Files groups by kind with counts, sources and sub-to-dos’ files; search filters (${theme})`, async ({ page }) => {
    await open(page, dark);
    await openTodo(page, 12);
    await openFiles(page);
    await expect(page.getByTestId('todo-details-tab-files')).toHaveText('Files · 6');
    const groups = page.getByTestId('todo-files-group');
    await expect(groups.locator(':scope > div:first-child')).toHaveText(['Plan · 1', 'Mock-ups · 1', 'PRs · 2', 'Findings · 1', 'Decisions · 1']);
    await expect(fileRow(page, 'Cover sheet r1')).toContainText(/planner · \d+h/);
    await expect(fileRow(page, 'Receipt mock-up')).toContainText('opened beside you');
    await expect(fileRow(page, 'PR #7')).toContainText('Pane · its PR');
    await expect(fileRow(page, 'Decisions')).toContainText('from an approval');
    await expect(fileRow(page, 'PR #8')).toContainText('implementer · from T-14');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/files-${theme}.png` });
    const search = page.getByTestId('todo-files-search');
    await search.fill('EMPTY STATE');
    await expect(page.getByTestId('todo-file')).toHaveText([/Receipt mock-up/]);
    await search.fill('pull/8');
    await expect(page.getByTestId('todo-file')).toHaveText([/PR #8/]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/files-search-${theme}.png` });
    await search.fill('nothing like it');
    await expect(page.getByTestId('todo-files-none')).toBeVisible();
    // Esc clears the search and stays on the page.
    await search.press('Escape');
    await expect(search).toHaveValue('');
    await expect(page.getByTestId('todo-page')).toBeVisible();
    await expect(page.getByTestId('todo-file')).toHaveCount(6);
  });
}

test('T-26: a file opens in the split, a sub-to-do’s too; ⋯ offers Open outside, and Detach only for its own', async ({ page }) => {
  await open(page);
  await openTodo(page, 12);
  await page.getByTestId('todo-split-toggle').click();
  await expect(page.getByTestId('todo-page-split')).toHaveCount(0);
  await openFiles(page);
  await fileRow(page, 'QA findings').click();
  // The file shows in the split, which the details give back (two splits at most, D-448).
  await expect(page.getByTestId('todo-page-split')).toBeVisible();
  await expect(page.getByTestId('todo-page-details')).toHaveCount(0);
  await expect(selected(page)).toHaveText('QA findings');
  await openFiles(page);
  await expect(fileRow(page, 'QA findings')).toHaveAttribute('aria-current', 'true');
  // By Enter.
  await fileRow(page, 'Cover sheet r1').focus();
  await page.keyboard.press('Enter');
  await expect(selected(page)).toHaveText('Plan');
  // A sub-to-do's file opens as its own tab, marked where it is from.
  await openFiles(page);
  await fileRow(page, 'PR #8').click();
  await expect(selected(page)).toContainText('PR #8');
  await expect(selected(page)).toContainText('from T-14');
  await openFiles(page);
  await page.getByTestId('todo-file-row').filter({ hasText: 'PR #8' }).hover();
  await page.getByTestId('todo-file-row').filter({ hasText: 'PR #8' }).getByTestId('todo-file-more').click();
  await expect(page.getByRole('menuitem', { name: /Open outside/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Detach/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByTestId('todo-file-row').filter({ hasText: 'Decisions' }).hover();
  await page.getByTestId('todo-file-row').filter({ hasText: 'Decisions' }).getByTestId('todo-file-more').click();
  await page.getByRole('menuitem', { name: /Detach/ }).click();
  await expect(fileRow(page, 'Decisions')).toHaveCount(0);
  await page.getByTestId('todo-details-toggle').click();
  await expect(tabs(page)).not.toHaveCount(0);
  await expect(tab(page, 'Decisions')).toHaveCount(0);
});

test('T-26: Files updates live when an attachment arrives', async ({ page }) => {
  await open(page);
  await openTodo(page, 12);
  await openFiles(page);
  await expect(page.getByTestId('todo-file')).toHaveCount(6);
  // Attached elsewhere (an agent, the CLI): main announces the change.
  await page.evaluate(async () => { await window.electronAPI.todos.act({ kind: 'attach', number: 12, target: '/tmp/t25/notes.md', label: 'Release notes' }); });
  await expect(fileRow(page, 'Release notes')).toBeVisible();
  await expect(page.getByTestId('todo-details-tab-files')).toHaveText('Files · 7');
  await expect(page.locator('[data-testid="todo-files-group"][data-kind="doc"]')).toContainText('Docs · 1');
});

for (const dark of [false, true]) {
  const theme = dark ? 'dark' : 'light';

  test(`T-26: another machine’s to-do lists its files on that machine and opens them through it (${theme})`, async ({ page }) => {
    await open(page, dark);
    await openTodo(page, 30);
    await openFiles(page);
    await expect(fileRow(page, 'Key rotation plan')).toContainText(/planner · on devbox · \d+h/);
    await page.getByTestId('todo-file-row').filter({ hasText: 'Key rotation plan' }).hover();
    await page.getByTestId('todo-file-row').filter({ hasText: 'Key rotation plan' }).getByTestId('todo-file-more').click();
    await expect(page.getByRole('menuitem', { name: /Open outside/ })).toBeDisabled();
    await page.keyboard.press('Escape');
    await fileRow(page, 'Key rotation plan').click();
    await expect(page.getByTestId('todo-split-filebar')).toContainText('on devbox');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/remote-files-${theme}.png` });
  });
}

// A 1×1 PNG, as devbox's readDocument sends an image (F-8).
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('another machine’s screenshot shows in the split as the image, read through that machine (F-8)', async ({ page }) => {
  const options = todos();
  const shot = attachment(30, 'image', 'Rotation screenshot', '/home/dev/keys/rotation.png', 1, { machine: 'devbox' });
  const remote = options.details[30];
  if (!remote) throw new Error('T-30 has no detail in the fixture');
  remote.attachments = [{ attachments: [remotePlan, shot] }];
  await open(page, false, {
    todos: options,
    machineConnections: {
      machines: [
        { id: 'local', label: 'This computer', kind: 'local', status: 'online', offlineSince: null },
        { id: 'devbox', label: 'devbox', kind: 'remote', status: 'online', offlineSince: null },
      ],
      reads: { devbox: { 'autopilot:read-doc': { kind: 'image', path: '/home/dev/keys/rotation.png', dataUrl: PIXEL } } },
    },
  });
  await openTodo(page, 30);
  await openFiles(page);
  await fileRow(page, 'Rotation screenshot').click();
  await expect(page.getByTestId('todo-split-filebar')).toContainText('on devbox');
  const image = page.getByTestId('todo-split-attachment').getByTestId('autopilot-image-doc').locator('img');
  await expect(image).toHaveAttribute('src', PIXEL);
  await expect(page.getByTestId('approvals-doc-failed')).toHaveCount(0);
});

test('a file that is gone says it isn\'t on its machine anymore, with nothing to open (D-442)', async ({ page }) => {
  await open(page);
  await openTodo(page, 12);
  await tab(page, 'Decisions').click();
  await expect(page.getByTestId('todo-split')).toContainText(/Decisions isn't on This (Mac|computer) anymore/);
  await expect(page.getByTestId('todo-split')).not.toContainText('There is no file at');
  await expect(page.getByTestId('autopilot-doc-missing')).toHaveCount(0);
});
