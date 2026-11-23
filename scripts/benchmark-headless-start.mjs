// Times the headless daemon (`pane --daemon-headless`), from spawning Electron to its control
// socket answering, and from a plain terminal request to that terminal's first prompt.
//
//   node scripts/benchmark-headless-start.mjs [rounds] [label=<main dist> ...]
//
// Run after `pnpm build:main`, with native modules built for Electron. Each label launches one
// build of main/dist (default: this checkout's) the way the packaged app does: Electron loads
// package.json's `main` and is passed --daemon-headless. Each round starts every label twice:
//   cold  a new Pane directory (first start: migrations from nothing, skills copied, Pane Chat made)
//   warm  the same directory again, with a Pane from the cold start, as a VM image would hold it
// With PANE_BENCH_BURST=<n>, each round instead starts n cold daemons at once (no warm start).
// In each, a client connects as soon as the socket accepts and at once opens a plain terminal
// (panels:create, terminal:setVisibility, panels:initialize) in that Pane: `prompt` is the time from that request
// to the shell's prompt in the panel's output. The shell is the test HOME's bash or zsh with a
// one-line rc, so it measures Pane, not the person's dotfiles.
// Marks, in ms from spawn: main (first JS line), dir (headless entry started), logger (bootstrap
// started), listen (socket listening, logged), connect (a client connected), answer (the socket
// answered `runpane:doctor`), ready (host ready, logged), prompt (from the terminal request),
// db (how long opening and migrating sessions.db took, logged).
// Everything lives under $PANE_BENCH_DIR (default ~/.pane_bench_headless.noindex); nothing
// touches the real ~/.pane. Set PANE_BENCH_KEEP_LOGS=1 to keep each launch's output, and
// PANE_BENCH_BEFORE_COLD to a shell command run before each cold start (as root on Linux,
// `sync; echo 3 > /proc/sys/vm/drop_caches` makes it cold for the disk cache too).
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import readline from 'node:readline';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..');
const electronBinary = createRequire(path.join(root, 'main/package.json'))('electron');
const benchDir = path.resolve(process.env.PANE_BENCH_DIR ?? path.join(os.homedir(), '.pane_bench_headless.noindex'));
const rounds = Number(process.argv[2] ?? 10);
const specs = process.argv.slice(3).length ? process.argv.slice(3) : [`current=${path.join(root, 'main/dist')}`];
const keepLogs = process.env.PANE_BENCH_KEEP_LOGS === '1';
const PROMPT_MARKER = 'PANE_BENCH_PROMPT>';

const LOG_MARKS = [
  ['main', /\[Polyfill\]/],
  ['dir', /\[Pane daemon\] Using custom Pane directory/],
  ['logger', /Logger initialized/],
  ['listen', /Local daemon server listening/],
  ['ready', /Headless host ready/],
];
const MARKS = ['main', 'dir', 'logger', 'listen', 'connect', 'answer', 'ready', 'prompt', 'db'];
// The phases P11's boot budget names, in ms, from the marks above.
const PHASES = [
  ['Electron start to first JS', (m) => m.main],
  ['module load (without the database)', (m) => m.dir - m.main - m.db],
  ['database open and migrations', (m) => m.db],
  ['bootstrap to socket listening', (m) => m.connect - m.dir],
  ['socket to first request served', (m) => m.answer - m.connect],
  ['plain terminal: request to prompt', (m) => m.prompt],
];

const home = path.join(benchDir, 'home');
const repo = path.join(benchDir, 'repo');
fs.mkdirSync(home, { recursive: true });
for (const rc of ['.bashrc', '.zshrc']) fs.writeFileSync(path.join(home, rc), `PS1='${PROMPT_MARKER} '\nPROMPT='${PROMPT_MARKER} '\n`);
fs.writeFileSync(path.join(home, '.bash_profile'), 'source ~/.bashrc\n');
if (!fs.existsSync(path.join(repo, '.git'))) {
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: repo, env: { ...process.env, HOME: home } });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'bench\n');
  git('add', '.');
  git('-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid', 'commit', '-qm', 'init');
}

function socketPath(paneDir) {
  if (process.platform === 'win32') throw new Error('Windows pipes are not supported by this script');
  const hash = createHash('sha256').update(path.resolve(paneDir)).digest('hex').slice(0, 16);
  return path.join('/tmp', `pane-daemon-${process.getuid()}-${hash}`, 'daemon.sock');
}

function makeVariant(spec) {
  const [label, dist] = spec.split('=');
  const appDir = path.join(benchDir, 'apps', label);
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(appDir, 'main'), { recursive: true });
  fs.symlinkSync(path.resolve(dist), path.join(appDir, 'main/dist'));
  fs.copyFileSync(path.join(root, 'package.json'), path.join(appDir, 'package.json'));
  return { label, appDir, paneDir: path.join(benchDir, 'pane', label), userData: path.join(benchDir, 'profiles', label), runs: { cold: [], warm: [] }, failures: 0 };
}

/** One connection speaking the daemon's newline-delimited JSON frames. */
function connect(file) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(file);
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.removeListener('error', reject);
      let buffer = '';
      let nextId = 1;
      const pending = new Map();
      const listeners = new Set();
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) {
          const frame = JSON.parse(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          if (frame.type === 'response') {
            const waiter = pending.get(frame.id);
            pending.delete(frame.id);
            if (frame.ok) waiter?.resolve(frame.result);
            else waiter?.reject(new Error(`${frame.error?.message ?? 'request failed'}`));
          } else if (frame.type === 'event') {
            for (const listener of listeners) listener(frame);
          }
        }
      });
      socket.on('error', () => {});
      resolve({
        request: (channel, ...args) => new Promise((res, rej) => {
          const id = nextId++;
          pending.set(id, { resolve: res, reject: rej });
          socket.write(`${JSON.stringify({ type: 'request', id, channel, args })}\n`);
        }),
        onEvent: (listener) => listeners.add(listener),
        close: () => socket.destroy(),
      });
    });
  });
}

async function connectWhenListening(file, deadline) {
  for (;;) {
    try { return await connect(file); } catch { /* not listening yet */ }
    if (performance.now() > deadline) throw new Error('socket never accepted a connection');
    await sleep(2);
  }
}

/** Opens a plain terminal in `paneId` and resolves with ms from the request to its prompt. */
async function timePlainTerminal(client, paneId, deadline) {
  await client.request('daemon:events', { include: ['terminal:output'] });
  const startedAt = performance.now();
  let output = '';
  let panelId;
  const prompted = new Promise((resolve) => {
    client.onEvent((frame) => {
      const payload = frame.args?.[0];
      if (frame.channel !== 'terminal:output' || !payload || (panelId && payload.panelId !== panelId)) return;
      output += payload.output ?? '';
      if (output.includes(PROMPT_MARKER)) resolve(performance.now() - startedAt);
    });
  });
  const created = await client.request('panels:create', { sessionId: paneId, type: 'terminal', title: 'Bench' });
  if (!created?.success) throw new Error(`panels:create failed: ${created?.error}`);
  panelId = created.data.id;
  // As the app's terminal view does: a panel nobody shows sends its output in 250 ms batches.
  await client.request('terminal:setVisibility', panelId, true, 'bench');
  await client.request('panels:initialize', panelId, { cols: 120, rows: 30 });
  const timeout = sleep(Math.max(0, deadline - performance.now())).then(() => { throw new Error(`no prompt; output so far: ${JSON.stringify(output.slice(-200))}`); });
  return Promise.race([prompted, timeout]);
}

async function createBenchPane(client) {
  await client.request('runpane:repos:add', { path: repo, name: 'bench' });
  const created = await client.request('runpane:panes:create', {
    repo: { path: repo },
    panes: [{ name: 'bench', tool: { command: 'true' } }],
    noFocus: true,
  });
  const item = created.items?.[0];
  if (!item?.ok) throw new Error(`panes:create failed: ${JSON.stringify(item?.error ?? created)}`);
  return item.paneId;
}

async function launch(variant, kind, paneId, { socketOnly = false } = {}) {
  const logLines = [];
  const startedAt = performance.now();
  const deadline = startedAt + 60_000;
  const child = spawn(electronBinary, [
    variant.appDir,
    '--daemon-headless',
    `--pane-dir=${variant.paneDir}`,
    `--user-data-dir=${variant.userData}`,
    ...(process.platform === 'linux' ? ['--ozone-platform=headless', '--no-sandbox'] : []),
  ], {
    env: { ...process.env, NODE_ENV: 'production', HOME: home, PANE_DIR: variant.paneDir, SHELL: process.env.PANE_BENCH_SHELL ?? '/bin/bash' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const marks = {};
  const onLine = (line) => {
    const now = performance.now() - startedAt;
    if (keepLogs) logLines.push(`${now.toFixed(0).padStart(6)} ${line}`);
    for (const [name, pattern] of LOG_MARKS) {
      if (marks[name] === undefined && pattern.test(line)) marks[name] = now;
    }
    const db = line.match(/\[Database\] Opened and migrated sessions\.db in (\d+) ms/);
    if (db) marks.db ??= Number(db[1]);
  };
  readline.createInterface({ input: child.stdout }).on('line', onLine);
  readline.createInterface({ input: child.stderr }).on('line', onLine);
  let client;
  try {
    client = await connectWhenListening(socketPath(variant.paneDir), deadline);
    marks.connect = performance.now() - startedAt;
    const answered = client.request('runpane:doctor').then(() => { marks.answer = performance.now() - startedAt; });
    // A burst's daemons share one repo, so they skip the terminal rather than race on its worktrees.
    const pane = socketOnly ? undefined : paneId ?? await (async () => { await answered; return createBenchPane(client); })();
    if (pane) marks.prompt = await timePlainTerminal(client, pane, deadline);
    await answered;
    while (marks.ready === undefined && performance.now() < deadline) await sleep(5);
    await sleep(500); // let deferred startup work finish so quitting does not race it
    return { marks, paneId: pane };
  } finally {
    client?.close();
    const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
    child.kill('SIGTERM');
    const timer = setTimeout(killGroup, 10_000);
    await exited;
    clearTimeout(timer);
    killGroup();
    if (keepLogs) {
      fs.mkdirSync(path.join(benchDir, 'logs'), { recursive: true });
      fs.writeFileSync(path.join(benchDir, 'logs', `${variant.label}-${kind}-${Date.now()}.log`), `${logLines.join('\n')}\n`);
    }
    const missing = MARKS.filter((name) => marks[name] === undefined && !(socketOnly && name === 'prompt'));
    if (missing.length) console.error(`${variant.label} ${kind}: missing marks ${missing.join(', ')}`);
  }
}

function percentile(values, p) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** PANE_BENCH_BURST=<n>: n cold starts at once, each with its own Pane directory, as n VMs booting on one host. */
async function burst(variant, index, size) {
  const copies = Array.from({ length: size }, (_, n) => ({ ...variant, paneDir: `${variant.paneDir}-b${n}`, userData: `${variant.userData}-b${n}` }));
  for (const copy of copies) {
    fs.rmSync(copy.paneDir, { recursive: true, force: true });
    fs.rmSync(copy.userData, { recursive: true, force: true });
  }
  if (process.env.PANE_BENCH_BEFORE_COLD) execFileSync('sh', ['-c', process.env.PANE_BENCH_BEFORE_COLD], { stdio: 'inherit' });
  const results = await Promise.all(copies.map((copy) => launch(copy, 'cold', undefined, { socketOnly: true })));
  if (index > 0) variant.runs.cold.push(...results.map((r) => r.marks));
  console.error(`burst ${index || 'warm-up'} ${variant.label}: listen ${results.map((r) => r.marks.connect?.toFixed(0)).join(' ')}`);
}

async function round(variant, index) {
  fs.rmSync(variant.paneDir, { recursive: true, force: true });
  fs.rmSync(variant.userData, { recursive: true, force: true });
  if (process.env.PANE_BENCH_BEFORE_COLD) execFileSync('sh', ['-c', process.env.PANE_BENCH_BEFORE_COLD], { stdio: 'inherit' });
  const cold = await launch(variant, 'cold');
  const warm = await launch(variant, 'warm', cold.paneId);
  if (index > 0) {
    variant.runs.cold.push(cold.marks);
    variant.runs.warm.push(warm.marks);
  }
  const fmt = (m) => MARKS.map((name) => `${name} ${m[name]?.toFixed(0) ?? '-'}`).join(' · ');
  console.error(`round ${index || 'warm-up'} ${variant.label}\n  cold: ${fmt(cold.marks)}\n  warm: ${fmt(warm.marks)}`);
}

const variants = specs.map(makeVariant);
for (let index = 0; index <= rounds; index++) {
  for (const variant of variants) {
    try {
      const size = Number(process.env.PANE_BENCH_BURST ?? 1);
      if (size > 1) await burst(variant, index, size);
      else await round(variant, index);
    } catch (error) {
      variant.failures++;
      console.error(`round ${index} ${variant.label}: failed, ${error.message}`);
    }
  }
}

console.log(`\n${os.platform()} ${os.arch()}, ${os.cpus().length} CPUs, load avg ${os.loadavg().map((l) => l.toFixed(1)).join(' ')}; ${rounds} rounds after a warm-up; ms p50 / p90 (prompt: from the terminal request, others: from spawn)`);
console.log(['mark', ...variants.flatMap((v) => [`${v.label} cold`, `${v.label} warm`])].join('\t'));
for (const mark of MARKS) {
  console.log([mark, ...variants.flatMap((v) => ['cold', 'warm'].map((kind) => {
    const values = v.runs[kind].map((m) => m[mark]);
    return `${percentile(values, 50).toFixed(0)} / ${percentile(values, 90).toFixed(0)}`;
  }))].join('\t'));
}
console.log(`\nphase (p50 ms)\t${variants.flatMap((v) => [`${v.label} cold`, `${v.label} warm`]).join('\t')}`);
for (const [name, phase] of PHASES) {
  console.log([name, ...variants.flatMap((v) => ['cold', 'warm'].map((kind) => percentile(v.runs[kind].map(phase), 50).toFixed(0)))].join('\t'));
}
for (const v of variants) if (v.failures) console.log(`${v.label}: ${v.failures} failed rounds`);
