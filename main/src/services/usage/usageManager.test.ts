import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3-multiple-ciphers';
import { appendFile, mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'fs/promises';
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
      metered INTEGER NOT NULL DEFAULT 1,
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

const PANE_CHAT = '8ff011fb-7f01-4e74-bbe1-e026d47ea50f';
const NESTED_CHAT = '11111111-2222-4333-8444-555555555555';
const OUTSIDE_CHAT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function cursorLines(...roles: string[]): string {
  return roles.map(role => JSON.stringify({ role, message: { content: [{ type: 'text', text: 'x' }] } })).join('\n') + '\n';
}

describe('Cursor transcripts', () => {
  it('indexes only chats Pane launched, as unmetered messages at the file time, and keeps them after the panel goes', async () => {
    const transcripts = join(home, '.cursor/projects/work-pane/agent-transcripts');
    await mkdir(join(transcripts, NESTED_CHAT), { recursive: true });
    const paneFile = join(transcripts, `${PANE_CHAT}.jsonl`);
    await writeFile(paneFile, cursorLines('user', 'assistant', 'assistant') + JSON.stringify({ type: 'turn_ended' }) + '\n');
    const nestedFile = join(transcripts, NESTED_CHAT, 'transcript.jsonl');
    await writeFile(nestedFile, cursorLines('assistant'));
    await writeFile(join(transcripts, `${OUTSIDE_CHAT}.jsonl`), cursorLines('assistant', 'assistant'));
    let chats = [{ chatId: PANE_CHAT, cwd: '/work/pane' }, { chatId: NESTED_CHAT, cwd: '/work/nested' }];
    manager = new UsageManager({
      roots: () => [{ provider: 'cursor', path: join(home, '.cursor/projects') }],
      repository,
      cursorChats: () => chats,
      createPriceProvider: () => ({ start() {}, stop() {} }),
    });

    await manager.start();
    await vi.waitFor(() => expect(repository.countEvents()).toBe(3));
    expect(manager.getStatus()).toMatchObject({ rootsChecked: 1, missingRoots: [] });

    // SAFETY: The projection names every column of the row type.
    const rows = () => db.prepare(`
      SELECT provider, metered, agent_session_id, cwd, timestamp_ms FROM usage_events ORDER BY agent_session_id
    `).all() as Array<{ provider: string; metered: number; agent_session_id: string; cwd: string; timestamp_ms: number }>;
    const mtimeMs = Math.floor((await stat(paneFile)).mtimeMs);
    const nestedMtimeMs = Math.floor((await stat(nestedFile)).mtimeMs);
    expect(rows()).toEqual([
      { provider: 'cursor', metered: 0, agent_session_id: NESTED_CHAT, cwd: '/work/nested', timestamp_ms: nestedMtimeMs },
      { provider: 'cursor', metered: 0, agent_session_id: PANE_CHAT, cwd: '/work/pane', timestamp_ms: mtimeMs },
      { provider: 'cursor', metered: 0, agent_session_id: PANE_CHAT, cwd: '/work/pane', timestamp_ms: mtimeMs },
    ]);

    chats = [];
    await appendFile(paneFile, cursorLines('assistant'));
    await manager.rescan();
    expect(rows().map(row => row.agent_session_id)).toEqual([NESTED_CHAT, PANE_CHAT, PANE_CHAT]);
  });

  it('checks the Cursor transcript root alongside Claude and Codex by default', async () => {
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    manager = new UsageManager({ repository, cursorChats: () => [], createPriceProvider: () => ({ start() {}, stop() {} }) });
    await manager.start();
    await manager.rescan();
    expect(manager.getStatus()).toMatchObject({ rootsChecked: 3 });
    expect(manager.getStatus().missingRoots).toContain(join(home, '.cursor', 'projects'));

    await mkdir(join(home, '.cursor', 'projects'), { recursive: true });
    await manager.rescan();
    expect(manager.getStatus().missingRoots).not.toContain(join(home, '.cursor', 'projects'));
    vi.unstubAllEnvs();
  });

  it('recounts a transcript rewritten in place instead of adding its messages again', async () => {
    const file = join(home, '.cursor/projects/work-pane/agent-transcripts', `${PANE_CHAT}.jsonl`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, cursorLines('assistant', 'assistant', 'assistant'));
    manager = new UsageManager({
      roots: () => [{ provider: 'cursor', path: join(home, '.cursor/projects') }],
      repository,
      cursorChats: () => [{ chatId: PANE_CHAT, cwd: '/work/pane' }],
      createPriceProvider: () => ({ start() {}, stop() {} }),
    });
    await manager.start();
    await vi.waitFor(() => expect(repository.countEvents()).toBe(3));

    // Shorter than before, so the scan reads it from the top.
    await writeFile(file, cursorLines('assistant', 'assistant'));
    await manager.rescan();

    expect(repository.countEvents()).toBe(2);
  });

  describe('message times', () => {
    const file = () => join(home, '.cursor/projects/work-pane/agent-transcripts', `${PANE_CHAT}.jsonl`);
    const at = (iso: string) => new Date(iso);
    // SAFETY: The projection names the one integer column.
    const times = () => (db.prepare(`
      SELECT timestamp_ms FROM usage_events ORDER BY timestamp_ms
    `).all() as Array<{ timestamp_ms: number }>).map(row => row.timestamp_ms);

    async function writeAt(content: string, mtime: Date, append = false) {
      await (append ? appendFile : writeFile)(file(), content);
      await utimes(file(), mtime, mtime);
    }

    beforeEach(async () => {
      await mkdir(dirname(file()), { recursive: true });
      await writeAt(cursorLines('assistant', 'assistant'), at('2026-09-01T10:00:00Z'));
      manager = new UsageManager({
        roots: () => [{ provider: 'cursor', path: join(home, '.cursor/projects') }],
        repository,
        cursorChats: () => [{ chatId: PANE_CHAT, cwd: '/work/pane' }],
        createPriceProvider: () => ({ start() {}, stop() {} }),
      });
      await manager.start();
      await vi.waitFor(() => expect(repository.countEvents()).toBe(2));
    });

    it('times appended messages at the later write and keeps the earlier ones', async () => {
      await writeAt(cursorLines('assistant'), at('2026-09-02T10:00:00Z'), true);
      await manager.rescan();

      expect(times()).toEqual([
        Date.parse('2026-09-01T10:00:00Z'),
        Date.parse('2026-09-01T10:00:00Z'),
        Date.parse('2026-09-02T10:00:00Z'),
      ]);
    });

    it('keeps message times when a parser change re-reads the transcript', async () => {
      db.prepare('UPDATE usage_files SET parser_version = 0').run();
      await utimes(file(), at('2026-09-03T10:00:00Z'), at('2026-09-03T10:00:00Z'));
      await manager.rescan();

      expect(times()).toEqual([Date.parse('2026-09-01T10:00:00Z'), Date.parse('2026-09-01T10:00:00Z')]);
    });

    it('recounts a rewrite that keeps or grows the file size', async () => {
      const padding = JSON.stringify({ role: 'user', message: { content: 'x'.repeat(400) } });
      await writeAt(`${padding}\n${cursorLines('assistant')}`, at('2026-09-04T10:00:00Z'));
      await manager.rescan();

      expect(times()).toEqual([Date.parse('2026-09-01T10:00:00Z')]);
    });
  });
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
    expect(manager.getStatus()).toMatchObject({ rootsChecked: 2 });
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
