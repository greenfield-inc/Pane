import { basename } from 'path';
import type { Database } from 'better-sqlite3-multiple-ciphers';
import {
  MAX_USAGE_DAY_BUCKETS,
  type UsageBucket,
  type UsageByPane,
  type UsageByPaneReport,
  type UsageByModel,
  type UsageByProject,
  type UsageProvider,
  type UsageReportRequest,
  type UsageTotals,
} from '../../../../shared/types/usage';
import { estimateCostUsd } from './modelPricing';
import { ROLLUP_BUCKET_MS } from './usageRollup';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

interface TokenRow {
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  message_count: number;
}

interface BucketRow extends TokenRow {
  bucket_start_ms: number;
}

interface SourceRow extends TokenRow {
  timestamp_ms: number;
  /** Earliest and latest event time the row may hold. */
  first_ms: number;
  last_ms: number;
  cwd: string;
}

interface UsageSource {
  sql: string;
  params: Array<number | string>;
}

/** When a pane owned its worktree path, in the terms the attribution rule uses. */
interface PaneLifetime {
  id: string;
  createdMs: number | null;
  active: boolean;
  /** Last millisecond an archived pane still owns its path. */
  endMs: number | null;
}

interface PaneRow {
  id: string;
  name: string;
  worktree_path: string;
  project_id: number | null;
  archived: number | null;
  created_at_ms: number;
}

interface FoldedCostSummary {
  totals: UsageTotals;
  cacheReadCostUsd: number;
}

interface ProviderFilter {
  clause: string;
  params: UsageProvider[];
}

interface ResolvedReportRange {
  fromMs: number;
  toMs: number;
  bucket: 'hour' | 'day';
}

function emptyTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    messageCount: 0,
    estimatedCostUsd: 0,
    costIncomplete: false,
    cacheSavingsUsd: 0,
  };
}

/**
 * Fold per-model rows into one total, pricing each model separately — a single
 * blended rate would be wrong whenever a range mixes Opus and Haiku traffic.
 */
function foldCostSummary(rows: TokenRow[]): FoldedCostSummary {
  const totals = emptyTotals();
  let cacheReadCostUsd = 0;

  for (const row of rows) {
    totals.inputTokens += row.input_tokens;
    totals.outputTokens += row.output_tokens;
    totals.cacheReadTokens += row.cache_read_tokens;
    totals.cacheCreationTokens += row.cache_creation_tokens;
    totals.messageCount += row.message_count;

    const estimate = estimateCostUsd({
      model: row.model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheCreationTokens: row.cache_creation_tokens,
    });
    totals.estimatedCostUsd += estimate.costUsd;
    totals.cacheSavingsUsd += estimate.cacheSavingsUsd;
    cacheReadCostUsd += estimate.cacheReadCostUsd;
    if (!estimate.complete) totals.costIncomplete = true;
  }

  totals.totalTokens =
    totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheCreationTokens;
  return { totals, cacheReadCostUsd };
}

function foldTotals(rows: TokenRow[]): UsageTotals {
  return foldCostSummary(rows).totals;
}

function foldPaneSlice(rows: TokenRow[]) {
  const { totals, cacheReadCostUsd } = foldCostSummary(rows);
  const denominator = totals.inputTokens + totals.cacheReadTokens;
  const byModel = rows
    .map(row => ({
      model: row.model,
      provider: row.provider === 'codex' ? 'codex' as const : 'claude' as const,
      ...foldTotals([row]),
    }))
    .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd);
  return {
    ...totals,
    uncachedCostUsd: totals.estimatedCostUsd - cacheReadCostUsd,
    uncachedInputTokens: totals.inputTokens,
    cacheHitRate: denominator > 0 ? totals.cacheReadTokens / denominator : 0,
    byModel,
  };
}

function ownsPathAt(lifetime: PaneLifetime, timestampMs: number): boolean {
  return lifetime.createdMs !== null && timestampMs >= lifetime.createdMs
    && (lifetime.active || (lifetime.endMs !== null && timestampMs <= lifetime.endMs));
}

/** The newest pane that owned the path at this time, or null. */
function paneAt(lifetimes: PaneLifetime[], timestampMs: number): string | null {
  return lifetimes.find(lifetime => ownsPathAt(lifetime, timestampMs))?.id ?? null;
}

/** Whether any pane gains or loses the path strictly inside (startMs, endMs). */
function ownershipChangesWithin(lifetimes: PaneLifetime[], startMs: number, endMs: number): boolean {
  const inside = (ms: number | null) => ms !== null && ms > startMs && ms < endMs;
  return lifetimes.some(lifetime => inside(lifetime.createdMs)
    || (!lifetime.active && inside(lifetime.endMs === null ? null : lifetime.endMs + 1)));
}

const AGGREGATE_COLUMNS = `
  model,
  provider,
  SUM(input_tokens)          AS input_tokens,
  SUM(output_tokens)         AS output_tokens,
  SUM(cache_read_tokens)     AS cache_read_tokens,
  SUM(cache_creation_tokens) AS cache_creation_tokens,
  SUM(message_count)         AS message_count
`;

export class UsageAggregator {
  constructor(private db: Database) {}

  /**
   * Per-model rollup for a time range. Buckets by model *and* provider so a
   * model id shared across providers stays distinguishable.
   */
  getByModel(fromMs: number, toMs: number, providers?: UsageProvider[]): UsageByModel[] {
    const source = this.source(fromMs, toMs, providers);
    // SAFETY: The fixed projection aliases every column required by TokenRow.
    const rows = this.db.prepare(`
      SELECT ${AGGREGATE_COLUMNS}
      FROM (${source.sql})
      GROUP BY model, provider
      ORDER BY SUM(input_tokens + output_tokens) DESC
    `).all(...source.params) as TokenRow[];

    return rows.map(row => ({
      model: row.model,
      provider: row.provider === 'codex' ? 'codex' : 'claude',
      ...foldTotals([row]),
    }));
  }

  /**
   * Per-directory rollup — "which worktree spent my quota".
   *
   * The transcripts know nothing about Pane's sessions; the working directory
   * each message recorded is the only link back to a project, so that is what
   * is grouped on. Rows without a cwd are folded into one "Unknown" entry
   * rather than dropped, so the parts still sum to the whole.
   */
  getByProject(fromMs: number, toMs: number, providers?: UsageProvider[]): UsageByProject[] {
    const source = this.source(fromMs, toMs, providers);
    // SAFETY: The fixed projection aliases every TokenRow field plus cwd.
    const rows = this.db.prepare(`
      SELECT cwd, ${AGGREGATE_COLUMNS}
      FROM (${source.sql})
      GROUP BY cwd, model, provider
    `).all(...source.params) as Array<TokenRow & { cwd: string }>;

    const byPath = new Map<string, TokenRow[]>();
    for (const row of rows) {
      const path = row.cwd && row.cwd.trim().length > 0 ? row.cwd : '';
      const existing = byPath.get(path);
      if (existing) existing.push(row);
      else byPath.set(path, [row]);
    }

    return [...byPath.entries()]
      .map(([path, pathRows]) => ({
        path,
        label: path ? basename(path) || path : 'Unknown',
        ...foldTotals(pathRows),
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens);
  }

  getByPane(fromMs: number, toMs: number, providers?: UsageProvider[]): UsageByPaneReport {
    const source = this.source(fromMs, toMs, providers);
    // SAFETY: The source projection is represented by SourceRow.
    const sourceRows = this.db.prepare(source.sql).all(...source.params) as SourceRow[];

    // An event belongs to the newest pane whose lifetime holds it at the
    // event's worktree path. Ownership of a path only changes at a pane's
    // creation or archive time, so a rolled-up row resolves at once unless one
    // of those falls between its first and last event. Those rare rows reread
    // their events.
    const lifetimes = this.paneLifetimes();
    const sums = new Map<string, TokenRow & { paneId: string | null }>();
    const add = (paneId: string | null, row: TokenRow) => {
      const key = `${paneId ?? ''}\0${row.model}\0${row.provider}`;
      const sum = sums.get(key);
      if (!sum) {
        sums.set(key, {
          paneId,
          model: row.model,
          provider: row.provider,
          input_tokens: row.input_tokens,
          output_tokens: row.output_tokens,
          cache_read_tokens: row.cache_read_tokens,
          cache_creation_tokens: row.cache_creation_tokens,
          message_count: row.message_count,
        });
        return;
      }
      sum.input_tokens += row.input_tokens;
      sum.output_tokens += row.output_tokens;
      sum.cache_read_tokens += row.cache_read_tokens;
      sum.cache_creation_tokens += row.cache_creation_tokens;
      sum.message_count += row.message_count;
    };

    const splitRows: Array<[number, string, string, string]> = [];
    for (const row of sourceRows) {
      const paths = row.cwd ? lifetimes.get(row.cwd) : undefined;
      if (paths && ownershipChangesWithin(paths, row.first_ms, row.last_ms + 1)) {
        splitRows.push([row.timestamp_ms, row.cwd, row.model, row.provider]);
        continue;
      }
      add(paths ? paneAt(paths, row.first_ms) : null, row);
    }

    if (splitRows.length > 0) {
      // SAFETY: The fixed projection aliases every SourceRow field used below.
      const eventRows = this.db.prepare(`
        SELECT timestamp_ms, cwd, usage_events.model, usage_events.provider, input_tokens,
          output_tokens, cache_read_tokens, cache_creation_tokens, 1 AS message_count
        FROM json_each(?) AS split
        JOIN usage_events
          ON timestamp_ms >= split.value ->> 0
          AND timestamp_ms < (split.value ->> 0) + ${ROLLUP_BUCKET_MS}
          AND cwd = split.value ->> 1
          AND usage_events.model = split.value ->> 2
          AND usage_events.provider = split.value ->> 3
      `).all(JSON.stringify(splitRows)) as SourceRow[];
      for (const row of eventRows) add(paneAt(lifetimes.get(row.cwd) ?? [], row.timestamp_ms), row);
    }

    const rows = [...sums.values()];

    const rowsByPane = new Map<string, TokenRow[]>();
    const unattributedRows: TokenRow[] = [];
    for (const row of rows) {
      if (row.paneId === null) {
        unattributedRows.push(row);
        continue;
      }
      const paneRows = rowsByPane.get(row.paneId);
      if (paneRows) paneRows.push(row);
      else rowsByPane.set(row.paneId, [row]);
    }

    // SAFETY: The fixed roster projection is represented by PaneRow.
    const roster = this.db.prepare(`
      SELECT
        id,
        name,
        worktree_path,
        project_id,
        archived,
        CAST(strftime('%s', created_at) AS INTEGER) * 1000 AS created_at_ms
      FROM sessions
      WHERE CAST(strftime('%s', created_at) AS INTEGER) * 1000 <= ?
        AND (
          archived IS NULL OR archived = 0
          OR CAST(strftime('%s', updated_at) AS INTEGER) * 1000 + 999 >= ?
        )
    `).all(toMs, fromMs) as PaneRow[];

    const rosterById = new Map(roster.map(pane => [pane.id, pane]));
    for (const paneId of rowsByPane.keys()) {
      if (rosterById.has(paneId)) continue;
      // SAFETY: The fixed by-id projection is represented by PaneRow and may return no row.
      const pane = this.db.prepare(`
        SELECT
          id,
          name,
          worktree_path,
          project_id,
          archived,
          CAST(strftime('%s', created_at) AS INTEGER) * 1000 AS created_at_ms
        FROM sessions
        WHERE id = ?
      `).get(paneId) as PaneRow | undefined;
      if (pane) rosterById.set(pane.id, pane);
    }

    const panes: UsageByPane[] = [...rosterById.values()]
      .map(pane => ({
        paneId: pane.id,
        paneName: pane.name,
        worktreePath: pane.worktree_path,
        repoId: pane.project_id,
        archived: pane.archived === 1,
        createdAtMs: pane.created_at_ms,
        ...foldPaneSlice(rowsByPane.get(pane.id) ?? []),
      }))
      .sort((a, b) => b.uncachedCostUsd - a.uncachedCostUsd || a.paneName.localeCompare(b.paneName));

    return { panes, unattributed: foldPaneSlice(unattributedRows) };
  }

  getTotals(fromMs: number, toMs: number, providers?: UsageProvider[]): UsageTotals {
    const source = this.source(fromMs, toMs, providers);
    // SAFETY: The fixed projection aliases every column required by TokenRow.
    const rows = this.db.prepare(`
      SELECT ${AGGREGATE_COLUMNS}
      FROM (${source.sql})
      GROUP BY model, provider
    `).all(...source.params) as TokenRow[];

    return foldTotals(rows);
  }

  /**
   * Time series. Bucketing is arithmetic on the epoch value rather than
   * `strftime`, so it never depends on the SQLite build's timezone handling.
   */
  getSeries(
    fromMs: number,
    toMs: number,
    bucket: 'hour' | 'day',
    providers?: UsageProvider[],
    dayBoundariesMs?: number[]
  ): UsageBucket[] {
    const bucketMs = bucket === 'hour' ? HOUR_MS : DAY_MS;

    if (dayBoundariesMs && (
      dayBoundariesMs.length < 2 || dayBoundariesMs.length > MAX_USAGE_DAY_BUCKETS + 1
      || dayBoundariesMs[0] !== fromMs || dayBoundariesMs[dayBoundariesMs.length - 1] !== toMs + 1
      || dayBoundariesMs.some((value, index) => !Number.isSafeInteger(value)
        || (index > 0 && value <= dayBoundariesMs[index - 1]))
    )) throw new Error('Invalid usage calendar boundaries');

    // Calendar intervals come from the viewer, which may be in a different
    // timezone from the daemon. Range joins preserve DST and fractional offsets.
    const calendarCte = dayBoundariesMs ? `WITH calendar AS (
      SELECT value AS start_ms, LEAD(value) OVER (ORDER BY key) AS end_ms
      FROM json_each(?)
    )` : '';
    // Day boundaries split the rolled-up hours they fall inside.
    const source = this.source(fromMs, toMs, providers, dayBoundariesMs);
    const from = dayBoundariesMs
      ? `calendar JOIN (${source.sql}) ON timestamp_ms >= start_ms AND timestamp_ms < end_ms`
      : `(${source.sql})`;
    const bucketStart = dayBoundariesMs ? 'start_ms' : `(timestamp_ms / ${bucketMs}) * ${bucketMs}`;
    // SAFETY: The fixed projection aliases every column required by BucketRow.
    const rows = this.db.prepare(`
      ${calendarCte}
      SELECT ${bucketStart} AS bucket_start_ms, ${AGGREGATE_COLUMNS}
      FROM ${from}
      GROUP BY bucket_start_ms, model, provider
      ORDER BY bucket_start_ms ASC
    `).all(...(dayBoundariesMs ? [JSON.stringify(dayBoundariesMs)] : []), ...source.params) as BucketRow[];

    const byBucket = new Map<number, TokenRow[]>();
    for (const row of rows) {
      const existing = byBucket.get(row.bucket_start_ms);
      if (existing) existing.push(row);
      else byBucket.set(row.bucket_start_ms, [row]);
    }

    return [...byBucket.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([bucketStartMs, bucketRows]) => ({ bucketStartMs, ...foldTotals(bucketRows) }));
  }

  /**
   * Every event in [fromMs, toMs] that passes the provider filter, with the
   * columns of SourceRow. Whole hours come from usage_hourly with the hour
   * start as their timestamp. Raw events cover the partial hours
   * at each end of the range and any hour a split point falls inside, so a
   * caller grouping on a boundary there still sees exact timestamps.
   */
  private source(fromMs: number, toMs: number, providers?: UsageProvider[], splitPointsMs: number[] = []): UsageSource {
    const { clause, params } = this.providerFilter(providers);
    let wholeFrom = Math.ceil(fromMs / ROLLUP_BUCKET_MS) * ROLLUP_BUCKET_MS;
    let wholeTo = Math.floor((toMs + 1) / ROLLUP_BUCKET_MS) * ROLLUP_BUCKET_MS;
    // A range inside a single hour has no whole hours; read it all raw.
    if (wholeFrom >= wholeTo) wholeFrom = wholeTo = toMs + 1;
    const splitHours = [...new Set(splitPointsMs
      .filter(point => point % ROLLUP_BUCKET_MS !== 0)
      .map(point => Math.floor(point / ROLLUP_BUCKET_MS) * ROLLUP_BUCKET_MS)
      .filter(hour => hour >= wholeFrom && hour < wholeTo))];
    // Half-open [start, end) windows read from raw events.
    const rawWindows = [
      [fromMs, wholeFrom],
      [wholeTo, toMs + 1],
      ...splitHours.map(hour => [hour, hour + ROLLUP_BUCKET_MS]),
    ].filter(([start, end]) => start < end);
    return {
      sql: `
        SELECT hour_ms AS timestamp_ms, first_ms, last_ms, cwd, model, provider, input_tokens,
          output_tokens, cache_read_tokens, cache_creation_tokens, message_count
        FROM usage_hourly
        WHERE hour_ms >= ? AND hour_ms < ?
          AND hour_ms NOT IN (SELECT value FROM json_each(?)) ${clause}
        UNION ALL
        SELECT timestamp_ms, timestamp_ms, timestamp_ms, COALESCE(cwd, ''), model, provider,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, 1
        FROM json_each(?) AS raw_window
        JOIN usage_events
          ON timestamp_ms >= raw_window.value ->> 0 AND timestamp_ms < raw_window.value ->> 1
        WHERE 1 = 1 ${clause}
      `,
      params: [wholeFrom, wholeTo, JSON.stringify(splitHours), ...params, JSON.stringify(rawWindows), ...params],
    };
  }

  /** Pane lifetimes by worktree path, newest first, as the attribution rule orders them. */
  private paneLifetimes(): Map<string, PaneLifetime[]> {
    // SAFETY: The fixed projection aliases every field read below.
    const rows = this.db.prepare(`
      SELECT
        id,
        worktree_path,
        CAST(strftime('%s', created_at) AS INTEGER) * 1000 AS created_ms,
        archived IS NULL OR archived = 0 AS active,
        CAST(strftime('%s', updated_at) AS INTEGER) * 1000 + 999 AS end_ms
      FROM sessions
      ORDER BY created_ms DESC, id
    `).all() as Array<{ id: string; worktree_path: string; created_ms: number | null; active: number; end_ms: number | null }>;
    const byPath = new Map<string, PaneLifetime[]>();
    for (const row of rows) {
      const lifetime = { id: row.id, createdMs: row.created_ms, active: row.active === 1, endMs: row.end_ms };
      const existing = byPath.get(row.worktree_path);
      if (existing) existing.push(lifetime);
      else byPath.set(row.worktree_path, [lifetime]);
    }
    return byPath;
  }

  private providerFilter(providers?: UsageProvider[]): ProviderFilter {
    if (!providers || providers.length === 0) return { clause: '', params: [] };
    const placeholders = providers.map(() => '?').join(', ');
    return { clause: `AND provider IN (${placeholders})`, params: [...providers] };
  }
}

/** Normalise a report request into a concrete, bounded range. */
export function resolveReportRange(
  request: UsageReportRequest | undefined,
  nowMs: number,
  defaultDays: number
): ResolvedReportRange {
  const toMs = request?.toMs ?? nowMs;
  const fromMs = request?.fromMs ?? toMs - defaultDays * DAY_MS;
  // An hourly series over months would return thousands of points; pick the
  // bucket from the range unless the caller was explicit.
  const bucket = request?.bucket ?? (toMs - fromMs <= 2 * DAY_MS ? 'hour' : 'day');
  return { fromMs: Math.min(fromMs, toMs), toMs, bucket };
}
