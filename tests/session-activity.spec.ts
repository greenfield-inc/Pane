import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dismissDialogs, isolatedPane, launchIsolated, runpane, type IsolatedPane } from './isolatedPane';

// Session activity journeys (cover sheet r1, J1–J12 and J16) in an isolated Electron build. The
// orchestrators are the scripted ACP agent; workers run the fake terminal agent, which replays
// real Claude Code and Codex captures (main/src/services/agentStatus/__fixtures__/screens), or
// plain shells. A recorder watches each Session row's icon and logs every change with its time.
// Every journey runs in its own Session, all at once, so the whole run takes about four minutes.

const AGENT = path.resolve('main/src/services/chatTabs/testing/scriptedAgent.mjs');
const FAKE = path.resolve('tests/fixtures/fakeTerminalAgent.mjs');
const SCREENS = path.resolve('main/src/services/agentStatus/__fixtures__/screens');
const SHOTS = process.env.SESSION_ACTIVITY_SHOTS_DIR;
/** A chat turn with no update for this long stalls (PANE_CHAT_STALL_MS), so J7 runs in seconds. */
const STALL_MS = 20_000;

interface SessionRef { id: string; name: string; paneId: string; panelId: string }
interface Change { state: string; at: number }

const fake = (fixture: string, ...options: string[]) => [process.execPath, FAKE, path.join(SCREENS, `${fixture}.json`), ...options].map(part => `'${part}'`).join(' ');

async function createSession(page: Page, name: string): Promise<SessionRef> {
  return page.evaluate(async sessionName => {
    const result = await window.electronAPI.orchestrationSessions.create({ name: sessionName, agent: 'claude' });
    // SAFETY: orchestration-sessions:create returns an OrchestrationSessionView in `data` when it succeeds.
    const view = result.data as { session: { id: string; internalSessionId: string }; panel: { id: string } };
    return { id: view.session.id, name: sessionName, paneId: view.session.internalSessionId, panelId: view.panel.id };
  }, name);
}

async function say(page: Page, session: SessionRef, text: string): Promise<number> {
  const at = Date.now();
  await page.evaluate(async ({ panelId, message }) => {
    await window.electronAPI.chatTab.send(panelId, { operationId: `op-${Math.random()}`, text: message });
  }, { panelId: session.panelId, message: text });
  return at;
}

async function chatStatus(page: Page, panelId: string): Promise<string> {
  return page.evaluate(async id => (await window.electronAPI.chatTab.get(id, 0)).status, panelId);
}

/** A worker Pane in the Session, made from its orchestrator's tab so it joins it (#1346). */
async function worker(pane: IsolatedPane, repo: string, session: SessionRef, name: string, command: string, agent?: string): Promise<{ paneId: string; panelId: string }> {
  const args = ['panes', 'create', '--repo', repo, '--name', name, '--tool-command', command, '--no-focus', '--source', 'agent', '--yes', '--json'];
  if (agent) args.push('--agent', agent);
  const out = JSON.parse(await runpane(pane, args, session));
  const { paneId, panelId } = out.items?.[0] ?? {};
  expect(paneId && panelId, `runpane panes create answered ${JSON.stringify(out)}`).toBeTruthy();
  return { paneId, panelId };
}

/** Watch every Session row's icon; log each change with its time. */
async function installRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const log: Record<string, Array<{ state: string; at: number }>> = {};
    const read = () => {
      for (const row of document.querySelectorAll<HTMLElement>('button[data-testid^="orchestration-session-"]')) {
        const id = row.dataset.testid!.slice('orchestration-session-'.length);
        const state = row.querySelector<HTMLElement>('[data-testid="session-activity-icon"]')?.dataset.state ?? 'none';
        const changes = (log[id] ??= []);
        if (changes.at(-1)?.state !== state) changes.push({ state, at: Date.now() });
      }
    };
    new MutationObserver(read).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state'] });
    read();
    (window as unknown as { __activity: typeof log }).__activity = log;
  });
}

async function changes(page: Page, session: SessionRef): Promise<Change[]> {
  // SAFETY: installRecorder sets window.__activity to this shape.
  return page.evaluate(id => (window as unknown as { __activity: Record<string, Change[]> }).__activity[id] ?? [], session.id);
}

/** The changes after the first one the recorder saw (the row appearing idle). */
const transitions = (log: Change[]) => log.slice(1).map(change => change.state);
const firstAt = (log: Change[], state: string, after = 0) => log.find(change => change.state === state && change.at >= after)?.at;

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

test.describe.configure({ mode: 'serial' });

test('the Session icon spins only for real turns, with no flicker (J1–J10, J12)', async ({ baseURL }) => {
  test.setTimeout(540_000);
  const pane = isolatedPane('pane-session-activity');
  const repo = path.join(pane.root, 'repo');
  mkdirSync(repo);
  writeFileSync(path.join(repo, 'README.md'), '# demo\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=qa@example.com', '-c', 'user.name=QA', 'commit', '-qm', 'init', '--allow-empty'], { cwd: repo });
  let { app, page } = await launchIsolated(pane, baseURL, { PANE_CHAT_TEST_AGENT: AGENT, PANE_CHAT_STALL_MS: String(STALL_MS) });
  try {
    await page.evaluate(async repoPath => {
      const api = window.electronAPI;
      await api.config.update({ chatTabsEnabled: true });
      await api.projects.create({ name: 'demo', path: repoPath, active: true });
    }, repo);
    await dismissDialogs(page);
    const names = ['J1 short', 'J2 long', 'J3 waiting', 'J4 worker', 'J5 prompts', 'J6 shells', 'J7 frozen', 'J7 stall', 'J8 busy', 'J8 quiet', 'J9 archive', 'J9 close', 'J9 detach', 'J10 long command'];
    const s: Record<string, SessionRef> = {};
    for (const name of names) s[name] = await createSession(page, name);
    await expect.poll(async () => (await page.locator('button[data-testid^="orchestration-session-"]').count()), { timeout: 20_000 }).toBeGreaterThanOrEqual(names.length);
    await expect.poll(() => runpane(pane, ['doctor', '--json']).then(() => true, () => false), { timeout: 30_000 }).toBe(true);
    // Every orchestrator starts and settles before the journeys, so starting never reads as work.
    for (const name of names) await say(page, s[name], 'hello');
    for (const name of names) await expect.poll(() => chatStatus(page, s[name].panelId), { timeout: 30_000 }).toBe('idle');
    await installRecorder(page);

    // Start every journey together. A poller in this process notes when J2's and J7's chat turns end.
    const t0 = Date.now();
    const ended: Record<string, number> = {};
    const poller = setInterval(() => {
      for (const name of ['J2 long', 'J7 stall']) {
        if (ended[name]) continue;
        void chatStatus(page, s[name].panelId).then(status => { if (status === 'idle' && Date.now() - t0 > 5_000) ended[name] ??= Date.now(); }, () => undefined);
      }
    }, 250);
    await say(page, s['J1 short'], 'turn 4');
    const j2Start = await say(page, s['J2 long'], 'turn 40');
    // J3: the orchestrator follows its Session with runpane watch in the foreground; a worker takes a turn later.
    const j3Worker = await worker(pane, repo, s['J3 waiting'], 'j3-worker', fake('claude-long-bash', '--to', 'idle'), 'claude');
    await say(page, s['J3 waiting'], `run runpane watch --follow --session '${s['J3 waiting'].id}' --json`);
    await worker(pane, repo, s['J4 worker'], 'j4-worker', fake('claude-long-bash', '--from', 'turn-start', '--to', 'turn-end'), 'claude');
    await worker(pane, repo, s['J5 prompts'], 'j5-claude', fake('claude-permission', '--from', 'turn-start', '--to', 'dismissed'), 'claude');
    await worker(pane, repo, s['J5 prompts'], 'j5-codex', fake('codex-approval-typing', '--from', 'turn-start', '--to', 'dismissed'), 'codex');
    await worker(pane, repo, s['J5 prompts'], 'j5-menu', fake('claude-menu-typing', '--from', 'menu', '--to', 'menu-closed'), 'claude');
    const devServer = `sh -c 'while true; do echo "GET / 200 $(date +%s)"; sleep 0.2; done'`;
    await worker(pane, repo, s['J6 shells'], 'j6-dev-server', devServer);
    // The same dev server in the orchestrator's own Pane, beside its chat.
    await page.evaluate(async ({ paneId, command }) => {
      await window.electronAPI.panels.createPanel(paneId, 'terminal', 'Dev server', { customState: { initialCommand: command } });
    }, { paneId: s['J6 shells'].paneId, command: devServer });
    await worker(pane, repo, s['J6 shells'], 'j6-typing', fake('claude-menu-typing', '--from', 'typing', '--to', 'typed'), 'claude');
    const j7FrozenAt = Date.now();
    await worker(pane, repo, s['J7 frozen'], 'j7-frozen', fake('claude-long-bash', '--from', 'turn-start', '--to', 'bash-mid'), 'claude');
    const j7Stall = await say(page, s['J7 stall'], 'stall');
    const j8Start = Date.now();
    await worker(pane, repo, s['J8 busy'], 'j8-worker', fake('claude-long-bash', '--from', 'turn-start', '--to', 'turn-end'), 'claude');
    const loop = (seconds: number) => fake('claude-long-bash', '--from', 'turn-start', '--loop', `bash-start:bash-late:${seconds}`, '--to', 'turn-end');
    const j9a = await worker(pane, repo, s['J9 archive'], 'j9-archive', loop(120), 'claude');
    const j9b = await worker(pane, repo, s['J9 close'], 'j9-close', loop(120), 'claude');
    const j9c = await worker(pane, repo, s['J9 detach'], 'j9-detach', loop(120), 'claude');
    await worker(pane, repo, s['J10 long command'], 'j10-claude', loop(180), 'claude');
    await worker(pane, repo, s['J10 long command'], 'j10-codex', fake('codex-long-command', '--from', 'turn-start', '--loop', 'working:command-late:180', '--to', 'turn-end'), 'codex');

    // J4: a collapsed Session with a working worker spins and says "1 working".
    const j4Row = page.getByTestId(`orchestration-session-${s['J4 worker'].id}`);
    await expect(j4Row.getByTestId('session-activity-icon')).toHaveAttribute('data-state', 'working', { timeout: 20_000 });
    await expect(j4Row).toContainText('1 working');
    await shot(page, 'j4-working');

    // J3: the worker's turn starts 25 s in, while the watch is open.
    await page.waitForTimeout(Math.max(0, t0 + 25_000 - Date.now()));
    const j3Turn = Date.now();
    await runpane(pane, ['panels', 'create', '--pane', j3Worker.paneId, '--tool-command', fake('claude-long-bash', '--from', 'turn-start', '--to', 'turn-end'), '--agent', 'claude', '--no-focus', '--yes', '--json']);

    // J9: 45 s in, with all three working, archive one Pane, close another's tab, detach the third.
    await page.waitForTimeout(Math.max(0, t0 + 45_000 - Date.now()));
    for (const name of ['J9 archive', 'J9 close', 'J9 detach']) expect((await changes(page, s[name])).at(-1)?.state, name).toBe('working');
    const j9At = Date.now();
    await runpane(pane, ['panes', 'archive', '--pane', j9a.paneId, '--force', '--yes', '--json']);
    await runpane(pane, ['panels', 'close', '--panel', j9b.panelId, '--force', '--yes', '--json']);
    await runpane(pane, ['sessions', 'detach', '--session', s['J9 detach'].id, '--pane', j9c.paneId, '--yes', '--json']);

    // Let the long ones finish: J10's 180 s loop (which ends at a loop's end, up to 35 s later),
    // its reply, and 10 s of quiet after.
    await page.waitForTimeout(Math.max(0, t0 + 300_000 - Date.now()));
    clearInterval(poller);
    await shot(page, 'after');
    const log = (name: string) => changes(page, s[name]);
    const report: Record<string, unknown> = {};
    for (const name of names) report[name] = (await log(name)).map(change => `${change.state}@${((change.at - t0) / 1000).toFixed(1)}s`);
    console.log(`[session activity] t0-relative changes: ${JSON.stringify(report, null, 1)}`);

    // J1: a 4 s turn never shows.
    expect(transitions(await log('J1 short'))).toEqual([]);
    // J2: spins 9.5–11.5 s in and goes idle 9.5–11.5 s after the turn ends; two changes only.
    const j2 = await log('J2 long');
    expect(transitions(j2)).toEqual(['working', 'idle']);
    expect(firstAt(j2, 'working')! - j2Start).toBeGreaterThanOrEqual(9_500);
    expect(firstAt(j2, 'working')! - j2Start).toBeLessThanOrEqual(11_500);
    expect(firstAt(j2, 'idle', j2Start)! - ended['J2 long']).toBeGreaterThanOrEqual(9_000);
    expect(firstAt(j2, 'idle', j2Start)! - ended['J2 long']).toBeLessThanOrEqual(11_500);
    // J3: nothing while only the watch runs; the worker's turn spins it about 10 s in, and it
    // goes idle again while the watch is still open.
    const j3 = await log('J3 waiting');
    expect(j3.filter(change => change.at < j3Turn + 5_000 && change.state === 'working')).toEqual([]);
    expect(transitions(j3)).toEqual(['working', 'idle']);
    expect(firstAt(j3, 'working')! - j3Turn).toBeGreaterThanOrEqual(9_500);
    expect(firstAt(j3, 'working')! - j3Turn).toBeLessThanOrEqual(15_000);
    expect(await chatStatus(page, s['J3 waiting'].panelId)).toBe('working');
    // J4 and J8's busy worker: one turn, one spin.
    expect(transitions(await log('J4 worker'))).toEqual(['working', 'idle']);
    expect(transitions(await log('J8 busy'))).toEqual(['working', 'idle']);
    expect(firstAt(await log('J8 busy'), 'working')! - j8Start).toBeLessThanOrEqual(15_000);
    // J5, J6 and the other Session in J8 never spin.
    for (const name of ['J5 prompts', 'J6 shells', 'J8 quiet']) expect(transitions(await log(name)), name).toEqual([]);
    // J7: a frozen spinner stops counting 15 s after the screen last changed, then idle 10 s later.
    const j7 = await log('J7 frozen');
    expect(transitions(j7)).toEqual(['working', 'idle']);
    // The replay's last screen change comes this long after it starts (the tab's own start adds ~1 s).
    const capture = JSON.parse(readFileSync(path.join(SCREENS, 'claude-long-bash.json'), 'utf8')) as { frames: Array<{ t: number }>; marks: Array<{ t: number; label: string }> };
    const mark = (label: string) => capture.marks.find(entry => entry.label === label)!.t;
    const lastChange = Math.max(...capture.frames.filter(frame => frame.t < mark('bash-mid')).map(frame => frame.t)) - mark('turn-start');
    const frozenFor = firstAt(j7, 'idle', firstAt(j7, 'working'))! - (j7FrozenAt + lastChange);
    console.log(`[J7] idle ${(frozenFor / 1000).toFixed(1)} s after the screen froze`);
    expect(frozenFor).toBeGreaterThanOrEqual(23_000);
    expect(frozenFor).toBeLessThanOrEqual(29_000);
    // A stalled chat turn: working 10 s in, idle by the stall limit plus 10 s.
    const stall = await log('J7 stall');
    expect(transitions(stall)).toEqual(['working', 'idle']);
    expect(firstAt(stall, 'idle', firstAt(stall, 'working'))! - j7Stall).toBeLessThanOrEqual(STALL_MS + 12_000);
    // J9: idle within 10 s of the Pane leaving, and never working again.
    for (const name of ['J9 archive', 'J9 close', 'J9 detach']) {
      const j9 = await log(name);
      expect(transitions(j9), name).toEqual(['working', 'idle']);
      expect(firstAt(j9, 'idle', j9At)! - j9At, name).toBeLessThanOrEqual(10_000);
    }
    // J10: a long silent command spins once and holds, with no dips, until the turn ends.
    expect(transitions(await log('J10 long command'))).toEqual(['working', 'idle']);
    for (const name of names) {
      const log = await changes(page, s[name]);
      for (let index = 1; index < log.length - 1; index += 1) {
        expect(log[index + 1].at - log[index].at, `${name}: no state lasts under 10 s`).toBeGreaterThanOrEqual(9_500);
      }
    }

    // J12: a renderer reload mid-turn spins again within 2 s of the page being back.
    const j12 = await createSession(page, 'J12 reload');
    await worker(pane, repo, j12, 'j12-worker', loop(60), 'claude');
    const j12Row = () => page.getByTestId(`orchestration-session-${j12.id}`).getByTestId('session-activity-icon');
    await expect(j12Row()).toHaveAttribute('data-state', 'working', { timeout: 20_000 });
    await page.reload();
    await page.waitForFunction(() => !!window.electronAPI?.orchestrationSessions, undefined, { timeout: 30_000 });
    await expect(page.getByTestId(`orchestration-session-${j12.id}`)).toBeVisible({ timeout: 15_000 });
    const shownAt = Date.now();
    await expect(j12Row()).toHaveAttribute('data-state', 'working', { timeout: 2_000 });
    console.log(`[J12] reload: spinning ${Date.now() - shownAt} ms after the row came back`);
    // J12: an app restart recomputes from live tabs: nothing is mid-turn yet, so idle, not a stale spin.
    await app.close();
    ({ app, page } = await launchIsolated(pane, baseURL, { PANE_CHAT_TEST_AGENT: AGENT, PANE_CHAT_STALL_MS: String(STALL_MS) }));
    await expect(page.getByTestId(`orchestration-session-${j12.id}`)).toBeVisible({ timeout: 30_000 });
    await expect(j12Row()).toHaveAttribute('data-state', 'idle');
    await shot(page, 'j12-restarted');
  } finally {
    await app.close().catch(() => undefined);
    rmSync(pane.root, { recursive: true, force: true });
  }
});
