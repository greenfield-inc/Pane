import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TodoCreateInput, TodoDetail, TodoRecord } from '../shared/types/todos';
import { dismissDialogs, isolatedPane, launchIsolated, runpane, type IsolatedPane } from './isolatedPane';

// To-dos with real agents (Q-404): a real Claude Code orchestrator attaches its plan without being
// told to (J38), and a message from the to-do's chat reaches a real Codex orchestrator, which
// replies into the chat (J11). Each runs in an isolated Pane (D-288) signed in from your existing
// login (isolatedPane's agentLogin). It spends real model turns, so it runs only with
// TODOS_REAL=1 and never in CI:
//
//   TODOS_REAL=1 npx playwright test --config=playwright.chat-tabs.config.ts tests/todos-real.spec.ts

test.skip(process.env.TODOS_REAL !== '1', 'Spends real model turns; set TODOS_REAL=1 to run it.');
test.describe.configure({ mode: 'serial' });

async function screen(pane: IsolatedPane, panelId: string): Promise<string> {
  const out = JSON.parse(await runpane(pane, ['panels', 'screen', '--panel', panelId, '--limit', '80', '--json']));
  return String(out.text ?? out.screen ?? (Array.isArray(out.lines) ? out.lines.join('\n') : JSON.stringify(out)));
}

async function detail(page: Page, number: number): Promise<TodoDetail> {
  return page.evaluate(async todoNumber => {
    const response = await window.electronAPI.todos.detail(todoNumber);
    if (!response.success || !response.data) throw new Error(response.error ?? 'no detail');
    return response.data;
  }, number);
}

/** A real Pane with one project, its Sessions run by real terminal agents. */
async function start(prefix: string, baseURL: string | undefined) {
  const pane = isolatedPane(prefix, {}, { agentLogin: true });
  const repo = path.join(pane.root, 'repo');
  mkdirSync(repo);
  writeFileSync(path.join(repo, 'README.md'), '# demo\n\nA tiny CLI that prints "hello".\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=qa@example.com', '-c', 'user.name=QA', 'commit', '-qm', 'init'], { cwd: repo });
  const { app, page } = await launchIsolated(pane, baseURL);
  const projectId = await page.evaluate(async repoPath => {
    await window.electronAPI.config.update({ notify: { enabled: true, showOutsidePane: false } });
    const created = await window.electronAPI.projects.create({ name: 'demo', path: repoPath, active: true });
    // SAFETY: projects:create returns the new project in `data` when it succeeds.
    return (created.data as { id: number }).id;
  }, repo);
  await dismissDialogs(page);
  // Ready once the daemon answers a to-dos read. Not `runpane doctor`: its exit code also needs the latest
  // release from api.github.com, which reads not-ok while GitHub rate-limits CI's shared address.
  await expect.poll(() => runpane(pane, ['todos', 'list', '--json']).then(() => true, () => false), { timeout: 30_000 }).toBe(true);
  const create = (input: TodoCreateInput) => page.evaluate(async todo => {
    const response = await window.electronAPI.todos.create(todo);
    if (!response.success || !response.data) throw new Error(response.error ?? 'create failed');
    return response.data;
  }, input);
  return {
    pane, page, projectId, create,
    close: async () => {
      await app.close().catch(() => undefined);
      // A real agent may still be writing into the throwaway root as it exits.
      rmSync(pane.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    },
  };
}

test('a real Claude Code orchestrator attaches the plan it writes, unprompted (J38)', async ({ baseURL }, testInfo) => {
  test.setTimeout(900_000);
  const run = await start('pane-todos-real-claude', baseURL);
  const save = (name: string, text: string) => writeFileSync(testInfo.outputPath(`${name}.txt`), text);
  let panelId = '';
  try {
    const todo: TodoRecord = await run.create({
      title: 'Plan a --verbose flag',
      // Nothing here says to attach: the orchestrator learns that from Pane's own instructions.
      summary: 'Write a short plan (five lines at most) for adding a --verbose flag to the demo CLI, as plan.md in your Session folder. Do not start workers, Panes or code changes. When the plan file exists, reply with a one-line summary and wait.',
      doneWhen: ['plan.md exists'],
      projectId: run.projectId,
      agent: 'claude',
      startNow: true,
    });
    await expect.poll(async () => (await detail(run.page, todo.number)).orchestrator?.panelId ?? '', { timeout: 60_000 }).not.toBe('');
    panelId = (await detail(run.page, todo.number)).orchestrator?.panelId ?? '';
    let attachments: string[] = [];
    await expect.poll(async () => {
      attachments = (await detail(run.page, todo.number)).attachments.flatMap(group => group.attachments).map(item => `${item.source} ${item.addedBy} ${item.target}`);
      return attachments.some(line => line.endsWith('plan.md'));
    }, { timeout: 600_000, intervals: [5_000] }).toBe(true);
    console.log(`[J38] attachments: ${JSON.stringify(attachments)}`);
    save('claude-orchestrator', await screen(run.pane, panelId));
    const final = await detail(run.page, todo.number);
    save('claude-activity', JSON.stringify(final.activity, null, 2));
    await run.page.evaluate(n => { window.location.hash = `#/todos/${n}`; }, todo.number).catch(() => undefined);
    await run.page.screenshot({ path: testInfo.outputPath('j38-todo.png') });
  } catch (error) {
    if (panelId) save('claude-orchestrator-failed', await screen(run.pane, panelId).catch(() => ''));
    throw error;
  } finally {
    await run.close();
  }
});

test('a message in the to-do chat reaches a real Codex orchestrator, and its reply comes back (J11)', async ({ baseURL }, testInfo) => {
  test.setTimeout(900_000);
  const run = await start('pane-todos-real-codex', baseURL);
  const save = (name: string, text: string) => writeFileSync(testInfo.outputPath(`${name}.txt`), text);
  let panelId = '';
  try {
    const todo: TodoRecord = await run.create({
      title: 'Say hello',
      summary: 'This to-do only checks the chat. Do not start workers, Panes or code changes. Reply with a one-line summary that you are ready, then wait for a message from the person.',
      projectId: run.projectId,
      agent: 'codex',
      startNow: true,
    });
    await expect.poll(async () => (await detail(run.page, todo.number)).orchestrator?.panelId ?? '', { timeout: 60_000 }).not.toBe('');
    panelId = (await detail(run.page, todo.number)).orchestrator?.panelId ?? '';
    const replies = async () => (await detail(run.page, todo.number)).activity.filter(entry => entry.kind === 'message' && entry.authorKind === 'agent');
    // First the orchestrator's answer to its start (in the to-do's chat or only in its tab), then a
    // quiet spell, so the next message lands on an idle prompt.
    await expect.poll(async () => (await replies()).length > 0 || /assistant: \S/.test(await screen(run.pane, panelId)), { timeout: 420_000, intervals: [5_000] }).toBe(true);
    let last = '';
    await expect.poll(async () => { const now = await screen(run.pane, panelId); const still = now === last; last = now; return still; }, { timeout: 300_000, intervals: [15_000] }).toBe(true);
    save('codex-started', await screen(run.pane, panelId));
    const before = (await replies()).length;
    await run.page.evaluate(n => window.electronAPI.todos.act({ kind: 'comment', number: n, body: 'Please reply in this chat with the single word PINEAPPLE, and do nothing else.' }), todo.number);
    await expect.poll(async () => (await replies()).slice(before).some(entry => /PINEAPPLE/i.test(entry.body)), { timeout: 300_000, intervals: [5_000] }).toBe(true);
    const final = await detail(run.page, todo.number);
    save('codex-activity', JSON.stringify(final.activity, null, 2));
    save('codex-orchestrator', await screen(run.pane, panelId));
    console.log(`[J11] chat: ${JSON.stringify(final.activity.map(entry => `${entry.authorKind}: ${entry.body.slice(0, 120)}`))}`);
  } catch (error) {
    if (panelId) {
      save('codex-orchestrator-failed', await screen(run.pane, panelId).catch(() => ''));
      save('codex-output-failed', await runpane(run.pane, ['panels', 'output', '--panel', panelId, '--limit', '400', '--json']).catch(() => ''));
    }
    throw error;
  } finally {
    await run.close();
  }
});
