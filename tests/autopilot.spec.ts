import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Autopilot journeys (J1–J8, J13, J15) in a real Electron build against the scripted ACP agent,
// never a real Claude account. Items are raised with the bundled `runpane notify`, as a Session
// orchestrator would; the scripted "Autopilot" calls the real `runpane autopilot` commands.

const AGENT = path.resolve('main/src/services/chatTabs/testing/scriptedAgent.mjs');
const SHOTS = process.env.AUTOPILOT_SHOTS_DIR;

async function launch(paneDir: string, baseURL: string | undefined, extraEnv: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [path.resolve('main/dist/main/src/index.js')],
    env: { ...process.env, PANE_DIR: paneDir, NODE_ENV: 'development', VITE_PORT: new URL(baseURL ?? 'http://localhost:4521').port, PANE_CHAT_TEST_AGENT: AGENT, ...extraEnv },
  });
  const isMain = (candidate: Page): boolean => /^https?:|^file:/.test(candidate.url()) && !candidate.url().includes('notify.html');
  await expect.poll(() => app.windows().some(isMain), { timeout: 30_000 }).toBe(true);
  const page = app.windows().find(isMain)!;
  await page.waitForFunction(() => !!window.electronAPI?.autopilot, undefined, { timeout: 30_000, polling: 250 });
  // Size the real window: an emulated viewport does not reach <webview> guests.
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(candidate => !candidate.webContents.getURL().includes('notify.html'));
    window?.setContentSize(1600, 1000);
  });
  return { app, page };
}

/** First-run dialogs (onboarding's agent picker, the welcome) can open a few seconds in. */
async function dismissDialogs(page: Page): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    let dismissed = false;
    for (const name of ['No thanks', 'Get Started', 'Skip', 'Skip for now']) {
      const button = page.getByRole('button', { name, exact: true });
      if (await button.isVisible().catch(() => false)) { await button.click().catch(() => undefined); dismissed = true; }
    }
    if (!dismissed && !(await page.locator('[data-state="open"].fixed.inset-0').isVisible().catch(() => false)) && Date.now() > deadline - 5_000) return;
    await page.waitForTimeout(250);
  }
}

interface Asker { child: ChildProcess; output: Promise<string> }

/** `runpane notify` from a Session orchestrator's tab (its env), running until answered. */
function ask(paneDir: string, who: { paneId: string; panelId: string }, args: string[]): Asker {
  const child = spawn(path.join(paneDir, 'bin', 'runpane'), ['notify', ...args, '--json'], {
    env: { ...process.env, PANE_DIR: paneDir, PANE_SESSION_ID: who.paneId, PANE_PANEL_ID: who.panelId },
  });
  let stdout = '';
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  return { child, output: new Promise(resolve => child.on('exit', () => resolve(stdout))) };
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

interface SessionRef { id: string; paneId: string; panelId: string }

test('Autopilot: switch, Start, the walk on the stack, answers by you, never by Autopilot, and a restart', async ({ baseURL }) => {
  test.setTimeout(240_000);
  const root = mkdtempSync(path.join(tmpdir(), 'pane-autopilot-'));
  const paneDir = path.join(root, 'pane');
  const askers: Asker[] = [];
  let { app, page } = await launch(paneDir, baseURL);
  try {
    await dismissDialogs(page);
    // Two Sessions, A listed above B.
    // Screenshots in a chosen theme (AUTOPILOT_THEME=dark); the journey itself is theme-free.
    const theme = process.env.AUTOPILOT_THEME;
    if (theme === 'dark' || theme === 'light') await page.evaluate(async value => { await window.electronAPI.config.update({ appearanceMode: 'fixed', theme: value }); }, theme);
    // SAFETY: the evaluated function returns exactly the SessionRef shape it builds.
    const sessions = await page.evaluate(async () => {
      const api = window.electronAPI;
      await api.config.update({ chatTabsEnabled: true });
      const made: Array<{ id: string; paneId: string; panelId: string }> = [];
      // Newest lists first: Infra, then Pane Fixes above it.
      for (const name of ['Infra', 'Pane Fixes']) {
        const result = await api.orchestrationSessions.create({ name, agent: 'claude' });
        // SAFETY: orchestration-sessions:create returns an OrchestrationSessionView in `data` when it succeeds.
        const view = result.data as { session: { id: string; internalSessionId: string }; panel: { id: string } };
        made.push({ id: view.session.id, paneId: view.session.internalSessionId, panelId: view.panel.id });
      }
      return made;
    }) as SessionRef[];
    const [b, a] = sessions;
    await expect.poll(() => existsSync(path.join(paneDir, 'bin', 'runpane')), { timeout: 20_000 }).toBe(true);

    // J1: the switch. Off by default; on adds the row above SESSIONS and makes the run folder.
    await expect(page.getByTestId('autopilot-nav')).toHaveCount(0);
    const turnedOn = await page.evaluate(() => window.electronAPI.autopilot.setEnabled(true));
    const run = turnedOn.run!;
    for (const name of ['AGENTS.md', 'docs', 'stack.json', 'state.json', 'log']) expect(existsSync(path.join(run.folder, name))).toBe(true);
    expect(readFileSync(path.join(paneDir, 'autopilot', 'current'), 'utf8').trim()).toBe(run.id);
    await expect(page.getByTestId('autopilot-nav')).toBeVisible();
    await expect(page.getByTestId('autopilot-nav-state')).toHaveText('Start');
    // The top list reads New, Pane Chat, Loops, Autopilot, then Approvals right under Autopilot (D-117).
    await expect(page.locator('[data-testid="loops-nav"] + [data-testid="autopilot-nav"] + [data-testid="approvals-nav"]')).toHaveCount(1);
    // One height and no gaps between them, so the list reads evenly.
    const rows = await Promise.all(['loops-nav', 'autopilot-nav', 'approvals-nav'].map(async id => (await page.getByTestId(id).boundingBox())!));
    expect(new Set(rows.map(row => row.height)).size).toBe(1);
    expect(rows[1].y - (rows[0].y + rows[0].height)).toBe(rows[2].y - (rows[1].y + rows[1].height));
    // Not a Session: absent from the Sessions list.
    // SAFETY: orchestration-sessions:list returns its Sessions in `data.sessions`.
    const listed = await page.evaluate(async () => ((await window.electronAPI.orchestrationSessions.list()).data as { sessions: Array<{ name: string }> }).sessions.map(session => session.name));
    expect(listed).not.toContain('Autopilot');

    // Items waiting in A (two) and B (one), raised by their orchestrators, oldest first.
    writeFileSync(path.join(root, 'cover-sheet.html'), '<!doctype html><title>Cover</title><style>body{background:rgb(255,255,255)}@media (prefers-color-scheme: dark){body{background:rgb(0,0,0)}}</style><body style="font-family:sans-serif"><h1>Chat tabs for agents, on ACP</h1><p>' + '<p>Package detail, one paragraph of the plan.</p>'.repeat(300) + '</p></body>');
    const waitingCount = () => page.evaluate(async () => (await window.electronAPI.notify.getSnapshot()).items.filter(item => item.state === 'waiting').length);
    const q14 = ask(paneDir, a, ['--ui', 'approve', '--title', 'Q-14 Approve the chat tabs plan (r7)?', '--context', 'Six packages, about 7½ weeks.', '--links', JSON.stringify([{ label: 'cover-sheet.html', path: path.join(root, 'cover-sheet.html') }])]);
    askers.push(q14);
    await expect.poll(waitingCount, { timeout: 20_000 }).toBe(1);
    askers.push(ask(paneDir, a, ['--ui', 'options', '--title', 'Q-5 Sidebar order: what should Sessions sort by? '.repeat(3), '--choices', JSON.stringify([{ label: 'Last activity' }, { label: 'Created, newest first' }, { label: 'Manual, drag to reorder' }, { label: 'Alphabetical' }, { label: 'By project' }])]));
    await expect.poll(waitingCount, { timeout: 20_000 }).toBe(2);
    askers.push(ask(paneDir, b, ['--ui', 'approve', '--title', 'Run terraform apply -target=module.queue?']));
    await expect.poll(waitingCount, { timeout: 20_000 }).toBe(3);

    // J2: opening Autopilot shows Start and runs no agent turn.
    await dismissDialogs(page);
    await page.getByTestId('autopilot-nav').click();
    await expect(page.getByTestId('autopilot-start')).toBeVisible();
    expect((await page.evaluate(() => window.electronAPI.autopilot.snapshot())).state).toBe('stopped');
    const before = await page.evaluate(async id => (await window.electronAPI.chatTab.get(id, 0)).status, turnedOn.panelId!);
    expect(before).toBe('stopped');
    await shot(page, '01-start');

    // J3: Start. Its first message lists what waits, grouped by Session, A first; A's first item is on the stack.
    await page.getByTestId('autopilot-start-button').click();
    const items = page.getByTestId('autopilot-items');
    await expect(items).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('autopilot-control-line')).toHaveText('You pressed Start');
    const groups = items.locator('> div');
    await expect(groups.nth(0)).toContainText('Pane Fixes');
    await expect(groups.nth(1)).toContainText('Infra');
    await expect(page.getByTestId('autopilot-entry-title')).toContainText('Q-14');
    // D-91: the question and its options are a card in the chat; the current one is in full.
    const currentCard = page.locator('[data-testid="autopilot-decision"][data-current="true"]');
    await expect(currentCard).toHaveCount(1);
    await expect(currentCard).toContainText('Approve the chat tabs plan (r7)?');
    await expect(currentCard.getByTestId('autopilot-decision-option')).toHaveText([/Approve.*Recommended/, 'Deny']);
    await expect(page.getByTestId('autopilot-walk-status')).toHaveText('Running on Pane Fixes');
    await expect(page.getByTestId('autopilot-nav-state')).toHaveText('2 open');
    await shot(page, '02-d1-first-message');

    // The header fits at any width: its last control stays inside the chat column (QA, 900–1600 px).
    for (const width of [900, 1280, 1600]) {
      await app.evaluate(({ BrowserWindow }, w) => {
        const window = BrowserWindow.getAllWindows().find(candidate => !candidate.webContents.getURL().includes('notify.html'));
        window?.setContentSize(w, 1000);
      }, width);
      await page.waitForTimeout(300);
      const column = (await page.getByRole('region', { name: 'Autopilot chat' }).boundingBox())!;
      const menu = (await page.getByTestId('autopilot-menu').boundingBox())!;
      expect(menu.x + menu.width, `menu inside the chat column at ${width}px`).toBeLessThanOrEqual(column.x + column.width);
      if (width === 900) await shot(page, '02b-narrow-900');
    }
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(candidate => !candidate.webContents.getURL().includes('notify.html'));
      window?.setContentSize(1600, 1000);
    });
    await page.waitForTimeout(300);

    // J4: one entry at a time; ‹ › and ← → step; tabs never move (D-72) whatever the entry holds.
    await expect(page.getByTestId('autopilot-stack-position')).toHaveText('1 of 2');
    const tabsY = async () => (await page.getByTestId('autopilot-entry-tabs').boundingBox())!.y;
    const firstY = await tabsY();
    await page.getByTestId('autopilot-stack-next').click();
    await expect(page.getByTestId('autopilot-stack-position')).toHaveText('2 of 2');
    await expect(page.getByTestId('autopilot-entry-title')).toContainText('Q-5');
    // The right side follows the current card: Q-5 is now the full card in the chat (D-71, D-91).
    await expect(currentCard).toContainText('Sidebar order');
    expect(await tabsY()).toBe(firstY);
    await page.locator('body').click({ position: { x: 5, y: 500 } });
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('autopilot-stack-position')).toHaveText('1 of 2');
    // The right side shows the current item's documents straight away: no question, no answer controls (D-91).
    await expect(page.getByRole('tab', { name: 'cover-sheet.html' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('autopilot-webview')).toBeVisible();
    await expect(page.getByTestId('autopilot-stack').getByTestId('autopilot-decision-option')).toHaveCount(0);
    await expect.poll(() => page.getByTestId('autopilot-webview').evaluate((element: Electron.WebviewTag) => {
      try { return element.isLoading() ? 'loading' : element.getURL(); } catch { return 'not ready'; }
    }), { timeout: 15_000 }).toContain('cover-sheet.html');
    // D-70: the page's scrollbar is Pane's (classic, the theme's tokens), not the OS overlay one.
    await expect.poll(() => page.getByTestId('autopilot-webview').evaluate((element: Electron.WebviewTag) => element.executeJavaScript('innerWidth - document.documentElement.clientWidth')), { timeout: 10_000 }).toBeGreaterThan(0);
    expect(await tabsY()).toBe(firstY);
    // D-163: the page follows Pane's theme, not the Mac's: its prefers-color-scheme styles are Pane's.
    // No debugger does this (D-216), so read the styles the person sees rather than the page's matchMedia.
    const guestDark = () => page.getByTestId('autopilot-webview').evaluate((element: Electron.WebviewTag) => element.executeJavaScript('getComputedStyle(document.body).backgroundColor === "rgb(0, 0, 0)"'));
    const startTheme = await page.evaluate(async () => (await window.electronAPI.config.get()).data!);
    for (const value of ['dark', 'light'] as const) {
      await page.evaluate(async theme => { await window.electronAPI.config.update({ appearanceMode: 'fixed', theme }); }, value);
      await expect.poll(guestDark, { timeout: 10_000 }).toBe(value === 'dark');
    }
    await page.evaluate(async config => { await window.electronAPI.config.update({ appearanceMode: config.appearanceMode, theme: config.theme }); }, startTheme);
    if (SHOTS) {
      const guest = await page.getByTestId('autopilot-webview').evaluate(async (element: Electron.WebviewTag) => (await element.capturePage()).toDataURL());
      writeFileSync(path.join(SHOTS, '03-doc-guest.png'), Buffer.from(guest.split(',')[1], 'base64'));
    }
    await shot(page, '03-doc-tab');

    // J6: "approve it" answers nothing; Autopilot points to the card.
    const box = page.getByRole('textbox', { name: 'Message Claude' });
    await box.fill('approve it');
    await box.press('Enter');
    await expect(page.getByRole('region', { name: 'Conversation messages' })).toContainText('the buttons are on the card');
    expect((await page.evaluate(() => window.electronAPI.notify.getSnapshot())).items.find(item => item.title.startsWith('Q-14'))?.state).toBe('waiting');

    // J5: approving on the card reaches the asking orchestrator, with the "by you" receipt and Undo.
    await currentCard.getByTestId('autopilot-decision-option').filter({ hasText: 'Approve' }).click();
    await expect(page.getByTestId('autopilot-decision-sent')).toContainText('by you');
    await shot(page, '04-d2-answered');
    const answer = await q14.output;
    expect(JSON.parse(answer)).toMatchObject({ approved: true });
    // The next item comes up on its own.
    await expect(page.getByTestId('autopilot-entry-title')).toContainText('Q-5', { timeout: 10_000 });

    // Pause and Go on.
    await page.getByTestId('autopilot-pause').click();
    await expect(page.getByTestId('autopilot-walk-status')).toHaveText('Paused');
    await expect(page.getByTestId('autopilot-nav-state')).toHaveText('Paused');
    await page.getByTestId('autopilot-go-on').click();
    await expect(page.getByTestId('autopilot-walk-status')).not.toHaveText('Paused');

    // J9/J17: Autopilot's own approval, with its document, from its own tab: violet, "written by Autopilot",
    // and under "Autopilot" in Approvals.
    const doc = path.join(run.folder, 'docs', 'close-out-pane-fixes.html');
    writeFileSync(doc, '<!doctype html><title>Close out</title><h1>Close out: Pane Fixes</h1><p>What /wrap-up would close and keep.</p>');
    const own = ask(paneDir, { paneId: turnedOn.ownerPaneId!, panelId: turnedOn.panelId! }, ['--ui', 'options', '--title', 'Close out finished work in Pane Fixes?', '--choices', JSON.stringify([{ label: 'Ask Pane Fixes to wrap up' }, { label: 'Not now' }]), '--links', JSON.stringify([{ label: 'close-out-pane-fixes.html', path: doc }])]);
    askers.push(own);
    await expect.poll(async () => (await page.evaluate(() => window.electronAPI.notify.getSnapshot())).items.find(item => item.source.autopilot)?.id ?? null, { timeout: 20_000 }).not.toBeNull();
    const ownId = (await page.evaluate(() => window.electronAPI.notify.getSnapshot())).items.find(item => item.source.autopilot)!.id;
    await page.evaluate(async id => {
      const snapshot = await window.electronAPI.autopilot.push({ item: id });
      const entry = snapshot.stack.entries.find(candidate => candidate.ref.kind === 'item' && candidate.ref.notifyId === id)!;
      await window.electronAPI.autopilot.stack({ type: 'show', id: entry.id });
    }, ownId);
    await expect(page.getByTestId('autopilot-entry-head')).toContainText('written by Autopilot');
    await shot(page, '06-own-approval');
    // d3: a Session's overview on the stack for close-out.
    await page.evaluate(async sessionId => {
      const snapshot = await window.electronAPI.autopilot.push({ session: sessionId });
      const entry = snapshot.stack.entries.find(candidate => candidate.ref.kind === 'session')!;
      await window.electronAPI.autopilot.stack({ type: 'show', id: entry.id });
    }, a.id);
    await expect(page.getByTestId('autopilot-session-overview')).toBeVisible();
    await shot(page, '07-d3-close-out');
    await page.getByRole('button', { name: /^Approvals/ }).first().click();
    await expect(page.getByTestId('approvals-queue').getByText('Autopilot').first()).toBeVisible();
    await shot(page, '08-approvals-autopilot-group');
    await page.getByTestId('autopilot-nav').click();

    // Package 7: Sentinel. On keeps Sessions moving (the row says so) and logs each call in the chat.
    await page.getByTestId('autopilot-sentinel').click();
    await expect(page.getByTestId('autopilot-sentinel')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('autopilot-nav-state')).toHaveText('Sentinel');
    await expect(page.getByTestId('autopilot-walk-status')).toContainText('Sentinel on');
    await expect(page.getByTestId('autopilot-log').first()).toContainText('Answered');
    await shot(page, '09-sentinel-on');
    // Off posts the While you were away card.
    await page.getByTestId('autopilot-sentinel').click();
    await expect(page.getByTestId('autopilot-away')).toContainText('While you were away');
    await expect(page.getByTestId('autopilot-away')).toContainText('1 answered · 1 nudged');
    await shot(page, '10-sentinel-away');
    // On again, so the restart below shows Sentinel stopping.
    await page.getByTestId('autopilot-sentinel').click();
    await expect(page.getByTestId('autopilot-sentinel')).toHaveAttribute('aria-checked', 'true');

    // J13: the stack survives a Pane restart; the run waits for Start again.
    const runBefore = (await page.evaluate(() => window.electronAPI.autopilot.snapshot())).run!.id;
    await app.close();
    ({ app, page } = await launch(paneDir, baseURL));
    await dismissDialogs(page);
    await page.getByTestId('autopilot-nav').click();
    await expect(page.getByTestId('autopilot-start')).toBeVisible();
    const after = await page.evaluate(() => window.electronAPI.autopilot.snapshot());
    expect(after.run!.id).toBe(runBefore);
    expect(after.state).toBe('stopped');
    // Sentinel is off after a restart, and the person is asked (a push on their phone) whether to turn it back on.
    expect(after.sentinel).toBe(false);
    await expect.poll(async () => (await page.evaluate(() => window.electronAPI.notify.getSnapshot())).items.some(item => item.title === 'Sentinel stopped: Pane restarted' && item.state === 'waiting'), { timeout: 10_000 }).toBe(true);
    expect(after.stack.entries.length).toBeGreaterThan(0);
    await shot(page, '05-after-restart');

    // New Autopilot Session: a new folder and an empty stack; the old run's folder stays.
    await page.getByTestId('autopilot-menu').click();
    await page.getByTestId('autopilot-new-run').click();
    await page.getByTestId('autopilot-new-run-confirm').click();
    await expect.poll(async () => (await page.evaluate(() => window.electronAPI.autopilot.snapshot())).run!.id).not.toBe(runBefore);
    expect(existsSync(path.join(paneDir, 'autopilot', 'runs', runBefore, 'docs'))).toBe(true);
    await expect(page.getByTestId('autopilot-stack-empty')).toBeVisible();

    // Off: the row is gone and the run is kept.
    await page.evaluate(() => window.electronAPI.autopilot.setEnabled(false));
    await expect(page.getByTestId('autopilot-nav')).toHaveCount(0);
  } finally {
    for (const asker of askers) asker.child.kill();
    await app.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test('Autopilot: not entitled, the switch is disabled and Start refuses with what to do', async ({ baseURL }) => {
  const root = mkdtempSync(path.join(tmpdir(), 'pane-autopilot-denied-'));
  const { app, page } = await launch(path.join(root, 'pane'), baseURL, { PANE_AUTOPILOT_ENTITLEMENT: 'denied' });
  try {
    await page.evaluate(() => window.electronAPI.config.update({ chatTabsEnabled: true }));
    const refusal = await page.evaluate(() => window.electronAPI.autopilot.setEnabled(true).then(() => 'on', (error: Error) => error.message));
    expect(refusal).toContain('not included');
    expect(refusal).toContain('Next:');
    const snapshot = await page.evaluate(() => window.electronAPI.autopilot.snapshot());
    expect(snapshot.entitlement.entitled).toBe(false);
    expect(snapshot.enabled).toBe(false);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});
