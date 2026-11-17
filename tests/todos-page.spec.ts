import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RunpaneTodo } from '../shared/types/todos';
import { launchIsolated, runpane, type IsolatedPane } from './isolatedPane';
import { AGENT, approvals, createSession, detail, json, ownCaller, setup, shot, transcript } from './todosHarness';

// To-dos round 7 (D-423): the to-do page in a real, isolated Pane (D-288) with the scripted agent. The
// renderer-only journeys (todos-page-frame and todos-thread specs) cover layout with fixtures; this one
// covers what needs the real app: delivery into tabs, replies to the card's author, the approval over the
// split with a real approval, and the split's hidden state across a reload.

test.describe.configure({ mode: 'serial' });

interface Caller { paneId: string; panelId: string }

async function openTodo(page: Page, number: number): Promise<void> {
  if (!(await page.getByTestId('todos-list').isVisible().catch(() => false))) await page.getByTestId('todos-nav').first().click();
  await expect(page.getByTestId('todos-view')).toBeVisible();
  await page.locator(`[data-testid="todo-row"][data-todo="${number}"]`).first().click();
  await expect(page.getByTestId('todo-page')).toHaveAttribute('data-todo', String(number));
}

/** A second tab in the to-do's own Session, run by the scripted agent: the worker whose card you reply under. */
async function addWorker(pane: IsolatedPane, orchestrator: Caller, title: string): Promise<Caller> {
  const out = JSON.parse(await runpane(pane, ['panels', 'create', '--pane', orchestrator.paneId, '--chat', '--agent', 'claude', '--title', title, '--no-focus', '--source', 'agent', '--yes', '--json'], orchestrator));
  const panelId = String(out.panelId ?? out.panel?.id ?? out.items?.[0]?.panelId ?? '');
  expect(panelId, JSON.stringify(out)).not.toBe('');
  return { paneId: orchestrator.paneId, panelId };
}

const theme = (page: Page, mode: 'light' | 'dark') => page.evaluate(async value => {
  await window.electronAPI.config.update({ theme: value === 'dark' ? 'dark' : 'light-rounded', appearanceMode: 'fixed' });
}, mode);

test('the to-do page: plan beside it, comments and replies reach the right tab, approvals cover the split (R1, R7, R9, R12, R13, R15–R18, R22)', async ({ baseURL }) => {
  test.setTimeout(300_000);
  const { pane, page, close } = await setup('pane-todos-page', { VITE_PORT: new URL(baseURL ?? 'http://localhost:4521').port, PANE_TODOS_TIME_SCALE: '1' });
  try {
    const sessionA = await createSession(page, 'Billing rewrite');
    const plan = path.join(pane.root, 'plan.md');
    writeFileSync(plan, '# Invoice PDFs: plan\n\nRender every paid invoice as a PDF.\n');
    await json<{ todo: RunpaneTodo }>(pane, ['todos', 'create', 'Invoice PDFs', '--summary', 'Render invoices as PDFs', '--done-when', 'PDF renders', '--attach', plan], sessionA);
    await json(pane, ['todos', 'create', 'Bundle the fonts', '--parent', 'T-1'], sessionA);
    await json(pane, ['todos', 'create', 'Another to-do'], sessionA);
    const orchestrator = await ownCaller(page, 1);
    await expect.poll(() => transcript(page, orchestrator.panelId), { timeout: 30_000 }).toContain('You are the orchestrator for T-1');

    // R1: the page opens with the plan beside it and the details closed; Esc returns to the list.
    await openTodo(page, 1);
    await expect(page.locator('[data-testid="todo-split-tab"][aria-selected="true"]')).toContainText('Plan');
    await expect(page.getByTestId('todo-details-toggle')).toHaveAttribute('aria-expanded', 'false');
    await shot(page, 'r7-page-light');
    await page.getByTestId('todo-page-title').click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('todos-list')).toBeVisible();

    // R13: a comment reaches the orchestrator's tab and reads Delivered.
    await openTodo(page, 1);
    await page.getByTestId('todo-composer-input').fill('Keep the fonts in the repo');
    await page.getByTestId('todo-composer-input').press('ControlOrMeta+Enter');
    await expect.poll(() => transcript(page, orchestrator.panelId), { timeout: 30_000 }).toContain('[From the person, via To-dos T-1] Keep the fonts in the repo');
    await expect(page.getByTestId('todo-thread-comment').filter({ hasText: 'Keep the fonts in the repo' }).getByTestId('todo-thread-delivery')).toContainText('Delivered', { timeout: 15_000 });

    // R12 / R15: a worker in the Session posts; your reply under its card reaches the worker, not the orchestrator.
    const worker = await addWorker(pane, orchestrator, 'implementer');
    await json(pane, ['todos', 'comment', 'T-1', 'Plan written: three packages'], worker);
    const run = page.getByTestId('todo-thread-run').filter({ hasText: 'Plan written: three packages' });
    await expect(run).toHaveCount(1, { timeout: 15_000 });
    await expect(run).toHaveAttribute('data-state', 'finished');
    // A worker in the Session's own Pane is named by its tab, not the Session.
    await expect(run).toContainText('implementer');
    await shot(page, 'r7-run-light');
    await run.getByTestId('todo-thread-reply-input').fill('Use the blue one');
    await run.getByTestId('todo-thread-reply-input').press('ControlOrMeta+Enter');
    await expect.poll(() => transcript(page, worker.panelId), { timeout: 30_000 }).toContain('[From the person, via To-dos T-1] Use the blue one');
    expect(await transcript(page, orchestrator.panelId)).not.toContain('Use the blue one');
    const reply = (await detail(page, 1)).activity.find(row => row.body === 'Use the blue one');
    expect(reply?.replyTo).toBeDefined();
    // The worker's next message threads under your reply.
    await json(pane, ['todos', 'comment', 'T-1', 'Switched to blue'], worker);
    expect((await detail(page, 1)).activity.find(row => row.body === 'Switched to blue')?.replyTo).toBe(reply?.id);

    // R17: a reply on your own comment goes where the comment went.
    const mine = page.getByTestId('todo-thread-comment').filter({ hasText: 'Keep the fonts in the repo' });
    await mine.getByTestId('todo-thread-reply-input').fill('and the licence file');
    await mine.getByTestId('todo-thread-reply-input').press('ControlOrMeta+Enter');
    await expect.poll(() => transcript(page, orchestrator.panelId), { timeout: 30_000 }).toContain('and the licence file');

    // R18: a reply aimed at another to-do's row is refused and nothing is typed.
    await json(pane, ['todos', 'comment', 'T-3', 'from three'], await ownCaller(page, 3));
    const other = (await detail(page, 3)).activity.find(row => row.body === 'from three');
    const refused = await page.evaluate(async id => window.electronAPI.todos.act({ kind: 'comment', number: 1, body: 'stray', replyTo: id }), other?.id ?? 0);
    expect(refused).toMatchObject({ success: false });
    expect(refused.error).toContain('isn’t on T-1');
    expect(await transcript(page, orchestrator.panelId)).not.toContain('stray');

    // R16: with the worker's tab closed, a reply goes to the orchestrator and says so.
    await runpane(pane, ['panels', 'close', '--panel', worker.panelId, '--yes', '--force', '--json'], orchestrator);
    await run.getByTestId('todo-thread-reply-input').fill('Are the tests green?');
    await run.getByTestId('todo-thread-reply-input').press('ControlOrMeta+Enter');
    await expect.poll(() => transcript(page, orchestrator.panelId), { timeout: 30_000 }).toContain('Are the tests green?');
    await expect(page.getByTestId('todo-thread-event').filter({ hasText: 'tab is closed; sent to the orchestrator' }).or(page.getByTestId('todo-thread-fold').filter({ hasText: 'tab is closed' }))).not.toHaveCount(0);

    // R9: a real approval on the to-do opens over the split, Esc returns, answering closes it.
    void runpane(pane, ['notify', '--ui', 'options', '--title', 'Which currencies at launch?', '--choices', JSON.stringify([{ label: 'EUR', recommended: true }, { label: 'EUR and USD' }]), '--todo', 'T-1'], orchestrator).catch(() => undefined);
    await expect.poll(async () => (await detail(page, 1)).status.status, { timeout: 20_000 }).toBe('waiting');
    const card = page.getByTestId('todo-thread-approval').filter({ hasText: 'Which currencies at launch?' });
    await card.getByTestId('todo-thread-answer').click();
    const overlay = page.getByTestId('todo-approval-over-split');
    await expect(overlay).toBeVisible();
    await expect(overlay.getByTestId('approval-column-close')).toContainText('Back to Plan');
    await shot(page, 'r9-approval-light');
    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);
    await card.getByTestId('todo-thread-answer').click();
    await expect(overlay).toBeVisible();
    const item = (await approvals(page)).items.find(entry => entry.todo?.number === 1 && entry.state === 'waiting');
    await page.evaluate(async id => { await window.electronAPI.notify.run({ type: 'answer', id, answer: { choice: 'EUR' } }); }, item?.id ?? '');
    await expect(overlay).toHaveCount(0, { timeout: 15_000 });
    // Reads Working at once, through the answer's Undo hold, and focus stays on the page (round 7 QA, R9).
    await expect(page.getByTestId('todo-chip-status')).toContainText('Working', { timeout: 1_500 });
    await expect(page.getByTestId('todo-page-title')).toBeFocused();
    await expect.poll(async () => (await detail(page, 1)).status.status, { timeout: 15_000 }).not.toBe('waiting');

    // R7: hidden is remembered for this to-do across another to-do and a reload; ⌘\ shows it again.
    await page.getByTestId('todo-split-toggle').click();
    await expect(page.getByTestId('todo-split')).toHaveCount(0);
    await shot(page, 'r7-hidden-light');
    await openTodo(page, 3);
    await openTodo(page, 1);
    await expect(page.getByTestId('todo-split')).toHaveCount(0);
    await page.reload();
    await openTodo(page, 1);
    await expect(page.getByTestId('todo-split')).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+Backslash');
    await expect(page.getByTestId('todo-split')).toBeVisible();

    // R22: the same screens in dark.
    await theme(page, 'dark');
    await shot(page, 'r7-page-dark');
    await page.getByTestId('todo-details-toggle').click();
    await shot(page, 'r7-details-dark');
  } finally {
    await close();
  }
});

test('a database from an earlier to-dos build opens: reply_to is added and its activity shows (R21)', async ({ baseURL }) => {
  test.setTimeout(180_000);
  const port = new URL(baseURL ?? 'http://localhost:4521').port;
  const run = await setup('pane-todos-r21', { VITE_PORT: port, PANE_TODOS_TIME_SCALE: '1' });
  try {
    const sessionA = await createSession(run.page, 'Billing rewrite');
    await json(run.pane, ['todos', 'create', 'Older to-do'], sessionA);
    await json(run.pane, ['todos', 'comment', 'T-1', 'written before the upgrade'], await ownCaller(run.page, 1));
    await run.app.close();
    // Turn the database back into one an earlier #1481 build made: no reply_to column.
    const db = path.join(run.pane.paneDir, 'sessions.db');
    execFileSync('/usr/bin/sqlite3', [db, 'DROP INDEX idx_todo_activity_reply; ALTER TABLE todo_activity DROP COLUMN reply_to;']);
    expect(execFileSync('/usr/bin/sqlite3', [db, 'PRAGMA table_info(todo_activity);'], { encoding: 'utf8' })).not.toContain('reply_to');
    const again = await launchIsolated(run.pane, baseURL, { PANE_CHAT_TEST_AGENT: AGENT, PANE_TODOS_TIME_SCALE: '1', VITE_PORT: port });
    try {
      await expect.poll(async () => (await detail(again.page, 1)).activity.map(row => row.body), { timeout: 30_000 }).toContain('written before the upgrade');
      expect(execFileSync('/usr/bin/sqlite3', [db, 'PRAGMA table_info(todo_activity);'], { encoding: 'utf8' })).toContain('reply_to');
    } finally {
      await again.app.close().catch(() => undefined);
    }
  } finally {
    await run.close();
  }
});
