import path from 'path';
import type { FoundSession, ReaderContext, SourceReader } from './types';
import type { ImportRunning } from '../../../../../shared/types/sessionImport';
import {
  absent,
  appDataDir,
  exists,
  hasColumns,
  isRecord,
  parseJsonLine,
  stringField,
  toMs,
  unreadable,
  withSqliteCopy,
  type SqliteDatabase,
} from './common';

const SOURCE = 'emdash';

const REQUIRED_COLUMNS: ReadonlyArray<[string, readonly string[]]> = [
  ['conversations', [
    'id', 'task_id', 'agent_status', 'title', 'provider', 'type', 'created_at', 'updated_at', 'cwd', 'workspace_path',
    'provider_session_id', 'id_regime', 'last_session_activity_at', 'observed_status', 'location', 'deletion_tombstone', 'untracked_at',
  ]],
  ['tasks', ['id', 'name', 'archived_at', 'deleted_at', 'workspace_id', 'type']],
  ['workspaces', ['id', 'path', 'config', 'observed_git']],
];

/** Agent statuses Emdash shows while a session is busy or waiting on the person. */
const LIVE_STATUSES = new Set(['working', 'awaiting-input']);

/** The packaged app's executable: `Emdash.app/…`, `Emdash.exe`, an AppImage, or `emdash` on Linux. */
const EMDASH_PROCESS = /[\\/]emdash(?:[- ]canary)?(?:\.app[\\/]|\.exe\b|\.appimage\b|(?=\s|$))/i;

interface ConversationRow {
  id: string;
  provider: string | null;
  type: string | null;
  cwd: string | null;
  workspace_path: string | null;
  provider_session_id: string | null;
  id_regime: string | null;
  title: string | null;
  created_at: string | null;
  updated_at: string | null;
  last_session_activity_at: string | null;
  agent_status: string | null;
  task_name: string | null;
  workspace_dir: string | null;
  observed_git: string | null;
  workspace_config: string | null;
}

/** Emdash's profile folder: `EMDASH_USER_DATA_DIR`, else `<appData>/emdash`. */
function userDataDir(context: ReaderContext): string {
  return context.env.EMDASH_USER_DATA_DIR || appDataDir(context, 'emdash');
}

/** emdash4.db holds SQLite `CURRENT_TIMESTAMP` text (UTC, no zone) or ISO-8601 strings. */
function emdashTimeMs(value: string | null): number | undefined {
  if (value && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return Date.parse(`${value.replace(' ', 'T')}Z`);
  return toMs(value);
}

/** The observed branch (`observed_git` v2), else the branch the workspace was set up with. */
function branchOf(row: ConversationRow): string | undefined {
  const observed = row.observed_git ? parseJsonLine(row.observed_git) : undefined;
  if (observed?.version === '2' && stringField(observed, 'branch')) return stringField(observed, 'branch');
  const git = row.workspace_config ? parseJsonLine(row.workspace_config)?.git : undefined;
  return isRecord(git) ? stringField(git, 'branchName') ?? stringField(git, 'headBranch') : undefined;
}

/**
 * The id the agent resumes by. Emdash starts Claude PTY sessions with its own
 * conversation id (`claude --session-id <id>`) and records `provider_session_id`
 * only when the agent reports a different one.
 */
function sessionIdOf(row: ConversationRow): string | undefined {
  if (row.provider_session_id) return row.provider_session_id;
  const pty = row.type === null || row.type === 'pty';
  const emdashChosen = row.id_regime === null || row.id_regime === 'emdash-chosen';
  return row.provider === 'claude' && pty && emdashChosen ? row.id : undefined;
}

function versionOf(db: SqliteDatabase): string | undefined {
  if (!hasColumns(db, '__drizzle_migrations', ['hash'])) return undefined;
  // SAFETY: COUNT(*) always returns one row with a numeric `count`.
  const row = db.prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations').get() as { count: number };
  return `emdash4.db with ${row.count} migrations`;
}

type StoreRead = { rows: ConversationRow[] } | { reason: string; version?: string };

function readStore(db: SqliteDatabase): StoreRead {
  const version = versionOf(db);
  const missing = REQUIRED_COLUMNS.find(([table, columns]) => !hasColumns(db, table, columns));
  if (!version || missing) {
    return { reason: `emdash4.db has no ${missing?.[0] ?? '__drizzle_migrations'} table in the shape Pane reads`, version };
  }
  // Local sessions only; automation runs, archived or deleted tasks and removed conversations are left out.
  // SAFETY: the selected columns were checked above.
  const rows = db.prepare(`
    SELECT c.id, c.provider, c.type, c.cwd, c.workspace_path, c.provider_session_id, c.id_regime, c.title,
           c.created_at, c.updated_at, c.last_session_activity_at, c.agent_status,
           t.name AS task_name, w.path AS workspace_dir, w.observed_git, w.config AS workspace_config
    FROM conversations c
    LEFT JOIN tasks t ON t.id = c.task_id
    LEFT JOIN workspaces w ON w.id = t.workspace_id
    WHERE (c.location IS NULL OR c.location = 'local')
      AND c.untracked_at IS NULL AND c.deletion_tombstone IS NULL
      AND (c.observed_status IS NULL OR c.observed_status <> 'missing')
      AND t.archived_at IS NULL AND t.deleted_at IS NULL
      AND (t.type IS NULL OR t.type <> 'automation-run')
  `).all() as ConversationRow[];
  return { rows };
}

export const readEmdash: SourceReader = async context => {
  const dir = userDataDir(context);
  const dbPath = path.join(dir, 'emdash4.db');
  if (!exists(dbPath)) {
    const previous = path.join(dir, 'emdash3.db');
    return exists(previous)
      ? unreadable(SOURCE, 'this Emdash store predates emdash4.db; open Emdash once to update it', [previous], 'emdash3.db')
      : absent(SOURCE, [dbPath]);
  }
  const storePaths = [dbPath];
  const read = withSqliteCopy(context, dbPath, readStore);
  if ('reason' in read) return unreadable(SOURCE, read.reason, storePaths, read.version);

  const commands = await context.processCommands();
  const emdashOpen = commands.some(command => EMDASH_PROCESS.test(command));
  // With tmux enabled in Emdash, agents outlive the app.
  const tmuxRunning = commands.some(command => /(^|[\\/\s])tmux(\s|$)/.test(command));

  const sessions: FoundSession[] = [];
  for (const row of read.rows) {
    const sessionId = sessionIdOf(row);
    if (!row.provider || !sessionId) continue;
    const lastActiveMs = emdashTimeMs(row.last_session_activity_at) ?? emdashTimeMs(row.updated_at) ?? emdashTimeMs(row.created_at);
    if (lastActiveMs === undefined || lastActiveMs < context.sinceMs) continue;
    // While Emdash is open its PTY keeps an idle agent alive, so only a busy status is a clear yes.
    const running: ImportRunning = commands.some(command => command.includes(sessionId)) ? 'yes'
      : emdashOpen ? (row.agent_status && LIVE_STATUSES.has(row.agent_status) ? 'yes' : 'unknown')
        : tmuxRunning ? 'unknown' : 'no';
    sessions.push({
      source: SOURCE,
      agent: row.provider,
      sessionId,
      folder: row.cwd || row.workspace_path || row.workspace_dir || undefined,
      branch: branchOf(row),
      title: row.task_name || row.title || undefined,
      lastActiveMs,
      running,
    });
  }
  return { source: SOURCE, status: 'ok', storePaths, sessions };
};
