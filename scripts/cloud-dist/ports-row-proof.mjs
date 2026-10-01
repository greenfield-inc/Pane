#!/usr/bin/env node
// LIVE proof of the Session ports chip row against a real cloud Session (no mocks):
//   desktop: a packaged Pane desktop (PANE_BIN, e.g. from a cloud-dist .deb) under xvfb, connected with the
//            Session's pairing code; the chip's shell.openExternal is recorded in the main process;
//   web:     the built web client (WEB_DIST = frontend/dist, served on 127.0.0.1:4599) in Chromium, same code.
// Linux, repo root, a machine on the tailnet: xvfb-run -a -s "-screen 0 1440x900x24" node scripts/cloud-dist/ports-row-proof.mjs
//   PANE_BIN DESK_DIR (throwaway; also the desktop's HOME, so first-run registration stays inside it)
//   OUT PAIR_FILE (0600, `runpane cloud pair <host>`) WEB_DIST CHROME (a Chromium binary)
//   ONLY=desktop,web       which surfaces to drive
//   PANE_TO_OPEN=<pane>    sidebar pane to open on the desktop (else Pane Chat); EXPLORE=1 stops after connecting
//   OPEN_CMD / LIST_CMD    shell commands that publish a port named LIVE_NAME (default p5ui-live) out of band and
//                          list ports as JSON (`runpane cloud port open|list <host> ...`): the chip must appear
//                          live, and closing it from the chip must remove it from the list
//   SUGGEST_PORT, SUGGEST_ON=desktop|web   a listener left unpublished: its dimmed chip must publish with one
//                          click (answering HTTP), then it is closed again
import { _electron as electron, chromium } from '@playwright/test';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const env = process.env;
const need = (name) => { if (!env[name]) throw new Error(`set ${name}`); return env[name]; };
const out = path.resolve(need('OUT'));
fs.mkdirSync(out, { recursive: true });
const code = fs.readFileSync(need('PAIR_FILE'), 'utf8').trim();
const liveName = env.LIVE_NAME ?? 'p5ui-live';
const checks = [];
const log = (...parts) => {
  const line = `${new Date().toISOString()} ${parts.join(' ')}`;
  console.log(line);
  fs.appendFileSync(path.join(out, 'steps.log'), `${line}\n`);
};
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); log(ok ? 'PASS' : 'FAIL', name, detail); };
const sh = (cmd) => { log('$', cmd.replace(/pane-remote:\/\/\S+/g, '<code>')); return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); };
const curlStatus = (url) => {
  try { return sh(`curl -sS -o /dev/null -m 10 -w '%{http_code}' '${url}'`).trim(); } catch (error) { return `ERR ${String(error.message).split('\n')[0]}`; }
};

async function rowShot(page, name) {
  const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file });
  const row = page.getByRole('region', { name: 'Session ports' }).first();
  if (await row.isVisible().catch(() => false)) await row.screenshot({ path: path.join(out, `${name}-row.png`) });
  fs.writeFileSync(file.replace(/\.png$/, '.aria.yml'), await page.locator('body').ariaSnapshot().catch(() => ''));
}

async function liveChangeRoundTrip(page, surface) {
  const row = page.getByRole('region', { name: 'Session ports' }).first();
  if (!env.OPEN_CMD) return;
  // The CLI runs in the background: the chip must appear while or after it runs, and on the web surface
  // no runpane:ports:list read may happen in between (then only the pushed runpane:ports:changed explains it).
  const listReads = [];
  const onRequest = (request) => { if ((request.postData() ?? '').includes('"runpane:ports:list"')) listReads.push(Date.now()); };
  page.on('request', onRequest);
  const cliStarted = Date.now();
  let cliEnded = 0;
  const cli = new Promise((resolve) => {
    const child = spawn('bash', ['-c', env.OPEN_CMD], { stdio: 'ignore' });
    child.on('exit', (code) => { cliEnded = Date.now(); resolve(code); });
  });
  const chip = row.getByRole('button', { name: new RegExp(`^Open ${liveName} \\(`) });
  const shown = await chip.waitFor({ timeout: 90_000 }).then(() => true, () => false);
  const shownAt = Date.now();
  const cliCode = await cli;
  page.off('request', onRequest);
  // The port exists only once the daemon's open finishes (just before the CLI exits); only a list read
  // after that could have shown it. A chip with no such read came from the pushed event.
  const commitFloor = Math.min(cliEnded, shownAt) - 1500;
  const readsBefore = listReads.filter((at) => at >= commitFloor && at <= shownAt).length;
  const pushed = surface === 'web' ? readsBefore === 0 : null;
  check(`${surface}: out-of-band port open appears live`, shown && cliCode === 0 && pushed !== false,
    `chip ${shownAt - cliStarted} ms after the CLI started; the CLI exited ${cliEnded - cliStarted} ms after start (code ${cliCode})` +
    (surface === 'web' ? `; runpane:ports:list reads after the open committed: ${readsBefore} of ${listReads.length} during the wait (0 = the push event delivered it)` : ''));
  await rowShot(page, `${surface}-live-open`);
  if (!shown) return;
  await row.getByRole('button', { name: `Close ${liveName}` }).click();
  await row.getByRole('button', { name: 'Close', exact: true }).click();
  const gone = await chip.waitFor({ state: 'detached', timeout: 15_000 }).then(() => true, () => false);
  const listed = env.LIST_CMD ? sh(env.LIST_CMD) : '';
  check(`${surface}: close from the chip unpublishes`, gone && (!env.LIST_CMD || !listed.includes(liveName)), env.LIST_CMD ? `port list after: ${listed.replace(/\s+/g, ' ').slice(0, 300)}` : '');
}

async function suggestionRoundTrip(page, surface) {
  if (!env.SUGGEST_PORT || (env.SUGGEST_ON ?? 'desktop') !== surface) return;
  const row = page.getByRole('region', { name: 'Session ports' }).first();
  const suggestion = row.getByTestId('session-port-suggestion').filter({ hasText: `:${env.SUGGEST_PORT}` });
  const shown = await suggestion.waitFor({ timeout: 45_000 }).then(() => true, () => false);
  check(`${surface}: detected listener shows as a suggested chip`, shown, `:${env.SUGGEST_PORT}`);
  await rowShot(page, `${surface}-suggested`);
  if (!shown) return;
  await suggestion.getByRole('button', { name: 'Open on tailnet' }).click();
  const confirm = row.getByRole('button', { name: 'Replace', exact: true });
  if (await confirm.waitFor({ timeout: 3000 }).then(() => true, () => false)) {
    log(`${surface}: Replace prompt shown`);
    await rowShot(page, `${surface}-replace-prompt`);
    await confirm.click();
  }
  const chip = row.getByTestId('session-port-chip').filter({ hasText: `:${env.SUGGEST_PORT}` });
  const published = await chip.waitFor({ timeout: 20_000 }).then(() => true, () => false);
  const url = published ? (await chip.getByRole('button').first().getAttribute('title')) : '';
  const status = url ? curlStatus(url) : '';
  check(`${surface}: Open on tailnet publishes it`, published && /^[23]/.test(status), `${url} -> HTTP ${status}`);
  await rowShot(page, `${surface}-suggestion-published`);
  if (published) {
    await chip.getByRole('button', { name: /^Close / }).click();
    await row.getByRole('button', { name: 'Close', exact: true }).click();
    await chip.waitFor({ state: 'detached', timeout: 15_000 }).catch(() => undefined);
  }
}

async function desktop() {
  const deskDir = path.resolve(need('DESK_DIR'));
  fs.mkdirSync(path.join(deskDir, 'home/.config'), { recursive: true });
  const app = await electron.launch({
    executablePath: need('PANE_BIN'),
    args: ['--no-sandbox', '--disable-webgl', '--disable-gpu'],
    // Isolated HOME/XDG: a packaged (non side-by-side) Pane registers agent MCP servers, skills and a login
    // item on first run; keep all of that inside the throwaway desktop dir.
    env: { ...env, PANE_DIR: deskDir, HOME: path.join(deskDir, 'home'), XDG_CONFIG_HOME: path.join(deskDir, 'home/.config'), XDG_DATA_HOME: path.join(deskDir, 'home/.local/share') },
    timeout: 90_000,
  });
  // The chip opens the default browser through shell.openExternal: record it in the main process instead.
  await app.evaluate(({ shell }) => {
    globalThis.__opened = [];
    shell.openExternal = async (url) => { globalThis.__opened.push(url); };
  });
  const page = await app.firstWindow();
  try {
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(5000);
    for (let round = 0; round < 5; round++) {
      await page.waitForTimeout(700);
      const update = page.getByRole('dialog', { name: 'Software Update' });
      if (await update.isVisible().catch(() => false)) { await update.getByRole('button', { name: 'Close', exact: true }).click(); continue; }
      const skip = page.getByRole('button', { name: 'Skip', exact: true });
      if (await skip.isVisible().catch(() => false)) { await skip.click(); continue; }
      const welcome = page.getByRole('dialog', { name: 'Welcome to Pane' });
      if (await welcome.isVisible().catch(() => false)) { await welcome.getByRole('button', { name: 'Close modal' }).click(); continue; }
      break;
    }
    // Same call Settings > Remote Access > Connections > "Import & Connect" makes.
    const imported = await page.evaluate(async (pairing) => window.electronAPI.remoteDaemon.importConnectionCode(pairing, { connect: true }), code);
    check('desktop: imports the pairing code and connects', imported?.success === true, imported?.error ?? '');
    await page.getByRole('button', { name: /^Agents run on .*Switch host$/ }).first().waitFor({ timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(3000);
    if (env.EXPLORE === '1') {
      const expand = page.getByRole('button', { name: /^Expand repository / });
      for (const button of await expand.all()) await button.click().catch(() => undefined);
      await page.waitForTimeout(2000);
      await rowShot(page, 'desktop-explore');
      return;
    }
    if (env.PANE_TO_OPEN) {
      const expand = page.getByRole('button', { name: /^Expand repository / });
      for (const button of await expand.all()) await button.click().catch(() => undefined);
      await page.getByRole('button', { name: env.PANE_TO_OPEN, exact: true }).first().click({ timeout: 20_000 });
    } else {
      await page.getByRole('button', { name: 'Pane Chat', exact: true }).click();
    }
    const row = page.getByRole('region', { name: 'Session ports' }).first();
    const visible = await row.waitFor({ timeout: 45_000 }).then(() => true, () => false);
    const chips = visible ? await row.getByTestId('session-port-chip').allTextContents() : [];
    check('desktop: Ports row shows the Session ports', visible && chips.length > 0, JSON.stringify(chips));
    await rowShot(page, 'desktop-row');
    if (visible && chips.length > 0) {
      const first = row.getByTestId('session-port-chip').first().getByRole('button').first();
      const url = await first.getAttribute('title');
      await first.click();
      await page.waitForTimeout(1000);
      const opened = await app.evaluate(() => globalThis.__opened);
      const status = curlStatus(url);
      check('desktop: chip opens its tailnet URL in the default browser', opened.includes(url), `openExternal(${JSON.stringify(opened)}); curl ${url} -> HTTP ${status}`);
    }
    await liveChangeRoundTrip(page, 'desktop');
    await suggestionRoundTrip(page, 'desktop');
    await rowShot(page, 'desktop-final');
  } catch (error) {
    check('desktop: run completed', false, String(error.message).split('\n')[0]);
    await rowShot(page, 'desktop-error').catch(() => undefined);
  } finally {
    await app.close().catch(() => undefined);
  }
}

async function web() {
  const server = spawn('python3', ['-m', 'http.server', '4599', '--bind', '127.0.0.1', '--directory', need('WEB_DIST')], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const browser = await chromium.launch({ executablePath: need('CHROME'), args: ['--disable-gpu', '--disable-webgl'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  try {
    await page.goto('http://127.0.0.1:4599/remote.html', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /Connect with a code/ }).click({ timeout: 15_000 }).catch(() => undefined);
    await page.locator('#connection-code').fill(code);
    await page.getByRole('button', { name: 'Import & Connect' }).click();
    const row = page.getByRole('region', { name: 'Session ports' }).first();
    const visible = await row.waitFor({ timeout: 45_000 }).then(() => true, () => false);
    const chips = visible ? await row.getByTestId('session-port-chip').allTextContents() : [];
    check('web: Ports row shows the Session ports', visible && chips.length > 0, JSON.stringify(chips));
    await rowShot(page, 'web-row');
    if (visible && chips.length > 0) {
      const first = row.getByTestId('session-port-chip').first().getByRole('button').first();
      const url = await first.getAttribute('title');
      const [popup] = await Promise.all([context.waitForEvent('page'), first.click()]);
      await popup.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => undefined);
      await popup.screenshot({ path: path.join(out, 'web-opened-tab.png') }).catch(() => undefined);
      check('web: chip opens the tailnet HTTPS URL in a new tab', popup.url().startsWith(url), `${popup.url()} title=${JSON.stringify(await popup.title().catch(() => ''))}`);
      await popup.close();
    }
    await liveChangeRoundTrip(page, 'web');
    await suggestionRoundTrip(page, 'web');
    await page.setViewportSize({ width: 390, height: 844 });
    await rowShot(page, 'web-phone');
  } catch (error) {
    check('web: run completed', false, String(error.message).split('\n')[0]);
    await rowShot(page, 'web-error').catch(() => undefined);
  } finally {
    await browser.close();
    server.kill();
  }
}

const only = env.ONLY ?? 'desktop,web';
if (only.includes('desktop')) await desktop();
if (only.includes('web')) await web();
const ok = checks.every((entry) => entry.ok);
fs.writeFileSync(path.join(out, 'results.json'), `${JSON.stringify({ ok, checks }, null, 2)}\n`);
log(ok ? 'RESULT PASS' : 'RESULT FAIL');
process.exitCode = ok ? 0 : 1;
