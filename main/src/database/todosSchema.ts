import type Database from 'better-sqlite3-multiple-ciphers';

/**
 * To-dos (D-408): three tables and one column in sessions.db, all additive so an older Pane opening
 * the same database still starts and its approvals still work. Added by runMigrations() in
 * database.ts and by TodoStore.
 */
const TODOS_SCHEMA_SQL = [
  // AUTOINCREMENT: T-n is never handed out twice on a machine, even after a closed to-do is deleted.
  `CREATE TABLE IF NOT EXISTS todos (
    number INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    parent_id INTEGER,
    title TEXT NOT NULL CHECK (length(title) > 0),
    summary TEXT NOT NULL DEFAULT '',
    done_when TEXT NOT NULL DEFAULT '[]',
    state TEXT NOT NULL CHECK (state IN ('todo', 'in_progress', 'in_review', 'accepted', 'stopped', 'done', 'dropped')),
    requester_kind TEXT NOT NULL CHECK (requester_kind IN ('person', 'orchestrator')),
    requester_session_id TEXT,
    requester_panel_id TEXT,
    requester_name TEXT NOT NULL DEFAULT 'you',
    project INTEGER,
    agent TEXT,
    assignee_panel_id TEXT,
    assignee_pane_id TEXT,
    assignee_name TEXT,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    updated_at INTEGER NOT NULL,
    accepted_at INTEGER,
    closed_at INTEGER,
    last_progress_at INTEGER,
    stuck_since INTEGER,
    episode_reminders INTEGER NOT NULL DEFAULT 0,
    episode_restarts INTEGER NOT NULL DEFAULT 0,
    stalls_today INTEGER NOT NULL DEFAULT 0,
    stalls_day TEXT,
    attach_reminded_at INTEGER,
    work_ms INTEGER NOT NULL DEFAULT 0,
    stuck_card_id TEXT,
    load_hold TEXT CHECK (load_hold IS NULL OR load_hold IN ('queued', 'paused')),
    load_hold_since INTEGER,
    load_override TEXT CHECK (load_override IS NULL OR load_override = 'never_pause')
  )`,
  'CREATE INDEX IF NOT EXISTS idx_todos_session ON todos(session_id)',
  'CREATE INDEX IF NOT EXISTS idx_todos_parent ON todos(parent_id)',
  'CREATE INDEX IF NOT EXISTS idx_todos_state ON todos(state)',
  'CREATE INDEX IF NOT EXISTS idx_todos_closed ON todos(closed_at)',
  `CREATE TABLE IF NOT EXISTS todo_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    todo_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    target TEXT NOT NULL CHECK (length(target) > 0),
    machine TEXT,
    label TEXT NOT NULL,
    note TEXT,
    added_by TEXT NOT NULL,
    added_by_tab TEXT,
    source TEXT NOT NULL CHECK (source IN ('attached', 'pr', 'approval', 'opened')),
    added_at INTEGER NOT NULL,
    removed_at INTEGER
  )`,
  'CREATE INDEX IF NOT EXISTS idx_todo_attachments_todo ON todo_attachments(todo_id, removed_at)',
  `CREATE TABLE IF NOT EXISTS todo_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    todo_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('message', 'event')),
    author_kind TEXT NOT NULL CHECK (author_kind IN ('person', 'agent', 'requester', 'pane')),
    author TEXT NOT NULL,
    author_tab TEXT,
    body TEXT NOT NULL,
    chat_ref TEXT,
    to_tab TEXT,
    to_name TEXT,
    delivered_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_todo_activity_todo ON todo_activity(todo_id, id)',
  'CREATE INDEX IF NOT EXISTS idx_todo_activity_undelivered ON todo_activity(to_tab, delivered_at)',
] as const;

/** Creates the to-do tables. Guarded: safe on fresh and upgraded databases. approvals.todo_id is added by ensureApprovalsSchema. */
export function ensureTodosSchema(db: Database.Database): void {
  for (const sql of TODOS_SCHEMA_SQL) db.prepare(sql).run();
}
