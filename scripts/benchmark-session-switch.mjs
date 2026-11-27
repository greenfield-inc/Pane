#!/usr/bin/env node
// Session switch latency, A/B, on this Mac (T-87): the real target, which CI's runners are too
// slow and noisy to judge. Each run is tests/session-switch-latency.spec.ts in one app checkout:
// real Electron, an isolated Pane (its own PANE_DIR, HOME and Electron profile under TMPDIR,
// D-288), the production renderer and the scripted ACP agent. Runs alternate between the apps.
//
// Each checkout must be built first: `pnpm build:main && pnpm build:frontend && pnpm electron:rebuild`.
// A checkout without the arrow-key scenarios (the Phase 0 branch) reports click and Enter only.
//
//   node scripts/benchmark-session-switch.mjs --app base=../t87-p0-switch-leak-benchmark --app change=. \
//     [--runs 2] [--grep "arrow keys"] [--out dir] [--json summary.json]
//
// Prints p50 / p95 of "keydown or click → the Session's last message on screen" per scenario and
// app, pooled over the runs, and checks the Phase 1 targets on the change:
//   arrow-walk-held        a Session shown before (held by the renderer)  p95 ≤ 50 ms
//   arrow-walk-not-opened  a Session not opened since launch (F-lite)     p95 ≤ 100 ms
// Long chats are expected to miss the first until Phase 2 (virtualized list); the table says so
// per size rather than hiding it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: args } = parseArgs({
  options: {
    app: { type: 'string', multiple: true },
    runs: { type: 'string', default: '1' },
    grep: { type: 'string' },
    out: { type: 'string' },
    json: { type: 'string' },
  },
});
const apps = (args.app ?? [`this=${root}`]).map((value) => {
  const [label, dir] = value.split('=');
  if (!label || !dir) throw new Error(`--app takes label=dir, not ${value}`);
  return { label, dir: path.resolve(dir) };
});
const runs = Number(args.runs);
const out = path.resolve(args.out ?? fs.mkdtempSync(path.join(os.tmpdir(), 'session-switch-ab-')));
const TARGETS = { 'arrow-walk-held': 50, 'arrow-walk-not-opened': 100 };

for (const app of apps) {
  if (!fs.existsSync(path.join(app.dir, 'frontend', 'dist', 'index.html')) || !fs.existsSync(path.join(app.dir, 'main', 'dist'))) {
    throw new Error(`${app.label} (${app.dir}) is not built: run pnpm build:main && pnpm build:frontend && pnpm electron:rebuild there first.`);
  }
}

// The isolated Panes live under TMPDIR; keep them out of the real one and never near ~/.pane.
const tmp = path.join(out, 'tmp');
fs.mkdirSync(tmp, { recursive: true });
const env = { ...process.env, TMPDIR: tmp };
delete env.BROWSER;
for (const key of Object.keys(env)) if (/^(PANE_|RUNPANE_|CLAUDE|AGENT_FARM)/.test(key)) delete env[key];

/** samples[app][scenario] = { size → visible ms[] } */
const samples = Object.fromEntries(apps.map(app => [app.label, {}]));
for (let run = 0; run < runs; run++) {
  for (const app of apps) {
    const dir = path.join(out, `${app.label}-${run + 1}`);
    console.log(`[${app.label} run ${run + 1}/${runs}] ${app.dir} → ${dir}`);
    const result = spawnSync('pnpm', ['test:session-switch', '--reporter=line', ...(args.grep ? ['-g', args.grep] : [])], {
      cwd: app.dir, stdio: 'inherit', env: { ...env, SESSION_SWITCH_OUT: dir, PLAYWRIGHT_PORT: String(4800 + run * apps.length + apps.indexOf(app)) },
    });
    if (result.status !== 0) console.warn(`[${app.label} run ${run + 1}] the spec failed (exit ${result.status}); its samples so far still count.`);
    const file = path.join(dir, 'session-switch.json');
    if (!fs.existsSync(file)) { console.warn(`[${app.label} run ${run + 1}] wrote no ${file}`); continue; }
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const sample of report.samples ?? []) {
      if (sample.visible === null) continue;
      const scenarios = samples[app.label];
      scenarios[sample.scenario] ??= {};
      (scenarios[sample.scenario][sample.size] ??= []).push(sample.visible);
      (scenarios[sample.scenario].all ??= []).push(sample.visible);
    }
  }
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1))];
}
const ms = value => (value === null ? '–' : String(Math.round(value)));

const scenarios = [...new Set(apps.flatMap(app => Object.keys(samples[app.label])))].sort();
const summary = [];
console.log(`\n| Scenario | size | ${apps.map(app => `${app.label} n · p50 / p95 (ms)`).join(' | ')} | target p95 |`);
console.log(`|---|---|${apps.map(() => '---|').join('')}---|`);
for (const scenario of scenarios) {
  const sizes = [...new Set(apps.flatMap(app => Object.keys(samples[app.label][scenario] ?? {})))].sort((a, b) => (a === 'all' ? -1 : b === 'all' ? 1 : a.localeCompare(b)));
  for (const size of sizes) {
    const cells = apps.map(app => {
      const values = samples[app.label][scenario]?.[size] ?? [];
      const row = { app: app.label, scenario, size, n: values.length, p50: percentile(values, 50), p95: percentile(values, 95) };
      summary.push(row);
      return values.length ? `${row.n} · ${ms(row.p50)} / ${ms(row.p95)}` : '–';
    });
    const target = TARGETS[scenario];
    console.log(`| ${scenario} | ${size} | ${cells.join(' | ')} | ${target ? `≤ ${target}` : ''} |`);
  }
}

const change = apps.at(-1).label;
const verdicts = Object.entries(TARGETS).map(([scenario, target]) => {
  const row = summary.find(entry => entry.app === change && entry.scenario === scenario && entry.size === 'all');
  return { scenario, target, p95: row?.p95 ?? null, met: row?.p95 != null && row.p95 <= target };
});
console.log(`\nTargets on ${change}:`);
for (const verdict of verdicts) console.log(`  ${verdict.scenario}: p95 ${ms(verdict.p95)} ms, target ≤ ${verdict.target} ms → ${verdict.p95 === null ? 'not measured' : verdict.met ? 'met' : 'missed'}`);
console.log(`\nRuns and samples: ${out}`);
if (args.json) fs.writeFileSync(path.resolve(args.json), JSON.stringify({ apps, runs, summary, verdicts }, null, 2));
