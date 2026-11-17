import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { NotifySnapshot } from '../shared/types/notify';
import type { TodoDetail, TodosSnapshot } from '../shared/types/todos';
import { dismissDialogs, isolatedPane, launchIsolated, runpane, type IsolatedPane } from './isolatedPane';

// To-dos journeys in a real, isolated Pane (D-288): shared by todos.spec.ts and todos-page.spec.ts. Every
// Session's chat runs the scripted ACP agent, so no real agent or account is touched.

export const SHOTS = process.env.TODOS_SHOTS_DIR;
export const AGENT = path.resolve('main/src/services/chatTabs/testing/scriptedAgent.mjs');
export const SCALE = 60;

export interface SessionRef { id: string; paneId: string; panelId: string }

export async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

export async function json<T>(pane: IsolatedPane, args: string[], from?: { paneId: string; panelId: string }): Promise<T> {
  // SAFETY: each call site names the shape `runpane … --json` prints for that command.
  return JSON.parse(await runpane(pane, [...args, '--json'], from)) as T;
}

export async function failure(pane: IsolatedPane, args: string[], from?: { paneId: string; panelId: string }): Promise<string> {
  return runpane(pane, [...args, '--json'], from).then(out => `unexpected success: ${out}`, (error: Error) => error.message);
}

export async function createSession(page: Page, name: string): Promise<SessionRef> {
  return page.evaluate(async sessionName => {
    const result = await window.electronAPI.orchestrationSessions.create({ name: sessionName, agent: 'claude' });
    // SAFETY: orchestration-sessions:create returns an OrchestrationSessionView in `data` when it succeeds.
    const view = result.data as { session: { id: string; internalSessionId: string }; panel: { id: string } };
    return { id: view.session.id, paneId: view.session.internalSessionId, panelId: view.panel.id };
  }, name);
}

export async function snapshot(page: Page): Promise<TodosSnapshot> {
  return page.evaluate(async () => {
    const response = await window.electronAPI.todos.snapshot();
    if (!response.success || !response.data) throw new Error(response.error ?? 'no snapshot');
    return response.data;
  });
}

export async function detail(page: Page, number: number): Promise<TodoDetail> {
  return page.evaluate(async todoNumber => {
    const response = await window.electronAPI.todos.detail(todoNumber);
    if (!response.success || !response.data) throw new Error(response.error ?? 'no detail');
    return response.data;
  }, number);
}

export async function approvals(page: Page): Promise<NotifySnapshot> {
  return page.evaluate(() => window.electronAPI.notify.getSnapshot());
}

export async function answer(page: Page, id: string, choice: string): Promise<void> {
  await page.evaluate(async ({ itemId, pick }) => { await window.electronAPI.notify.run({ type: 'answer', id: itemId, answer: { choice: pick } }); }, { itemId: id, pick: choice });
}

/** Everything the chat tab's agent was sent, as the scripted agent echoes it. */
export async function transcript(page: Page, panelId: string): Promise<string> {
  return page.evaluate(async id => JSON.stringify(await window.electronAPI.chatTab.get(id, 500)), panelId);
}

export async function statusOf(page: Page, number: number): Promise<string> {
  return (await detail(page, number)).status.status;
}

export interface Running {
  pane: IsolatedPane;
  app: ElectronApplication;
  page: Page;
  repo: string;
  close: () => Promise<void>;
}

/** A to-do's own Session's orchestrator, as runpane's caller: its hidden owner Pane and tab. */
export async function ownCaller(page: Page, number: number): Promise<{ paneId: string; panelId: string }> {
  const todo = await detail(page, number);
  const paneId = await page.evaluate(async id => (await window.electronAPI.orchestrationSessions.get({ sessionId: id })).data?.session.internalSessionId ?? '', todo.todo.sessionId ?? '');
  return { paneId, panelId: todo.orchestrator?.panelId ?? '' };
}

export async function setup(prefix: string, extra: Record<string, string> = {}): Promise<Running> {
  const pane = isolatedPane(prefix);
  const bin = path.join(pane.root, 'fake-bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.999 (Claude Code)"; exit 0; fi\necho "stand-in claude"\nexit 1\n');
  chmodSync(path.join(bin, 'claude'), 0o755);
  pane.env.PATH = `${bin}${path.delimiter}${pane.env.PATH}`;
  const repo = path.join(pane.root, 'repo');
  mkdirSync(repo);
  writeFileSync(path.join(repo, 'README.md'), '# demo\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=qa@example.com', '-c', 'user.name=QA', 'commit', '-qm', 'init', '--allow-empty'], { cwd: repo });
  const { app, page } = await launchIsolated(pane, undefined, { PANE_CHAT_TEST_AGENT: AGENT, PANE_TODOS_TIME_SCALE: String(SCALE), ...extra });
  await page.evaluate(async repoPath => {
    const api = window.electronAPI;
    await api.config.update({ chatTabsEnabled: true, notify: { enabled: true, showOutsidePane: false } });
    await api.projects.create({ name: 'demo', path: repoPath, active: true });
  }, repo);
  await dismissDialogs(page);
  await expect.poll(() => runpane(pane, ['doctor', '--json']).then(() => true, () => false), { timeout: 30_000 }).toBe(true);
  return {
    pane, app, page, repo,
    close: async () => {
      await app.close().catch(() => undefined);
      rmSync(pane.root, { recursive: true, force: true });
    },
  };
}
