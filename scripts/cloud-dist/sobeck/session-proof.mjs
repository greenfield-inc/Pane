// R3.5: drives the side-by-side Pane desktop test build to create a FRESH Pane in a repo on a cloud host
// (seed-profile.cjs saved the host), then proves end to end from that Pane's terminal
// (session-checks.sh, typed in as base64) and from this machine:
//   secrets-at-creation  the repo manifest's Doppler secrets are there in the new Pane (names only)
//   port-open            a tiny server in the Pane, published with `runpane port open`
//   ports-chip           its chip appears in the Session's Ports row with that URL
//   ports-chip-opens     clicking it makes the app open exactly that URL, and the URL answers 200 from
//                        this machine (Invoke-WebRequest on Windows, fetch elsewhere) with the server's text
//   broker-*, gh-*, master-push-refused
//                        through the coordinator's GitHub broker: push, gh issue create, gh pr create
//                        --draft, `runpane cloud agent github push --branch master` refused
//                        (ref-outside-namespace), then the issue and the PR closed (the branch is kept)
//   port-closed          the port closed and the server stopped again
//
// Privacy: as proof.mjs. Screenshots are of the app window only; nothing from config.json but the host
// label is read or logged, and app console lines have the saved host tokens redacted. The Session side
// prints secret NAMES and counts only.
//
// Runs with the Pane binary itself as Node (run-session-proof.ps1 does this on Windows):
//   PANE_EXE        the test build (never the installed Pane)
//   PANE_DIR        its data dir; never ~/.pane
//   OUT             evidence dir (screenshots, steps.log, session-lines.txt, results.json)
//   HOST_LABEL      the cloud host's label (default: the only saved profile's label)
//   REPO            repo to create the Pane in (default montlakev2)
//   PANE_PREFIX     the new Pane's name is <prefix>-<tag> (default r35)
//   PORT            port of the tiny server (default 18000 + a random 0..899)
//   GITHUB          1 (default) runs the broker checks; 0 skips them (no coordinator, e.g. CI)
//   KEEP_PANE       1 keeps the new Pane; by default it is archived at the end (its local branch is kept)
//   EXTRA_ARGS      extra Electron switches, space separated (e.g. --no-sandbox under xvfb on Linux)
//   OPEN_IN_BROWSER 1 = the chip click also opens the default browser
import { _electron as electron } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const required = (name) => {
  if (!env[name]) throw new Error(`session-proof: set ${name}`);
  return env[name];
};
const paneExe = path.resolve(required('PANE_EXE'));
const paneDir = path.resolve(required('PANE_DIR'));
if (paneDir.toLowerCase() === path.join(os.homedir(), '.pane').toLowerCase()) throw new Error('session-proof: PANE_DIR must not be ~/.pane');
if (/[\\/]Programs[\\/]Pane[\\/]/i.test(paneExe)) throw new Error('session-proof: PANE_EXE is the installed Pane; use the test build');
const out = path.resolve(required('OUT'));
fs.mkdirSync(out, { recursive: true });
const here = path.dirname(fileURLToPath(import.meta.url));
const sessionScript = fs.readFileSync(path.join(here, 'session-checks.sh'));

const config = JSON.parse(fs.readFileSync(path.join(paneDir, 'config.json'), 'utf8'));
const profiles = config.remoteDaemon?.client?.profiles ?? [];
const hostLabel = env.HOST_LABEL || (() => {
  if (profiles.length !== 1) throw new Error(`session-proof: set HOST_LABEL (saved hosts: ${JSON.stringify(profiles.map((p) => p.label))})`);
  return profiles[0].label;
})();
const secrets = profiles.map((profile) => profile.token).filter(Boolean);
const repo = env.REPO || 'montlakev2';
const tag = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 13).toLowerCase()}${Math.random().toString(36).slice(2, 6)}`;
const paneName = `${env.PANE_PREFIX || 'r35'}-${tag}`;
const port = Number(env.PORT || 18000 + Math.floor(Math.random() * 900));
const github = env.GITHUB === '0' ? '0' : '1';
const openInBrowser = env.OPEN_IN_BROWSER === '1';
const keepPane = env.KEEP_PANE === '1';
const extraArgs = (env.EXTRA_ARGS || '').split(/\s+/).filter(Boolean);
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const started = Date.now();
const checks = [];
const redact = (text) => secrets.reduce((current, secret) => current.split(secret).join('<redacted>'), String(text));
const log = (...parts) => {
  const line = `${new Date().toISOString()} ${redact(parts.join(' '))}`;
  console.log(line);
  fs.appendFileSync(path.join(out, 'steps.log'), `${line}\n`);
};
const check = (name, verdict, detail) => {
  checks.push({ name, verdict, detail: redact(detail ?? '') });
  log(verdict, name, detail ?? '');
};
const pass = (name, ok, detail) => check(name, ok ? 'PASS' : 'FAIL', detail);
const appLog = (source, text) => {
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim()) fs.appendFileSync(path.join(out, 'app-console.log'), `${new Date().toISOString()} [${source}] ${redact(line).slice(0, 500)}\n`);
  }
};

const childEnv = { ...env, PANE_DIR: paneDir };
delete childEnv.ELECTRON_RUN_AS_NODE;
log(`launching ${paneExe} with PANE_DIR=${paneDir}; host "${hostLabel}"; new Pane "${paneName}" in ${repo}; port ${port}; github ${github}`);
const app = await electron.launch({
  executablePath: paneExe,
  // --disable-webgl: xterm's DOM renderer, whose rows can be read (as proof.mjs).
  args: [`--user-data-dir=${path.join(paneDir, 'chromium-profile')}`, '--disable-webgl', ...extraArgs],
  env: childEnv,
  timeout: 120_000,
});
app.process().stdout?.on('data', (chunk) => appLog('main', chunk));
app.process().stderr?.on('data', (chunk) => appLog('main:err', chunk));
const page = await app.firstWindow();
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') appLog(`renderer:${message.type()}`, message.text());
});
let shotIndex = 0;
const shot = async (name) => {
  const file = path.join(out, `${String(++shotIndex).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file });
  log('screenshot', path.basename(file));
};

async function dismissFirstRun() {
  for (let round = 0; round < 6; round++) {
    await page.waitForTimeout(800);
    const skip = page.getByRole('button', { name: 'Skip', exact: true });
    if (await skip.isVisible().catch(() => false)) {
      await skip.click();
      continue;
    }
    const welcome = page.getByRole('dialog', { name: 'Welcome to Pane' });
    if (await welcome.isVisible().catch(() => false)) {
      await welcome.getByRole('button', { name: 'Close modal' }).click();
      continue;
    }
    // Only a normal (not side-by-side) build checks for updates, e.g. the Linux .deb used on agentbox.
    const update = page.getByRole('dialog', { name: 'Software Update' });
    if (await update.isVisible().catch(() => false)) {
      log('first run: Software Update -> Close');
      await update.getByRole('button', { name: 'Close', exact: true }).click();
      continue;
    }
    return;
  }
}

// The raw terminal output the preload delivers (independent of the renderer), ANSI stripped.
async function collectTerminalStream() {
  await page.evaluate(() => {
    if (window.__proofStream !== undefined) return;
    window.__proofStream = '';
    window.electronAPI?.events?.onTerminalOutput?.((event) => {
      window.__proofStream += event.output ?? event.data ?? '';
      if (window.__proofStream.length > 400_000) window.__proofStream = window.__proofStream.slice(-200_000);
    });
  }).catch(() => undefined);
}
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[@-Z\\\\-_]`, 'g');
const streamText = async () => (await page.evaluate(() => window.__proofStream ?? '').catch(() => '')).replace(ANSI, '');
const domText = () => page.evaluate(() => [...document.querySelectorAll('.xterm-rows')].map((rows) => rows.textContent ?? '').join('\n')).catch(() => '');

const visibleTerminal = () => page.locator('.xterm:visible').last();
async function typeLine(text) {
  await visibleTerminal().click();
  await page.keyboard.insertText(text);
  await page.keyboard.press('Enter');
}

// One "R35:<tag>:<base64 of check TAB verdict TAB detail>:/R35" line per check from session-checks.sh (it
// also prints a readable line), looked for with ALL whitespace removed in the raw terminal stream (exact from
// a Linux pty such as Scratch's), in that stream with ConPTY's wraps undone, and in the rows xterm renders
// when it uses its DOM renderer. Acks and the script's sha256 are matched the same way; the typed commands
// have a quote between "R35" and the tag, so they never match. Matches are kept as they are seen.
//
// ConPTY (a Windows host such as the CI fake host; the Windows app also draws with WebGL, so there are no DOM
// rows) hard-wraps at the terminal width and starts each continuation row with the previous row's last
// character again: "…0117aa9\n9d7b…". The width is the most common row length; a row of that length (or
// one less) whose successor starts with its last character is joined to it without the repeat.
function unwrapConpty(text) {
  const rows = text.split(/\r?\n/);
  const counts = new Map();
  for (const row of rows) if (row.length > 0) counts.set(row.length, (counts.get(row.length) ?? 0) + 1);
  const width = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  let joined = rows[0] ?? '';
  for (let i = 1; i < rows.length; i++) {
    const previous = rows[i - 1];
    const wrapped = previous.length >= width - 1 && previous.length <= width && rows[i][0] === previous.at(-1);
    joined += wrapped ? rows[i].slice(1) : `\n${rows[i]}`;
  }
  return joined;
}
const compact = (text) => text.replace(/\s+/g, '');
const compactStream = async () => {
  const stream = await streamText();
  return [compact(stream), compact(unwrapConpty(stream)), compact(await domText())].join('\u0000');
};
const LINE = new RegExp(`R35:${tag}:([A-Za-z0-9+/=]+):/R35`, 'g');
const seen = new Set();
const sessionLines = async () => [...(await compactStream()).matchAll(LINE)].map(([, encoded]) => {
  const [name = '', verdict = '', detail = ''] = Buffer.from(encoded, 'base64').toString('utf8').split('\t');
  return { name, verdict, detail: detail.trim() };
}).filter((line) => /^(PASS|FAIL|SKIP|INFO)$/.test(line.verdict));
async function runPhase(phase, timeoutMs) {
  await typeLine(`bash "$R35" ${phase} ${tag} ${port} ${github}`);
  const deadline = Date.now() + timeoutMs;
  const results = [];
  for (;;) {
    const lines = await sessionLines();
    for (const line of lines) {
      if (line.name === 'phase-done' || seen.has(line.name)) continue;
      seen.add(line.name);
      results.push(line);
      fs.appendFileSync(path.join(out, 'session-lines.txt'), `${redact(`${line.name} ${line.verdict} ${line.detail}`)}\n`);
      if (line.verdict === 'INFO') log('session', line.name, line.detail);
      else check(line.name, line.verdict, line.detail);
    }
    if (lines.some((line) => line.name === 'phase-done' && line.detail === phase)) return results;
    if (Date.now() > deadline) {
      check(`phase-${phase}`, 'FAIL', `no "phase-done ${phase}" from the Session within ${timeoutMs / 1000} s`);
      return results;
    }
    await page.waitForTimeout(300);
  }
}

// Types one line and waits until the shell has run it: the line ends with an echo whose output (not the
// typed text, which has a quote in the middle) is looked for. Keys typed while the shell is still busy can be
// lost (ConPTY + Git Bash on the CI fake host dropped the last of several quick lines), so the next line is
// only typed after this one's ack.
let acks = 0;
async function typeAcked(command, timeoutMs = 30_000) {
  const ack = `R35${tag}ack${++acks}.`;
  await typeLine(`${command}; echo "R35 ${tag}" "ack ${acks}."`);
  return waitFor(async () => (await compactStream()).includes(ack), timeoutMs);
}

// Writes session-checks.sh into the Session through the terminal: base64 in short printf lines (no line
// near a tty's limits), each acknowledged, decoded once, then checked against its sha256 before it runs.
async function deliverScript() {
  const sha = (await import('node:crypto')).createHash('sha256').update(sessionScript).digest('hex');
  const b64 = sessionScript.toString('base64');
  let typed = await typeAcked(`R35="\${TMPDIR:-/tmp}/runpane-r35-${tag}.sh"; : > "$R35.b64"`);
  for (let at = 0; typed && at < b64.length; at += 900) {
    typed = await typeAcked(`printf %s '${b64.slice(at, at + 900)}' >> "$R35.b64"`);
  }
  if (typed) await typeLine(`base64 -d "$R35.b64" > "$R35" && rm -f "$R35.b64" && echo "R35 ${tag}" "script $(sha256sum "$R35" | cut -c1-64)"`);
  const delivered = typed && await waitFor(async () => (await compactStream()).includes(`R35${tag}script${sha}`), 60_000);
  pass('script-delivered', delivered, delivered
    ? `session-checks.sh in the Pane in ${acks} acknowledged lines (sha256 ${sha.slice(0, 12)}…)`
    : `${typed ? `sha256 ${sha.slice(0, 12)}… never echoed back within 60 s` : `typed line ${acks} not acknowledged within 30 s`}`);
  return delivered;
}
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await page.waitForTimeout(300);
  }
}

// GET from this machine: Invoke-WebRequest on Windows (what the relay would type), fetch elsewhere. Windows
// PowerShell 5.1 hands back Content as bytes when the response isn't typed as text.
function getFromHere(url) {
  const startedAt = Date.now();
  if (process.platform === 'win32') {
    const command = `$ProgressPreference='SilentlyContinue'; try { $r = Invoke-WebRequest -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 20 -Uri '${url.replace(/'/g, "''")}'; $c = $r.Content; if ($c -is [byte[]]) { $c = [Text.Encoding]::UTF8.GetString($c) }; "$($r.StatusCode) $c" } catch { "error $($_.Exception.Message)" }`;
    let text;
    try {
      text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 40_000 }).trim();
    } catch (error) {
      text = `error ${error.message.split('\n')[0]}`;
    }
    const [status, ...body] = text.split(' ');
    return Promise.resolve({ via: 'Invoke-WebRequest', status, body: body.join(' '), ms: Date.now() - startedAt });
  }
  return fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000) })
    .then(async (response) => ({ via: 'fetch', status: String(response.status), body: (await response.text()).trim(), ms: Date.now() - startedAt }),
      (error) => ({ via: 'fetch', status: `error ${error?.cause?.code ?? error?.message ?? error}`, body: '', ms: Date.now() - startedAt }));
}

let scriptReady = false;
let setupRan = false;
let paneCreated = false;
try {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(5000);
  await dismissFirstRun();
  await collectTerminalStream();
  await shot('launched');

  // 1. The cloud host is the active host (an earlier proof or Red picked it; pick it otherwise).
  const connectedChip = page.getByRole('button', { name: `Agents run on ${hostLabel}. Switch host` });
  if (!await connectedChip.waitFor({ timeout: 20_000 }).then(() => true, () => false)) {
    await page.getByRole('button', { name: /Switch host$/ }).first().click();
    await page.getByRole('menuitemradio', { name: new RegExp(escapeRegExp(hostLabel)) }).click();
  }
  const newPane = page.getByRole('button', { name: `New pane in ${repo}` });
  const ready = await connectedChip.waitFor({ timeout: 60_000 }).then(() => true, () => false)
    && await newPane.waitFor({ timeout: 60_000 }).then(() => true, () => false);
  pass('host-connected', ready, `switcher names "${hostLabel}"; ${repo} listed`);
  if (!ready) throw new Error(`${repo} is not listed on ${hostLabel}`);

  // 2. A fresh Pane in the repo, created in the UI.
  await newPane.click();
  const dialog = page.getByRole('dialog', { name: `New Pane in ${repo}` });
  await dialog.waitFor({ timeout: 20_000 });
  await dialog.getByRole('textbox', { name: 'Enter a name for your pane' }).fill(paneName);
  await shot('new-pane-dialog');
  const createdAt = Date.now();
  await dialog.getByRole('button', { name: /^Create/ }).click();
  const paneButton = page.getByRole('button', { name: paneName, exact: true });
  const created = await paneButton.waitFor({ timeout: 120_000 }).then(() => true, () => false);
  pass('pane-created', created, created ? `"${paneName}" in ${repo} on ${hostLabel}, listed ${Date.now() - createdAt} ms after Create` : `"${paneName}" not listed within 120 s`);
  if (!created) throw new Error('the new Pane never appeared');
  paneCreated = true;
  await paneButton.click();

  // 3. Its terminal: the Pane is new, so open one from its empty stage (or use one it already has).
  const tabs = page.getByRole('tab', { name: /^Terminal\b/ });
  const addTerminal = page.getByRole('button', { name: /^Terminal Ctrl\+Alt\+1/ });
  const stageAt = Date.now();
  while (await tabs.count() === 0 && !await addTerminal.isVisible().catch(() => false) && Date.now() - stageAt < 90_000) await page.waitForTimeout(500);
  if (await tabs.count() > 0) await tabs.first().click();
  else await addTerminal.click({ timeout: 30_000 });
  const attached = await visibleTerminal().waitFor({ timeout: 120_000 }).then(() => true, () => false);
  pass('pane-terminal', attached, attached ? `terminal attached ${Date.now() - stageAt} ms after the Pane opened` : 'no terminal on screen within 120 s');
  if (!attached) throw new Error('the new Pane has no terminal');
  await page.waitForTimeout(3000);
  await shot('pane-terminal');

  scriptReady = await deliverScript();
  if (!scriptReady) throw new Error('session-checks.sh did not arrive in the Pane');

  // 4. Secrets and the port, from inside the new Pane.
  setupRan = true;
  const setupLines = await runPhase('setup', 120_000);
  await shot('setup');
  const opened = setupLines.find((line) => line.name === 'port-open' && line.verdict === 'PASS');
  const url = opened?.detail.match(/-> (\S+)$/)?.[1] ?? '';

  // 5. The new port's chip in the Session's Ports row, its click and the URL from this machine.
  const portName = `r35-${tag}`;
  if (url) {
    const row = page.getByRole('region', { name: 'Session ports' }).first();
    const chip = row.getByRole('button', { name: new RegExp(`^Open ${escapeRegExp(portName)} \\(`) });
    const shownAt = Date.now();
    const shown = await chip.waitFor({ timeout: 45_000 }).then(() => true, () => false);
    const chipUrl = shown ? (await chip.getAttribute('title')) ?? '' : '';
    const chips = await row.getByTestId('session-port-chip').allTextContents().catch(() => []);
    pass('ports-chip', shown && chipUrl === url, shown
      ? `${portName} -> ${chipUrl} (expected ${url}) ${Date.now() - shownAt} ms after port open; row: ${JSON.stringify(chips)}`
      : `no "${portName}" chip in the Session's Ports row within 45 s (row: ${JSON.stringify(chips)})`);
    await shot('ports');
    if (shown) {
      await app.evaluate(({ shell }, passThrough) => {
        globalThis.__proofOpened = [];
        globalThis.__proofOpenExternal ??= shell.openExternal.bind(shell);
        shell.openExternal = async (target, options) => {
          globalThis.__proofOpened.push(target);
          if (passThrough) await globalThis.__proofOpenExternal(target, options);
        };
      }, openInBrowser);
      await chip.click();
      await page.waitForTimeout(1500);
      const openedUrls = await app.evaluate(() => globalThis.__proofOpened ?? []);
      const got = await getFromHere(chipUrl);
      const expectedBody = `runpane-cloud R3.5 ${tag}`;
      pass('ports-chip-opens', openedUrls.length === 1 && openedUrls[0] === chipUrl && got.status === '200' && got.body.includes(expectedBody),
        `click opened ${JSON.stringify(openedUrls)}${openInBrowser ? ' in the default browser' : ' (recorded, browser not opened)'}; ${got.via} ${chipUrl} from ${os.hostname()} -> ${got.status} "${got.body.slice(0, 60)}" in ${got.ms} ms`);
    }
  } else {
    check('ports-chip', 'SKIP', 'no port was opened');
  }

  // 6. The GitHub broker, from inside the new Pane.
  await runPhase('broker', 240_000);
  await shot('broker');
} catch (error) {
  pass('run-completed', false, error instanceof Error ? error.message.split('\n')[0] : String(error));
  await shot('error').catch(() => undefined);
} finally {
  if (setupRan) {
    await runPhase('cleanup', 60_000).catch((error) => check('phase-cleanup', 'FAIL', String(error)));
    await shot('cleanup').catch(() => undefined);
  }
  // The Pane was only for this proof: archive it like the UI's Archive (worktree removed, branch kept).
  // --force: its test commit went to GitHub through the broker, so it has no upstream to count as pushed.
  if (paneCreated && !keepPane) {
    const paneButton = page.getByRole('button', { name: paneName, exact: true });
    const archived = await typeLine('"${PANE_RUNPANE_BIN:-runpane}" panes archive --pane "$PANE_SESSION_ID" --force --yes')
      .then(() => paneButton.waitFor({ state: 'detached', timeout: 90_000 })).then(() => true, () => false);
    pass('pane-archived', archived, archived ? `"${paneName}" archived (worktree removed, local branch kept)` : `"${paneName}" still listed 90 s after runpane panes archive`);
    if (!archived) await shot('archive-failed').catch(() => undefined);
  } else if (paneCreated) {
    check('pane-archived', 'SKIP', `KEEP_PANE=1: "${paneName}" kept`);
  }
  // What the terminals printed (ANSI stripped; no value of any secret is ever printed there), for diagnosis.
  fs.writeFileSync(path.join(out, 'terminal-stream.txt'), redact(await streamText().catch(() => '')));
  await app.close().catch(() => undefined);
  const ok = checks.every((entry) => entry.verdict !== 'FAIL');
  const result = { ok, host: hostLabel, repo, pane: paneName, tag, port, seconds: Math.round((Date.now() - started) / 1000), checks };
  fs.writeFileSync(path.join(out, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);
  log(ok ? 'RESULT PASS' : 'RESULT FAIL');
  process.exitCode = ok ? 0 : 1;
}
