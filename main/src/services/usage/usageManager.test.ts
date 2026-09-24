import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { UsageManager } from './usageManager';
import { databaseService } from '../database';
import { UsageRepository } from './usageRepository';
import { ensureUsageRollup } from './usageRollup';
import { scanJsonlFile } from './jsonlScanner';
import type { UsageProvider } from '../../../../shared/types/usage';

// The manager imports the application database singleton before test setup.
// Isolate that initialization as well as the injected in-memory repositories.
const appDirectory = vi.hoisted(() => {
  const previous = process.env.PANE_DIR;
  const root = process.env.TMPDIR ?? process.env.TEMP ?? '/tmp';
  const directory = `${root}/pane-usage-manager-${process.pid}-${process.env.VITEST_POOL_ID}-${Date.now()}`;
  process.env.PANE_DIR = directory;
  return { previous, directory };
});

afterAll(async () => {
  databaseService.getDb().close();
  await rm(appDirectory.directory, { recursive: true, force: true });
  if (appDirectory.previous === undefined) delete process.env.PANE_DIR;
  else process.env.PANE_DIR = appDirectory.previous;
});

const POLL_MS = 4 * 60 * 60 * 1000;
let home: string;
let db: InstanceType<typeof Database>;
let repository: UsageRepository;
let manager: UsageManager;
let message = 0;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function usage(provider: UsageProvider): string {
  const id = ++message;
  return JSON.stringify(provider === 'claude' ? {
    type: 'assistant', timestamp: new Date().toISOString(), sessionId: 'synthetic',
    message: { id: `message-${id}`, model: 'claude-sonnet-4', usage: { input_tokens: 10, output_tokens: 2 } },
  } : {
    type: 'event_msg', timestamp: new Date().toISOString(),
    payload: { type: 'token_count', rate_limits: { limit_id: 'codex', primary: { used_percent: 42, window_minutes: 300 } }, info: {
      last_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      total_token_usage: { input_tokens: id * 10, output_tokens: id * 2, total_tokens: id * 12 },
    } },
  }) + '\n';
}

async function transcript(relative: string, provider: UsageProvider): Promise<string> {
  const path = join(home, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, usage(provider));
  return path;
}

function createManager(
  scanFile: typeof scanJsonlFile = scanJsonlFile,
  roots: () => Array<{ provider: UsageProvider; path: string }> = () => [
    { provider: 'claude', path: join(home, '.claude/projects') },
    { provider: 'codex', path: join(home, '.codex/sessions') },
  ],
) {
  return new UsageManager({
    roots,
    repository, scanFile,
    createPriceProvider: () => ({ start() {}, stop() {} }),
  });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  home = await mkdtemp(join(tmpdir(), 'pane-usage-poll-test-'));
  db = new Database(':memory:');
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
      agent_session_id TEXT,
      cwd TEXT,
      source_path TEXT NOT NULL
    );
  `);
  ensureUsageRollup(db);
  repository = new UsageRepository(db);
  manager = createManager();
});

afterEach(async () => {
  manager.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  db.close();
  await rm(home, { recursive: true, force: true });
});

describe('usage polling', () => {
  it('indexes every layout at startup and discovers appends, new directories and files on the four-hour tick', async () => {
    const layouts: Array<[string, UsageProvider]> = [
      ['.claude/projects/project/session.jsonl', 'claude'],
      ['.claude/projects/project/session/subagents/agent.jsonl', 'claude'],
      ['.codex/sessions/2026/09/09/rollout.jsonl', 'codex'],
    ];
    const files = await Promise.all(layouts.map(([path, provider]) => transcript(path, provider)));
    await manager.start();
    await vi.waitFor(() => expect(repository.countEvents()).toBe(3));
    for (const [i, path] of files.entries()) await appendFile(path, usage(layouts[i][1]));
    await transcript('.claude/projects/new/session/subagents/new.jsonl', 'claude');
    await transcript('.codex/sessions/2027/01/01/new.jsonl', 'codex');
    await vi.advanceTimersByTimeAsync(POLL_MS - 1);
    expect(repository.countEvents()).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(repository.countEvents()).toBe(8));
    await manager.rescan();
    expect(repository.countEvents()).toBe(8);
  });

  it('discovers provider parents and transcript roots created after startup', async () => {
    await manager.start();
    await manager.rescan();
    expect(manager.getStatus().missingRoots).toHaveLength(2);
    await transcript('.claude/projects/project/session/subagents/new.jsonl', 'claude');
    await transcript('.codex/sessions/2026/09/09/new.jsonl', 'codex');
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await vi.waitFor(() => expect(repository.countEvents()).toBe(2));
    expect(manager.getStatus().missingRoots).toEqual([]);
  });

  it('queues one follow-up discovery for overlapping refreshes and never overlaps file reads', async () => {
    const entered = deferred(), release = deferred();
    let active = 0, maxActive = 0, reads = 0;
    const discover = vi.fn((): Array<{ provider: UsageProvider; path: string }> => [
      { provider: 'claude', path: join(home, '.claude/projects') },
      { provider: 'codex', path: join(home, '.codex/sessions') },
    ]);
    manager = createManager(async (...args) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const result = await scanJsonlFile(...args);
      if (++reads === 1) { entered.resolve(); await release.promise; }
      active -= 1;
      return result;
    }, discover);
    await transcript('.claude/projects/p/first.jsonl', 'claude');
    await manager.start();
    await entered.promise;
    await transcript('.codex/sessions/2026/10/01/new.jsonl', 'codex');
    let finished = false;
    const refresh = manager.rescan().then(() => { finished = true; });
    const other = manager.rescan();
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    expect(finished).toBe(false);
    release.resolve();
    await Promise.all([refresh, other]);
    expect(discover).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
    expect(reads).toBe(2);
    expect(repository.countEvents()).toBe(2);
  });

  it('discards an in-flight read after stop and cancels queued refreshes and timers', async () => {
    const entered = deferred(), release = deferred();
    manager = createManager(async (...args) => {
      const result = await scanJsonlFile(...args);
      entered.resolve(); await release.promise;
      return result;
    });
    await transcript('.codex/sessions/2026/09/09/a.jsonl', 'codex');
    const running = manager.rescan();
    await entered.promise;
    const queued = manager.rescan();
    manager.stop();
    release.resolve();
    await Promise.all([running, queued]);
    expect(repository.countEvents()).toBe(0);
    expect(repository.countFiles()).toBe(0);
    expect(repository.getRateLimits(Date.now())).toEqual([]);
    expect(manager.getStatus().lastScanFinishedMs).toBeNull();
    expect(manager.getStatus().scanning).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restarts with fresh discovery after old reads drain, without committing their stale snapshots', async () => {
    const entered = deferred(), release = deferred();
    let reads = 0;
    manager = createManager(async (...args) => {
      const result = await scanJsonlFile(...args);
      if (++reads === 1) { entered.resolve(); await release.promise; }
      return result;
    });
    const file = await transcript('.claude/projects/p/a.jsonl', 'claude');
    await manager.start();
    await entered.promise;
    manager.stop();
    await appendFile(file, usage('claude'));
    const later = await transcript('.codex/sessions/2026/11/01/later.jsonl', 'codex');
    await manager.start();
    const refresh = manager.rescan();
    release.resolve();
    await refresh;
    expect(repository.countEvents()).toBe(3);
    expect(repository.getFileCursor(later)).not.toBeNull();
    const offset = repository.getFileCursor(file)?.offsetBytes;
    await manager.rescan();
    expect(repository.getFileCursor(file)?.offsetBytes).toBe(offset);
    expect(repository.countEvents()).toBe(3);
  });

  it.each(['ENOENT', 'EMFILE'])('ignores a late %s after stop without deleting cursors or changing status', async code => {
    const entered = deferred(), release = deferred();
    let fail = false;
    manager = createManager(async (...args) => {
      if (fail) {
        entered.resolve(); await release.promise;
        throw Object.assign(new Error(`synthetic ${code}`), { code });
      }
      return scanJsonlFile(...args);
    });
    const file = await transcript('.claude/projects/p/a.jsonl', 'claude');
    await manager.rescan();
    const cursor = repository.getFileCursor(file);
    const finished = manager.getStatus().lastScanFinishedMs;
    await appendFile(file, usage('claude'));
    fail = true;
    const running = manager.rescan();
    await entered.promise;
    manager.stop();
    release.resolve();
    await running;
    expect(repository.getFileCursor(file)).toEqual(cursor);
    expect(repository.countEvents()).toBe(1);
    expect(manager.getStatus().lastError).toBeNull();
    expect(manager.getStatus().lastScanFinishedMs).toBe(finished);
  });

  it('starts only one timer and does no scheduled indexing after stop', async () => {
    await manager.start();
    await manager.start();
    await manager.rescan();
    expect(vi.getTimerCount()).toBe(1);
    manager.stop();
    expect(vi.getTimerCount()).toBe(0);
    await transcript('.claude/projects/p/a.jsonl', 'claude');
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(repository.countEvents()).toBe(0);
    await manager.start();
    await manager.rescan();
    expect(repository.countEvents()).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each(['EMFILE', 'ENFILE', 'ENOSPC'])('retains the last successful scan and error until recovery from %s', async code => {
    let fail = false;
    manager = createManager(async (...args) => {
      if (fail) throw Object.assign(new Error(`synthetic ${code}`), { code });
      return scanJsonlFile(...args);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await transcript('.claude/projects/p/a.jsonl', 'claude');
    await manager.rescan();
    const finished = manager.getStatus().lastScanFinishedMs;
    fail = true;
    await transcript('.codex/sessions/2026/09/09/b.jsonl', 'codex');
    vi.setSystemTime(Date.now() + 10_000);
    await manager.rescan();
    expect(manager.getStatus().lastError).toContain(code);
    expect(manager.getStatus().lastScanFinishedMs).toBe(finished);
    expect(warn).toHaveBeenCalledOnce();
    fail = false;
    await manager.rescan();
    expect(manager.getStatus().lastError).toBeNull();
    expect(manager.getStatus().lastScanFinishedMs).toBeGreaterThan(finished!);
    expect(repository.countEvents()).toBe(2);
  });
});
