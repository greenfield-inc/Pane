import type Database from 'better-sqlite3-multiple-ciphers';

/**
 * Agent-to-agent messages (T-104): one additive table in sessions.db, so an older Pane opening the
 * same database still starts. Added by runMigrations() in database.ts and by AgentMessageStore.
 * AUTOINCREMENT: M-n is never handed out twice on a machine.
 */
const AGENT_MESSAGES_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS agent_messages (
    number INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('message', 'reply')),
    reply_to INTEGER,
    sender_panel_id TEXT,
    sender_pane_id TEXT,
    sender_session_id TEXT,
    sender_name TEXT NOT NULL,
    sender_orchestrator INTEGER NOT NULL DEFAULT 0,
    receiver_panel_id TEXT,
    receiver_pane_id TEXT,
    receiver_session_id TEXT,
    receiver_name TEXT NOT NULL,
    receiver_orchestrator INTEGER NOT NULL DEFAULT 0,
    body TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('sending', 'queued', 'delivered', 'answered', 'undelivered')),
    delivered_via TEXT CHECK (delivered_via IS NULL OR delivered_via IN ('tab', 'call')),
    undelivered_reason TEXT,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER,
    answered_at INTEGER,
    operation_id TEXT,
    request_key TEXT,
    prompt_file TEXT,
    prompt_attachments TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS idx_agent_messages_reply_to ON agent_messages(reply_to)',
  'CREATE INDEX IF NOT EXISTS idx_agent_messages_sender ON agent_messages(sender_panel_id)',
  'CREATE INDEX IF NOT EXISTS idx_agent_messages_receiver ON agent_messages(receiver_panel_id)',
  'CREATE INDEX IF NOT EXISTS idx_agent_messages_state ON agent_messages(state)',
] as const;

function columnsOf(db: Database.Database): string[] {
  // SAFETY: PRAGMA table_info rows always carry a name.
  return db.prepare('PRAGMA table_info(agent_messages)').all().map(column => (column as { name: string }).name);
}

/** Creates the messages table. Guarded: safe on fresh and upgraded databases. */
export function ensureAgentMessagesSchema(db: Database.Database): void {
  for (const sql of AGENT_MESSAGES_SCHEMA_SQL) db.prepare(sql).run();
  // A database made by an earlier build of this branch lacks the replay columns.
  const columns = columnsOf(db);
  for (const column of ['operation_id', 'request_key', 'prompt_file', 'prompt_attachments']) {
    if (!columns.includes(column)) db.prepare(`ALTER TABLE agent_messages ADD COLUMN ${column} TEXT`).run();
  }
  db.prepare('CREATE INDEX IF NOT EXISTS idx_agent_messages_operation ON agent_messages(operation_id)').run();
}
