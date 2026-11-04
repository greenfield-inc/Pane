import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readT3Code } from './t3code';
import type { ReaderContext } from './types';

// Fixture schema and field names from the T3 Code research note (migrations 005, 055, OrchestrationV2/Foundation).
const SCHEMA = `
  CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT);
  CREATE TABLE projection_projects (
    project_id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_root TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
  );
  CREATE TABLE orchestration_v2_projection_threads (
    thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, default_provider TEXT NOT NULL,
    runtime_mode TEXT NOT NULL, interaction_mode TEXT NOT NULL, active_provider_thread_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT, deleted_at TEXT,
    payload_json TEXT NOT NULL, provider_instance_id TEXT
  );
  CREATE TABLE orchestration_v2_projection_provider_threads (
    provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, owner_node_id TEXT, provider TEXT NOT NULL,
    provider_session_id TEXT, status TEXT NOT NULL, first_run_ordinal INTEGER, last_run_ordinal INTEGER,
    updated_at TEXT NOT NULL, payload_json TEXT NOT NULL, driver TEXT, provider_instance_id TEXT
  );
  CREATE TABLE orchestration_v2_projection_runs (
    run_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, ordinal INTEGER NOT NULL, provider TEXT NOT NULL,
    provider_thread_id TEXT, status TEXT NOT NULL, requested_at TEXT NOT NULL, completed_at TEXT, payload_json TEXT NOT NULL
  );
`;

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const SINCE = Date.parse('2026-10-01T00:00:00.000Z');
const LIVE_PID = 4242;

interface ThreadFixture {
  id: string;
  title: string;
  updatedAt: string;
  driver: string;
  nativeId: string | null;
  branch?: string;
  worktreePath?: string | null;
  instanceId?: string;
  runStatus?: string;
  providerThreadStatus?: string;
  archivedAt?: string;
  deletedAt?: string;
  relationshipToParent?: 'fork' | 'subagent' | null;
}

let root: string;
let home: string;
let tempDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 't3code-reader-'));
  home = path.join(root, 'home');
  tempDir = path.join(root, 'tmp');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function context(overrides: Partial<ReaderContext> = {}): ReaderContext {
  return {
    env: {},
    home,
    platform: 'darwin',
    now: NOW,
    sinceMs: SINCE,
    tempDir,
    isPidAlive: pid => pid === LIVE_PID,
    processCommands: async () => [],
    ...overrides,
  };
}

function writeStore(userdata: string, threads: ThreadFixture[], schema = SCHEMA): string {
  fs.mkdirSync(userdata, { recursive: true });
  const dbPath = path.join(userdata, 'statev2.sqlite');
  const db = new Database(dbPath);
  db.exec(schema);
  db.prepare('INSERT INTO effect_sql_migrations (migration_id, name) VALUES (69, ?)').run('ThreadMessageSearch');
  db.prepare('INSERT INTO projection_projects VALUES (?, ?, ?, ?, ?, NULL)')
    .run('project-1', 'shop', '/repos/shop', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
  threads.forEach((thread, index) => {
    const providerThreadId = `pt-${thread.id}`;
    const lineage = { parentThreadId: null, relationshipToParent: thread.relationshipToParent ?? null, rootThreadId: thread.id };
    db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      thread.id, 'project-1', thread.title, thread.driver, 'full-access', 'default', providerThreadId,
      '2026-09-01T00:00:00.000Z', thread.updatedAt, thread.archivedAt ?? null, thread.deletedAt ?? null,
      JSON.stringify({ branch: thread.branch ?? null, worktreePath: thread.worktreePath ?? null, lineage }),
      thread.instanceId ?? thread.driver,
    );
    db.prepare('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, NULL, ?, NULL, ?, 1, 1, ?, ?, ?, ?)').run(
      providerThreadId, thread.id, thread.driver, thread.providerThreadStatus ?? 'idle', thread.updatedAt,
      JSON.stringify({ nativeThreadRef: { driver: thread.driver, nativeId: thread.nativeId, strength: 'strong' } }),
      thread.driver, thread.instanceId ?? thread.driver,
    );
    if (thread.runStatus) {
      db.prepare('INSERT INTO orchestration_v2_projection_runs VALUES (?, ?, 1, ?, ?, ?, ?, NULL, ?)').run(
        `run-${index}`, thread.id, thread.driver, providerThreadId, thread.runStatus, thread.updatedAt, '{}',
      );
    }
  });
  db.close();
  return dbPath;
}

function writeRuntime(userdata: string, pid: number): void {
  fs.writeFileSync(path.join(userdata, 'server-runtime.json'), JSON.stringify({
    version: 1, pid, port: 3773, origin: 'http://127.0.0.1:3773', startedAt: '2026-10-26T11:00:00.000Z',
  }));
}

const defaultUserdata = (): string => path.join(home, '.t3', 'userdata');

describe('readT3Code', () => {
  it('reads each thread with its agent, native session id, folder, branch, title and activity', async () => {
    const userdata = defaultUserdata();
    writeStore(userdata, [
      {
        id: 'thread-a', title: 'Fix checkout', updatedAt: '2026-10-25T10:00:00.000Z', driver: 'claudeAgent',
        nativeId: '7f9c2d1e-0b3a-4c5d-8e6f-1a2b3c4d5e6f', branch: 't3/fix-checkout',
        worktreePath: '/home/me/.t3/worktrees/shop/t3-fix-checkout', runStatus: 'running',
      },
      {
        id: 'thread-b', title: 'Add search', updatedAt: '2026-10-24T09:30:00.000Z', driver: 'codex',
        nativeId: '019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5b', branch: 'main', worktreePath: null, runStatus: 'completed',
      },
      {
        id: 'thread-c', title: 'Try Grok', updatedAt: '2026-10-23T08:00:00.000Z', driver: 'grok',
        nativeId: 'grok-native-1', runStatus: 'waiting',
      },
    ]);
    writeRuntime(userdata, LIVE_PID);

    const result = await readT3Code(context());

    expect(result.status).toBe('ok');
    expect(result.version).toBe('schema 69');
    expect(result.sessions).toEqual([
      {
        source: 't3code', agent: 'claude', sessionId: '7f9c2d1e-0b3a-4c5d-8e6f-1a2b3c4d5e6f',
        folder: '/home/me/.t3/worktrees/shop/t3-fix-checkout', branch: 't3/fix-checkout', title: 'Fix checkout',
        lastActiveMs: Date.parse('2026-10-25T10:00:00.000Z'), running: 'yes',
      },
      {
        source: 't3code', agent: 'codex', sessionId: '019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5b',
        folder: '/repos/shop', branch: 'main', title: 'Add search',
        lastActiveMs: Date.parse('2026-10-24T09:30:00.000Z'), running: 'no',
      },
      {
        source: 't3code', agent: 'grok', sessionId: 'grok-native-1', folder: '/repos/shop', title: 'Try Grok',
        lastActiveMs: Date.parse('2026-10-23T08:00:00.000Z'), running: 'yes',
      },
    ]);
  });

  it.each(['darwin', 'win32', 'linux'] as const)('finds the store under ~/.t3 on %s', async platform => {
    writeStore(defaultUserdata(), [
      { id: 't1', title: 'One', updatedAt: '2026-10-20T00:00:00.000Z', driver: 'codex', nativeId: 'codex-1' },
    ]);
    const result = await readT3Code(context({ platform, env: { APPDATA: path.join(root, 'appdata'), XDG_CONFIG_HOME: path.join(root, 'xdg') } }));
    expect(result.sessions.map(session => session.sessionId)).toEqual(['codex-1']);
    expect(result.storePaths).toContain(path.join(home, '.t3', 'userdata', 'statev2.sqlite'));
  });

  it('uses T3CODE_HOME as the data folder when set', async () => {
    const custom = path.join(root, 'custom-t3');
    writeStore(path.join(custom, 'userdata'), [
      { id: 't1', title: 'One', updatedAt: '2026-10-20T00:00:00.000Z', driver: 'codex', nativeId: 'codex-custom' },
    ]);
    writeStore(defaultUserdata(), [
      { id: 't2', title: 'Two', updatedAt: '2026-10-20T00:00:00.000Z', driver: 'codex', nativeId: 'codex-default' },
    ]);
    const result = await readT3Code(context({ env: { T3CODE_HOME: custom } }));
    expect(result.sessions.map(session => session.sessionId)).toEqual(['codex-custom']);
  });

  it('reports absent when T3 Code has no store', async () => {
    const result = await readT3Code(context());
    expect(result).toEqual({ source: 't3code', status: 'absent', storePaths: [], sessions: [] });
  });

  it('fails closed on a pre-0.1.0 store that only has state.sqlite', async () => {
    fs.mkdirSync(defaultUserdata(), { recursive: true });
    fs.writeFileSync(path.join(defaultUserdata(), 'state.sqlite'), '');
    const result = await readT3Code(context());
    expect(result.status).toBe('unreadable');
    expect(result.version).toBe('before 0.1.0');
    expect(result.sessions).toEqual([]);
  });

  it('fails closed when the thread table lacks a column it reads', async () => {
    const schema = SCHEMA.replace('active_provider_thread_id TEXT,', 'current_provider_thread TEXT,');
    const userdata = defaultUserdata();
    fs.mkdirSync(userdata, { recursive: true });
    const db = new Database(path.join(userdata, 'statev2.sqlite'));
    db.exec(schema);
    db.prepare('INSERT INTO effect_sql_migrations (migration_id, name) VALUES (80, ?)').run('Future');
    db.close();

    const result = await readT3Code(context());

    expect(result.status).toBe('unreadable');
    expect(result.version).toBe('schema 80');
    expect(result.reason).toContain('orchestration_v2_projection_threads');
    expect(result.sessions).toEqual([]);
  });

  it('leaves out stale, archived, deleted, subagent and id-less threads', async () => {
    writeStore(defaultUserdata(), [
      { id: 'keep', title: 'Keep', updatedAt: '2026-10-20T00:00:00.000Z', driver: 'codex', nativeId: 'keep-id', relationshipToParent: 'fork' },
      { id: 'stale', title: 'Stale', updatedAt: '2026-09-30T23:59:59.000Z', driver: 'codex', nativeId: 'stale-id' },
      { id: 'archived', title: 'Archived', updatedAt: '2026-10-20T00:00:00.000Z', driver: 'codex', nativeId: 'archived-id', archivedAt: '2026-10-21T00:00:00.000Z' },
      { id: 'deleted', title: 'Deleted', updatedAt: '2026-10-20T00:00:00.000Z', driver: 'codex', nativeId: 'deleted-id', deletedAt: '2026-10-21T00:00:00.000Z' },
      { id: 'sub', title: 'Subagent', updatedAt: '2026-10-20T00:00:00.000Z', driver: 'claudeAgent', nativeId: 'sub-id', relationshipToParent: 'subagent' },
      { id: 'v1', title: 'Imported from V1', updatedAt: '2026-10-20T00:00:00.000Z', driver: 'codex', nativeId: null },
    ]);
    const result = await readT3Code(context());
    expect(result.sessions.map(session => session.sessionId)).toEqual(['keep-id']);
  });

  it('says not running when the server is down, and unknown when its marker is unreadable', async () => {
    const userdata = defaultUserdata();
    writeStore(userdata, [
      { id: 't1', title: 'One', updatedAt: '2026-10-20T00:00:00.000Z', driver: 'codex', nativeId: 'codex-1', runStatus: 'running' },
    ]);
    expect((await readT3Code(context())).sessions[0].running).toBe('no');

    writeRuntime(userdata, 999);
    expect((await readT3Code(context())).sessions[0].running).toBe('no');

    fs.writeFileSync(path.join(userdata, 'server-runtime.json'), '{"pid":');
    expect((await readT3Code(context())).sessions[0].running).toBe('unknown');
  });

  it('points at the transcript when a Claude instance keeps its own CLAUDE_CONFIG_DIR', async () => {
    const userdata = defaultUserdata();
    const sessionId = '3b1e0c9a-1111-4222-8333-944455566677';
    writeStore(userdata, [
      { id: 't1', title: 'Work account', updatedAt: '2026-10-20T00:00:00.000Z', driver: 'claudeAgent', nativeId: sessionId, instanceId: 'claude-work' },
      { id: 't2', title: 'Missing', updatedAt: '2026-10-20T00:00:00.000Z', driver: 'claudeAgent', nativeId: 'missing-id', instanceId: 'claude-work' },
    ]);
    const agentHome = path.join(home, 'claude-work');
    const transcript = path.join(agentHome, 'projects', '-repos-shop', `${sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '{}\n');
    fs.writeFileSync(path.join(userdata, 'settings.json'), JSON.stringify({
      providerInstances: { 'claude-work': { driver: 'claudeAgent', config: { homePath: '~/claude-work' } } },
    }));

    const [found, missing] = (await readT3Code(context())).sessions;

    expect(found.transcript).toEqual({ agentHome, path: transcript });
    expect(missing.transcript).toBeUndefined();
    expect(missing.unavailable).toContain(agentHome);
  });

  it('points at the rollout when a Codex instance keeps its own CODEX_HOME', async () => {
    const userdata = defaultUserdata();
    const sessionId = '019a2222-3333-7444-8555-666677778888';
    writeStore(userdata, [
      { id: 't1', title: 'Second account', updatedAt: '2026-10-20T00:00:00.000Z', driver: 'codex', nativeId: sessionId, instanceId: 'codex-2' },
    ]);
    const agentHome = path.join(root, 'codex-2-home');
    const rollout = path.join(agentHome, 'sessions', '2026', '10', '19', `rollout-2026-10-19T09-00-00-${sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(rollout), { recursive: true });
    fs.writeFileSync(rollout, '{}\n');
    fs.writeFileSync(path.join(userdata, 'settings.json'), JSON.stringify({
      providerInstances: { 'codex-2': { driver: 'codex', config: { homePath: agentHome } } },
    }));

    const [session] = (await readT3Code(context())).sessions;

    expect(session.transcript).toEqual({ agentHome, path: rollout });
  });

  it('leaves the live store untouched', async () => {
    const userdata = defaultUserdata();
    const dbPath = writeStore(userdata, [
      { id: 't1', title: 'One', updatedAt: '2026-10-20T00:00:00.000Z', driver: 'codex', nativeId: 'codex-1' },
    ]);
    const before = { bytes: fs.readFileSync(dbPath), mtimeMs: fs.statSync(dbPath).mtimeMs };

    await readT3Code(context());

    expect(fs.readFileSync(dbPath).equals(before.bytes)).toBe(true);
    expect(fs.statSync(dbPath).mtimeMs).toBe(before.mtimeMs);
    expect(fs.readdirSync(userdata)).toEqual(['statev2.sqlite']);
    expect(fs.readdirSync(tempDir)).toEqual([]);
  });
});
