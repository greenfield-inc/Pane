import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RunpaneTodo, TodoAction } from '../shared/types/todos';
import { dismissDialogs, isolatedPane, launchIsolated, runpane, type IsolatedPane } from './isolatedPane';
import { AGENT, detail, json, shot, statusOf, transcript } from './todosHarness';

// Round 9 (T-17): snoozing in a real, isolated Pane (D-288), on the real clock. Every Session's chat runs
// the scripted ACP agent, so no real agent or account is touched. Service checks with a fake clock
// (todoSnooze.test.ts) cover the overdue, load, sleep and clock-change journeys; this one shows the
// real tick, the real tabs and a real restart doing it.

test.describe.configure({ mode: 'serial' });

async function act(page: Page, action: TodoAction): Promise<void> {
  const result = await page.evaluate(async todoAction => window.electronAPI.todos.act(todoAction), action);
  if (!result.success) throw new Error(result.error ?? `todos:act ${action.kind} failed`);
}

/** The messages typed into a chat tab (the scripted agent echoes each one back, so replies are left out). */
async function typed(page: Page, panelId: string): Promise<string[]> {
  return page.evaluate(async id => {
    const view = await window.electronAPI.chatTab.get(id, 500);
    return (view.transcript?.messages ?? []).filter(message => message.role === 'user')
      .map(message => message.parts.map(part => part.type === 'text' ? part.text : '').join(''));
  }, panelId);
}

async function count(page: Page, panelId: string, needle: string): Promise<number> {
  return (await typed(page, panelId)).filter(text => text.includes(needle)).length;
}

/**
 * As todosHarness's setup, but ready once the daemon answers a to-dos read: `runpane doctor` also
 * checks GitHub for the latest release and reads not-ok while GitHub rate-limits that lookup.
 */
async function start(prefix: string, extra: Record<string, string>): Promise<{ pane: IsolatedPane; app: Awaited<ReturnType<typeof launchIsolated>>['app']; page: Page }> {
  const pane = isolatedPane(prefix);
  const bin = path.join(pane.root, 'fake-bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.999 (Claude Code)"; exit 0; fi\necho "stand-in claude"\nexit 1\n');
  chmodSync(path.join(bin, 'claude'), 0o755);
  pane.env.PATH = `${bin}${path.delimiter}${pane.env.PATH}`;
  const repo = path.join(pane.root, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=qa@example.com', '-c', 'user.name=QA', 'commit', '-qm', 'init', '--allow-empty'], { cwd: repo });
  const { app, page } = await launchIsolated(pane, undefined, { PANE_CHAT_TEST_AGENT: AGENT, ...extra });
  await page.evaluate(async repoPath => {
    await window.electronAPI.config.update({ chatTabsEnabled: true, notify: { enabled: true, showOutsidePane: false } });
    await window.electronAPI.projects.create({ name: 'demo', path: repoPath, active: true });
  }, repo);
  await dismissDialogs(page);
  await expect.poll(() => runpane(pane, ['todos', 'list', '--json']).then(() => true, () => false), { timeout: 30_000 }).toBe(true);
  return { pane, app, page };
}

async function events(page: Page, number: number): Promise<string[]> {
  return (await detail(page, number)).activity.filter(row => row.kind === 'event').map(row => row.body);
}

test('snooze, held comment, wake on time, and a wake after a restart (S1, S2, S6, S9)', async ({ baseURL }) => {
  test.setTimeout(300_000);
  // The real clock: a wake is due seconds from now, and a restart keeps the same time.
  const extra = { VITE_PORT: new URL(baseURL ?? 'http://localhost:4675').port, PANE_TODOS_TIME_SCALE: '1' };
  const running = await start('pane-todos-snooze', extra);
  const { pane } = running;
  let { app, page } = running;
  try {
    const { todo } = await json<{ todo: RunpaneTodo }>(pane, ['todos', 'create', 'Ship', '--summary', 'Ship the invoices']);
    expect(todo.state).toBe('in_progress');
    const orchestrator = (await detail(page, todo.number)).orchestrator?.panelId ?? '';
    expect(orchestrator).toBeTruthy();
    await expect.poll(() => transcript(page, orchestrator), { timeout: 30_000 }).toContain('You are the orchestrator for T-1');
    // Launch resume has run (10 s after start), so the wake check is live.
    await page.waitForTimeout(11_000);

    // S1: snoozed from the app with a note: the row reads Snoozed, the orchestrator is told once, the thread logs it.
    const zone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    const until = Date.now() + 40_000;
    await act(page, { kind: 'snooze', number: todo.number, until, zone, note: 'check Sentry' });
    const snoozed = await detail(page, todo.number);
    expect(snoozed.status).toMatchObject({ status: 'snoozed', reason: expect.stringMatching(/^until .* · check Sentry$/) });
    expect(snoozed.todo).toMatchObject({ state: 'stopped', snooze: { until, zone, note: 'check Sentry', action: 'agents', by: 'you', from: 'in_progress' } });
    expect((await events(page, todo.number)).at(-1)).toMatch(/^Snoozed until .* by you: check Sentry$/);
    await expect.poll(async () => count(page, orchestrator, 'Snoozed T-1 until'), { timeout: 30_000 }).toBe(1);
    await shot(page, 'r9-a-s1-snoozed');

    // S9: a comment while snoozed is held: written, undelivered, and not typed into the tab.
    await act(page, { kind: 'comment', number: todo.number, body: 'use the blue one' });
    const held = (await detail(page, todo.number)).activity.find(row => row.body === 'use the blue one');
    expect(held).toMatchObject({ toTab: orchestrator });
    expect(held?.deliveredAt).toBeUndefined();
    await page.waitForTimeout(6_000);
    expect((await typed(page, orchestrator)).some(text => text.includes('use the blue one'))).toBe(false);

    // S2: the time arrives: In progress within a tick, one Reminder with the note and the held comment, same tab.
    await expect.poll(() => statusOf(page, todo.number), { timeout: 60_000, intervals: [1_000] }).not.toBe('snoozed');
    const woke = await detail(page, todo.number);
    expect(woke.todo.state).toBe('in_progress');
    expect(woke.todo.snooze).toBeUndefined();
    expect(woke.orchestrator?.panelId).toBe(orchestrator);
    expect(await events(page, todo.number)).toContainEqual(expect.stringMatching(/^Woke at \d{1,2}:\d{2} [AP]M$/));
    await expect.poll(async () => count(page, orchestrator, 'Reminder for T-1 "Ship"'), { timeout: 30_000 }).toBe(1);
    const reminder = (await typed(page, orchestrator)).find(text => text.includes('Reminder for T-1')) ?? '';
    expect(reminder).toContain('check Sentry');
    expect(reminder).toContain('While it was snoozed, the person wrote:\n- use the blue one');
    await expect.poll(async () => (await detail(page, todo.number)).activity.find(row => row.id === held?.id)?.deliveredAt, { timeout: 15_000 }).toBeDefined();
    await shot(page, 'r9-a-s2-woke');

    // S6: snoozed again, Pane quits before the time and starts after it: it wakes once, after launch resume, in the same tab.
    await act(page, { kind: 'snooze', number: todo.number, until: Date.now() + 8_000, zone, note: 'after the restart' });
    await app.close();
    await new Promise(resolve => setTimeout(resolve, 12_000));
    ({ app, page } = await launchIsolated(pane, baseURL, { PANE_CHAT_TEST_AGENT: AGENT, ...extra }));
    await dismissDialogs(page);
    // Its time passed while Pane was closed, so it may already have woken by the first read (a slow relaunch):
    // what matters is the log below, one wake after launch resume and no plain restart.
    await expect.poll(() => statusOf(page, todo.number), { timeout: 60_000, intervals: [1_000] }).not.toBe('snoozed');
    const after = await detail(page, todo.number);
    expect(after.todo.state).toBe('in_progress');
    expect(after.orchestrator?.panelId).toBe(orchestrator);
    const sinceRestart = after.activity.filter(row => row.kind === 'event' && row.createdAt > until + 20_000).map(row => row.body);
    expect(sinceRestart.filter(body => body.startsWith('Woke at'))).toHaveLength(1);
    expect(sinceRestart.some(body => body.startsWith('Pane restarted'))).toBe(false);
    await expect.poll(async () => count(page, orchestrator, 'after the restart'), { timeout: 45_000 }).toBe(1);
    await shot(page, 'r9-a-s6-after-restart');
  } finally {
    await app.close().catch(() => undefined);
    rmSync(pane.root, { recursive: true, force: true });
  }
});
