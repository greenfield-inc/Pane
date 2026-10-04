import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import { UsageRepository } from './usageRepository';
import type { UsageRateLimitSample } from '../../../../shared/types/usage';

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 26, 12, 0, 0);

function createDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_rate_limits (
      provider TEXT NOT NULL,
      limit_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      used_percent REAL NOT NULL,
      window_minutes INTEGER,
      resets_at_ms INTEGER,
      plan_type TEXT,
      captured_at_ms INTEGER NOT NULL,
      credits_has INTEGER,
      credits_balance TEXT,
      credits_unlimited INTEGER,
      rate_limit_reached_type TEXT,
      spend_control_reached INTEGER,
      limit_name TEXT,
      PRIMARY KEY (provider, limit_id, scope)
    );
    CREATE TABLE IF NOT EXISTS usage_files (
      path TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      offset_bytes INTEGER NOT NULL DEFAULT 0,
      last_scanned_ms INTEGER NOT NULL,
      parser_version INTEGER,
      parse_context TEXT
    );
    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      metered INTEGER NOT NULL DEFAULT 1,
      agent_session_id TEXT,
      cwd TEXT,
      source_path TEXT NOT NULL
    );
  `);
  return db;
}

let db: ReturnType<typeof createDb>;
let repo: UsageRepository;

function seedRateLimit(sample: UsageRateLimitSample) {
  repo.recordRateLimits([sample]);
}

beforeEach(() => {
  db = createDb();
  repo = new UsageRepository(db);
});

describe('UsageRepository.getRateLimits', () => {
  it('leaves out limits from a provider this version does not know', () => {
    db.prepare(`
      INSERT INTO usage_rate_limits (provider, limit_id, scope, used_percent, window_minutes, resets_at_ms, captured_at_ms)
      VALUES ('gemini', 'daily', 'primary', 50, 1440, ?, ?)
    `).run(NOW + HOUR_MS, NOW - HOUR_MS);
    seedRateLimit({
      provider: 'codex', limitId: 'weekly', scope: 'primary',
      usedPercent: 20, windowMinutes: 300, resetsAtMs: NOW + HOUR_MS,
      planType: 'plus', capturedAtMs: NOW - HOUR_MS,
    });

    expect(repo.getRateLimits(NOW).map(limit => limit.provider)).toEqual(['codex']);
  });

  it('returns one row per provider+scope, newest wins', () => {
    seedRateLimit({
      provider: 'codex', limitId: 'old', scope: 'primary',
      usedPercent: 10, windowMinutes: 300, resetsAtMs: NOW + HOUR_MS,
      planType: 'plus', capturedAtMs: NOW - 2 * HOUR_MS,
    });
    seedRateLimit({
      provider: 'codex', limitId: 'new', scope: 'primary',
      usedPercent: 20, windowMinutes: 300, resetsAtMs: NOW + HOUR_MS,
      planType: 'plus', capturedAtMs: NOW - HOUR_MS,
    });

    const limits = repo.getRateLimits(NOW);
    expect(limits).toHaveLength(1);
    expect(limits[0].usedPercent).toBe(20);
  });

  /**
   * Regression (#526 review): a parser-version rescan re-reads the same newest
   * event with the same capturedAtMs. Equal timestamps must overwrite, or the
   * columns added in v4 (credits, limit_name) stay null on upgraded installs.
   */
  it('backfills new columns when the same capture is re-recorded', () => {
    seedRateLimit({
      provider: 'codex', limitId: 'same', scope: 'primary',
      usedPercent: 20, windowMinutes: 300, resetsAtMs: NOW + HOUR_MS,
      planType: 'plus', capturedAtMs: NOW - HOUR_MS,
      creditsHas: null, creditsBalance: null, creditsUnlimited: null,
      rateLimitReachedType: null, spendControlReached: null, limitName: null,
    });
    seedRateLimit({
      provider: 'codex', limitId: 'same', scope: 'primary',
      usedPercent: 20, windowMinutes: 300, resetsAtMs: NOW + HOUR_MS,
      planType: 'plus', capturedAtMs: NOW - HOUR_MS,
      creditsHas: true, creditsBalance: '12.50', creditsUnlimited: false,
      rateLimitReachedType: null, spendControlReached: false, limitName: 'codex_plus',
    });

    const limits = repo.getRateLimits(NOW);
    expect(limits).toHaveLength(1);
    expect(limits[0].limitName).toBe('codex_plus');
    expect(limits[0].creditsBalance).toBe('12.50');
  });

  it('drops expired windows', () => {
    seedRateLimit({
      provider: 'codex', limitId: 'x', scope: 'primary',
      usedPercent: 50, windowMinutes: 300,
      resetsAtMs: NOW - 1000,
      planType: null, capturedAtMs: NOW - 6 * HOUR_MS,
    });

    expect(repo.getRateLimits(NOW)).toHaveLength(0);
  });

  /**
   * Regression: OpenAI plan change drops the 5h window and promotes 7d into
   * the primary slot. Pre-change records had primary=300 + secondary=10080.
   * Post-change records have primary=10080 + no secondary. The old secondary
   * lingered because nothing displaced it and its 7d window hadn't expired.
   * Result: two "7d window" rows instead of one.
   */
  it('retires a scope when a newer capture for the same provider omits it', () => {
    // Pre-Aug-24 regime: primary=5h, secondary=7d
    seedRateLimit({
      provider: 'codex', limitId: 'old-plan', scope: 'primary',
      usedPercent: 20, windowMinutes: 300, resetsAtMs: NOW + HOUR_MS,
      planType: 'pro', capturedAtMs: NOW - 48 * HOUR_MS,
    });
    seedRateLimit({
      provider: 'codex', limitId: 'old-plan', scope: 'secondary',
      usedPercent: 0, windowMinutes: 10080, resetsAtMs: NOW + 5 * 24 * HOUR_MS,
      planType: 'pro', capturedAtMs: NOW - 48 * HOUR_MS,
    });

    // Post-Aug-24 regime: primary=7d only, secondary=null (no record emitted)
    seedRateLimit({
      provider: 'codex', limitId: 'new-plan', scope: 'primary',
      usedPercent: 20, windowMinutes: 10080, resetsAtMs: NOW + 6 * 24 * HOUR_MS,
      planType: 'pro', capturedAtMs: NOW - HOUR_MS,
    });

    const limits = repo.getRateLimits(NOW);
    expect(limits).toHaveLength(1);
    expect(limits[0].scope).toBe('primary');
    expect(limits[0].windowMinutes).toBe(10080);
    expect(limits[0].planType).toBe('pro');
  });

  it('keeps both scopes when they share the same capture time', () => {
    const capturedAt = NOW - HOUR_MS;
    seedRateLimit({
      provider: 'codex', limitId: 'plan', scope: 'primary',
      usedPercent: 30, windowMinutes: 300, resetsAtMs: NOW + HOUR_MS,
      planType: 'plus', capturedAtMs: capturedAt,
    });
    seedRateLimit({
      provider: 'codex', limitId: 'plan', scope: 'secondary',
      usedPercent: 5, windowMinutes: 10080, resetsAtMs: NOW + 6 * 24 * HOUR_MS,
      planType: 'plus', capturedAtMs: capturedAt,
    });

    const limits = repo.getRateLimits(NOW);
    expect(limits).toHaveLength(2);
  });

  it('does not cross-retire between providers', () => {
    seedRateLimit({
      provider: 'codex', limitId: 'a', scope: 'primary',
      usedPercent: 10, windowMinutes: 10080, resetsAtMs: NOW + 6 * 24 * HOUR_MS,
      planType: null, capturedAtMs: NOW - HOUR_MS,
    });
    seedRateLimit({
      provider: 'claude', limitId: 'b', scope: 'primary',
      usedPercent: 20, windowMinutes: 300, resetsAtMs: NOW + HOUR_MS,
      planType: null, capturedAtMs: NOW - 4 * HOUR_MS,
    });

    const limits = repo.getRateLimits(NOW);
    expect(limits).toHaveLength(2);
  });
});

describe('UsageRepository.commitFile', () => {
  it('stores whether each event was metered', () => {
    const base = {
      provider: 'cursor' as const,
      timestampMs: NOW,
      model: 'cursor',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      agentSessionId: 'chat-1',
      messageId: null,
      cwd: '/repo',
    };
    repo.commitFile(
      {
        path: '/t.jsonl', provider: 'cursor', sizeBytes: 10, mtimeMs: NOW, offsetBytes: 10,
        lastScannedMs: NOW, parserVersion: 4, parseContext: null,
      },
      [{ event: { ...base, metered: false }, byteOffset: 0 }, { event: { ...base, metered: true }, byteOffset: 5 }],
      NOW,
    );

    // SAFETY: SELECT metered returns the one integer column.
    const rows = db.prepare('SELECT metered FROM usage_events ORDER BY id').all() as Array<{ metered: number }>;
    expect(rows.map(row => row.metered)).toEqual([0, 1]);
  });
});
