#!/usr/bin/env node
// Cold-start milestones for the built desktop app (`pnpm build:frontend && pnpm build:main`).
//
// Each run spawns Electron against an isolated PANE_DIR and reports ms from spawn:
//   ready, services, window   main-process log lines
//   navStart, fcp             renderer navigation start and first contentful paint
//   paneRow                   the --open-pane row is in the sidebar (window is usable)
//   terminal                  after clicking that row, its xterm has mounted
// Seed the PANE_DIR once (a repo plus a few panes). Pass --home <empty dir> to
// keep the usage scanner from indexing your real ~/.claude while measuring.
//
//   node scripts/benchmark-startup-milestones.mjs --pane-dir ~/.pane_test_cold \
//     --open-pane "my-repo/feature" [--runs 10] [--port 4171] [--home dir] [--json out.json]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    'pane-dir': { type: 'string' },
    'open-pane': { type: 'string' },
    runs: { type: 'string', default: '10' },
    port: { type: 'string', default: '4171' },
    json: { type: 'string' },
    home: { type: 'string' },
  },
});
if (!args['pane-dir'] || !args['open-pane']) throw new Error('--pane-dir and --open-pane are required');
const paneDir = path.resolve(args['pane-dir'].replace(/^~/, process.env.HOME));
const port = Number(args.port);
// Spawn the binary itself: the .bin wrapper does not forward SIGTERM.
const electronDir = path.join(root, 'node_modules/electron');
const electron = path.join(electronDir, 'dist', fs.readFileSync(path.join(electronDir, 'path.txt'), 'utf8').trim());

const MAIN_MARKS = {
  ready: '[Main] App is ready',
  services: '[Main] Services initialized',
  window: '[Main] Window created successfully',
};

// Epoch times, so they compare with the spawn clock.
const paneRowSelector = JSON.stringify(`[data-testid="sidebar"] button[aria-label=${JSON.stringify(args['open-pane'])}]`);
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findPage(deadline) {
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((t) => t.type === 'page' && t.url.startsWith('file:'));
      if (page) return page;
    } catch { /* not listening yet */ }
    await sleep(10);
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
    send(method, params = {}) {
      const msgId = ++id;
      ws.send(JSON.stringify({ id: msgId, method, params }));
      return new Promise((resolve) => pending.set(msgId, resolve));
    },
  };
}

async function runOnce() {
  fs.rmSync(path.join(paneDir, '.running'), { force: true });
  const env = { ...process.env, NODE_ENV: 'production', PANE_DIR: paneDir };
  if (args.home) env.HOME = args.home;
  const spawnedAt = Date.now();
  const child = spawn(electron, ['.', `--remote-debugging-port=${port}`], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const t = {};
  let output = '';
  child.stdout.on('data', (chunk) => {
    const at = Date.now() - spawnedAt;
    output += chunk;
    for (const [key, marker] of Object.entries(MAIN_MARKS)) {
      if (t[key] === undefined && output.includes(marker)) t[key] = at;
    }
  });
  child.stderr.resume();
  const exited = new Promise((resolve) => child.once('exit', resolve));

  try {
    const deadline = Date.now() + 90_000;
    const client = cdp((await findPage(deadline)).webSocketDebuggerUrl);
    await client.opened;
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
    client.close();
  } finally {
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    await exited;
    clearTimeout(killTimer);
  }
  return t;
}

const runs = [];
for (let i = 0; i < Number(args.runs); i += 1) {
  runs.push(await runOnce());
  console.error(`run ${i + 1}: ${JSON.stringify(runs.at(-1))}`);
  await sleep(1000);
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
console.log(`milestone   p50    p75   (ms from spawn, n=${runs.length})`);
for (const key of [...Object.keys(MAIN_MARKS), 'navStart', 'fcp', 'paneRow', 'terminal']) {
  const vals = runs.map((r) => r[key]).filter((v) => v !== undefined).sort((a, b) => a - b);
  if (vals.length) console.log(`${key.padEnd(10)} ${String(pct(vals, 0.5)).padStart(5)}  ${String(pct(vals, 0.75)).padStart(5)}`);
}
if (args.json) fs.writeFileSync(args.json, JSON.stringify(runs, null, 2));
