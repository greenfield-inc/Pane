// Run after pnpm build:main with the same Node version used for native modules:
// node scripts/benchmark-db.js [rounds] [pragma set names, comma-separated]
// PANE_DIST=<dir> times another build of main/dist, e.g. one from origin/main.
// Seeds a database shaped like a long-lived install (500 panes, 2,000 panels,
// 260k usage events over 80 days, 360 terminal buffers), then times Pane's frequent writes
// and hot reads under each pragma set. Every round opens each set in a fresh
// process on its own copy of the seed, interleaved so machine noise hits all
// sets alike. Prints the median of each figure across rounds.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const dist = path.resolve(process.env.PANE_DIST ?? path.join(__dirname, '../main/dist'), 'main/src');
const { DatabaseService } = require(path.join(dist, 'database/database.js'));
const { UsageAggregator } = require(path.join(dist, 'services/usage/usageAggregator.js'));
const { UsageRepository } = require(path.join(dist, 'services/usage/usageRepository.js'));

// Each set is applied on top of the pragmas DatabaseService already sets.
const PRAGMA_SETS = {
  current: [],
  'mmap_size=0': ['mmap_size = 0'],
  'temp_store=MEMORY': ['temp_store = MEMORY'],
  'cache_size=-32000': ['cache_size = -32000'],
  'optimize=0x10002': ['optimize = 0x10002'],
};
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 8, 1);
const SESSIONS = 500;
const PANELS_PER_SESSION = 4;

// The service logs every migration and panel merge; keep stdout for the result.
const print = console.log;
console.log = () => {};

function sessionId(s) {
  return `session-${s}`;
}

function panelId(s, p) {
  return `${sessionId(s)}-panel-${p}`;
}

function worktreePath(s) {
  return `/Users/dev/.pane/worktrees/project-${s % 20}/feature-branch-number-${s}`;
}

function terminalBuffer(seed) {
  return `\x1b[32m$\x1b[0m build output line ${seed} `.repeat(1500);
}

function seed(file) {
  const db = new DatabaseService(file);
  db.initialize();
  for (let s = 0; s < SESSIONS; s++) {
    db.createSession({ id: sessionId(s), name: sessionId(s), initial_prompt: '', worktree_name: sessionId(s), worktree_path: worktreePath(s), project_id: null, tool_type: 'none' });
    for (let p = 0; p < PANELS_PER_SESSION; p++) {
      db.createPanel({ id: panelId(s, p), sessionId: sessionId(s), type: 'terminal', title: panelId(s, p), state: { isActive: false, customState: { cwd: worktreePath(s) } } });
    }
  }
  for (let s = 0; s < 360; s++) {
    db.updatePanel(panelId(s, 0), { state: { customState: { scrollbackBuffer: terminalBuffer(s), serializedBuffer: terminalBuffer(s + 1) } } });
  }
  // Session timestamps are "now"; backdate them so usage attributes to panes.
  db.getDb().prepare("UPDATE sessions SET created_at = datetime(?, 'unixepoch')").run((NOW_MS - 90 * DAY_MS) / 1000);
  const insert = db.getDb().prepare(`
    INSERT INTO usage_events (id, provider, timestamp_ms, model, input_tokens, output_tokens,
      cache_read_tokens, cache_creation_tokens, agent_session_id, cwd, source_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.getDb().transaction(() => {
    const events = 260_000;
    for (let i = 0; i < events; i++) {
      // Agents work in bursts: three run at once, each for a few hours on one
      // or two models. One of the three works in a directory Pane never opened.
      const atMs = NOW_MS - 80 * DAY_MS + Math.floor((i / events) * 80 * DAY_MS);
      const shift = Math.floor(atMs / (3 * 60 * 60 * 1000));
      const lane = i % 3;
      const pane = (shift * 3 + lane) % SESSIONS;
      const cwd = lane === 2 ? `/Users/dev/code/other-project-${shift % 500}` : worktreePath(pane);
      const source = `/Users/dev/.claude/projects/-Users-dev-code-project-${pane}/0b6c1f2e-${shift}.jsonl`;
      insert.run(`${source}:${i * 977}:${i}`, pane % 3 === 0 ? 'codex' : 'claude', atMs,
        `model-${(pane + (i % 7 === 0 ? 1 : 0)) % 19}`, 1200 + (i % 900), 300 + (i % 400), 40_000 + (i % 9000), i % 7 === 0 ? 5000 : 0, `agent-${shift}`, cwd, source);
    }
  })();
  new UsageRepository(db.getDb()).recordRateLimits(['primary', 'secondary'].flatMap((scope) => ['codex', 'codex_other'].map((limitId) => ({
    provider: 'codex', limitId, scope, usedPercent: 42, windowMinutes: scope === 'primary' ? 300 : 10080, resetsAtMs: NOW_MS + DAY_MS,
    planType: 'pro', capturedAtMs: NOW_MS - 60_000, creditsHas: null, creditsBalance: null, creditsUnlimited: null,
    rateLimitReachedType: null, spendControlReached: null, limitName: null,
  }))));
  db.getDb().pragma('wal_checkpoint(TRUNCATE)');
  db.close();
}

function measure(count, operation) {
  const times = [];
  for (let i = 0; i < count; i++) {
    const started = performance.now();
    operation(i);
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  const at = (q) => times[Math.floor(q * (times.length - 1))];
  const total = times.reduce((sum, t) => sum + t, 0);
  return { p50: at(0.5), p95: at(0.95), perSec: count / (total / 1000) };
}

function run(seedFile, pragmas) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-db-benchmark-run-'));
  const file = path.join(directory, 'sessions.db');
  fs.copyFileSync(seedFile, file);
  const db = new DatabaseService(file);
  try {
    for (const pragma of pragmas) db.getDb().pragma(pragma);
    db.initialize();
    const usage = new UsageAggregator(db.getDb());
    const repository = new UsageRepository(db.getDb());
    const from30d = NOW_MS - 30 * DAY_MS;
    // What UsageManager.getReport runs for the Usage & limits view's default 30-day range.
    const report = () => ({
      totals: usage.getTotals(from30d, NOW_MS),
      series: usage.getSeries(from30d, NOW_MS, 'day'),
      byModel: usage.getByModel(from30d, NOW_MS),
      byProject: usage.getByProject(from30d, NOW_MS),
      byPane: usage.getByPane(from30d, NOW_MS),
      rateLimits: repository.getRateLimits(NOW_MS),
      files: repository.countFiles(),
      events: repository.countEvents(),
    });
    const statuses = ['running', 'waiting', 'stopped'];
    // Reads run first, while this connection's page cache is still cold.
    return {
      getAllSessions: measure(200, () => db.getAllSessions()),
      getSession: measure(2000, (i) => db.getSession(sessionId(i % SESSIONS))),
      getPanelsForSession: measure(2000, (i) => db.getPanelsForSession(sessionId(i % SESSIONS))),
      getPanelBuffers: measure(360, (i) => db.getPanelBuffers(panelId(i, 0))),
      'usage report, 30d': measure(5, report),
      'usage by pane, 30d': measure(5, () => usage.getByPane(from30d, NOW_MS)),
      'usage by model, 30d': measure(10, () => usage.getByModel(from30d, NOW_MS)),
      'usage by project, 30d': measure(10, () => usage.getByProject(from30d, NOW_MS)),
      'usage series, 30d': measure(10, () => usage.getSeries(from30d, NOW_MS, 'day')),
      'usage totals, 7d': measure(20, () => usage.getTotals(NOW_MS - 7 * DAY_MS, NOW_MS)),
      'rate limits': measure(200, () => repository.getRateLimits(NOW_MS)),
      updatePanel: measure(2000, (i) => db.updatePanel(panelId(Math.floor(i / PANELS_PER_SESSION) % SESSIONS, i % PANELS_PER_SESSION), { state: { isActive: i % 2 === 0, customState: { lastActivity: i } } })),
      updateSession: measure(2000, (i) => db.updateSession(sessionId(i % SESSIONS), { status: statuses[i % statuses.length] })),
      'save terminal buffer': measure(360, (i) => db.updatePanel(panelId(i, 0), { state: { customState: { serializedBuffer: terminalBuffer(i + 7) } } })),
      // One changed transcript as the scanner commits it: 200 new events.
      'index 200 usage events': measure(20, (i) => repository.commitFile(
        { path: `/Users/dev/.claude/projects/new-${i}.jsonl`, provider: 'claude', sizeBytes: 1, mtimeMs: 1, offsetBytes: 1, lastScannedMs: 0, parserVersion: 1, parseContext: null },
        Array.from({ length: 200 }, (_, e) => ({ byteOffset: e, event: {
          provider: 'claude', timestampMs: NOW_MS - e * 20_000, model: `model-${e % 3}`, inputTokens: 1000, outputTokens: 200,
          cacheReadTokens: 40_000, cacheCreationTokens: 0, agentSessionId: null, messageId: `new-${i}-${e}`, cwd: worktreePath(i),
        } })),
        NOW_MS,
      )),
    };
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function format(ms) {
  return ms >= 10 ? `${ms.toFixed(0)} ms` : `${ms.toFixed(ms >= 1 ? 1 : 3)} ms`;
}

if (process.argv[2] === '--run') {
  process.stdout.write(JSON.stringify(run(process.argv[3], JSON.parse(process.argv[4]))));
} else {
  const rounds = Number(process.argv[2] ?? 5);
  const setNames = process.argv[3]?.split(',') ?? Object.keys(PRAGMA_SETS);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-db-benchmark-'));
  try {
    const seedFile = path.join(directory, 'seed.db');
    seed(seedFile);
    const results = Object.fromEntries(setNames.map((name) => [name, []]));
    for (let round = 0; round < rounds; round++) {
      for (const name of setNames) {
        const pragmas = PRAGMA_SETS[name];
        const output = execFileSync(process.execPath, [__filename, '--run', seedFile, JSON.stringify(pragmas)], { maxBuffer: 1 << 24 });
        results[name].push(JSON.parse(output.toString()));
      }
    }
    const names = setNames;
    print(`${process.platform} ${os.arch()}, Node ${process.version}, ${rounds} rounds, seed ${(fs.statSync(seedFile).size / 1024 / 1024).toFixed(0)} MB`);
    print(`p50 / p95 per call / calls per second, median across rounds\n`);
    print(`| | ${names.join(' | ')} |`);
    print(`|---|${names.map(() => '---').join('|')}|`);
    for (const metric of Object.keys(results[names[0]][0])) {
      const cells = names.map((name) => {
        const p50 = median(results[name].map((r) => r[metric].p50));
        const p95 = median(results[name].map((r) => r[metric].p95));
        const perSec = median(results[name].map((r) => r[metric].perSec));
        return `${format(p50)} / ${format(p95)} / ${Math.round(perSec).toLocaleString('en-US')}`;
      });
      print(`| ${metric} | ${cells.join(' | ')} |`);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
