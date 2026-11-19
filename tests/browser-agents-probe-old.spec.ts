import { expect, test, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { JsonValue } from '../shared/validation/boundaryDecoder';
import path from 'node:path';
import { dismissDialogs, isolatedPane, launchIsolated, runpane, type IsolatedPane } from './isolatedPane';

// Agents drive Pane's browser tabs (docs/BROWSER_AGENTS.md), end to end in a real, isolated Pane:
// an agent's browser_* calls, made as `runpane browser …` from a tab, act on local fixture pages.
// Journeys J1 to J5, J8 and J15 of the browser-agents plan.

const SHOTS = process.env.BROWSER_AGENTS_SHOTS_DIR;

const SIGN_UP = `<!doctype html><html><head><meta charset="utf-8"><title>Sign up</title></head><body>
<h1>Sign up</h1>
<form onsubmit="event.preventDefault(); document.getElementById('result').textContent = 'Welcome, ' + email.value + ' (' + country.value + ')';">
  <label>Email <input id="email" name="email"></label>
  <label>Password <input id="password" type="password"></label>
  <label>Country <select id="country"><option value="us">United States</option><option value="ca">Canada</option></select></label>
  <button type="submit">Create account</button>
</form>
<div id="result"></div>
<button onclick="document.getElementById('confirmed').textContent = 'confirm returned ' + confirm('Delete everything?')">Delete account</button>
<span id="confirmed"></span>
<label>Avatar <input id="file" type="file" onchange="document.getElementById('picked').textContent = 'Picked ' + this.files[0].name"></label>
<span id="picked"></span>
<a href="/next">Next page</a>
<one-deep></one-deep><two-deep></two-deep><md-button>Save draft</md-button><span id="shadow-clicks"></span>
<script>
  const note = label => { document.getElementById('shadow-clicks').textContent += ' ' + label; };
  const define = (name, html) => customElements.define(name, class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = html; } });
  define('one-deep', '<button>Shadow button</button>');
  define('inner-el', '<button>Nested button</button>');
  define('two-deep', '<div><inner-el></inner-el></div>');
  define('md-button', '<button><span><slot></slot></span></button>');
  document.addEventListener('click', event => { const button = event.composedPath().find(node => node instanceof HTMLButtonElement); if (button && button.getRootNode() instanceof ShadowRoot) note(button.textContent || 'slotted'); });
</script>
<div style="height:2000px"></div><p>Bottom of the page</p>
</body></html>`;
const NEXT = '<!doctype html><html><head><title>Next</title></head><body><h1>Next page</h1></body></html>';

/** A `runpane browser … --json` reply: the fields these journeys read, and the error's code. */
interface Reply { ok: boolean; code?: string; tab?: string; snapshot?: string; dialog?: { type: string; message: string }; value?: JsonValue; truncated?: boolean; reused?: boolean; title?: string; mimeType?: string }
interface Caller { paneId: string; panelId: string }

/** `runpane browser <verb>` as the agent in `from` runs it; failures come back with their code. */
function browser(pane: IsolatedPane, from: Caller | undefined, verb: string, args: string[] = []): Promise<Reply> {
  const env = { ...pane.env };
  if (from) {
    env.PANE_SESSION_ID = from.paneId;
    env.PANE_PANEL_ID = from.panelId;
  }
  return new Promise((resolve, reject) => {
    execFile(path.join(pane.paneDir, 'bin', 'runpane'), ['browser', verb, ...args, '--json'], { env, timeout: 120_000 }, (error, stdout, stderr) => {
      if (!stdout.trim()) {
        reject(new Error(`runpane browser ${verb} printed nothing (${error?.message ?? 'no error'}): ${stderr}`));
        return;
      }
      // SAFETY: `runpane … --json` prints one JSON object, a result or { ok: false, error }.
      const parsed = JSON.parse(stdout) as Reply & { error?: { code: string } };
      resolve({ ...parsed, code: parsed.error?.code });
    });
  });
}

/** The ref a snapshot gave an element, by its role and name (`textbox "Email"`). Refs count up across snapshots. */
function refIn(snapshot: string | undefined, label: string): string {
  const ref = new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\n]*\\[ref=(e\\d+)\\]`).exec(snapshot ?? '')?.[1];
  if (!ref) throw new Error(`No ref for ${label} in the snapshot:\n${snapshot ?? ''}`);
  return ref;
}

/** Snapshots the agent's tab and returns a finder for its refs. */
async function refs(pane: IsolatedPane, from: Caller): Promise<(label: string) => string> {
  const reading = await browser(pane, from, 'snapshot');
  return label => refIn(reading.snapshot, label);
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

function serve(): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(request.url === '/next' ? NEXT : SIGN_UP);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    // SAFETY: a server listening on a TCP port reports an AddressInfo.
    const { port } = server.address() as AddressInfo;
    resolve({ server, origin: `http://127.0.0.1:${port}` });
  }));
}

async function newPane(pane: IsolatedPane, repo: string, name: string): Promise<Caller & { worktree: string }> {
  // SAFETY: `panes create --json` prints its items with these fields.
  const created = JSON.parse(await runpane(pane, ['panes', 'create', '--repo', repo, '--name', name, '--agent', 'claude', '--tool-command', 'bash', '--focus', '--yes', '--json'])) as { items: Array<{ paneId: string; panelId: string; worktreePath: string }> };
  const item = created.items[0];
  return { paneId: item.paneId, panelId: item.panelId, worktree: item.worktreePath };
}

test('agents drive a Pane\'s browser tabs: act, hand over to the person, answer dialogs, stay inside their Pane', async ({ baseURL }) => {
  test.setTimeout(300_000);
  const pane = isolatedPane('pane-browser-agents');
  const bin = path.join(pane.root, 'fake-bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.999 (Claude Code)"; exit 0; fi\nexit 1\n');
  chmodSync(path.join(bin, 'claude'), 0o755);
  pane.env.PATH = `${bin}${path.delimiter}${pane.env.PATH}`;
  const repo = path.join(pane.root, 'repo');
  mkdirSync(repo);
  await new Promise<void>((resolve, reject) => execFile('sh', ['-c', 'git init -q -b main && echo hi > README.md && git add . && git -c user.email=qa@example.com -c user.name=qa commit -qm init'], { cwd: repo }, error => (error ? reject(error) : resolve())));
  const { server, origin } = await serve();
  const { app, page } = await launchIsolated(pane, baseURL);
  // Playwright answers every dialog on a page it attaches to (browser tabs included) unless the page
  // has a listener; this one leaves them to Pane.
  const leaveDialogs = (attached: Page) => { attached.on('dialog', () => undefined); };
  app.context().pages().forEach(leaveDialogs);
  app.context().on('page', leaveDialogs);
  try {
    await dismissDialogs(page);
    // A loaded test machine can raise Pane's own machine health cards (memory, disk) over the window at any time.
    // Cards can follow one another (memory, then disk), so dismiss until none is left.
    const healthCard = page.getByRole('button', { name: /Review in Resources/ }).first();
    await page.addLocatorHandler(healthCard, async () => {
      for (let card = 0; card < 5 && await healthCard.isVisible(); card += 1) {
        await page.getByRole('button', { name: 'Not now', exact: true }).locator('visible=true').first().click();
        await page.waitForTimeout(300);
      }
    }, { noWaitAfter: true });
    // And the first-run cards ("Which agent do you use?", "Open your project") that can come late.
    const skip = page.getByRole('button', { name: 'Skip', exact: true }).locator('visible=true').first();
    await page.addLocatorHandler(skip, async () => { await skip.click(); });
    await expect.poll(() => runpane(pane, ['sessions', 'list', '--json']).then(() => true, () => false), { timeout: 30_000 }).toBe(true);
    await runpane(pane, ['repos', 'add', '--path', repo, '--yes', '--json']);
    const other = await newPane(pane, 'repo', 'other');
    const agent = await newPane(pane, 'repo', 'browser');

    // J1: the agent opens the form beside it, reads it, fills it in and submits it.
    const opened = await browser(pane, agent, 'open', ['--url', `${origin}/`]);
    expect(opened).toMatchObject({ ok: true, reused: false });
    const read = await browser(pane, agent, 'snapshot');
    expect(read.snapshot).toMatch(/textbox "Email" \[ref=e\d+\]/);
    const form = (label: string) => refIn(read.snapshot, label);
    expect(await browser(pane, agent, 'type', ['--ref', form('textbox "Email"'), '--text', 'ada@example.com'])).toMatchObject({ ok: true });
    await browser(pane, agent, 'type', ['--ref', form('textbox "Password"'), '--text', 'hunter22']);
    await browser(pane, agent, 'select', ['--ref', form('combobox "Country"'), '--values', '["Canada"]']);
    await browser(pane, agent, 'click', ['--ref', form('button "Create account"')]);
    await new Promise(resolve => setTimeout(resolve, 2_500)); // PROBE: forced delay past the chip's 2 s linger
    // The tab shows who drives while the agent's calls run.
    await expect(page.locator('[data-browser-page-visible="true"]').getByTestId('browser-driver-chip')).toContainText('is driving');
    await shot(page, 'j1-agent-driving');
    const after = await browser(pane, agent, 'snapshot');
    expect(after.snapshot).toContain('Welcome, ada@example.com (ca)');
    // Controls inside shadow roots (one deep, two deep, and a web component's slotted label) take clicks.
    for (const label of ['button "Shadow button"', 'button "Nested button"', 'button "Save draft"']) {
      expect(await browser(pane, agent, 'click', ['--ref', refIn(after.snapshot, label)])).toMatchObject({ ok: true });
    }
    expect(await browser(pane, agent, 'evaluate', ['--expression', "document.getElementById('shadow-clicks').textContent.trim()"])).toMatchObject({ value: 'Shadow button Nested button slotted' });
    // J8: the password is dots in the snapshot, never its value.
    expect(after.snapshot).toMatch(/textbox "Password" \[ref=e\d+\]: "••••••••"/);
    expect(after.snapshot).not.toContain('hunter22');
    const screenshot = await browser(pane, agent, 'screenshot');
    expect(screenshot).toMatchObject({ ok: true, mimeType: 'image/png' });

    // J3: a confirm() is held; nothing else runs until it is answered.
    const clicked = await browser(pane, agent, 'click', ['--ref', refIn(after.snapshot, 'button "Delete account"')]);
    expect(clicked.dialog).toEqual({ type: 'confirm', message: 'Delete everything?' });
    expect((await browser(pane, agent, 'snapshot')).code).toBe('ERR_BROWSER_DIALOG_PENDING');
    await browser(pane, agent, 'dialog', ['--accept']);
    expect((await browser(pane, agent, 'evaluate', ['--expression', 'document.getElementById("confirmed").textContent'])).value).toBe('confirm returned true');

    // J5: evaluate, and upload from the worktree only.
    writeFileSync(path.join(agent.worktree, 'avatar.png'), 'png');
    writeFileSync(path.join(agent.worktree, '.env'), 'SECRET=1');
    const avatar = (await refs(pane, agent))('button "Avatar"');
    expect(await browser(pane, agent, 'upload', ['--ref', avatar, '--paths', '["avatar.png"]'])).toMatchObject({ ok: true });
    expect(await browser(pane, agent, 'wait', ['--text', 'Picked avatar.png'])).toMatchObject({ ok: true });
    expect((await browser(pane, agent, 'upload', ['--ref', avatar, '--paths', '[".env"]'])).code).toBe('ERR_BROWSER_PATH_REFUSED');
    expect((await browser(pane, agent, 'upload', ['--ref', avatar, '--paths', '["/etc/hosts"]'])).code).toBe('ERR_BROWSER_PATH_REFUSED');
    const big = await browser(pane, agent, 'evaluate', ['--expression', '"x".repeat(100000)']);
    expect(big).toMatchObject({ ok: true, truncated: true });

    // J15: the other verbs.
    expect(await browser(pane, agent, 'scroll', ['--dy', '600'])).toMatchObject({ ok: true });
    expect((await browser(pane, agent, 'evaluate', ['--expression', 'scrollY'])).value).toBe(600);
    await browser(pane, agent, 'navigate', ['--url', `${origin}/next`]);
    await browser(pane, agent, 'navigate', ['--back']);
    expect((await browser(pane, agent, 'evaluate', ['--expression', 'location.pathname'])).value).toBe('/');
    await browser(pane, agent, 'navigate', ['--forward']);
    expect((await browser(pane, agent, 'evaluate', ['--expression', 'location.pathname'])).value).toBe('/next');
    expect(await browser(pane, agent, 'navigate', ['--reload'])).toMatchObject({ ok: true, title: 'Next' });
    expect((await browser(pane, agent, 'wait', ['--text', 'never there', '--timeout-ms', '800'])).code).toBe('ERR_BROWSER_WAIT_TIMEOUT');
    expect(await browser(pane, agent, 'open', ['--url', `${origin}/`])).toMatchObject({ ok: true, reused: true });
    await browser(pane, agent, 'type', ['--ref', (await refs(pane, agent))('textbox "Email"'), '--text', 'grace@example.com']);
    await browser(pane, agent, 'press', ['--key', 'Enter']);
    expect(await browser(pane, agent, 'wait', ['--text', 'Welcome, grace@example.com'])).toMatchObject({ ok: true });

    // J4: only http(s); only this Pane's tabs; only from inside a Pane; off in Settings.
    for (const url of ['file:///etc/hosts', 'javascript:alert(1)', 'chrome://settings', 'data:text/html,hi']) {
      expect((await browser(pane, agent, 'navigate', ['--url', url])).code).toBe('ERR_BROWSER_URL_REFUSED');
    }
    expect(await browser(pane, other, 'tabs')).toMatchObject({ ok: true, tabs: [] });
    expect((await browser(pane, other, 'snapshot', ['--tab', opened.tab ?? ''])).code).toBe('ERR_BROWSER_NO_TAB');
    expect((await browser(pane, undefined, 'tabs')).code).toBe('ERR_BROWSER_NO_PANE');
    await page.evaluate(() => window.electronAPI.config.update({ browser: { agentTools: false } }));
    expect((await browser(pane, agent, 'tabs')).code).toBe('ERR_BROWSER_TOOLS_OFF');
    await page.evaluate(() => window.electronAPI.config.update({ browser: { agentTools: true } }));

    // J2: Take over holds until Hand to: the agent's next call waits, then runs. Touch takeover is
    // in main/src/ipc/browser.test.ts: Playwright's synthetic clicks don't reach a webview's page reliably.
    let email = (await refs(pane, agent))('textbox "Email"');
    // The chip, with its Take over button, shows while the agent drives (a call that takes a while)
    // and a moment after. Take over may land before or during that call: either way it, and the
    // click after it, wait for Hand to.
    const working = browser(pane, agent, 'evaluate', ['--expression', '(() => { const end = Date.now() + 5000; while (Date.now() < end) { /* busy */ } return true; })()']);
    await page.locator('[data-browser-page-visible="true"]').getByTestId('browser-driver-chip').getByRole('button', { name: 'Take over' }).click();
    email = (await refs(pane, agent))('textbox "Email"');
    const waiting = browser(pane, agent, 'click', ['--ref', email]);
    await expect(page.locator('[data-browser-page-visible="true"]').getByTestId('browser-driver-chip')).toContainText("You're driving · Claude is waiting");
    await shot(page, 'j2-person-driving');
    await page.locator('[data-browser-page-visible="true"]').getByTestId('browser-driver-chip').getByRole('button', { name: 'Hand to Claude' }).click();
    expect(await working).toMatchObject({ ok: true });
    expect(await waiting).toMatchObject({ ok: true });

    // J13: background tabs. A second tab comes forward; the first keeps its half-filled form while
    // hidden, across a Pane switch, and no page is drawn over Settings.
    const first = opened.tab ?? '';
    await browser(pane, agent, 'navigate', ['--tab', first, '--url', `${origin}/`]);
    const firstForm = (await browser(pane, agent, 'snapshot', ['--tab', first])).snapshot;
    await browser(pane, agent, 'type', ['--tab', first, '--ref', refIn(firstForm, 'textbox "Email"'), '--text', 'half@filled.test']);
    const second = await browser(pane, agent, 'open', ['--url', `${origin.replace('127.0.0.1', 'localhost')}/`]);
    expect(second).toMatchObject({ ok: true, reused: false });
    const emailValue = async () => (await browser(pane, agent, 'evaluate', ['--tab', first, '--expression', "document.getElementById('email').value"])).value;
    expect(await emailValue()).toBe('half@filled.test');
    await page.locator(`[data-sidebar-key="pane-${other.paneId}"]`).click();
    await expect(page.locator('[data-browser-page-visible="true"]')).toHaveCount(0);
    await page.locator(`[data-sidebar-key="pane-${agent.paneId}"]`).click();
    await expect(page.locator('[data-browser-page-visible="true"]')).toHaveCount(1);
    expect(await emailValue()).toBe('half@filled.test');
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('pane:open-settings', { detail: { category: 'browser' } })));
    await expect(page.locator('[data-browser-page-visible="true"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Back', exact: true }).first().click();
    await expect(page.locator('[data-browser-page-visible="true"]')).toHaveCount(1);
    expect(await browser(pane, agent, 'close', ['--tab', second.tab ?? ''])).toMatchObject({ ok: true });

    // J15: tab rules.
    expect((await browser(pane, other, 'snapshot')).code).toBe('ERR_BROWSER_NO_TAB');
    expect(await browser(pane, agent, 'close')).toMatchObject({ ok: true });
    expect((await browser(pane, agent, 'snapshot')).code).toBe('ERR_BROWSER_NO_TAB');
  } finally {
    await app.close();
    server.close();
  }
});
