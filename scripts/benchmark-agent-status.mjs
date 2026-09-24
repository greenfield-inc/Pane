// Cost of one agent-status scan (detectAgentState) per screen shape.
//   node scripts/benchmark-agent-status.mjs            # macOS: instructions + wall time
//   SCANS=50000 node scripts/benchmark-agent-status.mjs
//   SRC=/path/to/other/agentStatus node scripts/benchmark-agent-status.mjs   # compare a baseline
//
// Bundles the engine straight from main/src (no build needed). Instructions per
// scan come from `/usr/bin/time -l` ("instructions retired", macOS) on a child
// run with SCANS scans minus one with zero, under `node --predictable`, so the
// number is deterministic to within a fraction of a percent. Wall time per scan
// is the p50/p75 of 200-scan batches.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCANS = Number(process.env.SCANS ?? 20000);
const SRC = process.env.SRC ?? path.join(root, 'main/src/services/agentStatus');

const rule = (cols) => '─'.repeat(cols);
const pad = (lines, rows) => [...Array(Math.max(0, rows - lines.length)).fill(''), ...lines];
const output = (cols, n) => Array.from({ length: n }, (_, i) =>
  (i % 4 === 0 ? '⏺ ' : '  ') + `step ${i}: reading src/services/file${i}.ts and checking the call sites `.repeat(3).slice(0, cols - 4));

// Shapes distilled from live 30x80 Claude/Codex/shell panels, plus a wide 50x160 Claude.
function fixtures() {
  const claudeBusy = (cols, rows) => pad([
    ...output(cols, rows - 8),
    '✽ Swooping… (3m 22s · ↓ 2.5k tokens)', '',
    rule(cols), '❯ ', rule(cols),
    '   Model: Opus  Ctx: 61.6k (6%)  Pane  ✓ perf-pane',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
  ], rows).join('\n');
  const claudeIdle = (cols, rows) => claudeBusy(cols, rows).replace('✽ Swooping… (3m 22s · ↓ 2.5k tokens)', '✻ Worked for 3m 22s');
  return {
    'claude busy 30x80': { agent: 'claude', screen: claudeBusy(80, 30), oscTitle: '⠐ Measure scanner', oscProgress: '' },
    'claude busy 50x160': { agent: 'claude', screen: claudeBusy(160, 50), oscTitle: '⠐ Measure scanner', oscProgress: '' },
    'claude idle 30x80': { agent: 'claude', screen: claudeIdle(80, 30), oscTitle: '✳ Measure scanner', oscProgress: '4;0' },
    'claude blocked 30x80': { agent: 'claude', oscTitle: '✳ Measure scanner', oscProgress: '', screen: pad([
      ...output(80, 18), rule(80), ' Bash command', '   pnpm test', '', ' Do you want to proceed?',
      ' ❯ 1. Yes', '   2. Yes, and don\'t ask again for pnpm commands', '   3. No, and tell Claude what to do differently (esc)', '', ' Esc to cancel · Tab to amend',
    ], 30).join('\n') },
    'codex busy 30x80': { agent: 'codex', oscTitle: '⠋ codex', oscProgress: '', screen: pad([
      ...output(80, 24), '', '• Working (12s • esc to interrupt)', '', '› Ask Codex to do anything', '', '  gpt-5 high · 88% context left',
    ], 30).join('\n') },
    'shell busy 30x80': { agent: 'shell', oscTitle: 'zsh', oscProgress: '', screen: pad(
      Array.from({ length: 30 }, (_, i) => ` ✓ src/services/file${i}.test.ts (12 tests) ${i * 3}ms`), 30).join('\n') },
  };
}

function bundle() {
  const esbuild = require(path.join(root, 'node_modules/esbuild'));
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-status-bench-'));
  const entry = path.join(dir, 'entry.ts');
  writeFileSync(entry, `export { detectAgentState } from ${JSON.stringify(path.join(SRC, 'manifestEngine'))};
export { getManifestForAgent } from ${JSON.stringify(path.join(SRC, 'manifests'))};`);
  const out = path.join(dir, 'engine.cjs');
  esbuild.buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error' });
  return out;
}

// Child mode: run `scans` scans of one fixture and exit.
if (process.argv[2] === '--child') {
  const [, , , enginePath, name, scans] = process.argv;
  const { detectAgentState, getManifestForAgent } = require(enginePath);
  const f = fixtures()[name];
  const manifest = getManifestForAgent(f.agent);
  let sink = 0;
  for (let i = 0; i < Number(scans); i += 1) sink += detectAgentState(manifest, f).state.length;
  if (sink < 0) console.log(sink);
  process.exit(0);
}

function instructions(enginePath, name, scans) {
  const r = spawnSync('/usr/bin/time', ['-l', process.execPath, '--predictable', fileURLToPath(import.meta.url), '--child', enginePath, name, String(scans)], { encoding: 'utf8' });
  const m = /(\d+)\s+instructions retired/.exec(r.stderr);
  if (!m) throw new Error(`no instruction count (macOS only):\n${r.stderr}`);
  return Number(m[1]);
}

function wallMicros(enginePath, f) {
  const { detectAgentState, getManifestForAgent } = require(enginePath);
  const manifest = getManifestForAgent(f.agent);
  for (let i = 0; i < 5000; i += 1) detectAgentState(manifest, f);
  const batches = [];
  for (let b = 0; b < 100; b += 1) {
    const t0 = performance.now();
    for (let i = 0; i < 200; i += 1) detectAgentState(manifest, f);
    batches.push(((performance.now() - t0) * 1000) / 200);
  }
  batches.sort((a, b) => a - b);
  return [batches[49], batches[74]];
}

const enginePath = bundle();
console.log(`scans=${SCANS}  node ${process.version}  load ${(await import('node:os')).loadavg().map((n) => n.toFixed(1)).join(' ')}`);
console.log('fixture'.padEnd(22), 'instr/scan'.padStart(11), 'p50 µs'.padStart(8), 'p75 µs'.padStart(8));
for (const [name, f] of Object.entries(fixtures())) {
  const perScan = (instructions(enginePath, name, SCANS) - instructions(enginePath, name, 0)) / SCANS;
  const [p50, p75] = wallMicros(enginePath, f);
  console.log(name.padEnd(22), Math.round(perScan).toLocaleString().padStart(11), p50.toFixed(2).padStart(8), p75.toFixed(2).padStart(8));
}
