import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readEmdash } from './emdash';
import type { ReaderContext } from './types';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const CONV_1 = '11111111-1111-4111-8111-111111111111';
const CONV_2 = '22222222-2222-4222-8222-222222222222';
const CODEX_THREAD = '019a0000-0000-7000-8000-000000000002';
const ACP_SESSION = '88888888-8888-4888-8888-888888888888';
const EMDASH_APP = '/Applications/Emdash.app/Contents/MacOS/Emdash';

let root: string;
let userData: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'emdash-reader-'));
  userData = path.join(root, 'userdata');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function context(overrides: Partial<ReaderContext> = {}): ReaderContext {
  return {
    env: { EMDASH_USER_DATA_DIR: userData },
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

interface Conversation {
  id: string;
  task?: string;
  provider: string;
  type?: string;
  cwd?: string;
  workspacePath?: string;
  providerSessionId?: string;
  idRegime?: string;
  title: string;
  updatedAt: string;
  lastSessionActivityAt?: string;
  agentStatus?: string;
  location?: string;
}

/** emdash4.db with the tables and columns named in the Emdash research note (schema.ts:153-469). */
function writeStore(file: string, data: {
  workspaces?: Array<{ id: string; path: string; observedGit?: object; config?: object }>;
  tasks?: Array<{ id: string; name: string; workspace: string; archivedAt?: string; type?: string }>;
  conversations?: Conversation[];
  sessionIdColumn?: string;
}): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(`
    CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric);
    INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('a', 1), ('b', 2);
    CREATE TABLE workspaces (id text PRIMARY KEY, type text NOT NULL DEFAULT 'local', kind text, location text, parent_id text,
      path text, config text, observed_status text, observed_git text, last_activated_at integer,
      created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP, untracked_at text);
    CREATE TABLE tasks (id text PRIMARY KEY, project_id text NOT NULL DEFAULT 'p1', name text NOT NULL, status text NOT NULL DEFAULT 'in_progress',
      archived_at text, created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_interacted_at text, workspace_id text, type text NOT NULL DEFAULT 'task', deleted_at text);
    CREATE TABLE conversations (id text PRIMARY KEY, project_id text, task_id text, agent_status_seen integer DEFAULT 1, agent_status text,
      title text NOT NULL, provider text, type text, config text, created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP, cwd text, workspace_path text, ${data.sessionIdColumn ?? 'provider_session_id'} text,
      id_regime text, last_session_activity_at text, observed_status text, last_observed_at text,
      origin text NOT NULL DEFAULT 'registered', location text, ssh_connection_id text, deletion_tombstone text, untracked_at text);
  `);
  for (const w of data.workspaces ?? []) {
    db.prepare('INSERT INTO workspaces (id, kind, location, path, observed_git, config) VALUES (?, \'worktree\', \'local\', ?, ?, ?)')
      .run(w.id, w.path, w.observedGit ? JSON.stringify(w.observedGit) : null, w.config ? JSON.stringify(w.config) : null);
  }
  for (const t of data.tasks ?? []) {
    db.prepare('INSERT INTO tasks (id, name, workspace_id, archived_at, type) VALUES (?, ?, ?, ?, ?)')
      .run(t.id, t.name, t.workspace, t.archivedAt ?? null, t.type ?? 'task');
  }
  for (const c of data.conversations ?? []) {
    db.prepare(`INSERT INTO conversations (id, task_id, agent_status, title, provider, type, updated_at, cwd, workspace_path,
      provider_session_id, id_regime, last_session_activity_at, observed_status, location) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'present', ?)`)
      .run(c.id, c.task ?? null, c.agentStatus ?? 'idle', c.title, c.provider, c.type ?? 'pty', c.updatedAt, c.cwd ?? null, c.workspacePath ?? null,
        c.providerSessionId ?? null, c.idRegime ?? 'emdash-chosen', c.lastSessionActivityAt ?? null, c.location ?? 'local');
  }
  db.close();
}

const observedGit = (branch: string) => ({ version: '2', branch, dirty: false, diffStats: null, ahead: 0, behind: 0, locked: false, prunable: false, headOid: null, upstream: null, prBreadcrumb: null });

/** One task with two live sessions and the rows the reader leaves out. */
function writeTypicalStore(): void {
  writeStore(path.join(userData, 'emdash4.db'), {
    workspaces: [
      { id: 'ws1', path: '/wt/app-1a2b3c4d/fix-login', observedGit: observedGit('fix-login') },
      { id: 'ws2', path: '/wt/app-1a2b3c4d/rate-limits', config: { version: '2', git: { kind: 'use-branch', branchName: 'rate-limits' }, workspace: { kind: 'new-worktree' } } },
    ],
    tasks: [
      { id: 'task1', name: 'Fix login', workspace: 'ws1' },
      { id: 'task2', name: 'Rate limits', workspace: 'ws2' },
      { id: 'task3', name: 'Done thing', workspace: 'ws1', archivedAt: '2026-10-20 09:00:00' },
      { id: 'task4', name: 'Nightly run', workspace: 'ws1', type: 'automation-run' },
    ],
    conversations: [
      { id: CONV_1, task: 'task1', provider: 'claude', title: 'Claude Code', cwd: '/wt/app-1a2b3c4d/fix-login', workspacePath: '/wt/app-1a2b3c4d/fix-login',
        updatedAt: '2026-10-26T09:00:00.000Z', lastSessionActivityAt: '2026-10-26T10:00:00.000Z', agentStatus: 'working' },
      { id: CONV_2, task: 'task2', provider: 'codex', title: 'Codex', cwd: '/wt/app-1a2b3c4d/rate-limits', providerSessionId: CODEX_THREAD, idRegime: 'provider-minted',
        updatedAt: '2026-10-25 08:30:00' },
      { id: 'conv-acp', provider: 'claude', type: 'acp', title: 'Chat', workspacePath: '/repos/app', providerSessionId: ACP_SESSION, idRegime: 'provider-minted',
        updatedAt: '2026-10-24T08:00:00.000Z' },
      { id: 'conv-codex-fresh', task: 'task2', provider: 'codex', title: 'Codex 2', cwd: '/wt/x', idRegime: 'none', updatedAt: '2026-10-26T08:00:00.000Z' },
      { id: 'conv-archived', task: 'task3', provider: 'claude', title: 'Old', cwd: '/wt/x', updatedAt: '2026-10-26T08:00:00.000Z' },
      { id: 'conv-automation', task: 'task4', provider: 'claude', title: 'Bot', cwd: '/wt/x', updatedAt: '2026-10-26T08:00:00.000Z' },
      { id: 'conv-remote', provider: 'claude', title: 'Remote', cwd: '/srv/app', location: 'remote', updatedAt: '2026-10-26T08:00:00.000Z' },
      { id: 'conv-stale', task: 'task1', provider: 'claude', title: 'Stale', cwd: '/wt/x', updatedAt: '2026-08-01T08:00:00.000Z' },
    ],
  });
}

describe('readEmdash', () => {
  it('reads each local conversation with its resume id, task, branch and last activity', async () => {
    writeTypicalStore();

    const result = await readEmdash(context());

    expect(result.status).toBe('ok');
    expect(result.storePaths).toEqual([path.join(userData, 'emdash4.db')]);
    expect(result.sessions).toEqual([
      { source: 'emdash', agent: 'claude', sessionId: CONV_1, folder: '/wt/app-1a2b3c4d/fix-login', branch: 'fix-login', title: 'Fix login',
        lastActiveMs: Date.parse('2026-10-26T10:00:00.000Z'), running: 'no' },
      { source: 'emdash', agent: 'codex', sessionId: CODEX_THREAD, folder: '/wt/app-1a2b3c4d/rate-limits', branch: 'rate-limits', title: 'Rate limits',
        lastActiveMs: Date.parse('2026-10-25T08:30:00Z'), running: 'no' },
      { source: 'emdash', agent: 'claude', sessionId: ACP_SESSION, folder: '/repos/app', title: 'Chat',
        lastActiveMs: Date.parse('2026-10-24T08:00:00.000Z'), running: 'no' },
    ]);
  });

  it('reads running state from the Emdash process, agent status, tmux and live command lines', async () => {
    writeTypicalStore();
    const running = async (commands: string[]) =>
      (await readEmdash(context({ processCommands: async () => commands }))).sessions.map(s => [s.sessionId, s.running]);

    expect(await running([EMDASH_APP])).toEqual([[CONV_1, 'yes'], [CODEX_THREAD, 'unknown'], [ACP_SESSION, 'unknown']]);
    expect(await running(['tmux new-session -d -s session-abc'])).toEqual([[CONV_1, 'unknown'], [CODEX_THREAD, 'unknown'], [ACP_SESSION, 'unknown']]);
    expect(await running([`codex resume ${CODEX_THREAD}`, 'vim /Users/me/emdash/worktrees/app/notes.md'])).toEqual([[CONV_1, 'no'], [CODEX_THREAD, 'yes'], [ACP_SESSION, 'no']]);
  });

  it.each([
    ['darwin', {}, '/Users/me/Library/Application Support/emdash/emdash4.db'],
    ['win32', { APPDATA: '/c/Users/me/AppData/Roaming' }, '/c/Users/me/AppData/Roaming/emdash/emdash4.db'],
    ['win32', {}, '/Users/me/AppData/Roaming/emdash/emdash4.db'],
    ['linux', { XDG_CONFIG_HOME: '/xdg' }, '/xdg/emdash/emdash4.db'],
    ['linux', {}, '/Users/me/.config/emdash/emdash4.db'],
    ['linux', { EMDASH_USER_DATA_DIR: '/profiles/emdash-scratch' }, '/profiles/emdash-scratch/emdash4.db'],
  ] as const)('looks for the store on %s with env %j', async (platform, env, expected) => {
    const result = await readEmdash(context({ platform, env, home: '/Users/me' }));

    // The reader joins with the host's separator, so compare in that form.
    expect(result).toEqual({ source: 'emdash', status: 'absent', storePaths: [path.normalize(expected)], sessions: [] });
  });

  it('fails closed on a store from before emdash4.db', async () => {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(path.join(userData, 'emdash3.db'), '');

    const result = await readEmdash(context());

    expect(result).toMatchObject({ status: 'unreadable', version: 'emdash3.db', storePaths: [path.join(userData, 'emdash3.db')], sessions: [] });
  });

  it('fails closed when conversations still carry the older session_id column', async () => {
    writeStore(path.join(userData, 'emdash4.db'), { sessionIdColumn: 'session_id' });

    const result = await readEmdash(context());

    expect(result.status).toBe('unreadable');
    expect(result.version).toBe('emdash4.db with 2 migrations');
    expect(result.reason).toContain('conversations');
  });

  it('leaves the live store untouched', async () => {
    writeTypicalStore();
    const db = path.join(userData, 'emdash4.db');
    const past = (NOW - DAY) / 1000;
    fs.utimesSync(db, past, past);
    const before = { bytes: fs.readFileSync(db), mtime: fs.statSync(db).mtimeMs, files: fs.readdirSync(userData) };

    await readEmdash(context({ processCommands: async () => [EMDASH_APP] }));

    expect(fs.readFileSync(db).equals(before.bytes)).toBe(true);
    expect(fs.statSync(db).mtimeMs).toBe(before.mtime);
    expect(fs.readdirSync(userData)).toEqual(before.files);
    expect(fs.readdirSync(root).filter(name => name.startsWith('store-'))).toEqual([]);
  });
});
