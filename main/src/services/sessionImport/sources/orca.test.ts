import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, describe, expect, it } from 'vitest';
import { readOrca } from './orca';
import type { ReaderContext } from './types';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const CLAUDE_ID = '6f1c2d3e-4a5b-4c6d-8e7f-901a2b3c4d5e';
const CODEX_ID = '019a2b3c-4d5e-7f60-8a9b-0c1d2e3f4a5b';
const CURSOR_ID = 'c0ffee00-1111-4222-8333-444455556666';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-reader-'));
  roots.push(root);
  return root;
}

function context(overrides: Partial<ReaderContext>): ReaderContext {
  return {
    env: {},
    home: '/nonexistent-home',
    platform: 'darwin',
    now: NOW,
    sinceMs: NOW - 30 * DAY,
    tempDir: tempRoot(),
    isPidAlive: () => false,
    processCommands: async () => [],
    ...overrides,
  };
}

/** profile-state.db as Orca's schema writes it (profile-state-database-schema.ts:8-39), one row per PersistedState key. */
function writeProfileDb(dbPath: string, documents: ReturnType<typeof fixtureDocuments>, userVersion = 3): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE profile_state_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE profile_state_documents (
      domain TEXT PRIMARY KEY, payload TEXT NOT NULL, domain_version INTEGER NOT NULL,
      revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, content_hash TEXT NOT NULL
    );
  `);
  const insert = db.prepare('INSERT INTO profile_state_documents VALUES (?, ?, 1, 1, ?, ?)');
  for (const [domain, value] of Object.entries(documents)) insert.run(domain, JSON.stringify(value), NOW, 'hash');
  db.pragma(`user_version = ${userVersion}`);
  db.close();
}

function writeJson(file: string, json: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, json);
}

/** An Orca userData folder with an active profile `p1` and the given state. */
function orcaStore(userData: string, options: { lastStatus?: string; userVersion?: number } = {}): string {
  writeJson(path.join(userData, 'orca-profile-index.json'), JSON.stringify({ activeProfileId: 'p1', profiles: [{ id: 'p1', name: 'Default' }] }));
  const dbPath = path.join(userData, 'profiles', 'p1', 'profile-state.db');
  writeProfileDb(dbPath, fixtureDocuments(userData), options.userVersion);
  if (options.lastStatus !== undefined) writeJson(path.join(userData, 'agent-hooks', 'last-status.json'), options.lastStatus);
  return dbPath;
}

function sleepRecord<T extends object>(fields: T) {
  return { prompt: 'p', state: 'done', capturedAt: NOW - 3 * DAY, origin: 'quit', ...fields };
}

function fixtureDocuments(userData: string) {
  const claudeHome = path.join(userData, 'claude-profiles', 'acct1', 'home');
  return {
    repos: [
      { id: 'r1', path: '/src/app', displayName: 'app', addedAt: 1, kind: 'git' },
      { id: 'r2', path: '/remote/app', displayName: 'remote', addedAt: 1, kind: 'git', connectionId: 'ssh-1' },
    ],
    worktreeMeta: {
      'r1::/work/app/login': { displayName: 'Login page', lastActivityAt: NOW - DAY },
      'r1::/work/app/billing': { displayName: 'Billing', lastActivityAt: NOW - 2 * DAY },
      'r1::/work/app/old': { displayName: 'Old', isArchived: true },
    },
    workspaceSession: {
      tabsByWorktree: {},
      sleepingAgentSessionsByPaneKey: {
        't1:leaf-a': sleepRecord({
          paneKey: 't1:leaf-a',
          worktreeId: 'r1::/work/app/login',
          agent: 'claude',
          providerSession: {
            key: 'session_id',
            id: CLAUDE_ID,
            cwd: '/work/app/login/web',
            transcriptPath: path.join(claudeHome, 'projects', '-work-app-login-web', `${CLAUDE_ID}.jsonl`),
          },
          terminalTitle: 'Fix login redirect',
          updatedAt: NOW - DAY,
          launchConfig: { agentArgs: '', agentEnv: { CLAUDE_CONFIG_DIR: claudeHome } },
        }),
        't2:leaf-b': sleepRecord({
          paneKey: 't2:leaf-b',
          worktreeId: 'r1::/work/app/billing',
          agent: 'codex',
          providerSession: { key: 'session_id', id: CODEX_ID },
          updatedAt: NOW - 2 * DAY,
          origin: 'worktree-sleep',
        }),
        't3:leaf-c': sleepRecord({
          paneKey: 't3:leaf-c',
          worktreeId: 'r1::/work/app/login',
          agent: 'claude',
          providerSession: { key: 'session_id', id: 'aaaaaaaa-0000-4000-8000-000000000001' },
          updatedAt: NOW - 40 * DAY,
        }),
        't4:leaf-d': sleepRecord({
          paneKey: 't4:leaf-d',
          worktreeId: 'r1::/work/app/old',
          agent: 'claude',
          providerSession: { key: 'session_id', id: 'aaaaaaaa-0000-4000-8000-000000000002' },
          updatedAt: NOW - DAY,
        }),
        't5:leaf-e': sleepRecord({
          paneKey: 't5:leaf-e',
          worktreeId: 'r2::/remote/app',
          agent: 'claude',
          providerSession: { key: 'session_id', id: 'aaaaaaaa-0000-4000-8000-000000000003' },
          updatedAt: NOW - DAY,
        }),
        't6:leaf-f': sleepRecord({
          paneKey: 't6:leaf-f',
          worktreeId: 'r1::/work/app/billing',
          agent: 'claude',
          providerSession: { key: 'session_id', id: 'aaaaaaaa-0000-4000-8000-000000000004' },
          updatedAt: NOW - DAY,
          launchConfig: { agentArgs: '', agentEnv: { CLAUDE_CONFIG_DIR: claudeHome } },
        }),
      },
    },
  };
}

/** agent-hooks/last-status.json v2 (server-persistence.ts:25-91). */
const LAST_STATUS = {
  version: 2,
  entries: {
    't7:leaf-g': {
      paneKey: 't7:leaf-g',
      source: 'cursor',
      worktreeId: 'r1::/work/app/login',
      connectionId: null,
      providerSession: { key: 'conversation_id', id: CURSOR_ID, cwd: '/work/app/login' },
      agentPresence: { agent: 'cursor', process: { pid: 4242, platform: 'darwin', startTime: 'x' } },
      receivedAt: NOW - 60_000,
      stateStartedAt: NOW - 60_000,
      payload: { state: 'working' },
    },
    't2:leaf-b': {
      paneKey: 't2:leaf-b',
      source: 'codex',
      worktreeId: 'r1::/work/app/billing',
      connectionId: null,
      providerSession: { key: 'session_id', id: CODEX_ID, cwd: '/work/app/billing' },
      agentPresence: { agent: 'codex', process: { pid: 5151, platform: 'darwin', startTime: 'y' } },
      receivedAt: NOW - 3 * DAY,
      stateStartedAt: NOW - 3 * DAY,
      payload: { state: 'done' },
    },
  },
  authorityCommitments: {},
};

describe('readOrca', () => {
  it('reads sleeping agent sessions and live hook sessions from the active profile', async () => {
    const userData = tempRoot();
    orcaStore(userData, { lastStatus: JSON.stringify(LAST_STATUS) });
    writeJson(path.join(userData, 'orca-runtime.json'), JSON.stringify({ runtimeId: 'r', pid: 999, startedAt: 1 }));

    const result = await readOrca(context({ env: { ORCA_USER_DATA_PATH: userData }, isPidAlive: pid => pid === 4242 }));

    expect(result.status).toBe('ok');
    expect(result.version).toBe('3');
    const byId = Object.fromEntries(result.sessions.map(session => [session.sessionId, session]));
    expect(Object.keys(byId).sort()).toEqual([CODEX_ID, CLAUDE_ID, 'aaaaaaaa-0000-4000-8000-000000000004', CURSOR_ID].sort());
    expect(byId[CLAUDE_ID]).toEqual({
      source: 'orca',
      agent: 'claude',
      sessionId: CLAUDE_ID,
      folder: '/work/app/login/web',
      title: 'Fix login redirect',
      lastActiveMs: NOW - DAY,
      running: 'no',
      transcript: {
        agentHome: path.join(userData, 'claude-profiles', 'acct1', 'home'),
        path: path.join(userData, 'claude-profiles', 'acct1', 'home', 'projects', '-work-app-login-web', `${CLAUDE_ID}.jsonl`),
      },
    });
    // In both the sleep record and last-status: the newer sleep record wins, its folder comes from the worktree id.
    expect(byId[CODEX_ID]).toEqual({
      source: 'orca',
      agent: 'codex',
      sessionId: CODEX_ID,
      folder: '/work/app/billing',
      title: 'Billing',
      lastActiveMs: NOW - 2 * DAY,
      running: 'no',
    });
    expect(byId[CURSOR_ID]).toEqual({
      source: 'orca',
      agent: 'cursor',
      sessionId: CURSOR_ID,
      folder: '/work/app/login',
      title: 'Login page',
      lastActiveMs: NOW - 60_000,
      running: 'yes',
    });
    expect(byId['aaaaaaaa-0000-4000-8000-000000000004'].unavailable).toBe(
      "Orca ran it with its own account folder and didn't record where the transcript is",
    );
  });

  it('treats sessions without a live process as unknown while Orca or its terminal daemon runs', async () => {
    const userData = tempRoot();
    orcaStore(userData);
    writeJson(path.join(userData, 'daemon', 'daemon-v52.pid'), JSON.stringify({ pid: 777, startedAtMs: 1, entryPath: 'x', appVersion: '1.4.241' }));

    const result = await readOrca(context({ env: { ORCA_USER_DATA_PATH: userData }, isPidAlive: pid => pid === 777 }));

    expect(result.sessions.map(session => session.running)).toEqual(['unknown', 'unknown', 'unknown']);
  });

  it('treats sessions as unknown when an Orca or daemon marker exists but cannot be read', async () => {
    const userData = tempRoot();
    orcaStore(userData);
    writeJson(path.join(userData, 'orca-runtime.json'), '{"pid": 12');
    writeJson(path.join(userData, 'daemon', 'daemon-v52.pid'), '');

    const result = await readOrca(context({ env: { ORCA_USER_DATA_PATH: userData }, isPidAlive: () => false }));

    expect(result.sessions.map(session => session.running)).toEqual(['unknown', 'unknown', 'unknown']);
  });

  it.each([
    ['darwin', {}, ['Library', 'Application Support', 'orca']],
    ['linux', {}, ['.config', 'orca']],
    ['win32', {}, ['AppData', 'Roaming', 'orca']],
  ] as const)('finds the store on %s', async (platform, env, relative) => {
    const home = tempRoot();
    const userData = path.join(home, ...relative);
    orcaStore(userData);

    const result = await readOrca(context({ home, platform, env }));

    expect(result.status).toBe('ok');
    expect(result.storePaths).toContain(path.join(userData, 'profiles', 'p1', 'profile-state.db'));
    expect(result.sessions).toHaveLength(3);
  });

  it.each([
    ['win32', 'APPDATA'],
    ['linux', 'XDG_CONFIG_HOME'],
  ] as const)('uses %s %s for the userData root', async (platform, variable) => {
    const base = tempRoot();
    orcaStore(path.join(base, 'orca'));

    const result = await readOrca(context({ platform, env: { [variable]: base } }));

    expect(result.storePaths).toContain(path.join(base, 'orca', 'profiles', 'p1', 'profile-state.db'));
    expect(result.sessions).toHaveLength(3);
  });

  it('reports absent when Orca has no userData folder', async () => {
    const home = tempRoot();

    const result = await readOrca(context({ home }));

    expect(result.status).toBe('absent');
  });

  it('fails closed on an unknown profile store schema version', async () => {
    const userData = tempRoot();
    orcaStore(userData, { userVersion: 4 });

    const result = await readOrca(context({ env: { ORCA_USER_DATA_PATH: userData } }));

    expect(result.status).toBe('unreadable');
    expect(result.version).toBe('4');
    expect(result.sessions).toEqual([]);
  });

  it('fails closed on an unknown last-status.json version', async () => {
    const userData = tempRoot();
    orcaStore(userData, { lastStatus: JSON.stringify({ ...LAST_STATUS, version: 3 }) });

    const result = await readOrca(context({ env: { ORCA_USER_DATA_PATH: userData } }));

    expect(result.status).toBe('unreadable');
    expect(result.version).toBe('3');
  });

  it('fails closed on a profile kept only in the older orca-data.json layout', async () => {
    const userData = tempRoot();
    writeJson(path.join(userData, 'orca-profile-index.json'), JSON.stringify({ activeProfileId: 'p1', profiles: [{ id: 'p1' }] }));
    writeJson(path.join(userData, 'profiles', 'p1', 'orca-data.json'), JSON.stringify({ schemaVersion: 1 }));

    const result = await readOrca(context({ env: { ORCA_USER_DATA_PATH: userData } }));

    expect(result.status).toBe('unreadable');
  });

  it('leaves the live store untouched', async () => {
    const userData = tempRoot();
    const dbPath = orcaStore(userData, { lastStatus: JSON.stringify(LAST_STATUS) });
    const lastStatusPath = path.join(userData, 'agent-hooks', 'last-status.json');
    const snapshot = (file: string) => ({ bytes: fs.readFileSync(file), mtimeMs: fs.statSync(file).mtimeMs });
    const before = { db: snapshot(dbPath), status: snapshot(lastStatusPath), entries: fs.readdirSync(path.dirname(dbPath)) };

    await readOrca(context({ env: { ORCA_USER_DATA_PATH: userData } }));

    expect(snapshot(dbPath)).toEqual(before.db);
    expect(snapshot(lastStatusPath)).toEqual(before.status);
    expect(fs.readdirSync(path.dirname(dbPath))).toEqual(before.entries);
  });
});
