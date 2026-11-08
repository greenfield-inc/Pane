import type Database from 'better-sqlite3-multiple-ciphers';
import { IMPORT_MARKERS_TABLE_SQL } from './jsonStoreImport';

/** The approvals table (D-159); see ApprovalStore. Added by the startup migrations in database.ts. */
const APPROVALS_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    machine TEXT NOT NULL,
    connected_kind TEXT NOT NULL CHECK (connected_kind IN ('session', 'pane', 'autopilot', 'machine')),
    connected_id TEXT NOT NULL CHECK (length(connected_id) > 0),
    connected_name TEXT NOT NULL,
    origin_kind TEXT NOT NULL CHECK (origin_kind IN ('orchestrator', 'worker', 'autopilot', 'claude-prompt', 'pane', 'agent')),
    session_id TEXT,
    pane_id TEXT,
    panel_id TEXT,
    addressee TEXT NOT NULL CHECK (addressee IN ('person', 'orchestrator')),
    qn TEXT,
    state TEXT NOT NULL,
    item_json TEXT,
    report_json TEXT,
    inbox_session_id TEXT,
    acked_at INTEGER,
    answered_by TEXT,
    closed_by TEXT,
    closed_reason TEXT,
    stale_since INTEGER,
    rewritten_from TEXT,
    rewritten_as TEXT,
    delivered_via TEXT,
    delivered_at INTEGER,
    decision TEXT,
    created_at INTEGER NOT NULL,
    ended_at INTEGER
  )`,
  'CREATE INDEX IF NOT EXISTS idx_approvals_state ON approvals(state)',
  'CREATE INDEX IF NOT EXISTS idx_approvals_session ON approvals(connected_id, state)',
  'CREATE INDEX IF NOT EXISTS idx_approvals_panel ON approvals(panel_id, state)',
  'CREATE INDEX IF NOT EXISTS idx_approvals_inbox ON approvals(inbox_session_id, acked_at)',
  'CREATE INDEX IF NOT EXISTS idx_approvals_ended ON approvals(ended_at)',
  `CREATE TABLE IF NOT EXISTS approvals_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
] as const;

export function ensureApprovalsSchema(db: Database.Database): void {
  for (const sql of [...APPROVALS_SCHEMA_SQL, IMPORT_MARKERS_TABLE_SQL]) db.prepare(sql).run();
}
