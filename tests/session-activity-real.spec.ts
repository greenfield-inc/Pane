import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dismissDialogs, isolatedPane, launchIsolated, runpane, type IsolatedPane } from './isolatedPane';

// J17, the approved real-agent smoke run (Q-367): real Claude Code and real Codex, each a worker
// in an isolated Pane, signed in from your existing login (isolatedPane's agentLogin). It spends a
// few cents of model turns, so it runs only with SESSION_ACTIVITY_REAL=1 and never in CI:
//
//   SESSION_ACTIVITY_REAL=1 npx playwright test --config=playwright.chat-tabs.config.ts tests/session-activity-real.spec.ts
//
// A long turn with a slow shell command spins the Session; a permission prompt, an idle composer
// and typing do not. Each screen is saved beside the test's output for the fixture set.

const AGENT = path.resolve('main/src/services/chatTabs/testing/scriptedAgent.mjs');
const SLOW = `python3 -c "import time; time.sleep(40); print('finished')"`;

interface Ref { paneId: string; panelId: string }

/** The installed agent, not a shim from the repository's node_modules that the test runner puts first on PATH. */
const installed = (name: string) => execFileSync('which', ['-a', name], { encoding: 'utf8' }).split('\n').find(entry => entry && !entry.includes('node_modules')) ?? name;
interface Change { state: string; at: number }

test.skip(process.env.SESSION_ACTIVITY_REAL !== '1', 'Spends real model turns; set SESSION_ACTIVITY_REAL=1 to run it.');

async function screen(pane: IsolatedPane, panelId: string): Promise<string> {
  const out = JSON.parse(await runpane(pane, ['panels', 'screen', '--panel', panelId, '--limit', '60', '--json']));
  return String(out.text ?? out.screen ?? (Array.isArray(out.lines) ? out.lines.join('\n') : JSON.stringify(out)));
}

async function waitForScreen(pane: IsolatedPane, panelId: string, pattern: RegExp, timeout = 90_000): Promise<string> {
  let last = '';
  await expect.poll(async () => { last = await screen(pane, panelId); return pattern.test(last); }, { timeout, intervals: [500], message: `waiting for ${pattern}` }).toBe(true)
    .catch((error: Error) => { throw new Error(`${error.message}\nThe screen was:\n${last}`); });
  return last;
}

/** Send a message the way each agent takes one (`runpane panels submit` knows Codex's submit key). */
async function send(pane: IsolatedPane, panelId: string, text: string): Promise<void> {
  const file = path.join(pane.root, `prompt-${Date.now()}.md`);
  writeFileSync(file, text);
  await runpane(pane, ['panels', 'submit', '--panel', panelId, '--input-file', file, '--yes', '--json']);
}

/** Clear what was typed into the composer. */
const clear = (pane: IsolatedPane, panelId: string, count: number) => runpane(pane, ['panels', 'input', '--panel', panelId, '--keys', Array(count).fill('backspace').join(','), '--yes', '--json']);

async function installRecorder(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(id => {
    const log: Array<{ state: string; at: number }> = [];
    const read = () => {
      const state = document.querySelector<HTMLElement>(`button[data-testid="orchestration-session-${id}"] [data-testid="session-activity-icon"]`)?.dataset.state ?? 'none';
      if (log.at(-1)?.state !== state) log.push({ state, at: Date.now() });
    };
    new MutationObserver(read).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state'] });
    read();
    window.__real = log;
  }, sessionId);
}

const changesSince = async (page: Page, since: number) => (await page.evaluate(() => window.__real ?? [])).filter(change => change.at >= since).map(change => change.state);

test('real Claude Code and Codex workers spin the Session only for a real turn (J17)', async ({ baseURL }, testInfo) => {
  test.setTimeout(600_000);
  const pane = isolatedPane('pane-session-activity-real', {}, { agentLogin: true });
  const repo = path.join(pane.root, 'repo');
  mkdirSync(repo);
  writeFileSync(path.join(repo, 'README.md'), '# demo\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=qa@example.com', '-c', 'user.name=QA', 'commit', '-qm', 'init', '--allow-empty'], { cwd: repo });
  const save = (name: string, text: string) => writeFileSync(testInfo.outputPath(`${name}.txt`), text);
  const { app, page } = await launchIsolated(pane, baseURL, { PANE_CHAT_TEST_AGENT: AGENT });
  try {
    await page.evaluate(async repoPath => {
      await window.electronAPI.config.update({ chatTabsEnabled: true });
      await window.electronAPI.projects.create({ name: 'demo', path: repoPath, active: true });
    }, repo);
    await dismissDialogs(page);
    const session = await page.evaluate(async () => {
      const result = await window.electronAPI.orchestrationSessions.create({ name: 'J17 real agents', agent: 'claude' });
      // SAFETY: orchestration-sessions:create returns an OrchestrationSessionView in `data` when it succeeds.
      const view = result.data as { session: { id: string; internalSessionId: string }; panel: { id: string } };
      return { id: view.session.id, paneId: view.session.internalSessionId, panelId: view.panel.id };
    });
    // The bundled runpane reaches this Pane. Not `runpane doctor`: its exit code also needs the latest
    // release from api.github.com, which CI can't count on.
    await expect.poll(() => runpane(pane, ['sessions', 'list', '--json']).then(() => true, () => false), { timeout: 30_000 }).toBe(true);
    const create = async (name: string, command: string, agent: string): Promise<Ref> => {
      const tool = command ? ['--tool-command', command] : [];
      const out = JSON.parse(await runpane(pane, ['panes', 'create', '--repo', repo, '--name', name, ...tool, '--agent', agent, '--no-focus', '--source', 'agent', '--yes', '--json'], session));
      return { paneId: out.items[0].paneId, panelId: out.items[0].panelId };
    };
    const icon = page.getByTestId(`orchestration-session-${session.id}`).getByTestId('session-activity-icon');
    await installRecorder(page, session.id);
    let since = Date.now();

    {
    // Real Claude Code that runs its tools without asking, for the typing and long-turn checks.
    const claude = await create('j17-claude', `'${installed('claude')}' --model haiku --dangerously-skip-permissions`, 'claude');
    save('claude-idle', await waitForScreen(pane, claude.panelId, /❯/));
    // Typing into the idle composer never spins it.
    since = Date.now();
    for (const word of 'someone is typing into an idle prompt box'.split(' ')) {
      await runpane(pane, ['panels', 'input', '--panel', claude.panelId, '--text', `${word} `, '--yes', '--json']);
      await page.waitForTimeout(700);
    }
    await page.waitForTimeout(12_000);
    save('claude-typing', await screen(pane, claude.panelId));
    expect(await changesSince(page, since)).toEqual([]);
    await clear(pane, claude.panelId, 60);

    // A long turn with a slow shell command spins it about 10 s in and holds, then idles after.
    since = Date.now();
    await send(pane, claude.panelId, `Use the Bash tool once, in the foreground, to run exactly: ${SLOW} (a stand-in for a slow test run). Wait for it, then reply with only its output in capital letters.`);
    await expect(icon).toHaveAttribute('data-state', 'working', { timeout: 30_000 });
    const spunAfter = Date.now() - since;
    save('claude-working', await screen(pane, claude.panelId));
    await page.screenshot({ path: testInfo.outputPath('j17-claude-working.png') });
    save('claude-done', await waitForScreen(pane, claude.panelId, /FINISHED/, 150_000));
    await expect(icon).toHaveAttribute('data-state', 'idle', { timeout: 20_000 });
    const claudeTurn = await changesSince(page, since);
    console.log(`[J17] Claude long turn: spun ${spunAfter} ms in, changes ${JSON.stringify(claudeTurn)}`);
    expect(claudeTurn).toEqual(['working', 'idle']);

    // A second real Claude Code that asks before it runs anything: the short think before its
    // permission prompt never reaches 10 s, and the prompt itself is idle (never red).
    const asking = await create('j17-claude-asks', `'${installed('claude')}' --model haiku --permission-mode default`, 'claude');
    save('claude-asks-idle', await waitForScreen(pane, asking.panelId, /❯/));
    await page.waitForTimeout(12_000);
    since = Date.now();
    await send(pane, asking.panelId, 'Use the Bash tool to run: touch made-by-claude.txt. Do nothing else.');
    save('claude-permission', await waitForScreen(pane, asking.panelId, /Do you want to proceed/));
    await page.waitForTimeout(20_000);
    expect(await changesSince(page, since)).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('j17-claude-permission.png') });
    await runpane(pane, ['panels', 'input', '--panel', asking.panelId, '--keys', 'escape', '--yes', '--json']);

    }

    // Real Codex: a long command spins it; its idle composer does not. Off by default
    // (SESSION_ACTIVITY_REAL_CODEX=1): Codex 0.166 quits by itself seconds after it starts in this
    // isolated Pane, most likely because its sign-in is a read-only copy it cannot refresh, and a
    // writable copy could rotate the person's real refresh token. Codex's real screens are covered
    // by the isolated captures, replayed through Pane (screenReplay.test.ts, journey J10).
    if (process.env.SESSION_ACTIVITY_REAL_CODEX === '1') {
      const codex = await create('j17-codex', `'${installed('codex')}' -c model_reasoning_effort="low" --dangerously-bypass-approvals-and-sandbox`, 'codex');
      save('codex-idle', await waitForScreen(pane, codex.panelId, /›/));
      await page.waitForTimeout(12_000);
      // Codex's idle composer, left alone, does not spin it.
      since = Date.now();
      await page.waitForTimeout(12_000);
      expect(await changesSince(page, since)).toEqual([]);
      since = Date.now();
      await send(pane, codex.panelId, 'Run exactly this one shell command: sleep 40; echo finished. Then reply with only its output, in capital letters.');
      await expect(icon).toHaveAttribute('data-state', 'working', { timeout: 30_000 })
        .catch(async (error: Error) => {
          save('codex-not-working', await screen(pane, codex.panelId));
          save('codex-output', await runpane(pane, ['panels', 'output', '--panel', codex.panelId, '--limit', '400', '--json']));
          throw error;
        });
      save('codex-working', await screen(pane, codex.panelId));
      await page.screenshot({ path: testInfo.outputPath('j17-codex-working.png') });
      save('codex-done', await waitForScreen(pane, codex.panelId, /FINISHED/, 150_000));
      await expect(icon).toHaveAttribute('data-state', 'idle', { timeout: 20_000 });
      const codexTurn = await changesSince(page, since);
      console.log(`[J17] Codex long turn: changes ${JSON.stringify(codexTurn)}`);
      expect(codexTurn).toEqual(['working', 'idle']);
    }
  } finally {
    await app.close().catch(() => undefined);
    rmSync(pane.root, { recursive: true, force: true });
  }
});
