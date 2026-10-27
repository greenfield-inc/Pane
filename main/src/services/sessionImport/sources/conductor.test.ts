import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readConductor } from './conductor';
import type { ReaderContext } from './types';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const CLAUDE_A = '11111111-1111-4111-8111-111111111111';
const CLAUDE_B = '22222222-2222-4222-8222-222222222222';
const CODEX_THREAD = '019a0000-0000-7000-8000-00000000000a';
const CODEX_CLI_THREAD = '019a0000-0000-7000-8000-00000000000b';

let root: string;
let home: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-reader-'));
  home = path.join(root, 'home');
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
    sinceMs: NOW - 30 * DAY,
    tempDir: root,
    isPidAlive: () => false,
    processCommands: async () => [],
    ...overrides,
  };
}

const dbPath = (): string => path.join(home, 'Library', 'Application Support', 'com.conductor.app', 'conductor.db');

interface SessionRow {
  id: string;
  workspace: string;
  agent: string;
  claudeId?: string;
  title?: string;
  status?: string;
  hidden?: number;
  updatedAt: string;
}

interface WorkspaceRow {
  key: string;
  name: string;
  branch: string;
  path: string;
  state?: string;
}

/** A conductor.db shaped like the third-party readers in the research note describe it. */
function writeDb(workspaces: WorkspaceRow[], sessions: SessionRow[], workspaceKey: 'local_id' | 'id' = 'local_id'): void {
  fs.mkdirSync(path.dirname(dbPath()), { recursive: true });
  const db = new Database(dbPath());
  db.exec(`
    CREATE TABLE repos (id TEXT PRIMARY KEY, name TEXT, root_path TEXT, remote_url TEXT, default_branch TEXT);
    CREATE TABLE workspaces (${workspaceKey} TEXT PRIMARY KEY, repository_id TEXT, directory_name TEXT, branch TEXT,
      workspace_path TEXT, state TEXT, derived_status TEXT, active_session_id TEXT, pr_title TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT, agent_type TEXT, claude_session_id TEXT,
      title TEXT DEFAULT 'Untitled', model TEXT, status TEXT, is_hidden INTEGER DEFAULT 0, unread_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), last_user_message_at TEXT);
  `);
  const insertWorkspace = db.prepare(`INSERT INTO workspaces (${workspaceKey}, repository_id, directory_name, branch, workspace_path, state) VALUES (?, 'repo-1', ?, ?, ?, ?)`);
  for (const workspace of workspaces) insertWorkspace.run(workspace.key, workspace.name, workspace.branch, workspace.path, workspace.state ?? 'ready');
  const insertSession = db.prepare(`INSERT INTO sessions (id, workspace_id, agent_type, claude_session_id, title, status, is_hidden, updated_at)
    VALUES (?, ?, ?, ?, COALESCE(?, 'Untitled'), ?, ?, ?)`);
  for (const session of sessions) {
    insertSession.run(session.id, session.workspace, session.agent, session.claudeId ?? null, session.title ?? null, session.status ?? 'idle', session.hidden ?? 0, session.updatedAt);
  }
  db.close();
}

function writeClaudeTranscript(folderSlug: string, id: string): void {
  const file = path.join(home, '.claude', 'projects', folderSlug, `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', sessionId: id, cwd: '/x', entrypoint: 'sdk-ts' })}\n`);
}

function writeCodexRollout(id: string, cwd: string, source: string, originator: string): void {
  const file = path.join(home, '.codex', 'sessions', '2026', '10', '25', `rollout-2026-10-25T09-00-00-${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ timestamp: '2026-10-25T09:00:00.000Z', type: 'session_meta', payload: { id, session_id: id, cwd, source, originator, git: { branch: 'x' } } })}\n`);
  const mtime = Date.parse('2026-10-25T09:30:00Z') / 1000;
  fs.utimesSync(file, mtime, mtime);
}

const WARSAW = { key: 'ws-1', name: 'warsaw', branch: 'me/warsaw', path: '/Users/me/conductor/workspaces/app/warsaw' };
const TOKYO = { key: 'ws-2', name: 'tokyo', branch: 'me/tokyo', path: '/Users/me/conductor/workspaces/app/tokyo' };

describe('readConductor', () => {
  it('reads Claude sessions with their workspace folder, branch, title, activity and running state', async () => {
    writeDb([WARSAW, TOKYO], [
      { id: 's-1', workspace: 'ws-1', agent: 'claude', claudeId: CLAUDE_A, title: 'Fix checkout', status: 'working', updatedAt: '2026-10-26 09:00:00' },
      { id: 's-2', workspace: 'ws-2', agent: 'claude', claudeId: CLAUDE_B, status: 'idle', updatedAt: '2026-10-25 18:30:00' },
    ]);
    writeClaudeTranscript('-Users-me-conductor-workspaces-app-warsaw', CLAUDE_A);
    fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'sessions', '777.json'), JSON.stringify({ pid: 777, sessionId: CLAUDE_A, cwd: WARSAW.path }));

    const result = await readConductor(context({ isPidAlive: pid => pid === 777 }));

    expect(result.status).toBe('ok');
    expect(result.sessions).toEqual([
      { source: 'conductor', agent: 'claude', sessionId: CLAUDE_A, folder: WARSAW.path, branch: 'me/warsaw', title: 'Fix checkout', lastActiveMs: Date.parse('2026-10-26T09:00:00Z'), running: 'yes', unavailable: undefined },
      { source: 'conductor', agent: 'claude', sessionId: CLAUDE_B, folder: TOKYO.path, branch: 'me/tokyo', title: 'tokyo', lastActiveMs: Date.parse('2026-10-25T18:30:00Z'), running: 'no', unavailable: 'its Claude Code transcript isn\'t on this computer' },
    ]);
    expect(result.storePaths).toContain(dbPath());
  });

  it.each([
    ['Conductor is running', ['/Applications/Conductor.app/Contents/MacOS/conductor'], 'unknown'],
    ['Conductor is not running', [], 'no'],
  ] as const)('reads a working session with no live Claude process as %s', async (_label, commands, running) => {
    writeDb([WARSAW], [{ id: 's-1', workspace: 'ws-1', agent: 'claude', claudeId: CLAUDE_A, status: 'working', updatedAt: '2026-10-26 09:00:00' }]);
    fs.mkdirSync(path.join(home, '.claude', 'sessions'), { recursive: true });

    const result = await readConductor(context({ processCommands: async () => [...commands] }));

    expect(result.sessions.map(session => session.running)).toEqual([running]);
  });

  it('finds Codex threads in the Codex store by workspace folder', async () => {
    writeDb([WARSAW], [{ id: 's-1', workspace: 'ws-1', agent: 'codex', title: 'Port the API', updatedAt: '2026-10-25 09:30:00' }]);
    writeCodexRollout(CODEX_THREAD, WARSAW.path, 'exec', 'codex_sdk_ts');
    writeCodexRollout(CODEX_CLI_THREAD, WARSAW.path, 'cli', 'codex_cli_rs');

    const result = await readConductor(context());

    expect(result.sessions).toEqual([
      { source: 'conductor', agent: 'codex', sessionId: CODEX_THREAD, folder: WARSAW.path, branch: 'me/warsaw', title: 'Port the API', lastActiveMs: Date.parse('2026-10-25T09:30:00Z'), running: 'no' },
    ]);
  });

  it('joins workspaces on id in older databases', async () => {
    writeDb([WARSAW], [{ id: 's-1', workspace: 'ws-1', agent: 'claude', claudeId: CLAUDE_A, updatedAt: '2026-10-26 09:00:00' }], 'id');

    const result = await readConductor(context());

    expect(result.sessions.map(session => [session.sessionId, session.folder])).toEqual([[CLAUDE_A, WARSAW.path]]);
  });

  it('leaves out archived workspaces, hidden sessions, old sessions and sessions without an agent id', async () => {
    writeDb([WARSAW, { ...TOKYO, state: 'archived' }], [
      { id: 's-1', workspace: 'ws-1', agent: 'claude', claudeId: CLAUDE_A, updatedAt: '2026-10-26 09:00:00' },
      { id: 's-2', workspace: 'ws-2', agent: 'claude', claudeId: CLAUDE_B, updatedAt: '2026-10-26 09:00:00' },
      { id: 's-3', workspace: 'ws-1', agent: 'claude', claudeId: '33333333-3333-4333-8333-333333333333', hidden: 1, updatedAt: '2026-10-26 09:00:00' },
      { id: 's-4', workspace: 'ws-1', agent: 'claude', claudeId: '44444444-4444-4444-8444-444444444444', updatedAt: '2026-09-01 09:00:00' },
      { id: 's-5', workspace: 'ws-1', agent: 'claude', updatedAt: '2026-10-26 09:00:00' },
    ]);

    const result = await readConductor(context());

    expect(result.sessions.map(session => session.sessionId)).toEqual([CLAUDE_A]);
  });

  it.each(['win32', 'linux'] as const)('reports absent on %s, where Conductor does not run', async platform => {
    writeDb([WARSAW], [{ id: 's-1', workspace: 'ws-1', agent: 'claude', claudeId: CLAUDE_A, updatedAt: '2026-10-26 09:00:00' }]);

    const result = await readConductor(context({ platform }));

    expect(result.status).toBe('absent');
  });

  it('reports absent when Conductor has no database', async () => {
    const result = await readConductor(context());

    expect(result).toMatchObject({ source: 'conductor', status: 'absent', storePaths: [dbPath()] });
  });

  it('fails closed on a database shape it does not know', async () => {
    fs.mkdirSync(path.dirname(dbPath()), { recursive: true });
    const db = new Database(dbPath());
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_ref TEXT); CREATE TABLE workspaces (id TEXT PRIMARY KEY); PRAGMA user_version = 91;');
    db.close();

    const result = await readConductor(context());

    expect(result).toMatchObject({ status: 'unreadable', version: '91', sessions: [] });
  });

  it('leaves the live database untouched', async () => {
    writeDb([WARSAW], [{ id: 's-1', workspace: 'ws-1', agent: 'claude', claudeId: CLAUDE_A, updatedAt: '2026-10-26 09:00:00' }]);
    const before = [fs.readFileSync(dbPath()), fs.statSync(dbPath()).mtimeMs];

    await readConductor(context());

    expect([fs.readFileSync(dbPath()), fs.statSync(dbPath()).mtimeMs]).toEqual(before);
    expect(fs.readdirSync(path.dirname(dbPath()))).toEqual(['conductor.db']);
    expect(fs.readdirSync(root).filter(name => name.startsWith('store-'))).toEqual([]);
  });
});
