/**
 * Turns phone logs into the mobile perf target table.
 *
 *   node scripts/perf-table.mts <scenario>.log [...]
 *
 * Each file holds one scenario's runs (a simulator `log stream`, or a phone's Console export).
 * With `--runs <n>`, a journey that ran a different number of times is reported on stderr.
 * Only `[perf] <journey> <mark> <ms>` lines count (src/features/perf/perfMarks.ts). A run begins
 * at `<journey> start 0`. For each scenario the script prints every metric its runs carry: the
 * median, the slowest run and the number of runs.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Mark { journey: string; mark: string; ms: number }
export interface Run { journey: string; marks: Mark[] }
export interface Metric { name: string; values: number[] }

const LINE = /\[perf\] (\S+) (\S+) (\d+)/;

export function parseRuns(log: string): { runs: Run[]; stalls: number[] } {
  const runs: Run[] = [];
  const open = new Map<string, Run>();
  const stalls: number[] = [];
  for (const line of log.split('\n')) {
    const match = LINE.exec(line);
    if (!match) continue;
    const [, journey, mark, ms] = match;
    if (journey === 'app' && mark === 'stall') {
      stalls.push(Number(ms));
      continue;
    }
    if (mark === 'start') {
      const run = { journey, marks: [] };
      runs.push(run);
      open.set(journey, run);
      continue;
    }
    open.get(journey)?.marks.push({ journey, mark, ms: Number(ms) });
  }
  return { runs, stalls };
}

const first = (run: Run, name: string) => run.marks.find(mark => mark.mark === name)?.ms;
const both = (a: number | undefined, b: number | undefined) => (a === undefined || b === undefined ? undefined : Math.max(a, b));

/** The machine the phone is on: the one its event stream goes to. */
function currentMachine(run: Run): string | undefined {
  return run.marks.find(mark => mark.mark.startsWith('stream-open@'))?.mark.split('@')[1];
}

/** Count changes after the first frame, and counts shown that the fresh data contradicts. */
function countChanges(run: Run): { changes: number; wrong: number } {
  const shown = run.marks.filter(mark => mark.mark.startsWith('counts=') && mark.mark !== 'counts=-').map(mark => mark.mark);
  if (shown.length === 0) return { changes: 0, wrong: 0 };
  const final = shown[shown.length - 1];
  return { changes: shown.length - 1, wrong: shown.filter(value => value !== final).length };
}

/** The metrics one run carries, by name. Absent marks give no value. */
export function runMetrics(run: Run): Record<string, number | undefined> {
  switch (run.journey) {
    case 'return':
    case 'switch':
    case 'launch': {
      const machine = currentMachine(run);
      const toCurrent = (mark: Mark) => !machine || mark.mark.endsWith(`@${machine}`);
      // A read is keyed by its channel and arguments, so only the same read sent twice counts again.
      const sends = run.marks.filter(mark => mark.mark.startsWith('send=') && toCurrent(mark));
      const distinctReads = new Set(sends.map(mark => mark.mark));
      const counts = countChanges(run);
      return {
        'first frame': first(run, run.journey === 'return' ? 'first-frame' : 'home-frame'),
        'stream open': run.marks.find(mark => mark.mark.startsWith('stream-open@'))?.ms,
        connected: first(run, 'status=connected'),
        'home live': first(run, 'home-live'),
        'home fresh': first(run, 'home-fresh'),
        'chat live': first(run, 'chat-live'),
        'terminal live': both(first(run, 'terminal-live'), first(run, 'terminal-screen')),
        'reads sent': sends.length,
        'reads sent again': sends.length - distinctReads.size,
        'writes sent': run.marks.filter(mark => mark.mark.startsWith('write=') && toCurrent(mark)).length,
        'terminal handshakes': sends.filter(mark => mark.mark.startsWith('send=terminal:getState#')).length,
        'count changes': counts.changes,
        'wrong counts shown': counts.wrong,
      };
    }
    case 'terminal':
      return { 'first frame': first(run, 'first-frame'), content: first(run, 'content'), screen: first(run, 'screen'), live: first(run, 'live') };
    case 'chat':
      return { 'first frame': first(run, 'first-frame'), messages: first(run, 'messages'), live: first(run, 'live') };
    case 'session':
      return { 'first frame': first(run, 'first-frame'), data: first(run, 'data') };
    case 'approval': {
      const layouts = run.marks.filter(mark => /^(card|tabs|body|workspace)=/.test(mark.mark));
      // Each region logs only when it moves, so every mark after a region's first is a shift.
      const firsts = new Set<string>();
      const changes = layouts.filter(mark => { const region = mark.mark.split('=')[0]; if (!firsts.has(region)) { firsts.add(region); return false; } return true; });
      return { 'first frame': first(run, 'first-frame'), 'layout final': layouts.at(-1)?.ms, 'layout changes': changes.length };
    }
    default:
      return {};
  }
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** Every metric of every journey in a scenario's log, values in run order. */
export function scenarioMetrics(log: string): Metric[] {
  return metricsOf(parseRuns(log));
}

/** Journeys whose run count differs from `expected`, as `journey: count`. */
export function runCountMismatches(log: string, expected: number): string[] {
  const counts = new Map<string, number>();
  for (const run of parseRuns(log).runs) counts.set(run.journey, (counts.get(run.journey) ?? 0) + 1);
  return [...counts].filter(([, count]) => count !== expected).map(([journey, count]) => `${journey}: ${count}`);
}

function metricsOf({ runs, stalls }: { runs: Run[]; stalls: number[] }): Metric[] {
  const metrics = new Map<string, number[]>();
  for (const run of runs) {
    for (const [name, value] of Object.entries(runMetrics(run))) {
      if (value === undefined) continue;
      const key = `${run.journey}: ${name}`;
      metrics.set(key, [...(metrics.get(key) ?? []), value]);
    }
  }
  if (stalls.length) {
    metrics.set('stalls over 100 ms', [stalls.length]);
    metrics.set('longest stall', [Math.max(...stalls)]);
  }
  return [...metrics].map(([name, values]) => ({ name, values }));
}

export function formatTable(scenarios: ReadonlyArray<{ scenario: string; metrics: Metric[] }>): string {
  const lines = ['| Scenario | Metric | Median | Slowest | Runs |', '|---|---|---|---|---|'];
  for (const { scenario, metrics } of scenarios) {
    for (const { name, values } of metrics) {
      lines.push(`| ${scenario} | ${name} | ${median(values)} | ${Math.max(...values)} | ${values.length} |`);
    }
  }
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const runsAt = args.indexOf('--runs');
  const expected = runsAt === -1 ? undefined : Number(args.splice(runsAt, 2)[1]);
  if (args.length === 0) {
    console.error('Usage: node scripts/perf-table.mts [--runs <n>] <scenario>.log [...]');
    process.exit(1);
  }
  const scenarios = args.map(file => {
    const log = readFileSync(file, 'utf8');
    const scenario = path.basename(file, path.extname(file));
    // A journey that ran a different number of times than asked usually means a step failed.
    if (expected !== undefined) for (const mismatch of runCountMismatches(log, expected)) console.error(`warning: ${scenario} ${mismatch} runs, expected ${expected}`);
    return { scenario, metrics: scenarioMetrics(log) };
  });
  console.log(formatTable(scenarios));
}
