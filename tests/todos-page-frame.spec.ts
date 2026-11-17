import { expect, test, type Page } from '@playwright/test';
import { installElectronApiMock, type TodosMockOptions } from './electronApiMock';
import type { JsonObject } from '../shared/validation/boundaryDecoder';
import { DEFAULT_NOTIFY_SETTINGS, type NotifyItem, type NotifySnapshot } from '../shared/types/notify';
import type { TodoActivity, TodoAttachment, TodoDetail, TodoListRow, TodoRecord, TodoShownStatus } from '../shared/types/todos';

// To-dos round 7 (D-423), renderer only with fixture to-dos: the page frame, details sidebar, chips and split
// (R1–R8, R20, R22 stills with TODOS_SHOTS_DIR set).
const SHOTS = process.env.TODOS_SHOTS_DIR;
const HOUR = 3_600_000;
const NOW = Date.now();

function record(number: number, title: string, extra: Partial<TodoRecord> = {}): TodoRecord {
  return {
    number, ref: `T-${number}`, sessionId: `s-${number}`, parentNumber: null, title, summary: '', doneWhen: [], state: 'in_progress',
    requester: { kind: 'orchestrator', name: 'Billing rewrite', sessionId: 'billing' }, projectId: 1, agent: 'claude', assignee: null,
    createdBy: 'Billing rewrite', createdAt: NOW - 3 * HOUR, startedAt: NOW - 3 * HOUR, updatedAt: NOW, acceptedAt: null, closedAt: null,
    lastProgressAt: NOW, stuckSince: null, episodeReminders: 0, episodeRestarts: 0, stallsToday: 0, stallsDay: null, attachRemindedAt: null,
    workMs: 0, loadHold: null, loadHoldSince: null, loadOverride: null, stuckCardId: null, ...extra,
  };
}

function row(todo: TodoRecord, status: TodoShownStatus, extra: Partial<TodoListRow> = {}): TodoListRow {
  return { todo, status: { status, reason: status === 'working' ? '' : status === 'idle' ? 'not started' : '' }, sessionName: todo.title, projectName: 'billing', machine: 'devbox', ...extra };
}

let attachmentId = 1;
function attachment(todoNumber: number, kind: TodoAttachment['kind'], label: string, target: string, ageHours: number, addedBy = 'planner'): TodoAttachment {
  return { id: attachmentId++, todoNumber, kind, label, target, addedBy, source: kind === 'pr' ? 'pr' : 'attached', addedAt: NOW - ageHours * HOUR };
}

const t13 = row(record(13, 'Bundle the fonts', { parentNumber: 12, state: 'done' }), 'done');
const t14 = row(record(14, 'Attach PDF to the receipt email', { parentNumber: 12, sessionId: null, assignee: { panelId: 'impl', name: 'implementer' } }), 'working', { agentId: 'codex' });
const t12Row = row(record(12, 'Invoice PDFs', {
  summary: 'Render every paid invoice as a PDF and attach it to the receipt email. Customers have asked for this since March.',
  doneWhen: [{ text: 'A paid invoice has a PDF within 10 s', met: true }, { text: 'The receipt email carries it', met: false }, { text: 'Totals match the invoice to the cent', met: false }],
  assignee: { panelId: 'impl', name: 'implementer' },
}), 'waiting', { pr: { number: 7, label: '#7 · checks passed', url: 'https://github.com/acme/billing/pull/7' }, subCounts: { done: 1, total: 2 }, agentId: 'codex' });
t12Row.status = { status: 'waiting', reason: 'Q-11 · Which currencies at launch?', waitingApprovalId: 'q11', waitingQuestion: 'Which currencies at launch?', waitingQn: 'Q-11', waitingCount: 1 };
const t20Row = row(record(20, 'Tax ID on invoices', { requester: { kind: 'person', name: 'you' } }), 'working');
const t21Row = row(record(21, 'Dunning emails', { requester: { kind: 'person', name: 'you' } }), 'working');

const t12Attachments = [
  attachment(12, 'findings', 'QA findings', '/tmp/r7/findings.md', 0.3, 'qa'),
  attachment(12, 'plan', 'Cover sheet r1', '/tmp/r7/plan.md', 2),
  attachment(12, 'mockup', 'Receipt mock-up', '/tmp/r7/receipt-mockup.svg', 1),
  attachment(12, 'pr', 'PR #7', 'https://github.com/acme/billing/pull/7', 0.7, 'Pane'),
  attachment(12, 'decision', 'Decisions', '/tmp/r7/decisions.md', 2),
];
const t21Attachments = [
  attachment(21, 'doc', 'Notes', '/tmp/r7/notes.md', 2, 'you'),
  attachment(21, 'findings', 'Bounce findings', '/tmp/r7/findings.md', 1, 'qa'),
];
const t14Attachments = [attachment(14, 'pr', 'PR #8', 'https://github.com/acme/billing/pull/8', 0.2, 'implementer')];

function activity(number: number): TodoActivity[] {
  return [
    { id: number * 100 + 1, todoNumber: number, kind: 'event', authorKind: 'pane', authorName: 'Pane', body: 'Billing rewrite orchestrator created this to-do', createdAt: NOW - 3 * HOUR },
    { id: number * 100 + 2, todoNumber: number, kind: 'message', authorKind: 'agent', authorName: 'planner', authorTab: 'planner-tab', body: 'Plan written: three packages (render, store, email). Attached the plan and decisions.', createdAt: NOW - 2 * HOUR },
  ];
}

const PLAN = '# Invoice PDFs: plan\n\nRender every paid invoice as a PDF the customer can download, and attach it to the receipt email.\n\n## Packages\n\n1. P1 Render. The invoice HTML template to PDF, with the bundled fonts (T-13).\n2. P2 Store. Keep the PDF beside the invoice row; regenerate on edit.\n3. P3 Email. Attach the PDF to the receipt (T-14).\n';
const MOCKUP = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="420" height="300"><rect width="420" height="300" fill="#fff"/><rect x="24" y="22" width="120" height="14" rx="3" fill="#1f2328"/><rect x="300" y="22" width="96" height="26" rx="6" fill="#2563eb"/></svg>');

function fixture(): TodosMockOptions {
  const base = (r: TodoListRow, extra: Partial<TodoDetail>): TodoDetail => ({
    ...r, subTodos: [], attachments: [{ attachments: [] }], activity: activity(r.todo.number), approvalIds: [],
    chatTarget: { panelId: 'orch', name: 'orchestrator', kind: 'orchestrator' }, orchestrator: { panelId: 'orch', name: 'orchestrator', agentId: 'claude' },
    load: { gate: 'normal', canPause: true }, keepMoving: 'quiet 2m · 0 reminders', ...extra,
  });
  return {
    snapshot: { rows: [t12Row, t13, t14, t20Row, t21Row], gate: { state: 'normal', enabled: true, since: 0 }, machine: 'devbox', ownSessionIds: [] },
    details: {
      12: base(t12Row, { subTodos: [t13, t14], attachments: [{ attachments: t12Attachments }], approvalIds: ['q11'] }),
      13: base(t13, { parent: t12Row }),
      14: base(t14, { parent: t12Row, attachments: [{ attachments: t14Attachments }, { from: { number: 12, relation: 'parent' }, attachments: t12Attachments }] }),
      20: base(t20Row, {}),
      21: base(t21Row, { attachments: [{ attachments: t21Attachments }] }),
    },
    docs: {
      '/tmp/r7/plan.md': { kind: 'text', path: '/tmp/r7/plan.md', text: PLAN },
      '/tmp/r7/receipt-mockup.svg': { kind: 'image', path: '/tmp/r7/receipt-mockup.svg', dataUrl: MOCKUP },
    },
  };
}

function approvals(): NotifySnapshot {
  const q11: NotifyItem = {
    id: 'q11', ui: 'options', title: 'Q-11: Which currencies at launch?', context: 'J3 checks totals to the cent in every currency we support.',
    choices: [{ label: 'EUR and USD', recommended: true }, { label: 'EUR, USD and GBP' }, { label: 'Every Stripe currency' }],
    source: { name: 'T-12 orchestrator', agent: 'Claude', session: { id: 's-12', name: 'Invoice PDFs', paneId: 'p-12' } }, state: 'waiting', createdAt: NOW - 300_000,
  };
  return {
    settings: { ...DEFAULT_NOTIFY_SETTINGS }, items: [q11], queue: ['q11'], hidden: [], strip: null, stripSurface: null,
    pausedUntil: null, shortcutRegistered: true, showOutsideSupported: true, firstRun: false, instructionFiles: [],
  };
}

interface OpenOptions { dark?: boolean; width?: number; overrides?: Record<string, string> }

async function open(page: Page, options: OpenOptions = {}) {
  await page.setViewportSize({ width: options.width ?? 1440, height: 900 });
  const initialConfig: JsonObject = { theme: options.dark ? 'dark' : 'light-rounded', appearanceMode: 'fixed' };
  if (options.overrides) initialConfig.keyboardShortcutOverrides = options.overrides;
  await installElectronApiMock(page, {
    initialProjects: [{ id: 1, name: 'billing', path: '/tmp/billing', active: true, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z' }],
    initialSessions: [],
    initialConfig,
    notifySnapshot: approvals(),
    todos: fixture(),
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
}

async function openTodos(page: Page) {
  if (!(await page.getByTestId('todos-list').isVisible())) await page.getByTestId('todos-nav').first().click();
  await expect(page.getByTestId('todos-view')).toBeVisible();
}

async function openTodo(page: Page, number: number) {
  await openTodos(page);
  await page.locator(`[data-testid="todo-row"][data-todo="${number}"]`).first().click();
  await expect(page.getByTestId('todo-page')).toHaveAttribute('data-todo', String(number));
}

const tabs = (page: Page) => page.getByTestId('todo-split-tab');

for (const dark of [false, true]) {
  const theme = dark ? 'dark' : 'light';

  test(`R1 R2 R6 R7 stills (${theme})`, async ({ page }) => {
    await open(page, { dark });
    await openTodo(page, 12);
    await expect(tabs(page).first()).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('todo-split-filebar')).toContainText('plan.md');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/R1-opened-${theme}.png` });
    await page.getByTestId('todo-details-toggle').click();
    await expect(page.getByTestId('todo-page-details')).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/R2-details-${theme}.png` });
    await page.getByTestId('todo-details-toggle').click();
    await page.getByTestId('todo-split-toggle').click();
    await expect(page.getByTestId('todo-chip-plan')).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/R7-hidden-${theme}.png` });
    await page.getByTestId('todo-chip-plan').click();
    await page.getByTestId('todo-page-back').click();
    await openTodo(page, 20);
    await expect(page.getByTestId('todo-chip-attach')).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/R6-empty-${theme}.png` });
  });
}

test('R1: opens by click and by Enter with the plan showing, details closed, focus on the title; Esc returns', async ({ page }) => {
  await open(page);
  await openTodo(page, 12);
  await expect(page.getByTestId('todo-page-split')).toBeVisible();
  await expect(tabs(page).first()).toContainText('Plan');
  await expect(tabs(page).first()).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('todo-page-details')).toHaveCount(0);
  await expect(page.getByTestId('todo-page-title')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('todos-list')).toBeVisible();
  // By Enter on the selected row.
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('todo-page')).toHaveAttribute('data-todo', /\d+/);
});

test('R2: details toggle, narrows the split, closed again after a sub-to-do, width survives reload', async ({ page }) => {
  await open(page);
  await openTodo(page, 12);
  const toggle = page.getByTestId('todo-details-toggle');
  await expect(toggle).toHaveAttribute('aria-label', 'Show details');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const before = (await page.getByTestId('todo-page-split').boundingBox())!;
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-label', 'Hide details');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const details = page.getByTestId('todo-page-details');
  for (const label of ['Status', 'Session', 'Requested by', 'Managed by', 'Working it', 'Repo', 'Machine', 'Machine load', 'Keep moving', 'Created']) {
    await expect(details.locator('dt', { hasText: new RegExp(`^${label}$`) })).toBeVisible();
  }
  const split = (await page.getByTestId('todo-page-split').boundingBox())!;
  const aside = (await details.boundingBox())!;
  expect(split.width).toBeLessThan(before.width);
  expect(split.x + split.width).toBeLessThanOrEqual(aside.x + 1);
  // Attachments tab.
  await page.getByTestId('todo-details-tab-attachments').click();
  await expect(details.getByTestId('todo-attachment')).toHaveCount(5);
  // Drag the details width.
  const separator = details.getByRole('separator');
  const box = (await separator.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x - 80, box.y + 200, { steps: 5 });
  await page.mouse.up();
  const dragged = (await details.boundingBox())!.width;
  expect(dragged).toBeGreaterThan(aside.width + 40);
  // A sub-to-do and back: closed again.
  await page.locator('[data-testid="todo-sub-row"][data-todo="14"]').first().click();
  await expect(page.getByTestId('todo-page')).toHaveAttribute('data-todo', '14');
  await expect(page.getByTestId('todo-page-details')).toHaveCount(0);
  await page.getByTestId('todo-page-back').click();
  await expect(page.getByTestId('todo-page')).toHaveAttribute('data-todo', '12');
  await expect(page.getByTestId('todo-page-details')).toHaveCount(0);
  await page.reload();
  await openTodo(page, 12);
  await page.getByTestId('todo-details-toggle').click();
  expect(Math.abs((await page.getByTestId('todo-page-details').boundingBox())!.width - dragged)).toBeLessThan(3);
});

test('R3: chips open what they name', async ({ page }) => {
  await open(page);
  await openTodo(page, 12);
  await page.getByTestId('todo-chip-pr').click();
  await expect(page.locator('[data-testid="todo-split-tab"][aria-selected="true"]')).toContainText('PR #7');
  await page.getByTestId('todo-chip-status').click();
  await expect(page.getByTestId('todo-approval-over-split')).toBeVisible();
  await expect(page.getByTestId('approval-column-close')).toContainText('Back to PR #7');
  await page.getByTestId('approval-column-close').click();
  await expect(page.getByTestId('todo-approval-over-split')).toHaveCount(0);
  await expect(page.getByTestId('todo-chip-subs')).toContainText('1/2');
  await page.getByTestId('todo-chip-subs').click();
  await expect(page.getByTestId('todo-sub-todos')).toBeInViewport();
  await expect(page.getByTestId('todo-chip-machine')).toBeVisible();
});

test('R4: tab order, arrows, + Attach adds and selects', async ({ page }) => {
  await open(page);
  await openTodo(page, 12);
  await expect(tabs(page)).toHaveText(['Plan', 'Receipt mock-up', 'PR #7', 'QA findings', 'Decisions']);
  await tabs(page).first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs(page).nth(1)).toBeFocused();
  await expect(tabs(page).nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(tabs(page).nth(4)).toBeFocused();
  await page.getByTestId('todo-split-attach').click();
  await page.getByTestId('todo-attach-input').fill('/tmp/r7/spec.md');
  await page.keyboard.press('Enter');
  await expect(tabs(page)).toHaveCount(6);
  await expect(page.locator('[data-testid="todo-split-tab"][aria-selected="true"]')).toContainText('spec.md');
  // A sub-to-do shows its parent's, marked from T-12.
  await page.locator('[data-testid="todo-sub-row"][data-todo="14"]').first().click();
  await expect(page.getByTestId('todo-page')).toHaveAttribute('data-todo', '14');
  await expect(tabs(page).first()).toContainText('from T-12');
});

test('R5: no plan selects the first in tab order', async ({ page }) => {
  await open(page);
  await openTodo(page, 21);
  await expect(tabs(page)).toHaveText(['Bounce findings', 'Notes']);
  await expect(tabs(page).first()).toHaveAttribute('aria-selected', 'true');
});

test('R6: no attachments, no split; attaching opens it', async ({ page }) => {
  await open(page);
  await openTodo(page, 20);
  await expect(page.getByTestId('todo-page-split')).toHaveCount(0);
  await expect(page.getByTestId('todo-split-toggle')).toBeDisabled();
  await page.getByTestId('todo-chip-attach').click();
  await page.getByTestId('todo-attach-input').fill('https://example.test/brief');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('todo-page-split')).toBeVisible();
  await expect(tabs(page)).toHaveCount(1);
});

test('R7: hide and show by button and chord, remembered, attachment shows it again', async ({ page }) => {
  await open(page);
  await openTodo(page, 12);
  const toggle = page.getByTestId('todo-split-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveAttribute('aria-label', 'Hide split');
  await toggle.click();
  await expect(page.getByTestId('todo-page-split')).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-label', 'Show split');
  await expect(page.getByTestId('todo-chip-plan')).toHaveText(/Plan\s*· 5 files/);
  const main = (await page.getByTestId('todo-page-main').boundingBox())!;
  const pageBox = (await page.getByTestId('todo-page').boundingBox())!;
  expect(Math.abs(main.width - pageBox.width)).toBeLessThan(2);
  await page.keyboard.press('ControlOrMeta+Backslash');
  await expect(page.getByTestId('todo-page-split')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Backslash');
  await expect(page.getByTestId('todo-page-split')).toHaveCount(0);
  // Remembered: the list, another to-do, a reload.
  await page.getByTestId('todo-page-back').click();
  await openTodo(page, 21);
  await expect(page.getByTestId('todo-page-split')).toBeVisible();
  await page.getByTestId('todo-page-back').click();
  await openTodo(page, 12);
  await expect(page.getByTestId('todo-page-split')).toHaveCount(0);
  await page.reload();
  await openTodo(page, 12);
  await expect(page.getByTestId('todo-page-split')).toHaveCount(0);
  // Clicking an attachment shows it again.
  await page.getByTestId('todo-details-toggle').click();
  await page.getByTestId('todo-details-tab-attachments').click();
  await page.locator('[data-testid="todo-attachment"]', { hasText: 'Decisions' }).click();
  await expect(page.getByTestId('todo-page-split')).toBeVisible();
  await expect(page.locator('[data-testid="todo-split-tab"][aria-selected="true"]')).toContainText('Decisions');
  // An approval shows it too.
  await toggle.click();
  await page.getByTestId('todo-chip-status').click();
  await expect(page.getByTestId('todo-approval-over-split')).toBeVisible();
});

test('R7: rebinding Split Right rebinds the toggle', async ({ page }) => {
  await open(page, { overrides: { 'split-right': 'mod+shift+y' } });
  await openTodo(page, 12);
  await page.keyboard.press('ControlOrMeta+Backslash');
  await expect(page.getByTestId('todo-page-split')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Shift+KeyY');
  await expect(page.getByTestId('todo-page-split')).toHaveCount(0);
  await expect(page.getByTestId('todo-split-toggle')).toHaveAttribute('title', /Show split \(.*Y\)/);
});

test('R8: under 1,000 px opens hidden, showing lasts this visit, no horizontal scroll at 900', async ({ page }) => {
  await open(page, { width: 900 });
  await openTodo(page, 12);
  await expect(page.getByTestId('todo-page-split')).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/R8-narrow-light.png` });
  await page.getByTestId('todo-split-toggle').click();
  await expect(page.getByTestId('todo-page-split')).toBeVisible();
  await page.getByTestId('todo-details-toggle').click();
  const overflow = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="todo-page"]');
    return { doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, page: el ? el.scrollWidth - el.clientWidth : 0 };
  });
  expect(overflow.doc).toBeLessThanOrEqual(0);
  expect(overflow.page).toBeLessThanOrEqual(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/R8-narrow-shown-light.png` });
  await page.getByTestId('todo-page-back').click();
  await openTodo(page, 12);
  await expect(page.getByTestId('todo-page-split')).toHaveCount(0);
});

test('R20: the frame controls are reachable by Tab and show focus', async ({ page }) => {
  await open(page);
  await openTodo(page, 12);
  const reached = new Set<string>();
  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press('Shift+Tab');
    const id = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? '');
    if (id) reached.add(id);
  }
  await page.getByTestId('todo-page-title').focus();
  for (let step = 0; step < 40; step += 1) {
    await page.keyboard.press('Tab');
    const id = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? '');
    if (id) reached.add(id);
  }
  for (const id of ['todo-chip-status', 'todo-chip-agents', 'todo-chip-pr', 'todo-chip-subs', 'todo-chip-machine', 'todo-split-toggle', 'todo-details-toggle']) {
    expect(reached, id).toContain(id);
  }
});
