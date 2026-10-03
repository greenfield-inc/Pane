import type { Database } from 'better-sqlite3-multiple-ciphers';
import { usageProviderFrom, type UsageEvent, type UsageProvider, type UsageRateLimitSample } from '../../../../shared/types/usage';
import { usageEventId, type CodexContextSnapshot } from './usageParser';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';

export interface UsageFileCursor {
  path: string;
  provider: UsageProvider;
  sizeBytes: number;
  mtimeMs: number;
  offsetBytes: number;
  lastScannedMs: number;
  /** Parser that produced this file's events; see USAGE_PARSER_VERSION. */
  parserVersion: number;
  /**
   * Codex attribution as of `offsetBytes`. Stored with the cursor because it
   * describes the same point in the file, and a resumed scan is past the lines
   * that state it. Null for Claude and for files never scanned as Codex.
   */
  parseContext: CodexContextSnapshot | null;
}

interface UsageFileRow {
  path: string;
  provider: string;
  size_bytes: number;
  mtime_ms: number;
  offset_bytes: number;
  last_scanned_ms: number;
  parser_version: number | null;
  parse_context: string | null;
}

const codexContextSchema = boundary.object({
  model: boundary.nullable(boundary.string),
  sessionId: boundary.nullable(boundary.string),
  cwd: boundary.nullable(boundary.string),
});

/** A stored context, or null if the column is empty or no longer parses. */
function readParseContext(raw: string | null | undefined): CodexContextSnapshot | null {
  if (!raw) return null;
  try {
    return decodeOptionalBoundary(JSON.parse(raw), codexContextSchema) ?? null;
  } catch {
    return null;
  }
}

/**
 * Persistence for the transcript index.
 *
 * Uses the raw better-sqlite3 handle rather than growing the ~5,000-line
 * `DatabaseService` facade — the same escape hatch `ScrollbackRetentionService`
 * uses for its sweeps.
 */
export class UsageRepository {
  constructor(private db: Database) {}

  getFileCursor(path: string): UsageFileCursor | null {
    // SAFETY: The fixed SELECT * projection matches the usage_files schema.
    const row = this.db
      .prepare('SELECT * FROM usage_files WHERE path = ?')
      .get(path) as UsageFileRow | undefined;
    if (!row) return null;

    return {
      path: row.path,
      provider: usageProviderFrom(row.provider),
      sizeBytes: row.size_bytes,
      mtimeMs: row.mtime_ms,
      offsetBytes: row.offset_bytes,
      lastScannedMs: row.last_scanned_ms,
      parserVersion: row.parser_version ?? 0,
      parseContext: readParseContext(row.parse_context),
    };
  }

  /**
   * Persist a file's parsed events and advance its cursor in one transaction,
   * so a crash mid-file cannot leave the cursor ahead of the stored rows.
   */
  commitFile(
    cursor: UsageFileCursor,
    events: Array<{ event: UsageEvent; byteOffset: number }>,
    nowMs: number
  ): number {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO usage_events (
        id, provider, timestamp_ms, model,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        agent_session_id, cwd, source_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const upsertFile = this.db.prepare(`
      INSERT INTO usage_files (
        path, provider, size_bytes, mtime_ms, offset_bytes, last_scanned_ms,
        parser_version, parse_context
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        provider = excluded.provider,
        size_bytes = excluded.size_bytes,
        mtime_ms = excluded.mtime_ms,
        offset_bytes = excluded.offset_bytes,
        last_scanned_ms = excluded.last_scanned_ms,
        parser_version = excluded.parser_version,
        parse_context = excluded.parse_context
    `);

    const run = this.db.transaction(() => {
      let inserted = 0;
      for (const { event, byteOffset } of events) {
        const result = insert.run(
          usageEventId(event, cursor.path, byteOffset),
          event.provider,
          event.timestampMs,
          event.model,
          event.inputTokens,
          event.outputTokens,
          event.cacheReadTokens,
          event.cacheCreationTokens,
          event.agentSessionId,
          event.cwd,
          cursor.path
        );
        inserted += result.changes;
      }

      upsertFile.run(
        cursor.path,
        cursor.provider,
        cursor.sizeBytes,
        cursor.mtimeMs,
        cursor.offsetBytes,
        nowMs,
        cursor.parserVersion,
        cursor.parseContext ? JSON.stringify(cursor.parseContext) : null
      );

      return inserted;
    });

    return run();
  }

  /**
   * Keep only the newest sample per limit; older re-scans must not regress it.
   * Equal timestamps DO overwrite: a parser-version rescan re-reads the same
   * newest event, and that is how columns added later (credits, limit_name)
   * get backfilled on an upgraded installation.
   */
  recordRateLimits(samples: UsageRateLimitSample[]): void {
    if (samples.length === 0) return;

    const upsert = this.db.prepare(`
      INSERT INTO usage_rate_limits (
        provider, limit_id, scope, used_percent, window_minutes,
        resets_at_ms, plan_type, captured_at_ms,
        credits_has, credits_balance, credits_unlimited,
        rate_limit_reached_type, spend_control_reached, limit_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, limit_id, scope) DO UPDATE SET
        used_percent = excluded.used_percent,
        window_minutes = excluded.window_minutes,
        resets_at_ms = excluded.resets_at_ms,
        plan_type = excluded.plan_type,
        captured_at_ms = excluded.captured_at_ms,
        credits_has = excluded.credits_has,
        credits_balance = excluded.credits_balance,
        credits_unlimited = excluded.credits_unlimited,
        rate_limit_reached_type = excluded.rate_limit_reached_type,
        spend_control_reached = excluded.spend_control_reached,
        limit_name = excluded.limit_name
      WHERE excluded.captured_at_ms >= usage_rate_limits.captured_at_ms
    `);

    this.db.transaction(() => {
      for (const sample of samples) {
        upsert.run(
          sample.provider,
          sample.limitId,
          sample.scope,
          sample.usedPercent,
          sample.windowMinutes,
          sample.resetsAtMs,
          sample.planType,
          sample.capturedAtMs,
          sample.creditsHas === null ? null : sample.creditsHas ? 1 : 0,
          sample.creditsBalance,
          sample.creditsUnlimited === null ? null : sample.creditsUnlimited ? 1 : 0,
          sample.rateLimitReachedType,
          sample.spendControlReached === null ? null : sample.spendControlReached ? 1 : 0,
          sample.limitName
        );
      }
    })();
  }

  /**
   * The current quota state, one row per provider and window.
   *
   * Rows are stored per `limit_id`, which the provider changes when the plan or
   * account behind a session changes — so the table accumulates several ids over
   * time and listing it raw showed four near-identical "OpenAI 7d window" bars.
   * A provider only ever has one primary (rolling) and one secondary (weekly)
   * window in force, so the newest capture of each is the answer; the older
   * ids are history, not additional limits.
   *
   * Readings whose window has already elapsed are dropped rather than shown at
   * their last value: "0% of a window that ended 54 days ago" is not a fact
   * about the present, and a progress bar makes it look like one.
   */
  getRateLimits(nowMs: number): UsageRateLimitSample[] {
    // SAFETY: The fixed SELECT * projection matches usage_rate_limits below.
    const rows = this.db.prepare(`
      SELECT * FROM usage_rate_limits ORDER BY provider, scope, captured_at_ms DESC
    `).all() as Array<{
      provider: string;
      limit_id: string;
      scope: string;
      used_percent: number;
      window_minutes: number | null;
      resets_at_ms: number | null;
      plan_type: string | null;
      captured_at_ms: number;
      credits_has: number | null;
      credits_balance: string | null;
      credits_unlimited: number | null;
      rate_limit_reached_type: string | null;
      spend_control_reached: number | null;
      limit_name: string | null;
    }>;

    const newestPerWindow = new Map<string, UsageRateLimitSample>();

    for (const row of rows) {
      // Expired by its own reset time, or — when the provider named no reset —
      // older than the window it describes.
      const windowMs = (row.window_minutes ?? 0) * 60_000;
      const expired = row.resets_at_ms !== null
        ? row.resets_at_ms <= nowMs
        : windowMs > 0 && row.captured_at_ms + windowMs <= nowMs;
      if (expired) continue;

      const sample: UsageRateLimitSample = {
        provider: usageProviderFrom(row.provider),
        limitId: row.limit_id,
        scope: row.scope === 'secondary' ? 'secondary' : 'primary',
        usedPercent: row.used_percent,
        windowMinutes: row.window_minutes,
        resetsAtMs: row.resets_at_ms,
        planType: row.plan_type,
        capturedAtMs: row.captured_at_ms,
        creditsHas: row.credits_has === null ? null : row.credits_has === 1,
        creditsBalance: row.credits_balance,
        creditsUnlimited: row.credits_unlimited === null ? null : row.credits_unlimited === 1,
        rateLimitReachedType: row.rate_limit_reached_type,
        spendControlReached: row.spend_control_reached === null ? null : row.spend_control_reached === 1,
        limitName: row.limit_name,
      };

      const key = `${sample.provider}:${sample.scope}`;
      const existing = newestPerWindow.get(key);
      if (!existing || existing.capturedAtMs < sample.capturedAtMs) {
        newestPerWindow.set(key, sample);
      }
    }

    // Retire scopes that no longer appear in the provider's latest events.
    // When a plan change drops a window (e.g. OpenAI removes the 5h primary
    // and promotes 7d into that slot), the absent scope stops getting new
    // samples but its old row lingers until its window expires. Comparing
    // capture timestamps detects this: within one token_count event, all
    // active scopes share the same timestamp, so a scope lagging behind the
    // provider's newest capture was not present in that event.
    const maxCapturePerProvider = new Map<string, number>();
    for (const sample of newestPerWindow.values()) {
      const prev = maxCapturePerProvider.get(sample.provider) ?? 0;
      if (sample.capturedAtMs > prev) {
        maxCapturePerProvider.set(sample.provider, sample.capturedAtMs);
      }
    }
    for (const [key, sample] of newestPerWindow) {
      const providerMax = maxCapturePerProvider.get(sample.provider);
      if (providerMax && sample.capturedAtMs < providerMax) {
        newestPerWindow.delete(key);
      }
    }

    return [...newestPerWindow.values()]
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.scope.localeCompare(b.scope));
  }

  /**
   * Swap one provider's events inside a time window for a freshly fetched set.
   *
   * The delete runs only after the caller has the full replacement in hand, and
   * it shares a transaction with the insert, so a failed fetch cannot erase the
   * previous window.
   */
  replaceProviderWindow(options: {
    sourcePath: string;
    provider: UsageProvider;
    fromMs: number;
    toMs: number;
    events: UsageEvent[];
    limits: UsageRateLimitSample[];
    nowMs: number;
    parserVersion: number;
    /** When set, Cursor rows for any other chat id are removed, including ones outside the window. */
    keepSessionIds?: readonly string[];
  }): void {
    const remove = this.db.prepare(`
      DELETE FROM usage_events
      WHERE provider = ? AND timestamp_ms >= ? AND timestamp_ms <= ?
    `);
    const insert = this.db.prepare(`
      INSERT INTO usage_events (
        id, provider, timestamp_ms, model,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        agent_session_id, cwd, source_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const upsertFile = this.db.prepare(`
      INSERT INTO usage_files (
        path, provider, size_bytes, mtime_ms, offset_bytes, last_scanned_ms,
        parser_version, parse_context
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        provider = excluded.provider,
        size_bytes = excluded.size_bytes,
        mtime_ms = excluded.mtime_ms,
        offset_bytes = excluded.offset_bytes,
        last_scanned_ms = excluded.last_scanned_ms,
        parser_version = excluded.parser_version,
        parse_context = excluded.parse_context
    `);

    this.db.transaction(() => {
      remove.run(options.provider, options.fromMs, options.toMs);
      for (const event of options.events) {
        insert.run(
          usageEventId(event, options.sourcePath, 0),
          event.provider,
          event.timestampMs,
          event.model,
          event.inputTokens,
          event.outputTokens,
          event.cacheReadTokens,
          event.cacheCreationTokens,
          event.agentSessionId,
          event.cwd,
          options.sourcePath,
        );
      }
      upsertFile.run(
        options.sourcePath,
        options.provider,
        0,
        options.nowMs,
        1,
        options.nowMs,
        options.parserVersion,
        null,
      );
      if (options.keepSessionIds) {
        const keep = new Set(options.keepSessionIds);
        // SAFETY: This SELECT returns the usage_events primary key and nullable session id.
        const stale = this.db.prepare(`
          SELECT id, agent_session_id FROM usage_events WHERE provider = ?
        `).all(options.provider) as Array<{ id: string; agent_session_id: string | null }>;
        const removeStale = this.db.prepare('DELETE FROM usage_events WHERE id = ?');
        for (const row of stale) {
          if (!row.agent_session_id || !keep.has(row.agent_session_id)) removeStale.run(row.id);
        }
      }
      this.recordRateLimits(options.limits);
    })();
  }

  countFiles(): number {
    // SAFETY: COUNT(*) always returns one numeric n column.
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM usage_files').get() as { n: number };
    return row.n;
  }

  countEvents(): number {
    // SAFETY: COUNT(*) always returns one numeric n column.
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM usage_events').get() as { n: number };
    return row.n;
  }

  /** Drop events older than the cutoff so the table stays bounded. */
  pruneOlderThan(cutoffMs: number): number {
    return this.db.prepare('DELETE FROM usage_events WHERE timestamp_ms < ?').run(cutoffMs).changes;
  }

  /** Forget a transcript file that no longer exists on disk. */
  forgetFile(path: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM usage_events WHERE source_path = ?').run(path);
      this.db.prepare('DELETE FROM usage_files WHERE path = ?').run(path);
    })();
  }
}
