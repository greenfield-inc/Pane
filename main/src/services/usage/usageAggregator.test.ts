import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import { UsageAggregator, resolveReportRange } from './usageAggregator';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW = Date.UTC(2026, 4, 15, 12, 0, 0);

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE usage_events (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      agent_session_id TEXT,
      cwd TEXT,
      source_path TEXT NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      project_id INTEGER,
      archived INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

let db: ReturnType<typeof createDb>;
let aggregator: UsageAggregator;
let seq = 0;

function seed(options: {
  timestampMs: number;
  model?: string;
  provider?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cwd?: string | null;
}) {
  seq += 1;
  db.prepare(`
    INSERT INTO usage_events (id, provider, timestamp_ms, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cwd, source_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `e${seq}`,
    options.provider ?? 'claude',
    options.timestampMs,
    options.model ?? 'claude-sonnet-5',
    options.input ?? 0,
    options.output ?? 0,
    options.cacheRead ?? 0,
    options.cacheWrite ?? 0,
    options.cwd ?? null,
    '/t.jsonl'
  );
}

function sqliteDate(timestampMs: number): string {
  return new Date(timestampMs).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

function seedSession(options: {
  id: string;
  path: string;
  createdAtMs: number;
  updatedAtMs?: number;
  name?: string;
  repoId?: number | null;
  archived?: boolean;
  isoCreatedAt?: boolean;
}): void {
  db.prepare(`
    INSERT INTO sessions (id, name, worktree_path, project_id, archived, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    options.id,
    options.name ?? options.id,
    options.path,
    options.repoId ?? null,
    options.archived ? 1 : 0,
    options.isoCreatedAt ? new Date(options.createdAtMs).toISOString() : sqliteDate(options.createdAtMs),
    sqliteDate(options.updatedAtMs ?? options.createdAtMs),
  );
}

beforeEach(() => {
  db = createDb();
  aggregator = new UsageAggregator(db);
  seq = 0;
});

describe('UsageAggregator.getTotals', () => {
  it('returns zeroed totals for an empty database', () => {
    const totals = aggregator.getTotals(0, NOW);
    expect(totals.totalTokens).toBe(0);
    expect(totals.messageCount).toBe(0);
    expect(totals.estimatedCostUsd).toBe(0);
    expect(totals.costIncomplete).toBe(false);
  });

  it('sums every token category and counts messages', () => {
    seed({ timestampMs: NOW - HOUR_MS, input: 100, output: 50, cacheRead: 20, cacheWrite: 10 });
    seed({ timestampMs: NOW - 2 * HOUR_MS, input: 200, output: 60 });

    const totals = aggregator.getTotals(NOW - DAY_MS, NOW);

    expect(totals.inputTokens).toBe(300);
    expect(totals.outputTokens).toBe(110);
    expect(totals.cacheReadTokens).toBe(20);
    expect(totals.cacheCreationTokens).toBe(10);
    expect(totals.totalTokens).toBe(440);
    expect(totals.messageCount).toBe(2);
  });

  it('excludes events outside the requested range', () => {
    seed({ timestampMs: NOW - 40 * DAY_MS, input: 1000 });
    seed({ timestampMs: NOW - HOUR_MS, input: 10 });

    expect(aggregator.getTotals(NOW - 30 * DAY_MS, NOW).inputTokens).toBe(10);
  });

  it('flags costs as incomplete when a model has no price entry', () => {
    seed({ timestampMs: NOW - HOUR_MS, model: 'some-unlisted-model', input: 100, output: 10 });

    const totals = aggregator.getTotals(NOW - DAY_MS, NOW);
    expect(totals.costIncomplete).toBe(true);
    expect(totals.estimatedCostUsd).toBe(0);
  });

  it('prices each model separately rather than blending rates', () => {
    seed({ timestampMs: NOW - HOUR_MS, model: 'claude-opus-5', input: 1_000_000 });
    seed({ timestampMs: NOW - HOUR_MS, model: 'claude-sonnet-5', input: 1_000_000 });

    // Opus input is $15/Mtok and Sonnet $3/Mtok.
    expect(aggregator.getTotals(NOW - DAY_MS, NOW).estimatedCostUsd).toBeCloseTo(18, 6);
  });

  it('prices OpenAI / Codex models, not just Claude', () => {
    // gpt-5-codex: $1.25/Mtok input, $10/Mtok output.
    seed({ timestampMs: NOW - HOUR_MS, provider: 'codex', model: 'gpt-5-codex', input: 1_000_000, output: 1_000_000 });

    const totals = aggregator.getTotals(NOW - DAY_MS, NOW);
    expect(totals.costIncomplete).toBe(false);
    expect(totals.estimatedCostUsd).toBeCloseTo(11.25, 6);
  });

  it('resolves dated and versioned OpenAI ids to their base model', () => {
    // Longest-prefix matching must pick gpt-5.3-codex, not the shorter gpt-5.
    seed({ timestampMs: NOW - HOUR_MS, provider: 'codex', model: 'gpt-5.3-codex-20260224', input: 1_000_000 });

    const totals = aggregator.getTotals(NOW - DAY_MS, NOW);
    expect(totals.costIncomplete).toBe(false);
    expect(totals.estimatedCostUsd).toBeCloseTo(1.75, 6);
  });

  it('filters by provider when asked', () => {
    seed({ timestampMs: NOW - HOUR_MS, provider: 'claude', input: 10 });
    seed({ timestampMs: NOW - HOUR_MS, provider: 'codex', model: 'gpt-5-codex', input: 90 });

    expect(aggregator.getTotals(NOW - DAY_MS, NOW, ['claude']).inputTokens).toBe(10);
    expect(aggregator.getTotals(NOW - DAY_MS, NOW, ['codex']).inputTokens).toBe(90);
  });
});

describe('UsageAggregator.getByModel', () => {
  it('groups by model and orders by volume', () => {
    seed({ timestampMs: NOW - HOUR_MS, model: 'claude-sonnet-5', input: 10 });
    seed({ timestampMs: NOW - HOUR_MS, model: 'claude-opus-5', input: 500 });

    const byModel = aggregator.getByModel(NOW - DAY_MS, NOW);

    expect(byModel).toHaveLength(2);
    expect(byModel[0].model).toBe('claude-opus-5');
    expect(byModel[0].provider).toBe('claude');
  });
});

describe('UsageAggregator.getByPane', () => {
  it('returns pane fields, totals, cache efficiency, and per-model costs', () => {
    seedSession({ id: 'p1', name: 'Cost work', path: '/work/p1', repoId: 7, createdAtMs: NOW - DAY_MS });
    seed({ timestampMs: NOW - HOUR_MS, cwd: '/work/p1', model: 'claude-opus-5', input: 100, output: 20, cacheRead: 400 });
    seed({ timestampMs: NOW - HOUR_MS, cwd: '/work/p1', model: 'claude-sonnet-5', input: 50, output: 10 });

    const report = aggregator.getByPane(NOW - DAY_MS, NOW);
    expect(report.panes).toHaveLength(1);
    expect(report.panes[0]).toMatchObject({
      paneId: 'p1',
      paneName: 'Cost work',
      worktreePath: '/work/p1',
      repoId: 7,
      archived: false,
      createdAtMs: NOW - DAY_MS,
      inputTokens: 150,
      outputTokens: 30,
      cacheReadTokens: 400,
      uncachedInputTokens: 150,
      messageCount: 2,
    });
    expect(report.panes[0].byModel.map(entry => entry.model)).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(report.panes[0].cacheHitRate).toBeCloseTo(400 / 550, 8);
    expect(report.panes[0].estimatedCostUsd).toBeGreaterThan(report.panes[0].uncachedCostUsd);
    expect(report.panes[0].cacheSavingsUsd).toBeGreaterThan(0);
  });

  it('computes cache hit rate, uncached cost, and cache savings from known pricing', () => {
    seedSession({ id: 'priced', path: '/priced', createdAtMs: NOW - DAY_MS });
    seed({
      timestampMs: NOW - HOUR_MS,
      cwd: '/priced',
      model: 'claude-opus-5',
      input: 1_000_000,
      cacheRead: 1_000_000,
    });

    const pane = aggregator.getByPane(NOW - DAY_MS, NOW).panes[0];
    expect(pane.cacheHitRate).toBe(0.5);
    expect(pane.estimatedCostUsd).toBeCloseTo(16.5, 8);
    expect(pane.uncachedCostUsd).toBeCloseTo(15, 8);
    expect(pane.cacheSavingsUsd).toBeCloseTo(13.5, 8);
  });

  it('attributes reused paths to the newest pane whose lifetime contains the event', () => {
    const split = NOW - 2 * HOUR_MS;
    seedSession({ id: 'old', path: '/shared', createdAtMs: NOW - DAY_MS, updatedAtMs: split, archived: true });
    seedSession({ id: 'new', path: '/shared', createdAtMs: split + 1_000 });
    seed({ timestampMs: split - 1_000, cwd: '/shared', input: 10 });
    seed({ timestampMs: split + 2_000, cwd: '/shared', input: 20 });

    const report = aggregator.getByPane(NOW - DAY_MS, NOW);
    expect(report.panes.find(pane => pane.paneId === 'old')?.inputTokens).toBe(10);
    expect(report.panes.find(pane => pane.paneId === 'new')?.inputTokens).toBe(20);
    expect(report.unattributed.messageCount).toBe(0);
  });

  it('reconciles panes and unattributed with workspace totals', () => {
    seedSession({ id: 'p1', path: '/known', createdAtMs: NOW - 2 * HOUR_MS });
    seed({ timestampMs: NOW - HOUR_MS, cwd: '/known', input: 10, output: 2 });
    seed({ timestampMs: NOW - HOUR_MS, cwd: '/unknown', input: 20 });
    seed({ timestampMs: NOW - HOUR_MS, cwd: null, input: 30 });
    seed({ timestampMs: NOW - 3 * HOUR_MS, cwd: '/known', input: 40 });

    const report = aggregator.getByPane(NOW - DAY_MS, NOW);
    const totals = aggregator.getTotals(NOW - DAY_MS, NOW);
    const buckets = [...report.panes, report.unattributed];
    expect(buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0)).toBe(totals.totalTokens);
    expect(buckets.reduce((sum, bucket) => sum + bucket.messageCount, 0)).toBe(totals.messageCount);
    expect(buckets.reduce((sum, bucket) => sum + bucket.estimatedCostUsd, 0)).toBeCloseTo(totals.estimatedCostUsd, 8);
    expect(report.unattributed.messageCount).toBe(3);
  });

  it('applies the provider filter to pane and unattributed buckets', () => {
    seedSession({ id: 'p1', path: '/known', createdAtMs: NOW - DAY_MS });
    seed({ timestampMs: NOW - HOUR_MS, cwd: '/known', provider: 'claude', input: 10 });
    seed({ timestampMs: NOW - HOUR_MS, cwd: '/known', provider: 'codex', model: 'gpt-5-codex', input: 20 });
    seed({ timestampMs: NOW - HOUR_MS, cwd: '/elsewhere', provider: 'codex', model: 'gpt-5-codex', input: 30 });

    const report = aggregator.getByPane(NOW - DAY_MS, NOW, ['codex']);
    const totals = aggregator.getTotals(NOW - DAY_MS, NOW, ['codex']);
    expect(report.panes[0].inputTokens + report.unattributed.inputTokens).toBe(totals.inputTokens);
    expect(report.panes[0].byModel.every(entry => entry.provider === 'codex')).toBe(true);
  });

  it('treats a restored pane as having one continuous active lifetime', () => {
    seedSession({ id: 'restored', path: '/restored', createdAtMs: NOW - DAY_MS, updatedAtMs: NOW - 4 * HOUR_MS });
    seed({ timestampMs: NOW - 5 * HOUR_MS, cwd: '/restored', input: 10 });
    seed({ timestampMs: NOW - HOUR_MS, cwd: '/restored', input: 20 });

    expect(aggregator.getByPane(NOW - DAY_MS, NOW).panes[0].inputTokens).toBe(30);
  });

  it('lets a newer pane win an overlap and leaves post-archive events unattributed', () => {
    seedSession({ id: 'old', path: '/overlap', createdAtMs: NOW - DAY_MS, updatedAtMs: NOW - 2 * HOUR_MS, archived: true });
    seedSession({ id: 'new', path: '/overlap', createdAtMs: NOW - 3 * HOUR_MS, updatedAtMs: NOW - HOUR_MS, archived: true });
    seed({ timestampMs: NOW - 150 * 60 * 1000, cwd: '/overlap', input: 10 });
    seed({ timestampMs: NOW - 30 * 60 * 1000, cwd: '/overlap', input: 20 });

    const report = aggregator.getByPane(NOW - DAY_MS, NOW);
    expect(report.panes.find(pane => pane.paneId === 'new')?.inputTokens).toBe(10);
    expect(report.panes.find(pane => pane.paneId === 'old')?.inputTokens).toBe(0);
    expect(report.unattributed.inputTokens).toBe(20);
  });

  it('parses and orders ISO and SQLite timestamps consistently', () => {
    seedSession({ id: 'sql', path: '/dates', createdAtMs: NOW - 3 * HOUR_MS });
    seedSession({ id: 'iso', path: '/dates', createdAtMs: NOW - 2 * HOUR_MS, isoCreatedAt: true });
    seed({ timestampMs: NOW - HOUR_MS, cwd: '/dates', input: 10 });

    const report = aggregator.getByPane(NOW - DAY_MS, NOW);
    expect(report.panes.find(pane => pane.paneId === 'iso')?.inputTokens).toBe(10);
    expect(report.panes.find(pane => pane.paneId === 'iso')?.createdAtMs).toBe(NOW - 2 * HOUR_MS);
  });

  it('zero-fills intersecting idle panes and excludes panes outside the range', () => {
    seedSession({ id: 'idle', name: 'Idle', path: '/idle', createdAtMs: NOW - HOUR_MS });
    seedSession({ id: 'future', path: '/future', createdAtMs: NOW + HOUR_MS });
    seedSession({ id: 'past', path: '/past', createdAtMs: NOW - 3 * DAY_MS, updatedAtMs: NOW - 2 * DAY_MS, archived: true });

    const report = aggregator.getByPane(NOW - DAY_MS, NOW);
    expect(report.panes).toHaveLength(1);
    expect(report.panes[0]).toMatchObject({ paneId: 'idle', totalTokens: 0, byModel: [] });
  });
});

describe('UsageAggregator.getSeries', () => {
  it.each([
    ['spring DST', ['2026-03-08T08:00:00Z', '2026-03-09T07:00:00Z', '2026-03-10T07:00:00Z', '2026-03-11T07:00:00Z']],
    ['fall DST', ['2025-11-02T07:00:00Z', '2025-11-03T08:00:00Z', '2025-11-04T08:00:00Z']],
    ['fractional offset', ['2026-03-07T18:15:00Z', '2026-03-08T18:15:00Z', '2026-03-09T18:15:00Z']],
  ])('keeps viewer calendar days intact across %s', (_name, dates) => {
    const boundaries = dates.map(date => Date.parse(date));
    const from = boundaries[0];
    const to = boundaries[boundaries.length - 1] - 1;
    seed({ timestampMs: from - 1, input: 999 });
    seed({ timestampMs: to + 1, input: 999 });
    boundaries.slice(0, -1).forEach((start, i) => {
      seed({ timestampMs: start, input: 10 });
      seed({ timestampMs: boundaries[i + 1] - 1, input: 20 });
      seed({ timestampMs: start, input: 999, provider: 'codex' });
    });
    const series = aggregator.getSeries(from, to, 'day', ['claude'], boundaries);
    expect(series.map(row => row.bucketStartMs)).toEqual(boundaries.slice(0, -1));
    expect(series.map(row => row.inputTokens)).toEqual(boundaries.slice(0, -1).map(() => 30));
    expect(series.reduce((sum, row) => sum + row.totalTokens, 0)).toBe(aggregator.getTotals(from, to, ['claude']).totalTokens);
  });

  it('rejects malformed calendar intervals rather than silently misbucketing', () => {
    expect(() => aggregator.getSeries(0, 199, 'day', undefined, [0, 100, 100, 200])).toThrow('Invalid usage calendar boundaries');
    expect(() => aggregator.getSeries(0, 199, 'day', undefined, [1, 200])).toThrow('Invalid usage calendar boundaries');
  });

  it('returns no buckets when there is no data', () => {
    expect(aggregator.getSeries(NOW - DAY_MS, NOW, 'day')).toEqual([]);
  });

  it('collapses events into hourly buckets', () => {
    seed({ timestampMs: NOW - 90 * 60 * 1000, input: 10 });
    seed({ timestampMs: NOW - 80 * 60 * 1000, input: 20 });
    seed({ timestampMs: NOW - 10 * 60 * 1000, input: 5 });

    const series = aggregator.getSeries(NOW - DAY_MS, NOW, 'hour');

    expect(series.length).toBeGreaterThanOrEqual(2);
    expect(series.every((bucket, i) => i === 0 || bucket.bucketStartMs > series[i - 1].bucketStartMs)).toBe(true);
    expect(series.reduce((sum, bucket) => sum + bucket.inputTokens, 0)).toBe(35);
  });

  it('merges several models within one bucket into a single point', () => {
    seed({ timestampMs: NOW - HOUR_MS, model: 'claude-opus-5', input: 10 });
    seed({ timestampMs: NOW - HOUR_MS, model: 'claude-sonnet-5', input: 20 });

    const series = aggregator.getSeries(NOW - DAY_MS, NOW, 'hour');
    const bucket = series.find(entry => entry.inputTokens === 30);
    expect(bucket).toBeDefined();
    expect(bucket?.messageCount).toBe(2);
  });

  it('buckets by day when asked', () => {
    seed({ timestampMs: NOW - 2 * DAY_MS, input: 10 });
    seed({ timestampMs: NOW - 2 * DAY_MS + HOUR_MS, input: 10 });

    const series = aggregator.getSeries(NOW - 7 * DAY_MS, NOW, 'day');
    expect(series).toHaveLength(1);
    expect(series[0].inputTokens).toBe(20);
  });
});


describe('resolveReportRange', () => {
  it('defaults to the trailing window ending now', () => {
    const range = resolveReportRange(undefined, NOW, 30);
    expect(range.toMs).toBe(NOW);
    expect(range.fromMs).toBe(NOW - 30 * DAY_MS);
  });

  it('picks hourly buckets for short ranges and daily for long ones', () => {
    expect(resolveReportRange({ fromMs: NOW - DAY_MS, toMs: NOW }, NOW, 30).bucket).toBe('hour');
    expect(resolveReportRange({ fromMs: NOW - 30 * DAY_MS, toMs: NOW }, NOW, 30).bucket).toBe('day');
  });

  it('honours an explicit bucket', () => {
    expect(resolveReportRange({ fromMs: NOW - 30 * DAY_MS, toMs: NOW, bucket: 'hour' }, NOW, 30).bucket).toBe('hour');
  });

  it('never returns an inverted range', () => {
    const range = resolveReportRange({ fromMs: NOW, toMs: NOW - DAY_MS }, NOW, 30);
    expect(range.fromMs).toBeLessThanOrEqual(range.toMs);
  });
});
