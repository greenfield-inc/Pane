import type { Database } from 'better-sqlite3-multiple-ciphers';

export const ROLLUP_BUCKET_MS = 60 * 60 * 1000;

/** SQL for the start of the rollup hour holding a millisecond timestamp. */
function rollupHourOf(column: string): string {
  return `CAST(${column} / ${ROLLUP_BUCKET_MS} AS INTEGER) * ${ROLLUP_BUCKET_MS}`;
}

/**
 * `usage_hourly` holds the token sums of `usage_events` per hour, provider,
 * model and cwd. A month of events collapses about 60 times, so reports read
 * whole hours from here instead of every event. Triggers keep it exact on
 * every insert and delete, whichever code path makes them. Events are never
 * updated in place, so there is no update trigger. A missing cwd is
 * stored as '' because a primary key column cannot tell NULLs apart.
 *
 * first_ms and last_ms bound the row's event times, so a reader can tell
 * whether a boundary splits the row's events. A delete leaves them as they
 * were: the bounds may become wider than the events, never narrower.
 *
 * Creating the table backfills it from the events in the same transaction,
 * so a crash can never leave an empty rollup next to existing events.
 */
export function ensureUsageRollup(db: Database): void {
  db.transaction(() => {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usage_hourly'")
      .get();
    if (exists) return;

    const key = (row: 'NEW' | 'OLD') =>
      `${rollupHourOf(`${row}.timestamp_ms`)}, ${row}.provider, ${row}.model, COALESCE(${row}.cwd, '')`;
    db.exec(`
      CREATE TABLE usage_hourly (
        hour_ms INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        cwd TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_creation_tokens INTEGER NOT NULL,
        message_count INTEGER NOT NULL,
        first_ms INTEGER NOT NULL,
        last_ms INTEGER NOT NULL,
        PRIMARY KEY (hour_ms, provider, model, cwd)
      ) WITHOUT ROWID;

      CREATE TRIGGER usage_hourly_insert AFTER INSERT ON usage_events BEGIN
        INSERT INTO usage_hourly VALUES (
          ${key('NEW')}, NEW.input_tokens, NEW.output_tokens,
          NEW.cache_read_tokens, NEW.cache_creation_tokens, 1,
          NEW.timestamp_ms, NEW.timestamp_ms
        )
        ON CONFLICT (hour_ms, provider, model, cwd) DO UPDATE SET
          input_tokens = input_tokens + excluded.input_tokens,
          output_tokens = output_tokens + excluded.output_tokens,
          cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
          cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
          message_count = message_count + 1,
          first_ms = MIN(first_ms, excluded.first_ms),
          last_ms = MAX(last_ms, excluded.last_ms);
      END;

      CREATE TRIGGER usage_hourly_delete AFTER DELETE ON usage_events BEGIN
        UPDATE usage_hourly SET
          input_tokens = input_tokens - OLD.input_tokens,
          output_tokens = output_tokens - OLD.output_tokens,
          cache_read_tokens = cache_read_tokens - OLD.cache_read_tokens,
          cache_creation_tokens = cache_creation_tokens - OLD.cache_creation_tokens,
          message_count = message_count - 1
        WHERE (hour_ms, provider, model, cwd) = (${key('OLD')});
        DELETE FROM usage_hourly
        WHERE (hour_ms, provider, model, cwd) = (${key('OLD')}) AND message_count = 0;
      END;

      INSERT INTO usage_hourly
      SELECT ${rollupHourOf('timestamp_ms')}, provider, model, COALESCE(cwd, ''),
        SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens),
        SUM(cache_creation_tokens), COUNT(*), MIN(timestamp_ms), MAX(timestamp_ms)
      FROM usage_events
      GROUP BY 1, 2, 3, 4;
    `);
  })();
}
