import { beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import type { UsageProvider, UsageTotals } from '../../../../shared/types/usage';
import { UsageAggregator } from './usageAggregator';
import { ensureUsageRollup } from './usageRollup';

// The reports read whole hours from usage_hourly. These tests hold them to the
// original definitions: the same GROUP BY over every raw event, and the
// original per-event pane lookup.

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const START = Date.UTC(2026, 4, 10);

const TOKENS = `
  SUM(input_tokens) AS input, SUM(output_tokens) AS output,
  SUM(cache_read_tokens) AS cacheRead, SUM(cache_creation_tokens) AS cacheWrite,
  COUNT(*) AS messages`;

interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  messages: number;
}

function sqliteDate(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE usage_events (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, timestamp_ms INTEGER NOT NULL,
      model TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0, agent_session_id TEXT, cwd TEXT,
      source_path TEXT NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, worktree_path TEXT NOT NULL,
      project_id INTEGER, archived INTEGER DEFAULT 0, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

function insertEvents(db: Database.Database, count: number, idPrefix: string) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO usage_events (id, provider, timestamp_ms, model, input_tokens,
      output_tokens, cache_read_tokens, cache_creation_tokens, cwd, source_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '/t.jsonl')
  `);
  const cwds = ['/w/shared', '/w/solo', '/w/archived', '/w/restored', '/w/none', null];
  const models = ['claude-sonnet-5', 'claude-haiku-4-5', 'gpt-5.1-codex'];
  for (let i = 0; i < count; i++) {
    // Every 7m 13s, so events land on and around hour and day boundaries.
    const timestampMs = START + i * (7 * MINUTE_MS + 13_000);
    const model = models[i % models.length];
    insert.run(`${idPrefix}${i}`, model.startsWith('gpt') ? 'codex' : 'claude', timestampMs, model,
      100 + (i % 37), 10 + (i % 11), 1000 + (i % 101), i % 5 === 0 ? 50 : 0, cwds[i % cwds.length]);
  }
}

function seedSessions(db: Database.Database) {
  const insert = db.prepare(`
    INSERT INTO sessions (id, name, worktree_path, project_id, archived, created_at, updated_at)
    VALUES (?, ?, ?, NULL, ?, ?, ?)
  `);
  const at = (hours: number, minutes: number, seconds = 0) =>
    START + hours * HOUR_MS + minutes * MINUTE_MS + seconds * 1000;
  // Three panes take over one path at mid-hour times; the middle one is archived.
  insert.run('shared-a', 'shared-a', '/w/shared', 0, sqliteDate(at(0, 0)), sqliteDate(at(0, 0)));
  insert.run('shared-b', 'shared-b', '/w/shared', 1, sqliteDate(at(20, 17, 41)), sqliteDate(at(31, 44, 9)));
  insert.run('shared-c', 'shared-c', '/w/shared', 0, sqliteDate(at(52, 5, 3)), sqliteDate(at(52, 5, 3)));
  insert.run('solo', 'solo', '/w/solo', 0, sqliteDate(at(-5, 0)), sqliteDate(at(-5, 0)));
  // Archived mid-hour: events after that stay unattributed.
  insert.run('archived', 'archived', '/w/archived', 1, sqliteDate(at(10, 30, 30)), sqliteDate(at(40, 12, 1)));
  // Created as an ISO timestamp mid-hour.
  insert.run('restored', 'restored', '/w/restored', 0, new Date(at(3, 3, 3)).toISOString(), sqliteDate(at(3, 3, 3)));
}

function providerClause(providers?: UsageProvider[]) {
  return providers ? `AND provider IN (${providers.map(() => '?').join(', ')})` : '';
}

function referenceGroups(db: Database.Database, groupBy: string, fromMs: number, toMs: number, providers?: UsageProvider[]) {
  // SAFETY: The projection aliases groupKey and every Tokens field.
  return db.prepare(`
    SELECT ${groupBy} AS groupKey, ${TOKENS}
    FROM usage_events
    WHERE timestamp_ms >= ? AND timestamp_ms <= ? ${providerClause(providers)}
    GROUP BY groupKey
  `).all(fromMs, toMs, ...(providers ?? [])) as Array<Tokens & { groupKey: string | number | null }>;
}

function referenceByPane(db: Database.Database, fromMs: number, toMs: number, providers?: UsageProvider[]) {
  // SAFETY: The projection aliases groupKey and every Tokens field.
  return db.prepare(`
    SELECT pane_id AS groupKey, ${TOKENS}
    FROM (
      SELECT *, (
        SELECT s.id FROM sessions s
        WHERE s.worktree_path = e.cwd
          AND e.timestamp_ms >= CAST(strftime('%s', s.created_at) AS INTEGER) * 1000
          AND (s.archived IS NULL OR s.archived = 0
            OR e.timestamp_ms <= CAST(strftime('%s', s.updated_at) AS INTEGER) * 1000 + 999)
        ORDER BY CAST(strftime('%s', s.created_at) AS INTEGER) DESC, s.id
        LIMIT 1
      ) AS pane_id
      FROM usage_events e
      WHERE timestamp_ms >= ? AND timestamp_ms <= ? ${providerClause(providers)}
    )
    GROUP BY pane_id
  `).all(fromMs, toMs, ...(providers ?? [])) as Array<Tokens & { groupKey: string | null }>;
}

function tokensOf(totals: UsageTotals): Tokens {
  return {
    input: totals.inputTokens,
    output: totals.outputTokens,
    cacheRead: totals.cacheReadTokens,
    cacheWrite: totals.cacheCreationTokens,
    messages: totals.messageCount,
  };
}

function keyed(rows: Array<Tokens & { groupKey: string | number | null }>) {
  return Object.fromEntries(rows.map(({ groupKey, ...tokens }) => [String(groupKey), tokens]));
}

function sumOf(rows: Tokens[]): Tokens {
  return rows.reduce((sum, row) => ({
    input: sum.input + row.input,
    output: sum.output + row.output,
    cacheRead: sum.cacheRead + row.cacheRead,
    cacheWrite: sum.cacheWrite + row.cacheWrite,
    messages: sum.messages + row.messages,
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 });
}

const RANGES: Array<{ name: string; fromMs: number; toMs: number; providers?: UsageProvider[] }> = [
  { name: 'every event', fromMs: 0, toMs: START + 30 * DAY_MS },
  { name: 'hour-aligned days', fromMs: START + DAY_MS, toMs: START + 3 * DAY_MS - 1 },
  { name: 'mid-hour edges', fromMs: START + 5 * HOUR_MS + 17 * MINUTE_MS + 123, toMs: START + 61 * HOUR_MS + 2 * MINUTE_MS },
  { name: 'inside one hour', fromMs: START + 20 * HOUR_MS + 5 * MINUTE_MS, toMs: START + 20 * HOUR_MS + 50 * MINUTE_MS },
  { name: 'one provider', fromMs: START + 7 * HOUR_MS + 1, toMs: START + 50 * HOUR_MS, providers: ['codex'] },
];

describe.each([
  ['after a backfill of existing events', false],
  ['when triggers maintain the rollup', true],
])('usage reports %s match the per-event definitions', (_name, rollupFirst) => {
  let db: Database.Database;
  let aggregator: UsageAggregator;

  beforeAll(() => {
    db = createDb();
    seedSessions(db);
    if (rollupFirst) ensureUsageRollup(db);
    insertEvents(db, 1200, 'e');
    // Duplicate ids are ignored and must not count twice.
    insertEvents(db, 50, 'e');
    // Deleted events must leave the rollup too.
    db.prepare("DELETE FROM usage_events WHERE id IN ('e3', 'e500', 'e501', 'e999')").run();
    if (!rollupFirst) ensureUsageRollup(db);
    aggregator = new UsageAggregator(db);
  });

  it.each(RANGES)('$name', ({ fromMs, toMs, providers }) => {
    const byModel = referenceGroups(db, "model || '/' || provider", fromMs, toMs, providers);
    expect(tokensOf(aggregator.getTotals(fromMs, toMs, providers))).toEqual(sumOf(byModel));
    expect(keyed(aggregator.getByModel(fromMs, toMs, providers).map(row => ({
      groupKey: `${row.model}/${row.provider}`, ...tokensOf(row),
    })))).toEqual(keyed(byModel));

    expect(keyed(aggregator.getByProject(fromMs, toMs, providers).map(row => ({
      groupKey: row.path, ...tokensOf(row),
    })))).toEqual(keyed(referenceGroups(db, "COALESCE(cwd, '')", fromMs, toMs, providers)));

    const byPane = aggregator.getByPane(fromMs, toMs, providers);
    const attributed = byPane.panes
      .filter(pane => pane.messageCount > 0)
      .map(pane => ({ groupKey: pane.paneId, ...tokensOf(pane) }));
    const unattributed = byPane.unattributed.messageCount > 0
      ? [{ groupKey: null, ...tokensOf(byPane.unattributed) }]
      : [];
    expect(keyed([...attributed, ...unattributed])).toEqual(keyed(referenceByPane(db, fromMs, toMs, providers)));

    for (const bucketMs of [HOUR_MS, DAY_MS]) {
      const bucket = bucketMs === HOUR_MS ? 'hour' : 'day';
      expect(keyed(aggregator.getSeries(fromMs, toMs, bucket, providers).map(row => ({
        groupKey: row.bucketStartMs, ...tokensOf(row),
      })))).toEqual(keyed(referenceGroups(db, `(timestamp_ms / ${bucketMs}) * ${bucketMs}`, fromMs, toMs, providers)));
    }
  });

  it('matches calendar days that start on the half hour', () => {
    // Midnights at UTC+5:30, as a viewer in India sends them.
    const boundaries = Array.from({ length: 5 }, (_, day) => START + day * DAY_MS - 5.5 * HOUR_MS + DAY_MS);
    const fromMs = boundaries[0];
    const toMs = boundaries[boundaries.length - 1] - 1;
    const dayOf = `CASE ${boundaries.slice(0, -1).map((start, index) =>
      `WHEN timestamp_ms < ${boundaries[index + 1]} THEN ${start}`).join(' ')} END`;
    expect(keyed(aggregator.getSeries(fromMs, toMs, 'day', undefined, boundaries).map(row => ({
      groupKey: row.bucketStartMs, ...tokensOf(row),
    })))).toEqual(keyed(referenceGroups(db, dayOf, fromMs, toMs)));
  });
});
