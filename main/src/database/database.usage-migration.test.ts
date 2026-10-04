import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseService } from './database';

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

/** A database as the base branch left it: no `metered` column and the old rollup and triggers. */
function createBaseBranchDatabase(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-usage-migration-'));
  tempDirs.push(tempDir);
  const file = path.join(tempDir, 'sessions.db');
  const current = new DatabaseService(file);
  current.initialize();
  current.close();

  const db = new Database(file);
  db.exec(`
    DROP TRIGGER usage_hourly_insert;
    DROP TRIGGER usage_hourly_delete;
    DROP TABLE usage_hourly;
    ALTER TABLE usage_events DROP COLUMN metered;
    CREATE TABLE usage_hourly (
      hour_ms INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, cwd TEXT NOT NULL,
      input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL, cache_creation_tokens INTEGER NOT NULL,
      message_count INTEGER NOT NULL, first_ms INTEGER NOT NULL, last_ms INTEGER NOT NULL,
      PRIMARY KEY (hour_ms, provider, model, cwd)
    ) WITHOUT ROWID;
    CREATE TRIGGER usage_hourly_insert AFTER INSERT ON usage_events BEGIN
      INSERT INTO usage_hourly VALUES (
        CAST(NEW.timestamp_ms / 3600000 AS INTEGER) * 3600000, NEW.provider, NEW.model, COALESCE(NEW.cwd, ''),
        NEW.input_tokens, NEW.output_tokens, NEW.cache_read_tokens, NEW.cache_creation_tokens, 1,
        NEW.timestamp_ms, NEW.timestamp_ms
      )
      ON CONFLICT (hour_ms, provider, model, cwd) DO UPDATE SET message_count = message_count + 1;
    END;
    INSERT INTO usage_events (id, provider, timestamp_ms, model, input_tokens, source_path)
    VALUES ('claude-1', 'claude', 3600000, 'claude-sonnet-5', 10, '/c.jsonl');
  `);
  db.close();
  return file;
}

describe('usage tables on upgrade', () => {
  it('adds the metered column before rebuilding the rollup from existing events', () => {
    const file = createBaseBranchDatabase();

    const upgraded = new DatabaseService(file);
    upgraded.initialize();
    const db = upgraded.getDb();
    db.prepare(`
      INSERT INTO usage_events (id, provider, timestamp_ms, model, metered, source_path)
      VALUES ('cursor-1', 'cursor', 3600001, 'cursor', 0, '/t.jsonl')
    `).run();

    // SAFETY: The projection names every column of the row type.
    const hourly = db.prepare(`
      SELECT provider, message_count, unmetered_count FROM usage_hourly ORDER BY provider
    `).all() as Array<{ provider: string; message_count: number; unmetered_count: number }>;
    expect(hourly).toEqual([
      { provider: 'claude', message_count: 1, unmetered_count: 0 },
      { provider: 'cursor', message_count: 1, unmetered_count: 1 },
    ]);
    upgraded.close();
  });
});
