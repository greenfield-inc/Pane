#!/usr/bin/env node
// Cold-start milestones for the built desktop app (`pnpm build:frontend && pnpm build:main`).
//
// Each run spawns Electron against an isolated PANE_DIR and reports ms from spawn:
//   mainLoaded                main's first script has run (its module graph is loaded)
//   ready, window             Electron ready, and the main window created
//   firstPaint, shown         the window's first painted frame (ready-to-show), and when it showed
//   navStart, fcp             renderer navigation start and first contentful paint
//   paneRow                   the --open-pane row is in the sidebar (window is usable)
//   terminal                  after clicking that row, its xterm has mounted
//   syncSpawnMs               main thread blocked in execSync/execFileSync/spawnSync
//                             before the terminal mounted (--sync-spawns lists each call)
// With --chat (launch reopens a chat, as ADEMark's A1 times it) instead of --open-pane:
//   composer                  a focused message box is on screen (the launch outline's or the chat's)
//   typed                     two probe letters typed into it at 50 ms intervals are in it, two frames later
//   chatBox                   the chat tab's own message box has mounted
// The window shows without taking focus (showInactive), so runs never steal the keyboard.
// Seed the PANE_DIR once (a repo plus a few panes; for --chat, quit with a chat tab in front).
// Pass --home <dir> to keep the usage scanner from indexing your real ~/.claude while measuring.
// Pass --app label=dir (repeatable) to compare builds; runs alternate between them. --fresh
// runs each from a new APFS copy of the app (macOS), so its files are not in the OS cache.
// --relaunch keeps Chromium's caches between runs (by default each run clears them).
//
//   node scripts/benchmark-startup-milestones.mjs --pane-dir ~/.pane_test_cold \
//     (--open-pane "my-repo/feature" | --chat) [--runs 10] [--port 4171] [--home dir] [--json out.json]
//     [--app base=../base-checkout --app change=.] [--fresh | --relaunch]
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    'pane-dir': { type: 'string' },
    'open-pane': { type: 'string' },
    chat: { type: 'boolean', default: false },
    runs: { type: 'string', default: '10' },
    port: { type: 'string', default: '4171' },
    json: { type: 'string' },
    home: { type: 'string' },
    app: { type: 'string', multiple: true },
    fresh: { type: 'boolean', default: false },
    relaunch: { type: 'boolean', default: false },
    'sync-spawns': { type: 'boolean', default: false },
  },
});
if (!args['pane-dir'] || (!args['open-pane'] && !args.chat)) throw new Error('--pane-dir and one of --open-pane or --chat are required');
const paneDir = path.resolve(args['pane-dir'].replace(/^~/, process.env.HOME));
const port = Number(args.port);
const apps = (args.app ?? [`this=${root}`]).map((value) => {
  const [label, dir] = value.split('=');
  return { label, dir: path.resolve(dir) };
});
// Spawn the binary itself: the .bin wrapper does not forward SIGTERM.
const electronOf = (appDir) => {
  const electronDir = path.join(appDir, 'node_modules/electron');
  return path.join(electronDir, 'dist', fs.readFileSync(path.join(electronDir, 'path.txt'), 'utf8').trim());
};

// Preloaded into the main process: time every synchronous child process call, mark the
// window's first paint and show, and show it without taking focus.
const probe = path.join(paneDir, 'bench-startup-probe.cjs');
fs.writeFileSync(probe, `
delete process.env.NODE_OPTIONS; // keep it out of the app's own child processes
const mark = (name) => process.stdout.write('[bench-mark] ' + name + ' ' + Date.now() + '\\n');
const cp = require('child_process');
for (const name of ['execSync', 'execFileSync', 'spawnSync']) {
  const original = cp[name];
  cp[name] = function (...args) {
    const start = performance.now();
    try { return original.apply(this, args); } finally {
      const ms = (performance.now() - start).toFixed(1);
      process.stdout.write('[bench-sync-spawn] ' + ms + ' ' + JSON.stringify(String(args[0]).slice(0, 80) + ' ' + (Array.isArray(args[1]) ? args[1].join(' ').slice(0, 60) : '')) + '\\n');
    }
  };
}
setImmediate(() => {
  mark('mainLoaded');
  const { app, BrowserWindow } = require('electron');
  if (app.isReady()) mark('ready'); else app.once('ready', () => mark('ready'));
  const showInactive = BrowserWindow.prototype.showInactive;
  let shown = false;
  BrowserWindow.prototype.showInactive = function () { if (!shown) { shown = true; mark('shown'); } return showInactive.call(this); };
  BrowserWindow.prototype.show = function () { return this.showInactive(); };
  BrowserWindow.prototype.maximize = function () { return this.showInactive(); };
  BrowserWindow.prototype.focus = function () {};
  app.focus = () => {};
  app.once('browser-window-created', (_event, win) => {
    mark('window');
    win.once('ready-to-show', () => mark('firstPaint'));
  });
});
`);

// Epoch times, so they compare with the spawn clock.
const paneRowSelector = JSON.stringify(`[data-testid="sidebar"] button[aria-label=${JSON.stringify(args['open-pane'] ?? '')}]`);
const PROBE = `(() => {
  const fcp = performance.getEntriesByName('first-contentful-paint')[0];
  const row = document.querySelector(${paneRowSelector});
  if (row && !window.__benchClicked) { window.__benchClicked = true; row.click(); }
  return {
    now: performance.timeOrigin + performance.now(),
    navStart: performance.timeOrigin,
    fcp: fcp ? performance.timeOrigin + fcp.startTime : null,
    paneRow: !!row,
    terminal: !!document.querySelector('.xterm-helper-textarea'),
  };
})()`;
// A1's probe: a message box with focus, and whether it holds the letters typed so far.
const PROBE_LETTERS = 'ademarkqz';
const CHAT_PROBE = `(() => {
  const fcp = performance.getEntriesByName('first-contentful-paint')[0];
  const box = document.activeElement?.matches?.('textarea[data-launch-composer], textarea[data-chat-composer]') ? document.activeElement : null;
  return {
    now: performance.timeOrigin + performance.now(),
    navStart: performance.timeOrigin,
    fcp: fcp ? performance.timeOrigin + fcp.startTime : null,
    composer: !!box,
    value: box?.value ?? '',
    chatBox: !!document.querySelector('textarea[data-chat-composer]'),
  };
})()`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findPage(deadline) {
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((t) => t.type === 'page' && t.url.startsWith('file:'));
      if (page) return page;
    } catch { /* not listening yet */ }
    await sleep(5);
  }
  throw new Error('renderer page never appeared');
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  };
  const opened = new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  return {
    opened,
    close: () => ws.close(),
    // A renderer or browser thread that stops answering ends the run instead of hanging it.
    send(method, params = {}) {
      const msgId = ++id;
      ws.send(JSON.stringify({ id: msgId, method, params }));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${method} got no answer in 30 s`)), 30_000);
        pending.set(msgId, (message) => { clearTimeout(timer); resolve(message); });
      });
    },
  };
}

/** A1: type a probe letter every 50 ms (±20 %) while a message box has focus, until two are in it. */
async function measureChat(client, spawnedAt, deadline, t) {
  let typed = 0;
  while (Date.now() < deadline && t.typed === undefined) {
    const probe = (await client.send('Runtime.evaluate', { expression: CHAT_PROBE, returnByValue: true })).result?.result?.value;
    if (probe) {
      const rel = (epoch) => Math.round(epoch - spawnedAt);
      t.navStart ??= rel(probe.navStart);
      if (probe.fcp !== null) t.fcp ??= rel(probe.fcp);
      if (probe.chatBox) t.chatBox ??= rel(probe.now);
      if (probe.composer) t.composer ??= rel(probe.now);
      const landed = [...PROBE_LETTERS.slice(0, typed)].filter((letter) => probe.value.includes(letter)).length;
      if (landed >= 2) {
        await client.send('Runtime.evaluate', { expression: 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))', awaitPromise: true });
        t.typed = Date.now() - spawnedAt;
        // Leave the box empty, so the next launch starts from the same draft.
        await client.send('Runtime.evaluate', { expression: `(() => { const box = document.querySelector('textarea[data-chat-composer]'); if (!box) return; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ''); box.dispatchEvent(new Event('input', { bubbles: true })); })()` });
        break;
      }
      if (probe.composer && typed < PROBE_LETTERS.length) await client.send('Input.insertText', { text: PROBE_LETTERS[typed++] });
    }
    await sleep(50 * (0.8 + 0.4 * Math.random()));
  }
}

async function measureTerminal(client, spawnedAt, deadline, t) {
  while (Date.now() < deadline && t.terminal === undefined) {
    const probe = (await client.send('Runtime.evaluate', { expression: PROBE, returnByValue: true })).result?.result?.value;
    if (probe) {
      const rel = (epoch) => Math.round(epoch - spawnedAt);
      t.navStart ??= rel(probe.navStart);
      if (probe.fcp !== null) t.fcp ??= rel(probe.fcp);
      if (probe.paneRow) t.paneRow ??= rel(probe.now);
      if (probe.terminal) t.terminal ??= rel(probe.now);
    }
    await sleep(8);
  }
}

/** A new APFS copy of the parts of the app Electron reads, so none of its files are in the OS cache. */
function freshCopy(appDir) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-bench-fresh-'));
  for (const part of ['package.json', 'node_modules', 'frontend', 'main', 'shared', 'packages']) {
    if (fs.existsSync(path.join(appDir, part))) execFileSync('cp', ['-c', '-R', path.join(appDir, part), copy]);
  }
  return copy;
}

async function runOnce(appDir) {
  fs.rmSync(path.join(paneDir, '.running'), { force: true });
  // Chromium's own caches go too, so every run compiles and loads the renderer from scratch;
  // --relaunch keeps them, as a launch right after quitting finds them.
  if (!args.relaunch) {
    for (const cache of ['Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Cache']) {
      fs.rmSync(path.join(paneDir, 'chromium-user-data', cache), { recursive: true, force: true });
    }
  }
  const runDir = args.fresh ? freshCopy(appDir) : appDir;
  const env = { ...process.env, NODE_ENV: 'production', PANE_DIR: paneDir, NODE_OPTIONS: `--require ${probe}` };
  if (args.home) env.HOME = args.home;
  // A log file, not a pipe: Pane writing to a pipe that closed hangs on quit, and the next launch then offers to resume.
  const logPath = path.join(paneDir, 'bench-startup.log');
  const log = fs.openSync(logPath, 'w');
  const spawnedAt = Date.now();
  const child = spawn(electronOf(runDir), [`--remote-debugging-port=${port}`, '.', `--user-data-dir=${path.join(paneDir, 'chromium-user-data')}`], { cwd: runDir, env, stdio: ['ignore', log, log], detached: true });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const t = {};
  try {
    const deadline = Date.now() + 90_000;
    const client = cdp((await findPage(deadline)).webSocketDebuggerUrl);
    await client.opened;
    await (args.chat ? measureChat : measureTerminal)(client, spawnedAt, deadline, t);
    client.close();
  } finally {
    const output = fs.readFileSync(logPath, 'utf8');
    for (const [, name, epoch] of output.matchAll(/^\[bench-mark\] (\w+) (\d+)$/gm)) t[name] ??= Number(epoch) - spawnedAt;
    const syncSpawns = [...output.matchAll(/^\[bench-sync-spawn\] ([\d.]+) (.*)$/gm)].map(([, ms, command]) => [Number(ms), JSON.parse(command)]);
    t.syncSpawnMs = Math.round(syncSpawns.reduce((sum, [ms]) => sum + ms, 0));
    if (args['sync-spawns']) for (const [ms, command] of syncSpawns) console.error(`  ${String(ms).padStart(7)} ms  ${command}`);
    process.kill(-child.pid, 'SIGTERM');
    const killTimer = setTimeout(() => process.kill(-child.pid, 'SIGKILL'), 15_000);
    await exited;
    clearTimeout(killTimer);
    fs.closeSync(log);
    if (runDir !== appDir) fs.rmSync(runDir, { recursive: true, force: true });
  }
  return t;
}

const runs = [];
for (let i = 0; i < Number(args.runs); i += 1) {
  for (const app of apps) {
    const t = await runOnce(app.dir);
    runs.push({ app: app.label, load1: Number(os.loadavg()[0].toFixed(2)), ...t });
    console.error(`run ${i + 1} ${app.label}: ${JSON.stringify(runs.at(-1))}`);
    await sleep(1000);
  }
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const keys = ['mainLoaded', 'ready', 'window', 'firstPaint', 'shown', 'navStart', 'fcp', ...(args.chat ? ['composer', 'typed', 'chatBox'] : ['paneRow', 'terminal']), 'syncSpawnMs'];
for (const app of apps) {
  console.log(`${app.label}: milestone   p50    p75   (ms from spawn, n=${runs.filter((r) => r.app === app.label).length})`);
  for (const key of keys) {
    const vals = runs.filter((r) => r.app === app.label).map((r) => r[key]).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (vals.length) console.log(`  ${key.padEnd(11)} ${String(pct(vals, 0.5)).padStart(5)}  ${String(pct(vals, 0.75)).padStart(5)}`);
  }
}
if (args.json) fs.writeFileSync(args.json, JSON.stringify(runs, null, 2));
