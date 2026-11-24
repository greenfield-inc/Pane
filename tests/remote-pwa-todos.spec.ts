import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { NotifyItem, NotifySharedState } from '../shared/types/notify';
import type { TodoAction, TodoActivity, TodoAttachment, TodoCreateInput, TodoDetail, TodoListRow, TodoRecord, TodosSnapshot } from '../shared/types/todos';
import type { JsonValue } from '../shared/validation/boundaryDecoder';
import { emitRemoteHostEvent, openConnectedRemotePwa } from './remotePwaMock';

// To-dos in the web app (P7, round 7 R23–R30): the Remote PWA at phone size reads the host's
// to-dos through `todos:*` and its approvals through `notify:remote-*`, one screen at a time, each
// a history entry. The host here is a fake (`remotePwaMock`) with a to-do host on top.

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const NOW = Date.now();
const MIN = 60_000;
const QUESTION = 'Which currencies must the PDF support at launch?';
const APPROVAL = 'q11';

function record(number: number, title: string, overrides: Partial<TodoRecord> = {}): TodoRecord {
  return {
    number, ref: `T-${number}`, sessionId: 'todo-session-12', parentNumber: null, title, summary: '', doneWhen: [], state: 'in_progress',
    requester: { kind: 'person', name: 'you' }, projectId: 1, agent: 'claude', assignee: null, createdBy: 'you',
    createdAt: NOW - 3 * 60 * MIN, startedAt: NOW - 3 * 60 * MIN, updatedAt: NOW - 2 * MIN, acceptedAt: null, closedAt: null,
    lastProgressAt: null, stuckSince: null, episodeReminders: 0, episodeRestarts: 0, stallsToday: 0, stallsDay: null,
    attachRemindedAt: null, workMs: 0, loadHold: null, loadHoldSince: null, loadOverride: null, stuckCardId: null,
    ...overrides,
  };
}

function attachment(id: number, kind: TodoAttachment['kind'], label: string, target: string, addedBy = 'planner'): TodoAttachment {
  return { id, todoNumber: 12, kind, target, machine: 'devbox', label, addedBy, source: 'attached', addedAt: NOW - 2 * 60 * MIN };
}

function event(id: number, body: string, at: number, authorName = 'Pane'): TodoActivity {
  return { id, todoNumber: 12, kind: 'event', authorKind: 'pane', authorName, body, createdAt: at };
}

const PLAN_HTML = '<!doctype html><html><body style="font-family:system-ui;padding:16px"><h1>Invoice PDFs: plan</h1><p>Render every paid invoice as a PDF the customer can download, and attach it to the receipt email.</p><h2>Packages</h2><ol><li><b>P1 Render.</b> The invoice HTML template to PDF.</li><li><b>P2 Store.</b> Keep the PDF beside the invoice row.</li><li><b>P3 Email.</b> Attach the PDF to the receipt.</li></ol></body></html>';

/** The fake host's to-dos and approvals; tests change them as the host would. */
class TodoHost {
  rows: TodoListRow[];
  details = new Map<number, TodoDetail>();
  items: NotifyItem[];
  revision = 1;
  commands: JsonValue[] = [];
  created: TodoCreateInput[] = [];
  acts: TodoAction[] = [];
  private nextNumber = 22;

  constructor() {
    const waiting = { status: 'waiting' as const, reason: QUESTION, waitingApprovalId: APPROVAL, waitingQuestion: QUESTION, waitingQn: 'Q-11', waitingCount: 1 };
    const t12: TodoListRow = { todo: record(12, 'Invoice PDFs', { summary: 'Render every paid invoice as a PDF and attach it to the receipt email. Customers have asked for this since March.', doneWhen: [{ text: 'A paid invoice has a PDF within 10 s', met: true }, { text: 'The receipt email carries it', met: false }, { text: 'Totals match the invoice to the cent', met: false }] }), status: waiting, machine: 'devbox', sessionName: 'Billing rewrite', projectName: 'billing', subCounts: { done: 1, total: 2 }, pr: { number: 7, label: '#7 · checks passed' }, agentId: 'claude' };
    const filler = Array.from({ length: 14 }, (_, index): TodoListRow => ({
      todo: record(30 + index, `Backlog item ${index + 1}`, { state: 'todo', startedAt: null, updatedAt: NOW - (index + 2) * 60 * MIN }),
      status: { status: 'idle', reason: 'not started' }, machine: 'devbox',
    }));
    this.rows = [
      t12,
      { todo: record(20, 'Tax ID on invoices', { updatedAt: NOW - 6 * MIN }), status: { status: 'working', reason: '' }, machine: 'devbox', agentId: 'codex' },
      { todo: record(21, 'Dunning emails', { state: 'todo', startedAt: null, updatedAt: NOW - 60 * MIN }), status: { status: 'idle', reason: 'not started' }, machine: 'devbox' },
      ...filler,
    ];
    const sub = (number: number, title: string, status: TodoListRow['status']): TodoListRow => ({ todo: record(number, title, { parentNumber: 12 }), status, machine: 'devbox' });
    this.details.set(12, {
      ...t12,
      subTodos: [sub(13, 'Bundle the fonts', { status: 'done', reason: '' }), sub(14, 'Attach PDF to the email', { status: 'working', reason: '' })],
      attachments: [{ attachments: [
        attachment(1, 'plan', 'Plan', '/Users/dev/billing/plan.html'),
        attachment(2, 'mockup', 'Receipt mock-up', '/Users/dev/billing/receipt.md', 'designer'),
        attachment(3, 'pr', 'PR #7', 'https://github.com/acme/billing/pull/7', 'Pane'),
        attachment(4, 'findings', 'QA findings', '/Users/dev/billing/qa.md', 'qa'),
        attachment(5, 'decision', 'Decisions', '/Users/dev/billing/decisions.md', 'orchestrator'),
      ] }],
      activity: [
        { ...event(1, 'created this', NOW - 3 * 60 * MIN, 'Billing rewrite orchestrator'), authorKind: 'requester' },
        event(2, 'Pane started its own Session', NOW - 3 * 60 * MIN),
        ...Array.from({ length: 10 }, (_, index): TodoActivity => ({ id: 10 + index, todoNumber: 12, kind: 'message', authorKind: 'person', authorName: 'you', body: `Note ${index + 1}: keep the PDF under 300 KB and the fonts subset.`, createdAt: NOW - (100 - index) * MIN })),
      ],
      approvalIds: [APPROVAL],
      chatTarget: { panelId: 'orch-panel', name: 'orchestrator', kind: 'orchestrator' },
      orchestrator: { panelId: 'orch-panel', name: 'orchestrator', agentId: 'claude' },
      load: { gate: 'normal', canPause: true },
      keepMoving: '',
    });
    this.items = [{
      id: APPROVAL, ui: 'options', title: `Q-11 ${QUESTION}`, state: 'waiting', createdAt: NOW - 5 * MIN,
      source: { name: 'Billing rewrite', agent: 'Claude', paneId: 'todo-pane-12' },
      choices: [{ label: 'EUR and USD', detail: 'Covers 94% of last quarter’s invoices', recommended: true }, { label: 'EUR, USD and GBP', detail: 'Adds UK customers' }, { label: 'Every Stripe currency', detail: 'Zero-decimal currencies need a check' }],
      todo: { number: 12, title: 'Invoice PDFs' },
    }];
  }

  snapshot(): TodosSnapshot {
    return { rows: this.rows, gate: { state: 'normal', enabled: true, since: NOW }, machine: 'devbox', ownSessionIds: [] };
  }

  shared(): NotifySharedState {
    return { machine: 'devbox', epoch: 'e1', revision: this.revision, enabled: true, items: this.items, queue: this.items.filter(item => item.state === 'waiting').map(item => item.id), hidden: [] };
  }

  /** The person answered Q-11: it is sent, and T-12 is worked on again. */
  answer(): void {
    this.items = this.items.map(item => (item.id === APPROVAL ? { ...item, state: 'answered', answerSummary: 'EUR and USD', resolvedAt: Date.now() } : item));
    this.revision += 1;
    const working = { status: 'working' as const, reason: '' };
    // oxlint-disable-next-line pane/no-bare-todo-number -- this mock serves one machine's to-dos by number, as main does.
    this.rows = this.rows.map(row => (row.todo.number === 12 ? { ...row, status: working } : row));
    const detail = this.details.get(12);
    if (detail) this.details.set(12, { ...detail, status: working });
  }

  create(input: TodoCreateInput): TodoRecord {
    this.created.push(input);
    const number = this.nextNumber++;
    const made = record(number, input.title, { parentNumber: input.parentNumber ?? null, state: 'in_progress', updatedAt: Date.now() });
    const row: TodoListRow = { todo: made, status: { status: 'working', reason: '' }, machine: 'devbox' };
    if (input.parentNumber) {
      const parent = this.details.get(input.parentNumber);
      if (parent) this.details.set(input.parentNumber, { ...parent, subTodos: [...parent.subTodos, row] });
    } else {
      this.rows = [row, ...this.rows];
    }
    return made;
  }
}

const STILLS = process.env.PANE_PWA_TODO_STILLS;

/** Opens the web app on a host with to-dos and approvals, at phone size, and taps To-dos in the drawer. */
async function openTodos(page: Page): Promise<TodoHost> {
  const todoHost = new TodoHost();
  await openConnectedRemotePwa(page);
  // Registered after the mock host's own route, so it answers first; everything else falls through.
  await page.route('http://anim-pane.test/**', async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.fallback();
    const raw = request.postData() ?? '{}';
    // SAFETY: the PWA posts the daemon's invoke envelope.
    const body = JSON.parse(raw) as { channel?: string; args?: JsonValue[] };
    const args = body.args ?? [];
    let result: JsonValue | object | null;
    switch (body.channel) {
      case 'todos:snapshot': result = { success: true, data: todoHost.snapshot() }; break;
      case 'todos:detail': {
        const detail = todoHost.details.get(Number(args[0]));
        result = detail ? { success: true, data: detail } : { success: false, error: `There is no T-${String(args[0])}.` };
        break;
      }
      case 'todos:create': {
        // SAFETY: the PWA sends one TodoCreateInput.
        const input = (JSON.parse(raw) as { args: [TodoCreateInput] }).args[0];
        result = { success: true, data: todoHost.create(input) };
        break;
      }
      case 'todos:act':
        // SAFETY: the PWA sends one TodoAction.
        todoHost.acts.push((JSON.parse(raw) as { args: [TodoAction] }).args[0]);
        result = { success: true, data: { todo: todoHost.rows[0].todo } };
        break;
      case 'notify:remote-snapshot': result = todoHost.shared(); break;
      case 'notify:remote-command':
        todoHost.commands.push(args[0] ?? null);
        todoHost.answer();
        result = null;
        break;
      case 'autopilot:read-doc':
        result = String(args[0]).endsWith('.html')
          ? { kind: 'html', url: `file://${String(args[0])}`, path: String(args[0]), html: PLAN_HTML }
          : { kind: 'text', text: `# ${path.basename(String(args[0]))}\n\nWritten on devbox.`, path: String(args[0]) };
        break;
      default: return route.fallback();
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, result }) });
  });
  // The host says its to-dos and approvals changed; the web app reads them.
  await emitRemoteHostEvent(page, 'todos:changed');
  await emitRemoteHostEvent(page, 'notify:shared-changed', {});
  await page.getByRole('button', { name: 'Open remote panes' }).click();
  await page.getByRole('button', { name: /^To-dos, 1 waiting on you/ }).click();
  await expect(page.getByTestId('phone-todos-list')).toBeVisible();
  return todoHost;
}

async function hostChanged(page: Page): Promise<void> {
  await emitRemoteHostEvent(page, 'todos:changed');
  await emitRemoteHostEvent(page, 'notify:shared-changed', {});
}

async function noSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    const wide = [...document.querySelectorAll<HTMLElement>('[data-testid="remote-todos"] *')]
      .filter(element => element.getBoundingClientRect().right > window.innerWidth + 1 && getComputedStyle(element).position !== 'fixed')
      // Rows that scroll sideways on purpose (the pills, the file tabs) clip inside their own box.
      .filter(element => !element.closest('[role="tablist"]'))
      .map(element => element.dataset.testid ?? element.tagName);
    return { page: root.scrollWidth - root.clientWidth, wide: wide.slice(0, 5) };
  });
  expect(overflow).toEqual({ page: 0, wide: [] });
}

async function still(page: Page, name: string): Promise<void> {
  if (!STILLS) return;
  mkdirSync(STILLS, { recursive: true });
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((dark) => {
      for (const element of [document.documentElement, document.body]) {
        element.classList.remove('light', 'light-rounded', 'dark');
        element.classList.add(...(dark ? ['dark'] : ['light', 'light-rounded']));
      }
    }, theme === 'dark');
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(STILLS, `${name}-${theme}.png`) });
  }
  await page.evaluate(() => {
    for (const element of [document.documentElement, document.body]) {
      element.classList.remove('dark');
      element.classList.add('light', 'light-rounded');
    }
  });
}

test('R23: the drawer opens a one-column list; a tap opens the to-do and back keeps the list where it was', async ({ page }) => {
  await openTodos(page);
  const list = page.getByTestId('phone-todos-list');
  await expect(list.getByTestId('phone-todos-waiting-count')).toHaveText('1');
  await expect(list.getByTestId('phone-todos-group').first()).toContainText('Waiting on you');
  await expect(list.locator('[data-todo="12"] [data-testid="phone-todo-row-meta"]')).toHaveText(`T-12 · ${QUESTION}`);
  await noSidewaysScroll(page);
  await still(page, 'r23-list');

  // Scrolled down, open a to-do near the end, and come back to the same place.
  const scroller = page.getByTestId('phone-todos-scroll');
  await scroller.evaluate(element => { element.scrollTop = 400; });
  await page.locator('[data-testid="phone-todo-row"][data-todo="40"]').click();
  await expect(page.getByTestId('phone-todo-page')).toBeVisible();
  await page.getByTestId('phone-back').click();
  await expect(list).toBeVisible();
  await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(400);

  await page.setViewportSize({ width: 320, height: 640 });
  await noSidewaysScroll(page);
  await page.locator('[data-testid="phone-todo-row"][data-todo="12"]').click();
  await expect(page.getByTestId('todo-page-title')).toHaveText('Invoice PDFs');
  await noSidewaysScroll(page);
});

test('R23, R26: the to-do page is one column with the composer pinned, and Send keeps the box focused', async ({ page }) => {
  const todoHost = await openTodos(page);
  await page.locator('[data-testid="phone-todo-row"][data-todo="12"]').click();
  const pageView = page.getByTestId('phone-todo-page');
  await expect(pageView.getByTestId('todo-page-title')).toHaveText('Invoice PDFs');
  await expect(pageView.getByTestId('phone-todo-files')).toContainText('Plan· 5 files');
  await expect(pageView.getByTestId('todo-done-when')).toBeVisible();
  await expect(pageView.getByTestId('todo-sub-todos')).toContainText('Bundle the fonts');
  await expect(page.getByTestId('todo-page-split')).toHaveCount(0);
  await expect(page.getByTestId('todo-page-details')).toHaveCount(0);
  // No 📎 where the web app can't save a file.
  await expect(page.getByTestId('todo-composer-attach')).toHaveCount(0);
  const composer = page.getByTestId('todo-composer');
  const box = await composer.boundingBox();
  expect(box && Math.round(box.y + box.height)).toBe(844);
  await noSidewaysScroll(page);
  await still(page, 'r23-todo');

  const input = page.getByTestId('todo-composer-input');
  await input.click();
  await input.fill('Ship EUR and USD first.');
  await page.getByTestId('todo-composer-send').click();
  await expect.poll(() => todoHost.acts.find(action => action.kind === 'comment')).toMatchObject({ kind: 'comment', number: 12, body: 'Ship EUR and USD first.' });
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await still(page, 'r26-composer');
});

test('R24: Plan · Files opens the attachments full screen on the Plan, the tabs switch, and back returns to the same place', async ({ page }) => {
  await openTodos(page);
  await page.locator('[data-testid="phone-todo-row"][data-todo="12"]').click();
  const scroller = page.getByTestId('phone-todo-scroll');
  await expect(page.getByTestId('todo-page-title')).toBeVisible();
  await scroller.evaluate(element => { element.scrollTop = 0; });
  await page.getByTestId('phone-todo-files').click();

  const files = page.getByTestId('phone-todo-files');
  await expect(files.getByTestId('phone-back')).toHaveText('T-12');
  await expect(files.getByTestId('phone-title')).toHaveText('Plan');
  await expect(files.getByRole('tab', { selected: true })).toHaveText('Plan');
  await expect(files.getByTestId('phone-files-bar')).toHaveText(/plan\.html\s*· planner · 2h/);
  await expect(files.frameLocator('[data-testid="phone-files-page"]').getByRole('heading', { name: 'Invoice PDFs: plan' })).toBeVisible();
  await noSidewaysScroll(page);
  await still(page, 'r24-files');

  await files.getByRole('tab', { name: 'QA findings' }).click();
  await expect(files.getByTestId('phone-title')).toHaveText('QA findings');
  await expect(files.getByTestId('phone-files-text')).toContainText('qa.md');

  // Back to the page, scrolled where it was.
  await files.getByTestId('phone-back').click();
  await expect(page.getByTestId('phone-todo-page')).toBeVisible();
  await scroller.evaluate(element => { element.scrollTop = 220; });
  await page.getByTestId('phone-todo-files').evaluate(element => element.scrollIntoView({ block: 'nearest' }));
  const before = await scroller.evaluate(element => element.scrollTop);
  await page.getByTestId('phone-todo-files').click();
  await page.getByTestId('phone-back').click();
  await expect.poll(() => scroller.evaluate(element => element.scrollTop)).toBe(before);
});

test('R25: Answer opens the approval full screen, and Send returns to the to-do reading Working', async ({ page }) => {
  const todoHost = await openTodos(page);
  await page.locator('[data-testid="phone-todo-row"][data-todo="12"]').click();
  await expect(page.getByTestId('todo-chip-status')).toContainText('Waiting on you');
  await page.getByTestId('todo-thread-answer').click();

  const approval = page.getByTestId('phone-todo-approval');
  await expect(approval.getByTestId('phone-title')).toHaveText('Q-11');
  await expect(approval.getByTestId('phone-back')).toHaveText('T-12');
  await expect(approval.getByTestId('approval-column')).toHaveAttribute('data-narrow', 'true');
  await expect(approval).toContainText(QUESTION);
  await noSidewaysScroll(page);
  await still(page, 'r25-approval');

  await approval.getByText('EUR and USD', { exact: true }).click();
  await approval.getByTestId('approval-send').click();
  await expect.poll(() => todoHost.commands.length).toBe(1);
  expect(todoHost.commands[0]).toMatchObject({ type: 'answer', id: APPROVAL });
  await hostChanged(page);
  await expect(page.getByTestId('phone-todo-page')).toBeVisible();
  await expect(page.getByTestId('todo-chip-status')).toContainText('Working');
  await still(page, 'r25-working');
});

test('R28: browser back steps out approval → to-do → list → the Pane', async ({ page }) => {
  await openTodos(page);
  await page.locator('[data-testid="phone-todo-row"][data-todo="12"]').click();
  await page.getByTestId('todo-chip-status').click();
  await expect(page.getByTestId('phone-todo-approval')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('phone-todo-page')).toBeVisible();
  await page.getByTestId('phone-todo-files').click();
  await expect(page.getByTestId('phone-todo-files')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('phone-todo-page')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('phone-todos-list')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('tablist', { name: 'Remote tool panels' })).toBeVisible();
  await page.goForward();
  await expect(page.getByTestId('phone-todos-list')).toBeVisible();

  // The header's back goes the same way, and leaves no extra entry to step through.
  await page.locator('[data-testid="phone-todo-row"][data-todo="12"]').click();
  await page.getByTestId('phone-back').click();
  await expect(page.getByTestId('phone-todos-list')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('tablist', { name: 'Remote tool panels' })).toBeVisible();
});

test('R28: after a back and forward, answering returns to the to-do and one back reaches the list', async ({ page }) => {
  const todoHost = await openTodos(page);
  await page.locator('[data-testid="phone-todo-row"][data-todo="12"]').click();
  await page.getByTestId('todo-thread-answer').click();
  const approval = page.getByTestId('phone-todo-approval');
  await expect(approval).toBeVisible();
  // Forward back into the approval: the web app must still know the to-do is under it.
  await page.goBack();
  await expect(page.getByTestId('phone-todo-page')).toBeVisible();
  await page.goForward();
  await expect(approval).toBeVisible();
  await approval.getByText('EUR and USD', { exact: true }).click();
  await approval.getByTestId('approval-send').click();
  await expect.poll(() => todoHost.commands.length).toBe(1);
  await hostChanged(page);
  await expect(page.getByTestId('phone-todo-page')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('phone-todos-list')).toBeVisible();
});

test('R29: New to-do and + Add create to-dos full screen, which appear in the list and under the parent', async ({ page }) => {
  const todoHost = await openTodos(page);
  await page.getByTestId('phone-todos-new').click();
  const form = page.getByRole('form', { name: 'New to-do' });
  await expect(form.getByTestId('phone-form-create')).toBeDisabled();
  await form.getByTestId('phone-form-title').fill('Refund receipts');
  await form.getByTestId('phone-form-summary').fill('Send a receipt with a PDF when an invoice is refunded.');
  await form.getByLabel('Done when 1').fill('A refund sends a receipt with the PDF');
  await expect(form.getByTestId('phone-form-machine')).toContainText('MacBook Pro');
  await noSidewaysScroll(page);
  await still(page, 'r29-new');
  await form.getByTestId('phone-form-create').click();
  await expect(form).toHaveCount(0);
  expect(todoHost.created[0]).toMatchObject({ title: 'Refund receipts', doneWhen: ['A refund sends a receipt with the PDF'], projectId: 1, agent: 'codex', startNow: true, parentNumber: null });
  await expect(page.locator('[data-testid="phone-todo-row"][data-todo="22"]')).toContainText('Refund receipts');

  await page.locator('[data-testid="phone-todo-row"][data-todo="12"]').click();
  await page.getByTestId('todo-add-sub').click();
  const sub = page.getByRole('form', { name: 'New sub-to-do' });
  await expect(sub.getByTestId('phone-form-parent')).toHaveText('Sub-to-do of T-12 · Invoice PDFs · same Session');
  await expect(sub.getByTestId('phone-form-machine')).toHaveCount(0);
  await sub.getByTestId('phone-form-title').fill('Subset the fonts');
  await sub.getByTestId('phone-form-create').click();
  await expect(sub).toHaveCount(0);
  expect(todoHost.created[1]).toMatchObject({ title: 'Subset the fonts', parentNumber: 12 });
  await expect(page.getByTestId('todo-sub-todos')).toContainText('Subset the fonts');
  // Cancel creates nothing and returns to the to-do.
  await page.getByTestId('todo-add-sub').click();
  await page.getByRole('form', { name: 'New sub-to-do' }).getByTestId('phone-back').click();
  await expect(page.getByTestId('phone-todo-page')).toBeVisible();
  expect(todoHost.created).toHaveLength(2);
});
