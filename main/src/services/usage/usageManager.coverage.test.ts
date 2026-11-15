import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { DatabaseService } from '../../database/database';
import { UsageManager } from './usageManager';
import { UsageRepository } from './usageRepository';
import { scanJsonlFile } from './jsonlScanner';
import { databaseService } from '../database';

// usageManager imports the app database singleton; isolate its migrations from
// other test workers before that module loads, even though tests inject a repo.
const appDirectory = vi.hoisted(() => {
  const previous = process.env.PANE_DIR;
  const temporaryRoot = previous ?? process.env.TMPDIR ?? process.env.TEMP ?? '/tmp';
  const directory = `${temporaryRoot}/pane-usage-coverage-${process.pid}-${process.env.VITEST_POOL_ID}`;
  process.env.PANE_DIR = directory;
  return { directory, previous };
});

afterAll(async () => {
  databaseService.getDb().close();
  await rm(appDirectory.directory, { recursive: true, force: true });
  if (appDirectory.previous === undefined) delete process.env.PANE_DIR;
  else process.env.PANE_DIR = appDirectory.previous;
});

function claudeLine(id: string): string {
  return `${JSON.stringify({
    type: 'assistant', timestamp: new Date().toISOString(),
    message: { id, model: 'claude-sonnet-4', usage: { input_tokens: 10, output_tokens: 1 } },
  })}\n`;
}

function codexLine(): string {
  return `${JSON.stringify({
    type: 'event_msg', timestamp: new Date().toISOString(),
    payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 1 } } },
  })}\n`;
}

describe('UsageManager transcript coverage without native watchers', () => {
  let directory: string;
  let database: DatabaseService;
  let repository: UsageRepository;
  let manager: UsageManager;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pane-usage-coverage-'));
    database = new DatabaseService(':memory:');
    database.initialize();
    repository = new UsageRepository(database.getDb());
    manager = new UsageManager({
      roots: () => [
        { provider: 'claude', path: join(directory, '.claude/projects') },
        { provider: 'codex', path: join(directory, '.codex/sessions') },
      ],
      repository,
      createPriceProvider: () => ({ start() {}, stop() {}, setPaused() {} }),
    });
  });

  afterEach(async () => {
    manager.stop();
    vi.useRealTimers();
    database.getDb().close();
    await rm(directory, { recursive: true, force: true });
  });

  async function addTranscript(relative: string, line: string): Promise<string> {
    const file = join(directory, relative);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, line);
    return file;
  }

  it('indexes additions and appended usage in Claude, subagent, and dated Codex layouts', async () => {
    await manager.start();
    await manager.rescan();
    const files = await Promise.all([
      addTranscript('.claude/projects/project/session.jsonl', claudeLine('parent-1')),
      addTranscript('.claude/projects/project/session/subagents/agent-child.jsonl', claudeLine('child-1')),
      addTranscript('.codex/sessions/2026/09/09/rollout-session.jsonl', codexLine()),
    ]);
    await manager.rescan();
    expect(repository.countFiles()).toBe(3);
    expect(repository.countEvents()).toBe(3);
    expect(files.map(file => repository.getFileCursor(file)?.provider)).toEqual(['claude', 'claude', 'codex']);

    await Promise.all([
      appendFile(files[0], claudeLine('parent-2')),
      appendFile(files[1], claudeLine('child-2')),
      appendFile(files[2], codexLine()),
    ]);
    await manager.rescan();
    expect(repository.countEvents()).toBe(6);
    await manager.rescan();
    expect(repository.countEvents()).toBe(6);
  });

  it('discovers newly created deep roots on the polling tick without an exhaustion error', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    await manager.start();
    await manager.rescan();
    expect(manager.getStatus().missingRoots).toHaveLength(2);
    await addTranscript('.codex/sessions/2026/09/10/rollout-new.jsonl', codexLine());
    await addTranscript('.claude/projects/project/session/subagents/agent-new.jsonl', claudeLine('new-child'));
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000);
    await vi.waitFor(() => expect(repository.countEvents()).toBe(2));
    await vi.waitFor(() => expect(manager.getStatus().scanning).toBe(false));
    expect(manager.getStatus().missingRoots).toEqual([]);
    manager.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['EMFILE', 'ENFILE', 'ENOSPC'])('recovers from a transient %s scan failure on refresh', async code => {
    let fail = true;
    manager = new UsageManager({
      roots: () => [{ provider: 'claude', path: directory }],
      repository,
      scanFile: async (...args) => {
        if (fail) throw Object.assign(new Error(`synthetic ${code}`), { code });
        return scanJsonlFile(...args);
      },
    });
    await addTranscript('project/session/subagents/agent-test.jsonl', claudeLine(code));
    await manager.rescan();
    expect(manager.getStatus().lastError).toContain(code);
    expect(repository.countEvents()).toBe(0);
    fail = false;
    await manager.rescan();
    expect(manager.getStatus().lastError).toBeNull();
    expect(repository.countEvents()).toBe(1);
  });
});
