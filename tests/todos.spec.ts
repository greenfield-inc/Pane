import { expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RunpaneTodo, RunpaneTodoShowResult } from '../shared/types/todos';
import { shot, json, failure, createSession, snapshot, detail, approvals, answer, transcript, statusOf, ownCaller, setup } from './todosHarness';

// To-dos (D-409) in a real, isolated Pane (D-288). Every Session's chat runs the scripted ACP agent,
// so no real agent or account is touched. PANE_TODOS_TIME_SCALE=60 runs the supervisor's and the
// load gate's minutes as seconds; PANE_MEMORY_PRESSURE_TEST_LEVEL stands in for memory pressure.

test.describe.configure({ mode: 'serial' });

test('an orchestrator creates a to-do: own hidden Session, requester asked first, review, Accept, done, archive (J1, J17, J20, J22, J23, J32, J34, J37, J47)', async ({ baseURL }) => {
  test.setTimeout(240_000);
  const { pane, page, close } = await setup('pane-todos-flow', { VITE_PORT: new URL(baseURL ?? 'http://localhost:4521').port });
  try {
    const sessionA = await createSession(page, 'Billing rewrite');
    const plan = path.join(pane.root, 'plan.html');
    writeFileSync(plan, '<h1>Plan</h1>');

    // J1: created by Session A's orchestrator, with a plan attached, then a sub-to-do.
    const started = Date.now();
    const { todo } = await json<{ todo: RunpaneTodo }>(pane, ['todos', 'create', 'Invoice PDFs', '--summary', 'Render invoices as PDFs', '--done-when', 'PDF renders', '--attach', plan], sessionA);
    const { todo: sub } = await json<{ todo: RunpaneTodo }>(pane, ['todos', 'create', 'Fonts', '--parent', todo.ref], sessionA);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(todo).toMatchObject({ ref: 'T-1', state: 'in_progress', requester: 'Billing rewrite orchestrator', attachmentCount: 1 });
    expect(sub).toMatchObject({ ref: 'T-2', parent: 'T-1', sessionId: todo.sessionId });
    const own = await snapshot(page);
    expect(own.ownSessionIds).toEqual([todo.sessionId]);
    // J17: the to-do's own Session is out of the Sessions sidebar.
    await expect(page.getByTestId(`orchestration-session-${todo.sessionId}`)).toHaveCount(0);
    await expect(page.getByTestId(`orchestration-session-${sessionA.id}`)).toHaveCount(1);
    await shot(page, 'j1-created');

    // The to-do's orchestrator got the to-do with its requester and attachments, typed in once.
    const t1 = await detail(page, 1);
    const orchestrator = t1.orchestrator?.panelId ?? '';
    expect(orchestrator).toBeTruthy();
    await expect.poll(() => transcript(page, orchestrator), { timeout: 30_000 }).toContain('requested by Billing rewrite orchestrator');
    expect(await transcript(page, orchestrator)).toContain(plan);
    const t1Ref = await ownCaller(page, 1);

    // J32: attach a file and a URL; J33: inherited on the sub-to-do without a copy.
    await json(pane, ['todos', 'attach', 'T-1', 'https://github.com/o/r/pull/7', '--kind', 'pr', '--label', 'PR #7'], t1Ref);
    const shown = await json<RunpaneTodoShowResult>(pane, ['todos', 'show', 'T-2']);
    expect(shown.attachments.map(item => [item.from, item.label])).toEqual([['T-1', 'plan.html'], ['T-1', 'PR #7']]);

    // J20: T-1's orchestrator asks its requester first; it is typed into Session A's orchestrator.
    const asked = await json<{ routedTo: string }>(pane, ['todos', 'ask', 'T-1', 'Which currency?'], t1Ref);
    expect(asked.routedTo).toBe('requester');
    await expect.poll(() => transcript(page, sessionA.panelId), { timeout: 30_000 }).toContain('asked by its orchestrator] Which currency?');
    // A's reply reaches T-1's orchestrator; escalating makes it the person's approval, linked to T-1.
    await json(pane, ['todos', 'comment', 'T-1', 'EUR'], sessionA);
    await expect.poll(() => transcript(page, orchestrator), { timeout: 30_000 }).toContain('via To-dos T-1] EUR');
    await json(pane, ['todos', 'comment', 'T-1', 'I am not sure, ask the person', '--escalate'], sessionA);
    // oxlint-disable-next-line pane/no-bare-todo-number -- one isolated Pane, so every card here is this machine's.
    await expect.poll(async () => (await approvals(page)).items.find(item => item.todo?.number === 1 && item.state === 'waiting')?.title, { timeout: 15_000 }).toBe('Which currency?');
    expect(await statusOf(page, 1)).toBe('waiting');
    // oxlint-disable-next-line pane/no-bare-todo-number -- one isolated Pane, so every card here is this machine's.
    const question = (await approvals(page)).items.find(item => item.todo?.number === 1 && item.state === 'waiting');
    await page.evaluate(async id => { await window.electronAPI.notify.run({ type: 'answer', id, answer: { text: 'EUR' } }); }, question?.id ?? '');

    // J23: an agent can't close an unaccepted top-level to-do; a sub-to-do closes at once.
    expect(await failure(pane, ['todos', 'done', 'T-1'], t1Ref)).toContain('todos review T-1');
    expect((await json<{ todo: RunpaneTodo }>(pane, ['todos', 'done', 'T-2'], t1Ref)).todo.state).toBe('done');

    // J22 / J37: review with attachments raises a review approval; Accept → Accepted; then done.
    const review = await json<{ approvalId: string }>(pane, ['todos', 'review', 'T-1', '--summary', 'PDFs render'], t1Ref);
    await expect.poll(async () => (await detail(page, 1)).status.reason, { timeout: 15_000 }).toBe('ready for your review');
    await shot(page, 'j22-review');
    await answer(page, review.approvalId, 'Accept');
    await expect.poll(async () => (await detail(page, 1)).todo.state, { timeout: 15_000 }).toBe('accepted');
    await expect.poll(() => transcript(page, orchestrator), { timeout: 30_000 }).toContain('Accepted. Do the post-acceptance work');
    expect((await json<{ todo: RunpaneTodo }>(pane, ['todos', 'done', 'T-1'], t1Ref)).todo.state).toBe('done');
    // The requester heard about the review and the done, and nothing else.
    await expect.poll(() => transcript(page, sessionA.panelId), { timeout: 30_000 }).toContain('which you requested, is done');
    expect(await transcript(page, sessionA.panelId)).toContain('which you requested, asks the person for review');

    // J47: archive the done to-do's Session (no Panes here): the Session is archived.
    const archived = await json<{ sessionArchived: boolean }>(pane, ['todos', 'archive', 'T-1'], t1Ref);
    expect(archived.sessionArchived).toBe(true);
  } finally {
    await close();
  }
});

test('the supervisor reminds, restarts and asks you on a quiet to-do, on a fast clock (J24, J26)', async ({ baseURL }) => {
  test.setTimeout(240_000);
  const { pane, page, close } = await setup('pane-todos-supervisor', { VITE_PORT: new URL(baseURL ?? 'http://localhost:4521').port });
  try {
    const { todo } = await json<{ todo: RunpaneTodo }>(pane, ['todos', 'create', 'Quiet one', '--attach', path.join(pane.root, 'plan.md')]);
    expect(todo.state).toBe('in_progress');
    // 10, 20, 30 and 40 minutes pass in about 10, 20, 30 and 40 seconds.
    await expect.poll(async () => (await detail(page, 1)).activity.map(row => row.body).join('\n'), { timeout: 90_000, intervals: [2_000] })
      .toContain('Pane reminded the orchestrator (1 of 2)');
    await expect.poll(async () => (await detail(page, 1)).activity.map(row => row.body).join('\n'), { timeout: 90_000, intervals: [2_000] })
      .toMatch(/Pane restarted the orchestrator|was down or hung/);
    await expect.poll(() => statusOf(page, 1), { timeout: 90_000, intervals: [2_000] }).toBe('waiting');
    // oxlint-disable-next-line pane/no-bare-todo-number -- one isolated Pane, so every card here is this machine's.
    const card = (await approvals(page)).items.find(item => item.todo?.number === 1 && item.state === 'waiting');
    expect(card?.title).toMatch(/^T-1 has been stuck for \d+ minutes/);
    // J17: its own Session stays out of the sidebar even with a card waiting.
    await expect(page.getByTestId(`orchestration-session-${todo.sessionId}`)).toHaveCount(0);
    await shot(page, 'j24-stuck-card');
    await answer(page, card?.id ?? '', 'Stop it');
    await expect.poll(async () => (await detail(page, 1)).status.reason, { timeout: 15_000 }).toBe('stopped by you');
  } finally {
    await close();
  }
});

test('the load gate holds new to-dos under memory pressure and starts them when it eases (J39, J41, J42)', async ({ baseURL }) => {
  test.setTimeout(240_000);
  const { pane, app, page, close } = await setup('pane-todos-gate', { VITE_PORT: new URL(baseURL ?? 'http://localhost:4521').port, PANE_MEMORY_PRESSURE_TEST_LEVEL: 'warning' });
  try {
    // A running to-do makes the gate sample; Warning for 30 s (half a second here) holds starts.
    await json(pane, ['todos', 'create', 'Running']);
    await expect.poll(async () => (await snapshot(page)).gate.state, { timeout: 60_000 }).toBe('holding');
    const { todo } = await json<{ todo: RunpaneTodo }>(pane, ['todos', 'create', 'Waits for load']);
    expect(todo).toMatchObject({ status: 'queued', sessionId: null });
    expect(todo.reason).toMatch(/is busy · starts when load comes down$/);
    // J41: an agent start from the running to-do's Session is refused with machine_busy.
    const caller = await ownCaller(page, 1);
    expect(await failure(pane, ['panels', 'create', '--pane', caller.paneId, '--tool-command', 'echo hi', '--source', 'agent', '--yes'], caller)).toContain('machine_busy');
    await shot(page, 'j39-queued');
    // Back to OK: after 2 minutes of OK (2 s here) the queued to-do starts, with its own Session.
    await app.evaluate(() => { process.env.PANE_MEMORY_PRESSURE_TEST_LEVEL = 'ok'; });
    await expect.poll(async () => (await snapshot(page)).gate.state, { timeout: 60_000 }).toBe('normal');
    await expect.poll(async () => (await detail(page, todo.number)).todo.sessionId, { timeout: 60_000 }).not.toBeNull();
    // J42: Start anyway on a queued to-do starts it now and marks it Never pause.
    await app.evaluate(() => { process.env.PANE_MEMORY_PRESSURE_TEST_LEVEL = 'warning'; });
    await expect.poll(async () => (await snapshot(page)).gate.state, { timeout: 60_000 }).toBe('holding');
    const { todo: urgent } = await json<{ todo: RunpaneTodo }>(pane, ['todos', 'create', 'Urgent']);
    expect(urgent.status).toBe('queued');
    await page.evaluate(async number => { await window.electronAPI.todos.act({ kind: 'start', number, anyway: true }); }, urgent.number);
    const started = await detail(page, urgent.number);
    expect(started.todo).toMatchObject({ loadOverride: 'never_pause', loadHold: null });
    expect(started.todo.sessionId).not.toBeNull();
  } finally {
    await close();
  }
});
