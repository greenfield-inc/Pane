import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSuperset } from './superset';
import type { ReaderContext } from './types';

const NOW = Date.parse('2026-10-26T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CLAUDE_A = '11111111-1111-4111-8111-111111111111';
const CODEX_B = '22222222-2222-4222-8222-222222222222';
const CLAUDE_C = '33333333-3333-4333-8333-333333333333';
const CLAUDE_D = '44444444-4444-4444-8444-444444444444';
const CLAUDE_E = '55555555-5555-4555-8555-555555555555';
const CODEX_F = '66666666-6666-4666-8666-666666666666';

let root: string;
let home: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'superset-reader-'));
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

interface Binding {
  terminal: string;
  workspace: string;
  agent: string;
  sessionId: string | null;
  startedAt: number;
  lastEventAt: number;
  endedAt?: number;
  endReason?: string;
  transcriptPath?: string;
}

/** host.db with the tables and columns named in the Superset research note (schema.ts:15-297). */
function writeHostDb(file: string, data: {
  projects?: Array<[string, string]>;
  workspaces?: Array<{ id: string; project: string | null; path: string; branch: string; name: string; archivedAt?: number }>;
  bindings?: Binding[];
  settings?: { claude?: string; codex?: string };
  withSessionIdColumn?: boolean;
}): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(`
    CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric);
    INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('a', 1), ('b', 2), ('c', 3);
    CREATE TABLE projects (id text PRIMARY KEY, repo_path text NOT NULL, name text NOT NULL DEFAULT '', deleted_at integer);
    CREATE TABLE workspaces (id text PRIMARY KEY, project_id text, worktree_path text NOT NULL, branch text NOT NULL,
      name text NOT NULL DEFAULT '', type text NOT NULL DEFAULT 'worktree', created_at integer, updated_at integer,
      last_activity_at integer, archived_at integer, archive_reason text);
    CREATE TABLE terminal_sessions (id text PRIMARY KEY, origin_workspace_id text, status text NOT NULL DEFAULT 'active',
      custom_title text, created_at integer, ended_at integer);
    CREATE TABLE terminal_agent_bindings (terminal_id text PRIMARY KEY, workspace_id text NOT NULL, agent_id text NOT NULL,
      ${data.withSessionIdColumn === false ? '' : 'agent_session_id text,'} definition_id text, started_at integer NOT NULL,
      last_event_at integer NOT NULL, last_event_type text NOT NULL, ended_at integer, end_reason text,
      resumed_into_terminal_id text, transcript_path text);
    CREATE TABLE host_settings (id integer PRIMARY KEY DEFAULT 1, worktree_base_dir text,
      default_claude_config_dir text, default_codex_home text);
  `);
  for (const [id, repo] of data.projects ?? []) db.prepare('INSERT INTO projects (id, repo_path) VALUES (?, ?)').run(id, repo);
  for (const w of data.workspaces ?? []) {
    db.prepare('INSERT INTO workspaces (id, project_id, worktree_path, branch, name, archived_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(w.id, w.project, w.path, w.branch, w.name, w.archivedAt ?? null);
  }
  for (const b of data.bindings ?? []) {
    db.prepare('INSERT INTO terminal_sessions (id, origin_workspace_id) VALUES (?, ?)').run(b.terminal, b.workspace);
    if (data.withSessionIdColumn === false) continue;
    db.prepare(`INSERT INTO terminal_agent_bindings (terminal_id, workspace_id, agent_id, agent_session_id, started_at,
      last_event_at, last_event_type, ended_at, end_reason, transcript_path) VALUES (?, ?, ?, ?, ?, ?, 'Attached', ?, ?, ?)`)
      .run(b.terminal, b.workspace, b.agent, b.sessionId, b.startedAt, b.lastEventAt, b.endedAt ?? null, b.endReason ?? null, b.transcriptPath ?? null);
  }
  if (data.settings) {
    db.prepare('INSERT INTO host_settings (id, default_claude_config_dir, default_codex_home) VALUES (1, ?, ?)')
      .run(data.settings.claude ?? null, data.settings.codex ?? null);
  }
  db.close();
}

function writeManifest(orgDir: string, pid: number): void {
  fs.writeFileSync(path.join(orgDir, 'manifest.json'), JSON.stringify({ pid, endpoint: 'http://127.0.0.1:1', authToken: 't', startedAt: NOW, organizationId: 'org' }));
}

/** local.db v1 tables from the note (packages/local-db/src/schema/schema.ts:29-149). */
function writeLocalDb(file: string): void {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric);
    INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('a', 1);
    CREATE TABLE projects (id text PRIMARY KEY, main_repo_path text NOT NULL, name text NOT NULL);
    CREATE TABLE worktrees (id text PRIMARY KEY, project_id text NOT NULL, path text NOT NULL, branch text NOT NULL);
    CREATE TABLE workspaces (id text PRIMARY KEY, project_id text NOT NULL, worktree_id text, type text NOT NULL,
      branch text NOT NULL, name text NOT NULL, updated_at integer, last_opened_at integer, deleting_at integer);
    INSERT INTO projects VALUES ('p1', '/repos/shop', 'shop');
    INSERT INTO worktrees VALUES ('wt1', 'p1', '/home/me/.superset/worktrees/shop/cart', 'cart');
    INSERT INTO workspaces VALUES ('ws1', 'p1', 'wt1', 'worktree', 'cart', 'Cart page', 0, 0, NULL);
    INSERT INTO workspaces VALUES ('ws2', 'p1', NULL, 'branch', 'main', 'Shop main', 0, 0, NULL);
  `);
  db.close();
}

function byId<T extends { sessionId: string }>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

describe('readSuperset', () => {
  it('reads agent bindings from every organization host.db with running state', async () => {
    const orgDir = path.join(home, '.superset', 'host', 'org-1');
    writeHostDb(path.join(orgDir, 'host.db'), {
      projects: [['p1', '/repos/shop']],
      workspaces: [
        { id: 'w1', project: 'p1', path: '/wt/shop/cart', branch: 'cart', name: 'Cart page' },
        { id: 'w2', project: 'p1', path: '/wt/shop/old', branch: 'old', name: 'Old work', archivedAt: NOW - DAY },
      ],
      bindings: [
        { terminal: 't1', workspace: 'w1', agent: 'claude', sessionId: CLAUDE_A, startedAt: NOW - 3 * HOUR, lastEventAt: NOW - 2 * HOUR, endedAt: NOW - HOUR, endReason: 'terminal-exited' },
        { terminal: 't2', workspace: 'w1', agent: 'codex', sessionId: CODEX_B, startedAt: NOW - 5 * HOUR, lastEventAt: NOW - 4 * HOUR },
        { terminal: 't3', workspace: 'w1', agent: 'claude', sessionId: CLAUDE_C, startedAt: NOW - 5 * HOUR, lastEventAt: NOW - 5 * HOUR, endedAt: NOW - 4 * HOUR, endReason: 'resumed' },
        { terminal: 't4', workspace: 'w2', agent: 'claude', sessionId: CLAUDE_D, startedAt: NOW - 5 * HOUR, lastEventAt: NOW - 5 * HOUR },
        { terminal: 't5', workspace: 'w1', agent: 'claude', sessionId: CLAUDE_E, startedAt: NOW - 40 * DAY, lastEventAt: NOW - 40 * DAY, endedAt: NOW - 40 * DAY, endReason: 'detached' },
        { terminal: 't6', workspace: 'w1', agent: 'amp', sessionId: null, startedAt: NOW - HOUR, lastEventAt: NOW - HOUR },
      ],
    });
    writeManifest(orgDir, 777);
    const otherOrg = path.join(home, '.superset', 'host', 'org-2');
    writeHostDb(path.join(otherOrg, 'host.db'), {
      projects: [['p9', '/repos/api']],
      workspaces: [{ id: 'w9', project: 'p9', path: '/repos/api', branch: 'main', name: '' }],
      bindings: [{ terminal: 't9', workspace: 'w9', agent: 'cursor-agent', sessionId: CODEX_F, startedAt: NOW - 2 * DAY, lastEventAt: NOW - DAY }],
    });

    const result = await readSuperset(context({ isPidAlive: pid => pid === 777 }));

    expect(result.status).toBe('ok');
    expect(byId(result.sessions)).toEqual([
      { source: 'superset', agent: 'claude', sessionId: CLAUDE_A, folder: '/wt/shop/cart', branch: 'cart', title: 'Cart page', lastActiveMs: NOW - HOUR, running: 'no' },
      { source: 'superset', agent: 'codex', sessionId: CODEX_B, folder: '/wt/shop/cart', branch: 'cart', title: 'Cart page', lastActiveMs: NOW - 4 * HOUR, running: 'yes' },
      // org-2 has no manifest: an unended binding may still live in Superset's pty-daemon.
      { source: 'superset', agent: 'cursor', sessionId: CODEX_F, folder: '/repos/api', branch: 'main', lastActiveMs: NOW - DAY, running: 'unknown' },
    ]);
    expect(result.storePaths).toEqual(expect.arrayContaining([path.join(orgDir, 'host.db'), path.join(otherOrg, 'host.db')]));
  });

  it('marks a session running when its id is on a live command line', async () => {
    const orgDir = path.join(home, '.superset', 'host', 'org-1');
    writeHostDb(path.join(orgDir, 'host.db'), {
      workspaces: [{ id: 'w1', project: null, path: '/s/1', branch: 'main', name: 'Scratch' }],
      bindings: [{ terminal: 't1', workspace: 'w1', agent: 'claude', sessionId: CLAUDE_A, startedAt: NOW - HOUR, lastEventAt: NOW - HOUR, endedAt: NOW - HOUR, endReason: 'detached' }],
    });

    const result = await readSuperset(context({ processCommands: async () => [`claude --resume ${CLAUDE_A}`] }));

    expect(result.sessions.map(s => s.running)).toEqual(['yes']);
  });

  it('points at the transcript when Superset ran the agent under its own profile folder', async () => {
    const profile = path.join(root, 'profiles', 'work-claude');
    const reported = path.join(profile, 'projects', '-wt-shop', `${CLAUDE_A}.jsonl`);
    const ownStore = path.join(home, '.claude', 'projects', '-wt-shop', `${CLAUDE_C}.jsonl`);
    const codexProfile = path.join(root, 'profiles', 'work-codex');
    const rollout = path.join(codexProfile, 'sessions', '2026', '10', '25', `rollout-2026-10-25T10-00-00-${CODEX_B}.jsonl`);
    fs.mkdirSync(path.dirname(rollout), { recursive: true });
    fs.writeFileSync(rollout, '{}\n');
    writeHostDb(path.join(home, '.superset', 'host', 'org-1', 'host.db'), {
      workspaces: [{ id: 'w1', project: null, path: '/wt/shop', branch: 'main', name: 'Shop' }],
      settings: { codex: codexProfile },
      bindings: [
        { terminal: 't1', workspace: 'w1', agent: 'claude', sessionId: CLAUDE_A, startedAt: NOW - HOUR, lastEventAt: NOW - HOUR, endedAt: NOW - HOUR, endReason: 'terminal-exited', transcriptPath: reported },
        { terminal: 't2', workspace: 'w1', agent: 'codex', sessionId: CODEX_B, startedAt: NOW - HOUR, lastEventAt: NOW - HOUR, endedAt: NOW - HOUR, endReason: 'terminal-exited' },
        { terminal: 't3', workspace: 'w1', agent: 'claude', sessionId: CLAUDE_C, startedAt: NOW - HOUR, lastEventAt: NOW - HOUR, endedAt: NOW - HOUR, endReason: 'terminal-exited', transcriptPath: ownStore },
      ],
    });

    const result = await readSuperset(context());

    expect(byId(result.sessions).map(s => [s.sessionId, s.transcript])).toEqual([
      [CLAUDE_A, { agentHome: profile, path: reported }],
      [CODEX_B, { agentHome: codexProfile, path: rollout }],
      [CLAUDE_C, undefined],
    ]);
  });

  it('reads legacy v1 sessions from app-state.json placed through local.db, preferring host.db for the same id', async () => {
    const base = path.join(home, '.superset');
    fs.mkdirSync(base, { recursive: true });
    writeLocalDb(path.join(base, 'local.db'));
    fs.writeFileSync(path.join(base, 'app-state.json'), JSON.stringify({
      tabsState: { tabs: [{ id: 'tab1', name: 'a', workspaceId: 'ws1', createdAt: 0 }], panes: { pane1: { id: 'pane1', tabId: 'tab1', type: 'terminal', name: 'a' } } },
      tabsStateByWindow: {
        win2: {
          tabs: [{ id: 'tab2', name: 'b', workspaceId: 'ws2', createdAt: 0 }],
          panes: {
            pane2: { id: 'pane2', tabId: 'tab2', type: 'terminal', name: 'b' },
            pane3: { id: 'pane3', tabId: 'tab2', type: 'terminal', name: 'c' },
            pane4: { id: 'pane4', tabId: 'tab2', type: 'terminal', name: 'd' },
          },
        },
      },
      v1AgentSessions: {
        pane1: { agentId: 'claude', agentSessionId: CLAUDE_A, prompted: true, updatedAt: NOW - 2 * HOUR },
        pane2: { agentId: 'codex', agentSessionId: CODEX_B, prompted: true, endedAt: NOW - HOUR, updatedAt: NOW - 3 * HOUR },
        pane3: { agentId: 'claude', agentSessionId: CLAUDE_C, prompted: false, updatedAt: NOW - HOUR },
        pane4: { agentId: 'claude', agentSessionId: CLAUDE_D, prompted: true, updatedAt: NOW - HOUR },
      },
    }));
    fs.writeFileSync(path.join(base, 'terminal-host.pid'), '4321\n');
    writeHostDb(path.join(base, 'host', 'org-1', 'host.db'), {
      workspaces: [{ id: 'w1', project: null, path: '/migrated/cart', branch: 'cart', name: 'Migrated' }],
      bindings: [{ terminal: 't1', workspace: 'w1', agent: 'claude', sessionId: CLAUDE_D, startedAt: NOW - HOUR, lastEventAt: NOW - HOUR, endedAt: NOW - HOUR, endReason: 'terminal-exited' }],
    });

    const result = await readSuperset(context({ isPidAlive: pid => pid === 4321 }));

    expect(result.status).toBe('ok');
    expect(byId(result.sessions)).toEqual([
      // The v1 daemon is alive and the agent never said goodbye.
      { source: 'superset', agent: 'claude', sessionId: CLAUDE_A, folder: '/home/me/.superset/worktrees/shop/cart', branch: 'cart', title: 'Cart page', lastActiveMs: NOW - 2 * HOUR, running: 'unknown' },
      { source: 'superset', agent: 'codex', sessionId: CODEX_B, folder: '/repos/shop', branch: 'main', title: 'Shop main', lastActiveMs: NOW - HOUR, running: 'no' },
      { source: 'superset', agent: 'claude', sessionId: CLAUDE_D, folder: '/migrated/cart', branch: 'cart', title: 'Migrated', lastActiveMs: NOW - HOUR, running: 'no' },
    ]);
  });

  it.each([
    ['darwin', '/Users/me'],
    ['win32', 'C:\\Users\\me'],
    ['linux', '/home/me'],
  ] as const)('looks in ~/.superset on %s', async (platform, fakeHome) => {
    const result = await readSuperset(context({ platform, home: fakeHome }));

    expect(result).toEqual({ source: 'superset', status: 'absent', storePaths: [path.join(fakeHome, '.superset')], sessions: [] });
  });

  it('follows SUPERSET_HOME_DIR', async () => {
    const custom = path.join(root, 'custom-superset');
    writeHostDb(path.join(custom, 'host', 'org-1', 'host.db'), {
      workspaces: [{ id: 'w1', project: null, path: '/s/1', branch: 'main', name: 'Scratch' }],
      bindings: [{ terminal: 't1', workspace: 'w1', agent: 'claude', sessionId: CLAUDE_A, startedAt: NOW - HOUR, lastEventAt: NOW - HOUR, endedAt: NOW - HOUR, endReason: 'detached' }],
    });

    const result = await readSuperset(context({ env: { SUPERSET_HOME_DIR: custom } }));

    expect(result.sessions.map(s => s.sessionId)).toEqual([CLAUDE_A]);
    expect(result.storePaths).toContain(path.join(custom, 'host', 'org-1', 'host.db'));
  });

  it('fails closed on a host.db without agent session ids', async () => {
    const db = path.join(home, '.superset', 'host', 'org-1', 'host.db');
    writeHostDb(db, { withSessionIdColumn: false });

    const result = await readSuperset(context());

    expect(result.status).toBe('unreadable');
    expect(result.version).toBe('host.db with 3 migrations');
    expect(result.reason).toContain('terminal_agent_bindings');
    expect(result.sessions).toEqual([]);
  });

  it('leaves the live store untouched', async () => {
    const orgDir = path.join(home, '.superset', 'host', 'org-1');
    const db = path.join(orgDir, 'host.db');
    writeHostDb(db, {
      workspaces: [{ id: 'w1', project: null, path: '/s/1', branch: 'main', name: 'Scratch' }],
      bindings: [{ terminal: 't1', workspace: 'w1', agent: 'claude', sessionId: CLAUDE_A, startedAt: NOW - HOUR, lastEventAt: NOW - HOUR }],
    });
    const past = (NOW - DAY) / 1000;
    fs.utimesSync(db, past, past);
    const before = { bytes: fs.readFileSync(db), mtime: fs.statSync(db).mtimeMs, files: fs.readdirSync(orgDir) };

    await readSuperset(context());

    expect(fs.readFileSync(db).equals(before.bytes)).toBe(true);
    expect(fs.statSync(db).mtimeMs).toBe(before.mtime);
    expect(fs.readdirSync(orgDir)).toEqual(before.files);
    expect(fs.readdirSync(root).filter(name => name.startsWith('store-'))).toEqual([]);
  });
});
