// Measures how the Pane desktop feels on a remote host: keystroke-to-echo, wheel scrolling in a fullscreen
// TUI (latency-tui.py, a stand-in for Claude Code's fullscreen UI: same alternate screen and mouse modes), and
// terminal tab switches. It also counts the app's remote requests per phase, so each number comes with its
// protocol round trips. Writes OUT/latency.json and OUT/steps.log.
//
// Privacy: only numbers leave the app. The renderer hook keeps the TUI's TOP=/K=/W= counters from one panel
// and byte counts; the main-process hook keeps request paths and invoke channel names, never bodies, headers
// or tokens. No screenshots unless SHOTS=1 (app window only).
//
// Runs with the Pane binary itself as Node, like proof.mjs (measure-latency.ps1 does this on Windows):
//   PANE_EXE, PANE_DIR, OUT       as in proof.mjs (never the installed Pane or ~/.pane)
//   HOST_LABEL                    saved host to connect to (default: the only one)
//   REPO, PANE_NAME               repo and Pane to measure in (default Hello-World / sobeck-check)
//   PYTHON                        python on the host (default python3)
//   KEYS (40), SCROLL_ROUNDS (4), SWITCHES (8), IDLE_KEYS (4)
//   SKIP                          comma list of phases to skip: echo,idle,motion,scroll,tabs,panes
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const required = (name) => {
  if (!env[name]) throw new Error(`measure-latency: set ${name}`);
  return env[name];
};
const paneExe = path.resolve(required('PANE_EXE'));
const paneDir = path.resolve(required('PANE_DIR'));
if (paneDir.toLowerCase() === path.join(os.homedir(), '.pane').toLowerCase()) throw new Error('measure-latency: PANE_DIR must not be ~/.pane');
if (/[\\/]Programs[\\/]Pane[\\/]/i.test(paneExe)) throw new Error('measure-latency: PANE_EXE is the installed Pane; use the test build');
const out = path.resolve(required('OUT'));
fs.mkdirSync(out, { recursive: true });
const here = path.dirname(fileURLToPath(import.meta.url));
const tuiSource = fs.readFileSync(path.join(here, 'latency-tui.py'));

const savedLabels = () => {
  const config = JSON.parse(fs.readFileSync(path.join(paneDir, 'config.json'), 'utf8'));
  return (config.remoteDaemon?.client?.profiles ?? []).map((profile) => profile.label);
};
const hostLabel = env.HOST_LABEL || (() => {
  const labels = savedLabels();
  if (labels.length !== 1) throw new Error(`measure-latency: set HOST_LABEL (saved hosts: ${JSON.stringify(labels)})`);
  return labels[0];
})();
const repo = env.REPO || 'Hello-World';
const paneName = env.PANE_NAME || 'sobeck-check';
const python = env.PYTHON || 'python3';
const KEYS = Number(env.KEYS || 40);
const IDLE_KEYS = Number(env.IDLE_KEYS || 4);
const SCROLL_ROUNDS = Number(env.SCROLL_ROUNDS || 4);
const SWITCHES = Number(env.SWITCHES || 8);
const ACTIVATION_WINDOW_MS = Number(env.ACTIVATION_WINDOW_MS || 6000);
const skip = new Set((env.SKIP || '').split(',').map((s) => s.trim()).filter(Boolean));
// Opt-in: start `claude --debug` in the measured terminal (needs Claude on the host; no prompt, no tokens),
// wheel once, quit, and report the wheel profile Claude picked from its debug log (one line, no content).
const claudeProbe = env.CLAUDE_PROBE === '1';
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const started = Date.now();
const result = { host: hostLabel, app: path.basename(path.dirname(paneExe)), startedAt: new Date().toISOString(), phases: {}, errors: [] };
const log = (...parts) => {
  const line = `${new Date().toISOString()} ${parts.join(' ')}`;
  console.log(line);
  fs.appendFileSync(path.join(out, 'steps.log'), `${line}\n`);
};
const stats = (values) => {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return { n: 0 };
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const round = (v) => Math.round(v * 10) / 10;
  return { n: sorted.length, min: round(sorted[0]), p50: round(q(0.5)), p95: round(q(0.95)), max: round(sorted[sorted.length - 1]) };
};

const childEnv = { ...env, PANE_DIR: paneDir };
delete childEnv.ELECTRON_RUN_AS_NODE;
log(`launching ${paneExe} with PANE_DIR=${paneDir}; host "${hostLabel}"`);
const app = await electron.launch({
  executablePath: paneExe,
  args: [`--user-data-dir=${path.join(paneDir, 'chromium-profile')}`, ...(env.EXTRA_ARGS ? env.EXTRA_ARGS.split(' ') : [])],
  env: childEnv,
  timeout: 120_000,
});
const page = await app.firstWindow();
const now = () => performance.timeOrigin + performance.now();

// Main process: time every request the remote client makes (path + invoke channel name only).
async function instrumentMain() {
  await app.evaluate(() => {
    if (globalThis.__latReq) return;
    const load = globalThis.process?.mainModule?.require ?? globalThis.require;
    const clock = () => performance.timeOrigin + performance.now();
    globalThis.__latReq = [];
    for (const name of ['http', 'https']) {
      const mod = load(name);
      const original = mod.request;
      mod.request = function patchedRequest(...args) {
        const req = original.apply(this, args);
        const url = args[0] instanceof URL ? args[0] : URL.canParse(String(args[0])) ? new URL(String(args[0])) : null;
        const entry = { t0: clock(), path: url?.pathname ?? args[0]?.path ?? '?', channel: null, reused: null, ms: null, bytes: 0 };
        if (!/\/(invoke|events)$/.test(entry.path)) return req;
        globalThis.__latReq.push(entry);
        const write = req.write;
        req.write = function patchedWrite(chunk, ...rest) {
          if (!entry.channel && entry.path.endsWith('/invoke')) {
            const match = /^\{"channel":"([^"]{1,80})"/.exec(String(chunk).slice(0, 120));
            entry.channel = match ? match[1] : '?';
          }
          return write.call(this, chunk, ...rest);
        };
        req.on('socket', () => { entry.reused = req.reusedSocket; });
        req.on('response', (res) => {
          entry.status = res.statusCode;
          entry.encoding = res.headers['content-encoding'] ?? null;
          res.on('data', (c) => { entry.bytes += c.length; });
          if (entry.path.endsWith('/invoke')) res.on('end', () => { entry.ms = clock() - entry.t0; });
        });
        return req;
      };
    }
  });
}
const requestsSince = async (t0, t1 = Infinity) => app.evaluate((_electron, [from, to]) =>
  (globalThis.__latReq ?? []).filter((r) => r.t0 >= from && r.t0 <= to), [t0, t1]);
const summarizeRequests = (requests) => {
  const invokes = requests.filter((r) => r.path.endsWith('/invoke'));
  const byChannel = {};
  for (const r of invokes) byChannel[r.channel] = (byChannel[r.channel] ?? 0) + 1;
  return {
    invokes: invokes.length,
    newConnections: invokes.filter((r) => r.reused === false).length,
    eventStreams: requests.filter((r) => r.path.endsWith('/events')).length,
    responseBytes: invokes.reduce((sum, r) => sum + r.bytes, 0),
    gzipResponses: invokes.filter((r) => r.encoding === 'gzip').length,
    invokeMs: stats(invokes.map((r) => r.ms)),
    byChannel,
  };
};

// Renderer: keydown times, and per terminal output event the arrival time, the next frame and the TUI counters.
async function instrumentRenderer() {
  await page.evaluate(() => {
    if (window.__lat) return;
    const clock = () => performance.timeOrigin + performance.now();
    window.__lat = { keys: [], out: [], panel: null, marker: null, markerPanel: null, longTasks: [], frames: [], allOutputs: 0, allOutputBytes: 0 };
    // Main-thread stalls (>50 ms) and every animation frame: what the user sees as jank.
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__lat.longTasks.push({ t: performance.timeOrigin + entry.startTime, ms: entry.duration });
      }).observe({ type: 'longtask', buffered: false });
    } catch { /* longtask unsupported */ }
    const tick = () => {
      window.__lat.frames.push(clock());
      if (window.__lat.frames.length > 20_000) window.__lat.frames.splice(0, 10_000);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.addEventListener('keydown', (event) => { window.__lat.keys.push({ key: event.key.length === 1 ? 'char' : event.key, t: clock() }); }, true);
    window.electronAPI.events.onTerminalOutput((event) => {
      const t = clock();
      const text = String(event.output ?? event.data ?? '');
      const lat = window.__lat;
      lat.allOutputs += 1;
      lat.allOutputBytes += text.length;
      if (lat.marker && !lat.markerPanel && text.includes(lat.marker)) lat.markerPanel = event.panelId;
      if (!lat.panel || event.panelId !== lat.panel) return;
      const counter = (name) => {
        const all = [...text.matchAll(new RegExp(`${name}=(\\d+)`, 'g'))];
        return all.length ? Number(all[all.length - 1][1]) : null;
      };
      const entry = { t, n: text.length, top: counter('TOP'), k: counter('K'), w: counter('W'), r: counter('R'), paint: null };
      lat.out.push(entry);
      requestAnimationFrame(() => { entry.paint = clock(); });
    });
  });
}

async function dismissFirstRun() {
  for (let round = 0; round < 6; round++) {
    await page.waitForTimeout(800);
    const skipButton = page.getByRole('button', { name: 'Skip', exact: true });
    if (await skipButton.isVisible().catch(() => false)) { await skipButton.click(); continue; }
    const update = page.getByRole('dialog', { name: 'Software Update' });
    if (await update.isVisible().catch(() => false)) { await update.getByRole('button', { name: 'Close', exact: true }).click(); continue; }
    const welcome = page.getByRole('dialog', { name: 'Welcome to Pane' });
    if (await welcome.isVisible().catch(() => false)) { await welcome.getByRole('button', { name: 'Close modal' }).click(); continue; }
    return;
  }
}

const visibleTerminal = () => page.locator('.xterm:visible').last();
// Dialogs that can open at any time (the update check) and block clicks.
async function closeStrayDialogs() {
  const update = page.getByRole('dialog', { name: 'Software Update' });
  if (await update.isVisible().catch(() => false)) {
    await update.getByRole('button', { name: 'Close', exact: true }).click().catch(() => undefined);
    await page.waitForTimeout(300);
  }
}
// A sidebar Pane row: its full-size overlay button is labelled with the Pane's name. (While a modal such as
// the update dialog is open, the page behind it is aria-hidden and has no such buttons: close it first.)
const paneRow = (name) => page.getByRole('button', { name, exact: true }).first();
const outputs = () => page.evaluate(() => window.__lat.out.map((e) => ({ ...e })));
async function waitForOutput(predicate, timeoutMs, since = 0) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = (await outputs()).find((e) => e.t >= since && predicate(e));
    if (found) return found;
    if (Date.now() > deadline) return null;
    await page.waitForTimeout(50);
  }
}
async function shellCommand(command) {
  await page.keyboard.insertText(command);
  await page.keyboard.press('Enter');
}

async function connectHost() {
  const switcherChip = page.getByRole('button', { name: /Switch host$/ }).first();
  // Builds without the host switcher (stock Pane) connect to the saved active host at launch.
  if (!await switcherChip.waitFor({ timeout: 20_000 }).then(() => true, () => false)) {
    await page.getByRole('button', { name: `New pane in ${repo}` }).waitFor({ timeout: 60_000 });
    return;
  }
  const connectedChip = page.getByRole('button', { name: `Agents run on ${hostLabel}. Switch host` });
  if (!await connectedChip.isVisible().catch(() => false)) {
    await switcherChip.click();
    await page.getByRole('menuitemradio', { name: new RegExp(escapeRegExp(hostLabel)) }).click();
  }
  await connectedChip.waitFor({ timeout: 60_000 });
  await page.getByRole('button', { name: `New pane in ${repo}` }).waitFor({ timeout: 60_000 });
}

async function openPane() {
  const existing = paneRow(paneName);
  if (await existing.waitFor({ timeout: 5000 }).then(() => true, () => false)) {
    await closeStrayDialogs();
    await existing.click();
  } else {
    await page.getByRole('button', { name: `New pane in ${repo}` }).click();
    const dialog = page.getByRole('dialog', { name: `New Pane in ${repo}` });
    await dialog.getByRole('textbox', { name: 'Enter a name for your pane' }).fill(paneName);
    await dialog.getByRole('button', { name: /^Create/ }).click();
  }
  // Panels load asynchronously: wait for a visible terminal; create one only if the empty stage stays empty.
  const addTerminal = page.getByRole('button', { name: /^Terminal\s*Ctrl\+Alt\+1/ });
  const t0 = Date.now();
  let emptySince = 0;
  for (;;) {
    if (await visibleTerminal().isVisible().catch(() => false)) break;
    const empty = await addTerminal.isVisible().catch(() => false);
    emptySince = empty ? (emptySince || Date.now()) : 0;
    if (empty && Date.now() - emptySince >= 8000) { await addTerminal.click({ timeout: 30_000 }); break; }
    if (Date.now() - t0 > 90_000) throw new Error('pane panels never loaded');
    await page.waitForTimeout(500);
  }
  await visibleTerminal().waitFor({ timeout: 90_000 });
  await page.waitForTimeout(1500);
}

// Finds the visible terminal's panel id by echoing a marker, then starts the TUI in it.
async function startTui() {
  const terminal = visibleTerminal();
  await terminal.click();
  // A TUI left running by an interrupted run would swallow the commands below.
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(500);
  const marker = `RCLMARK${Math.floor(Math.random() * 1e6)}`;
  await page.evaluate((m) => { window.__lat.marker = m; window.__lat.markerPanel = null; }, marker);
  await shellCommand(`printf '%s\\n' ${marker}`);
  const deadline = Date.now() + 30_000;
  let panel = null;
  while (!panel && Date.now() < deadline) {
    panel = await page.evaluate(() => window.__lat.markerPanel);
    if (!panel) await page.waitForTimeout(100);
  }
  if (!panel) throw new Error('could not identify the terminal panel (marker never echoed)');
  await page.evaluate((p) => { window.__lat.panel = p; window.__lat.out = []; }, panel);
  const encoded = tuiSource.toString('base64');
  await shellCommand(`printf '%s' '${encoded}' | base64 -d > ~/.rcl-latency-tui.py && ${python} ~/.rcl-latency-tui.py 3000`);
  const ready = await waitForOutput((e) => e.top !== null, 30_000);
  if (!ready) throw new Error(`the TUI did not start (is ${python} on the host?)`);
  await page.waitForTimeout(800);
  return panel;
}
const lastCounter = async (name) => {
  const all = (await outputs()).filter((e) => e[name] !== null);
  return all.length ? all[all.length - 1][name] : null;
};

// Each key's echo = the first output whose K counter reaches that key's count.
async function typeAndMeasure(count, gapMs, { idleMs = 0, moveMouse = false } = {}) {
  const box = await visibleTerminal().boundingBox();
  const baseK = (await lastCounter('k')) ?? 0;
  const letters = 'qzxjkvwy';
  const pressed = [];
  let moving = moveMouse;
  const mover = (async () => {
    let i = 0;
    while (moving) {
      const x = box.x + box.width * (0.3 + 0.4 * ((i % 40) / 40));
      const y = box.y + box.height * (0.3 + 0.3 * (((i * 7) % 40) / 40));
      await page.mouse.move(x, y).catch(() => undefined);
      await page.waitForTimeout(16);
      i += 1;
    }
  })();
  const t0 = now();
  for (let i = 0; i < count; i++) {
    if (idleMs) await page.waitForTimeout(idleMs);
    pressed.push(now());
    await page.keyboard.press(letters[i % letters.length]);
    if (gapMs) await page.waitForTimeout(gapMs);
  }
  await waitForOutput((e) => e.k !== null && e.k >= baseK + count, 10_000);
  moving = false;
  await mover;
  const outs = await outputs();
  const arrival = []; const painted = [];
  for (let i = 0; i < count; i++) {
    const echo = outs.find((e) => e.t >= pressed[i] && e.k !== null && e.k >= baseK + i + 1);
    arrival.push(echo ? echo.t - pressed[i] : NaN);
    painted.push(echo?.paint ? echo.paint - pressed[i] : NaN);
  }
  await page.keyboard.press('Control+u');
  await page.waitForTimeout(300);
  return { echoArrivalMs: stats(arrival), echoPaintedMs: stats(painted), lost: arrival.filter((v) => !Number.isFinite(v)).length, requests: summarizeRequests(await requestsSince(t0)) };
}

// One wheel gesture: `notches` notches 16 ms apart over the terminal, then wait for the screen to settle.
async function scrollGesture(notches, direction) {
  const box = await visibleTerminal().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(400);
  const startTop = await lastCounter('top');
  const startW = await lastCounter('w');
  const t0 = now();
  for (let i = 0; i < notches; i++) {
    await page.mouse.wheel(0, direction * 100);
    await page.waitForTimeout(16);
  }
  const tLast = now();
  // Settled = no new frame for 1 s.
  let lastSeen = tLast;
  for (;;) {
    await page.waitForTimeout(100);
    const latest = (await outputs()).filter((e) => e.t > t0).at(-1);
    if (latest) lastSeen = Math.max(lastSeen, latest.t);
    if (now() - lastSeen > 1000 || now() - tLast > 15_000) break;
  }
  const frames = (await outputs()).filter((e) => e.t > t0 && e.top !== null);
  const moved = frames.length ? Math.abs(frames.at(-1).top - startTop) : 0;
  const firstChange = frames.find((e) => e.top !== startTop);
  const lastChange = [...frames].reverse().find((e, i, arr) => i === arr.length - 1 || e.top !== arr[i + 1].top) ?? frames.at(-1);
  const gestureMs = tLast - t0;
  const finalTop = frames.at(-1)?.top ?? startTop;
  const settleAt = frames.filter((e) => e.top === finalTop)[0]?.t ?? tLast;
  return {
    notches,
    wheelReportsReceived: (frames.at(-1)?.w ?? startW) - startW,
    linesMoved: moved,
    firstFrameMs: firstChange ? firstChange.t - t0 : null,
    settledAfterLastNotchMs: Math.max(0, settleAt - tLast),
    gestureMs: Math.round(gestureMs),
    framesDuringGesture: frames.filter((e) => e.t <= tLast).length,
    frames: frames.length,
    lastChangeMs: lastChange ? Math.round(lastChange.t - t0) : null,
    requests: summarizeRequests(await requestsSince(t0)),
  };
}

// Click -> painted: the later of "a terminal is visible" and "the last activation mask is gone", watched
// for 3.5 s per switch so a mask that appears a few frames late (React commit, remote loads) still counts.
async function measureActivation(click) {
  const t0 = now();
  await click();
  const seen = await page.evaluate(async (windowMs) => {
    const clock = () => performance.timeOrigin + performance.now();
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const start = clock();
    let lastMask = null; let firstVisible = null; let maskFrames = 0;
    while (clock() - start < windowMs) {
      await frame();
      const t = clock();
      const masked = [...document.querySelectorAll('[data-testid="terminal-activation-mask"]')].some((el) => el.offsetParent !== null);
      if (masked) { lastMask = t; maskFrames += 1; continue; }
      if (firstVisible === null && [...document.querySelectorAll('.xterm')].some((el) => el.offsetParent !== null)) firstVisible = t;
    }
    return { lastMask, firstVisible, maskFrames };
  }, ACTIVATION_WINDOW_MS);
  const done = Math.max(seen.firstVisible ?? Infinity, seen.lastMask ?? 0);
  const requests = summarizeRequests(await requestsSince(t0, t0 + ACTIVATION_WINDOW_MS));
  return { ms: Number.isFinite(done) ? done - t0 : null, masked: seen.maskFrames > 0, invokes: requests.invokes, newConnections: requests.newConnections, responseBytes: requests.responseBytes, byChannel: requests.byChannel };
}
const summarizeSwitches = (samples) => ({
  switchMs: stats(samples.map((s) => s.ms)),
  maskedSwitchMs: stats(samples.filter((s) => s.masked).map((s) => s.ms)),
  afterIdleMs: samples.find((s) => s.afterIdle)?.ms ?? null,
  invokesPerSwitch: stats(samples.map((s) => s.invokes)),
  bytesPerSwitch: stats(samples.map((s) => s.responseBytes)),
  samples,
});

// Within the Pane: the TUI's tab <-> a plain shell tab (created once, reused by later runs).
async function tabSwitches(count) {
  const tabs = page.getByRole('tablist', { name: 'Panel tabs' }).first().getByRole('tab');
  if (await tabs.count() < 2) {
    await page.getByRole('button', { name: 'Add tool' }).first().click();
    await page.getByRole('menuitem', { name: /^Terminal/ }).first().click();
    await page.waitForTimeout(4000);
  }
  const names = await tabs.evaluateAll((nodes) => nodes.map((n) => n.getAttribute('aria-label')));
  const samples = [];
  for (let i = 0; i < count; i++) {
    await page.waitForTimeout(i === 4 ? 6000 : 1000);
    const sample = await measureActivation(() => page.getByRole('tab', { name: names[(i + 1) % 2], exact: true }).first().click());
    samples.push({ ...sample, afterIdle: i === 4 });
  }
  await page.getByRole('tab', { name: names[0], exact: true }).first().click();
  return summarizeSwitches(samples);
}

// Between two Panes (terminals unmount and remount: the full activation path). The second Pane runs the TUI too.
async function paneSwitches(count) {
  const other = `${paneName}-b`;
  const otherButton = paneRow(other);
  if (!await otherButton.waitFor({ timeout: 3000 }).then(() => true, () => false)) {
    await page.getByRole('button', { name: `New pane in ${repo}` }).click();
    const dialog = page.getByRole('dialog', { name: `New Pane in ${repo}` });
    await dialog.getByRole('textbox', { name: 'Enter a name for your pane' }).fill(other);
    await dialog.getByRole('button', { name: /^Create/ }).click();
  } else {
    await closeStrayDialogs();
    await otherButton.click();
  }
  const addTerminal = page.getByRole('button', { name: /^Terminal\s*Ctrl\+Alt\+1/ });
  // The first Pane's terminal stays on screen until the switch renders: let it go before looking.
  await page.waitForTimeout(4000);
  log('panes: second Pane open; waiting for a terminal');
  const deadline = Date.now() + 60_000;
  while (!await visibleTerminal().isVisible().catch(() => false) && Date.now() < deadline) {
    if (await addTerminal.isVisible().catch(() => false)) {
      await page.waitForTimeout(3000);
      if (!await visibleTerminal().isVisible().catch(() => false)) {
        log('panes: empty stage; opening a terminal');
        await addTerminal.click();
      }
    }
    await page.waitForTimeout(500);
  }
  log('panes: starting the TUI in the second Pane');
  await visibleTerminal().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await visibleTerminal().click();
  await shellCommand(`${python} ~/.rcl-latency-tui.py 3000`);
  log('panes: switching');
  await page.waitForTimeout(2000);
  const samples = [];
  for (let i = 0; i < count; i++) {
    await page.waitForTimeout(i === 4 ? 6000 : 1000);
    const target = paneRow(i % 2 === 0 ? paneName : other);
    await closeStrayDialogs();
    const sample = await measureActivation(() => target.click());
    samples.push({ ...sample, afterIdle: i === 4 });
  }
  return summarizeSwitches(samples);
}

// Renderer health over a window: long tasks and frame gaps (a 60 Hz display draws every 16.7 ms).
async function rendererHealth(t0, t1) {
  return page.evaluate(([from, to]) => {
    const lat = window.__lat;
    const tasks = lat.longTasks.filter((task) => task.t >= from && task.t <= to);
    const frames = lat.frames.filter((t) => t >= from && t <= to);
    const gaps = frames.slice(1).map((t, i) => t - frames[i]).sort((a, b) => a - b);
    const q = (p) => (gaps.length ? Math.round(gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))] * 10) / 10 : null);
    return {
      longTasks: tasks.length,
      longTaskMs: Math.round(tasks.reduce((sum, task) => sum + task.ms, 0)),
      fps: frames.length > 1 ? Math.round((frames.length - 1) / ((frames.at(-1) - frames[0]) / 1000)) : null,
      frameGapP95Ms: q(0.95),
      frameGapMaxMs: gaps.length ? Math.round(gaps.at(-1)) : null,
    };
  }, [t0, t1]);
}
const outputRate = async (fn) => {
  const before = await page.evaluate(() => [window.__lat.allOutputs, window.__lat.allOutputBytes, performance.timeOrigin + performance.now()]);
  const value = await fn();
  const after = await page.evaluate(() => [window.__lat.allOutputs, window.__lat.allOutputBytes, performance.timeOrigin + performance.now()]);
  const secs = (after[2] - before[2]) / 1000;
  return { value, outputEventsPerSec: Math.round((after[0] - before[0]) / secs), outputKBps: Math.round((after[1] - before[1]) / 1024 / secs), t0: before[2], t1: after[2] };
};

async function probeClaudeWheelProfile() {
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(800);
  await visibleTerminal().click();
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(500);
  const marker = `RCLDBG${Math.floor(Math.random() * 1e6)}`;
  await shellCommand(`clear; claude --debug --debug-file ~/.rcl-claude-${marker}.txt`);
  await page.waitForTimeout(9000);
  const box = await visibleTerminal().boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, -100); await page.waitForTimeout(100); }
  await page.waitForTimeout(1000);
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(400);
  await page.keyboard.press('Control+c');
  await page.waitForTimeout(2500);
  await page.evaluate((m) => { window.__lat.marker = m; window.__lat.markerPanel = null; }, `${marker}END`);
  await page.evaluate(() => { window.__lat.capture = ''; });
  await page.evaluate(() => {
    window.electronAPI.events.onTerminalOutput((event) => {
      if (event.panelId === window.__lat.panel && window.__lat.capture !== undefined) window.__lat.capture += String(event.output ?? '');
    });
  });
  await shellCommand(`grep -ahoE 'wheel accel: [^\\r]{0,120}' ~/.rcl-claude-${marker}.txt | head -1; echo ${marker}END`);
  await page.waitForTimeout(2500);
  const captured = await page.evaluate(() => window.__lat.capture ?? '');
  const plain = captured.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g'), '');
  const line = /wheel accel: [^\r\n]{0,120}/.exec(plain.slice(plain.indexOf('head -1')))?.[0] ?? null;
  return { wheelProfile: line };
}

const phase = async (name, fn) => {
  if (skip.has(name)) { result.phases[name] = { skipped: true }; return; }
  log(`phase ${name}`);
  try {
    await closeStrayDialogs();
    const measured = await outputRate(fn);
    result.phases[name] = { ...measured.value, renderer: await rendererHealth(measured.t0, measured.t1), allTerminalOutput: { eventsPerSec: measured.outputEventsPerSec, kBps: measured.outputKBps } };
    log(`phase ${name} done`, JSON.stringify(result.phases[name]).slice(0, 400));
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    result.errors.push(`${name}: ${message}`);
    log(`phase ${name} FAILED: ${message}`);
    await page.screenshot({ path: path.join(out, `error-${name}.png`) }).catch(() => undefined);
  }
};

try {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(4000);
  await dismissFirstRun();
  await instrumentMain();
  await instrumentRenderer();
  await connectHost();
  await openPane();
  await startTui();
  await phase('echo', () => typeAndMeasure(KEYS, 110));
  await phase('idle', () => typeAndMeasure(IDLE_KEYS, 0, { idleMs: 6000 }));
  await phase('motion', () => typeAndMeasure(Math.min(KEYS, 30), 110, { moveMouse: true }));
  await phase('scroll', async () => {
    const rounds = [];
    for (let i = 0; i < SCROLL_ROUNDS; i++) rounds.push(await scrollGesture(30, i % 2 === 0 ? -1 : 1));
    return {
      rounds,
      completeness: stats(rounds.map((r) => r.linesMoved / (3 * r.notches))),
      firstFrameMs: stats(rounds.map((r) => r.firstFrameMs)),
      settledAfterLastNotchMs: stats(rounds.map((r) => r.settledAfterLastNotchMs)),
      framesDuringGesture: stats(rounds.map((r) => r.framesDuringGesture)),
    };
  });
  if (claudeProbe) await phase('claude', () => probeClaudeWheelProfile());
  await phase('tabs', () => tabSwitches(SWITCHES));
  await phase('panes', () => paneSwitches(SWITCHES));
  if (env.SHOTS === '1') await page.screenshot({ path: path.join(out, 'final.png') });
  // Stop the TUIs (Pane A's first terminal tab, Pane B's terminal) so the shells are free for the next run.
  for (const name of [paneName, `${paneName}-b`]) {
    const button = paneRow(name);
    if (!await button.isVisible().catch(() => false)) continue;
    await button.click();
    await page.waitForTimeout(1500);
    await page.getByRole('tablist', { name: 'Panel tabs' }).first().getByRole('tab').first().click().catch(() => undefined);
    await page.waitForTimeout(800);
    await visibleTerminal().click().catch(() => undefined);
    await page.keyboard.press('Control+c');
    await page.waitForTimeout(500);
  }
} catch (error) {
  result.errors.push(error instanceof Error ? error.message.split('\n')[0] : String(error));
  log('FAILED', result.errors.at(-1));
  await page.screenshot({ path: path.join(out, 'error.png') }).catch(() => undefined);
  // Requests still unanswered (channel names only): what the UI is waiting on.
  result.pendingRequests = await app.evaluate(() => (globalThis.__latReq ?? [])
    .filter((r) => r.path.endsWith('/invoke') && r.ms === null)
    .map((r) => ({ channel: r.channel, ageMs: Math.round(performance.timeOrigin + performance.now() - r.t0), status: r.status ?? null, encoding: r.encoding ?? null })))
    .catch(() => []);
} finally {
  result.seconds = Math.round((Date.now() - started) / 1000);
  result.ok = result.errors.length === 0;
  fs.writeFileSync(path.join(out, 'latency.json'), `${JSON.stringify(result, null, 2)}\n`);
  log(result.ok ? 'RESULT PASS' : 'RESULT FAIL', path.join(out, 'latency.json'));
  await app.close().catch(() => undefined);
  process.exitCode = result.ok ? 0 : 1;
}
