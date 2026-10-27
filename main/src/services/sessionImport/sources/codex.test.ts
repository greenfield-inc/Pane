import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readCodex } from './codex';
import type { ReaderContext } from './types';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ID_A = '019a0000-0000-7000-8000-00000000000a';
const ID_B = '019a0000-0000-7000-8000-00000000000b';
const ID_C = '019a0000-0000-7000-8000-00000000000c';
const ID_D = '019a0000-0000-7000-8000-00000000000d';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-reader-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function context(overrides: Partial<ReaderContext> = {}): ReaderContext {
  return {
    env: {},
    home: path.join(root, 'home'),
    platform: 'darwin',
    now: NOW,
    sinceMs: NOW - 30 * DAY,
    tempDir: root,
    isPidAlive: () => false,
    processCommands: async () => [],
    ...overrides,
  };
}

const defaultHome = (): string => path.join(root, 'home', '.codex');

/** Fields of a session_meta payload, as the research note lists them. */
interface MetaPayload {
  session_id?: string;
  cwd?: string;
  source?: string | { subagent: { thread_spawn: { parent_thread_id: string } } };
  originator?: string;
  git?: { branch: string };
}

function writeRollout(home: string, id: string, payload: MetaPayload, mtime: number, firstLine?: string): string {
  const file = path.join(home, 'sessions', '2026', '10', '22', `rollout-2026-10-22T01-41-33-${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const meta = firstLine ?? JSON.stringify({
    timestamp: '2026-10-22T01:41:33.000Z',
    type: 'session_meta',
    payload: {
      id,
      session_id: id,
      cwd: '/work/app',
      timestamp: '2026-10-22T01:41:33.000Z',
      originator: 'codex_cli_rs',
      cli_version: '0.164.0',
      source: 'cli',
      base_instructions: { text: 'x'.repeat(200 * 1024) },
      git: { branch: 'main', commit_hash: 'abc123', repository_url: 'git@github.com:me/app.git' },
      ...payload,
    },
  });
  const turn = JSON.stringify({ timestamp: '2026-10-22T01:42:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'hi' } });
  fs.writeFileSync(file, `${meta}\n${turn}\n`);
  fs.utimesSync(file, mtime / 1000, mtime / 1000);
  return file;
}

function writeIndex(home: string, entries: Array<{ id: string; thread_name: string; updated_at: string }>): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'session_index.jsonl'), entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
}

function writeLock(home: string, id: string): void {
  fs.mkdirSync(path.join(home, 'thread-writer-locks'), { recursive: true });
  fs.writeFileSync(path.join(home, 'thread-writer-locks', `${id}.lock`), '');
}

describe('readCodex', () => {
  it('reads thread id, folder, branch, name and last activity', async () => {
    const home = defaultHome();
    const active = NOW - 3 * 60 * 60 * 1000;
    writeRollout(home, ID_A, { cwd: '/work/app', git: { branch: 'feature/search' } }, active);
    writeIndex(home, [
      { id: ID_A, thread_name: 'Old name', updated_at: '2026-10-22T02:00:00Z' },
      { id: ID_A, thread_name: 'Search page', updated_at: '2026-10-23T02:00:00Z' },
    ]);
    fs.mkdirSync(path.join(home, 'thread-writer-locks'));

    const result = await readCodex(context());

    expect(result.status).toBe('ok');
    expect(result.sessions).toEqual([
      { source: 'codex', agent: 'codex', sessionId: ID_A, folder: '/work/app', branch: 'feature/search', title: 'Search page', lastActiveMs: active, running: 'no' },
    ]);
  });

  it.each([
    ['a lock and a live codex process', true, ['/opt/homebrew/bin/codex'], 'yes'],
    ['a lock left by a crash', true, ['/usr/bin/vim'], 'no'],
    ['no lock while codex runs another thread', false, ['/usr/local/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex'], 'no'],
  ] as const)('reads running from %s', async (_label, locked, commands, running) => {
    const home = defaultHome();
    writeRollout(home, ID_A, {}, NOW - DAY);
    fs.mkdirSync(path.join(home, 'thread-writer-locks'), { recursive: true });
    if (locked) writeLock(home, ID_A);

    const result = await readCodex(context({ processCommands: async () => [...commands] }));

    expect(result.sessions.map(session => session.running)).toEqual([running]);
  });

  it('says running is unknown when Codex keeps no writer locks and a codex process runs', async () => {
    writeRollout(defaultHome(), ID_A, {}, NOW - DAY);

    const result = await readCodex(context({ processCommands: async () => ['codex'] }));

    expect(result.sessions.map(session => session.running)).toEqual(['unknown']);
  });

  it.each(['darwin', 'win32', 'linux'] as const)('finds the store in <home>/.codex on %s', async platform => {
    writeRollout(defaultHome(), ID_A, {}, NOW - DAY);

    const result = await readCodex(context({ platform }));

    expect(result.sessions.map(session => session.sessionId)).toEqual([ID_A]);
    expect(result.storePaths[0]).toBe(path.join(root, 'home', '.codex', 'sessions'));
  });

  it('uses CODEX_HOME over the home folder', async () => {
    const custom = path.join(root, 'custom-codex');
    writeRollout(custom, ID_B, {}, NOW - DAY);
    writeRollout(defaultHome(), ID_A, {}, NOW - DAY);

    const result = await readCodex(context({ env: { CODEX_HOME: custom } }));

    expect(result.sessions.map(session => session.sessionId)).toEqual([ID_B]);
  });

  it('reports absent when there is no Codex store', async () => {
    const result = await readCodex(context());

    expect(result).toMatchObject({ source: 'codex', status: 'absent', sessions: [] });
  });

  it('fails closed when rollouts do not start with session_meta', async () => {
    writeRollout(defaultHome(), ID_A, {}, NOW - DAY, JSON.stringify({ kind: 'thread_header', thread: ID_A }));

    const result = await readCodex(context());

    expect(result.status).toBe('unreadable');
  });

  it('leaves out old, exec and subagent threads', async () => {
    const home = defaultHome();
    writeRollout(home, ID_A, {}, NOW - DAY);
    writeRollout(home, ID_B, {}, NOW - 31 * DAY);
    writeRollout(home, ID_C, { source: 'exec', originator: 'codex_exec' }, NOW - DAY);
    writeRollout(home, ID_D, { session_id: ID_A, source: { subagent: { thread_spawn: { parent_thread_id: ID_A } } } }, NOW - DAY);

    const result = await readCodex(context());

    expect(result.sessions.map(session => session.sessionId)).toEqual([ID_A]);
  });

  it('leaves the store and its locks untouched', async () => {
    const home = defaultHome();
    const file = writeRollout(home, ID_A, {}, NOW - DAY);
    writeLock(home, ID_A);
    const lock = path.join(home, 'thread-writer-locks', `${ID_A}.lock`);
    const before = [fs.readFileSync(file, 'utf8'), fs.statSync(file).mtimeMs, fs.statSync(lock).mtimeMs, fs.readdirSync(path.dirname(lock))];

    await readCodex(context({ processCommands: async () => ['codex'] }));

    expect([fs.readFileSync(file, 'utf8'), fs.statSync(file).mtimeMs, fs.statSync(lock).mtimeMs, fs.readdirSync(path.dirname(lock))]).toEqual(before);
  });

  it('reports the folder of a locked thread while Codex runs, even when its rollout is too old to list', async () => {
    const home = defaultHome();
    writeRollout(home, ID_A, { cwd: '/work/old' }, NOW - 60 * DAY);
    writeLock(home, ID_A);

    const running = await readCodex(context({ processCommands: async () => ['/opt/homebrew/bin/codex'] }));
    const stopped = await readCodex(context({ processCommands: async () => ['/usr/bin/vim'] }));

    expect(running.sessions).toEqual([]);
    expect(running.busy).toEqual([{ folder: '/work/old', agent: 'codex', sessionId: ID_A }]);
    expect(stopped.busy).toEqual([]);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('keeps the other locked threads when one locked rollout can\'t be read', async () => {
    const home = defaultHome();
    const unreadable = writeRollout(home, ID_A, { cwd: '/work/old' }, NOW - 60 * DAY);
    writeRollout(home, ID_B, { cwd: '/work/app' }, NOW - DAY);
    writeLock(home, ID_A);
    writeLock(home, ID_B);
    fs.chmodSync(unreadable, 0o000);
    try {
      const result = await readCodex(context({ processCommands: async () => ['/opt/homebrew/bin/codex'] }));

      expect(result.status).toBe('ok');
      expect(result.sessions.map(session => [session.sessionId, session.running])).toEqual([[ID_B, 'yes']]);
      expect(result.busy).toEqual([{ folder: '/work/app', agent: 'codex', sessionId: ID_B }]);
    } finally {
      fs.chmodSync(unreadable, 0o600);
    }
  });
});
