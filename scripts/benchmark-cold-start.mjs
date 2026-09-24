// Times Pane's launch, from spawning Electron to the sidebar on screen, and
// splits the main process's share by the lines it logs on the way.
//
//   node scripts/benchmark-cold-start.mjs [rounds] [label=<main dist> ...]
//
// Run after `pnpm build:frontend && pnpm build:main`, with native modules built
// for Electron. Each label launches one build of main/dist (default: this
// checkout's). Rounds alternate between labels so machine load hits them alike,
// after one untimed warm-up launch each.
// Also reports the main thread's CPU time from the start of JS to Electron's
// `ready` and to index.html loaded, which machine load disturbs far less than
// wall time. Launches use an isolated Pane directory, profile and HOME under
// $PANE_BENCH_DIR (default ~/.pane_bench_cold_start.noindex) and CDP on $PORT
// (default 4160); nothing touches the real ~/.pane.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import readline from 'node:readline';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..');
const electronBinary = createRequire(path.join(root, 'main/package.json'))('electron');
const benchDir = process.env.PANE_BENCH_DIR ?? path.join(os.homedir(), '.pane_bench_cold_start.noindex');
const port = Number(process.env.PORT ?? 4160);
const rounds = Number(process.argv[2] ?? 20);
const specs = process.argv.slice(3).length ? process.argv.slice(3) : [`current=${path.join(root, 'main/dist')}`];

// Main-process lines, in the order index.ts logs them.
const LOG_MARKS = [
  ['main', /\[Polyfill\]/], // first import of index.js has run
  ['ready', /App is ready/], // every top-level require done, Electron ready
  ['services', /Services initialized/],
  ['window', /Window created successfully/], // index.html finished loading
];
// Loaded with --require in every process; only Electron's main process reports.
// `electron` cannot be required until the main script is running.
const PROBE = `if (process.type === 'browser') {
  const start = process.threadCpuUsage();
  const cpuMs = () => { const u = process.threadCpuUsage(start); return ((u.user + u.system) / 1000).toFixed(1); };
  setImmediate(() => {
    const { app } = require('electron');
    app.whenReady().then(() => console.log('[probe] readyCpu ' + cpuMs()));
    app.once('browser-window-created', (_event, win) => {
      win.webContents.once('did-finish-load', () => console.log('[probe] windowCpu ' + cpuMs()));
    });
  });
}
`;
const CPU_MARKS = ['readyCpu', 'windowCpu'];
const MARKS = [...LOG_MARKS.map(([name]) => name), 'sidebar', ...CPU_MARKS];

const home = path.join(benchDir, 'home');
const probe = path.join(benchDir, 'probe.cjs');
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(probe, PROBE);

// Electron resolves the app from a directory, so each build gets one that
// points at its main/dist and shares this checkout's frontend and package.json.
function makeVariant(spec) {
  const [label, dist] = spec.split('=');
  const appDir = path.join(benchDir, 'apps', label);
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(appDir, 'main'), { recursive: true });
  fs.symlinkSync(path.resolve(dist), path.join(appDir, 'main/dist'));
  fs.symlinkSync(path.join(root, 'frontend'), path.join(appDir, 'frontend'));
  fs.copyFileSync(path.join(root, 'package.json'), path.join(appDir, 'package.json'));
  return { label, appDir, userData: path.join(benchDir, 'profiles', label), times: [], failures: 0 };
}

async function sidebarShown(startedAt, deadline) {
  let page;
  while (!page) {
    if (performance.now() > deadline) throw new Error('no page target');
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = targets.find((t) => t.type === 'page' && t.url.startsWith('file:'));
    } catch { /* not listening yet */ }
    if (!page) await sleep(10);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const evaluate = (expression) => new Promise((resolve) => {
    const msgId = ++id;
    ws.addEventListener('message', function onMessage(event) {
      const msg = JSON.parse(event.data);
      if (msg.id !== msgId) return;
      ws.removeEventListener('message', onMessage);
      resolve(msg.result?.result?.value);
    });
    ws.send(JSON.stringify({ id: msgId, method: 'Runtime.evaluate', params: { expression } }));
  });
  try {
    while (!(await evaluate(`!!document.querySelector('[data-testid="sidebar"]')`))) {
      if (performance.now() > deadline) throw new Error('sidebar never appeared');
      await sleep(5);
    }
    return performance.now() - startedAt;
  } finally {
    ws.close();
  }
}

async function launch(variant) {
  const startedAt = performance.now();
  const child = spawn(electronBinary, [
    variant.appDir,
    `--pane-dir=${path.join(benchDir, 'pane')}`,
    `--user-data-dir=${variant.userData}`,
    `--remote-debugging-port=${port}`,
  ], { env: { ...process.env, NODE_ENV: 'production', HOME: home, NODE_OPTIONS: `--require ${probe}` }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const marks = {};
  const onLine = (line) => {
    const now = performance.now() - startedAt;
    for (const [name, pattern] of LOG_MARKS) {
      if (marks[name] === undefined && pattern.test(line)) marks[name] = now;
    }
    const probed = line.match(/\[probe\] (\w+) ([\d.]+)/);
    if (probed) marks[probed[1]] ??= Number(probed[2]);
  };
  readline.createInterface({ input: child.stdout }).on('line', onLine);
  readline.createInterface({ input: child.stderr }).on('line', onLine);
  try {
    marks.sidebar = await sidebarShown(startedAt, startedAt + 60_000);
    await sleep(1500); // let startup settle so quitting does not race it
  } finally {
    // Pane can linger after app.exit(0), and a killed main process orphans its
    // helpers, so the whole process group goes once the main process is gone.
    const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
    child.kill('SIGTERM');
    const timer = setTimeout(killGroup, 10_000);
    await exited;
    clearTimeout(timer);
    killGroup();
  }
  const missing = MARKS.filter((name) => marks[name] === undefined);
  if (missing.length) throw new Error(`${variant.label}: missing marks ${missing.join(', ')}`);
  return marks;
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const variants = specs.map(makeVariant);
for (const variant of variants) await launch(variant); // warm-up: OS file cache and first-run state
for (let round = 1; round <= rounds; round++) {
  for (const variant of variants) {
    try {
      const marks = await launch(variant);
      variant.times.push(marks);
      console.error(`round ${round} ${variant.label}: ${MARKS.map((m) => `${m} ${marks[m].toFixed(0)}`).join(' · ')}`);
    } catch (error) {
      variant.failures++;
      console.error(`round ${round} ${variant.label}: failed, ${error.message}`);
    }
  }
}

console.log(`\n${variants.map((v) => `${v.label} ${v.times.length} launches${v.failures ? ` (${v.failures} failed)` : ''}`).join(', ')}; ms (p50 / p75): wall time from spawn, then main-thread CPU, load avg ${os.loadavg().map((l) => l.toFixed(1)).join(' ')}`);
console.log(['mark', ...variants.map((v) => v.label)].join('\t'));
for (const mark of MARKS) {
  console.log([mark, ...variants.map((v) => {
    const values = v.times.map((t) => t[mark]);
    return `${percentile(values, 50).toFixed(0)} / ${percentile(values, 75).toFixed(0)}`;
  })].join('\t'));
}
