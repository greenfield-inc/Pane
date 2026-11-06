import path from 'path';
import type { ImportRunning } from '../../../../../shared/types/sessionImport';
import type { FoundSession, ReaderContext, SourceReader } from './types';
import { absent, appDataDir, claudeConfigDir, codexHome, exists, findClaudeTranscript, tableColumns, toMs, unreadable, withSqliteCopy } from './common';
import { claudeRunning, liveClaudeSessions } from './claudeCode';
import { codexRunning, listCodexSessions } from './codex';

// Conductor (macOS only) keeps `~/Library/Application Support/com.conductor.app/conductor.db`.
// `sessions` has one row per chat tab: `workspace_id`, `agent_type`,
// `claude_session_id` (the Claude Code session id), `title`, `status`
// (working/waiting/idle/error) and `datetime('now')` timestamps. `workspaces`
// joins on `local_id` (newer) or `id` (older) and has `workspace_path`,
// `branch`, `state` and `directory_name`. Claude and Codex keep their
// transcripts in the person's own ~/.claude and ~/.codex. Which column holds a
// Codex thread id is unknown, so Codex threads come from Codex's own store by
// workspace folder.

const SESSION_COLUMNS = ['id', 'workspace_id', 'agent_type', 'claude_session_id', 'title', 'status', 'updated_at'] as const;
const WORKSPACE_COLUMNS = ['workspace_path', 'branch', 'state', 'directory_name'] as const;
const BUSY_STATUSES = new Set(['working', 'waiting']);

interface WorkspaceRow {
  workspacePath: string | null;
  branch: string | null;
  workspaceName: string | null;
}

interface ConductorRow extends WorkspaceRow {
  agentType: string | null;
  claudeSessionId: string | null;
  title: string | null;
  status: string | null;
  updatedAt: string | null;
  lastUserMessageAt: string | null;
}

/** A Conductor workspace that isn't archived, with every chat Pane can resume from it. */
export interface ConductorWorkspace {
  name: string;
  folder: string;
  branch?: string;
  chats: FoundSession[];
}

export type ConductorWorkspaceRead =
  | { status: 'ok'; storePaths: string[]; workspaces: ConductorWorkspace[] }
  | { status: 'absent' | 'unreadable'; reason?: string; version?: string; storePaths: string[] };

/** Conductor writes sqlite `datetime('now')`: UTC without a zone. */
function conductorTimeMs(value: string | null): number | undefined {
  if (value && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/u.test(value)) return Date.parse(`${value.replace(' ', 'T')}Z`);
  return toMs(value);
}

function sessionTitle(row: ConductorRow): string | undefined {
  return row.title && row.title !== 'Untitled' ? row.title : row.workspaceName ?? undefined;
}

function lastActive(row: ConductorRow): number {
  return Math.max(conductorTimeMs(row.updatedAt) ?? 0, conductorTimeMs(row.lastUserMessageAt) ?? 0);
}

/** Every workspace Conductor hasn't archived, each with all of its chats, whatever their age. */
export async function readConductorWorkspaces(context: ReaderContext): Promise<ConductorWorkspaceRead> {
  const read = await readStore(context);
  if (read.status !== 'ok') return read;
  const byFolder = new Map<string, ConductorWorkspace>();
  for (const row of read.workspaceRows) {
    if (!row.workspacePath) continue;
    const folder = path.resolve(row.workspacePath);
    if (!byFolder.has(folder)) {
      byFolder.set(folder, { name: row.workspaceName ?? path.basename(folder), folder: row.workspacePath, branch: row.branch ?? undefined, chats: [] });
    }
  }
  for (const session of read.sessions) {
    if (session.folder) byFolder.get(path.resolve(session.folder))?.chats.push(session);
  }
  return { status: 'ok', storePaths: read.storePaths, workspaces: [...byFolder.values()] };
}

export const readConductor: SourceReader = async context => {
  const read = await readStore(context);
  if (read.status === 'absent') return absent('conductor', read.storePaths);
  if (read.status !== 'ok') return unreadable('conductor', read.reason ?? 'Conductor\'s database couldn\'t be read', read.storePaths, read.version);
  return {
    source: 'conductor',
    status: 'ok',
    version: read.version,
    storePaths: read.storePaths,
    sessions: read.sessions.filter(session => session.lastActiveMs >= context.sinceMs),
  };
};

type StoreRead =
  | { status: 'ok'; version: string; storePaths: string[]; workspaceRows: WorkspaceRow[]; sessions: FoundSession[] }
  | Exclude<ConductorWorkspaceRead, { status: 'ok' }>;

async function readStore(context: ReaderContext): Promise<StoreRead> {
  if (context.platform !== 'darwin') return { status: 'absent', storePaths: [] };
  const dbPath = path.join(appDataDir(context, 'com.conductor.app'), 'conductor.db');
  const storePaths = [dbPath];
  if (!exists(dbPath)) return { status: 'absent', storePaths };

  const read = withSqliteCopy(context, dbPath, db => {
    // SAFETY: PRAGMA user_version returns one integer.
    const version = String(db.pragma('user_version', { simple: true }) as number);
    const sessionColumns = tableColumns(db, 'sessions');
    const workspaceColumns = tableColumns(db, 'workspaces');
    const workspaceKeys = ['local_id', 'id'].filter(column => workspaceColumns.has(column));
    if (!SESSION_COLUMNS.every(column => sessionColumns.has(column))
      || !WORKSPACE_COLUMNS.every(column => workspaceColumns.has(column))
      || workspaceKeys.length === 0) {
      return { version };
    }
    const lastUserMessage = sessionColumns.has('last_user_message_at') ? 's.last_user_message_at' : 'NULL';
    const hidden = sessionColumns.has('is_hidden') ? 'AND COALESCE(s.is_hidden, 0) = 0' : '';
    // SAFETY: the selected columns are checked above and aliased to WorkspaceRow's fields.
    const workspaceRows = db.prepare(`
      SELECT workspace_path AS workspacePath, branch AS branch, directory_name AS workspaceName
      FROM workspaces WHERE COALESCE(state, '') <> 'archived'
    `).all() as WorkspaceRow[];
    // SAFETY: the selected columns are checked above and aliased to ConductorRow's fields.
    const rows = db.prepare(`
      SELECT s.agent_type AS agentType, s.claude_session_id AS claudeSessionId, s.title AS title,
        s.status AS status, s.updated_at AS updatedAt, ${lastUserMessage} AS lastUserMessageAt,
        w.workspace_path AS workspacePath, w.branch AS branch, w.directory_name AS workspaceName
      FROM sessions s
      JOIN workspaces w ON s.workspace_id IN (${workspaceKeys.map(key => `w.${key}`).join(', ')})
      WHERE COALESCE(w.state, '') <> 'archived' ${hidden}
    `).all() as ConductorRow[];
    return { version, rows, workspaceRows };
  });
  if (!read.rows || !read.workspaceRows) {
    return { status: 'unreadable', reason: 'Conductor\'s database has tables Pane doesn\'t recognise', storePaths, version: read.version };
  }

  const executables = await context.processCommands();
  const conductorAlive = executables.some(executable => executable.includes('/Conductor.app/'));
  const busyInConductor = (row: ConductorRow): boolean => conductorAlive && BUSY_STATUSES.has(row.status ?? '');
  const settle = (fromAgent: ImportRunning, busy: boolean): ImportRunning => (fromAgent === 'yes' ? 'yes' : busy ? 'unknown' : fromAgent);

  const withFolder = read.rows.filter(row => row.workspacePath);
  const sessions: FoundSession[] = [];

  const claudeRows = withFolder.filter(row => (!row.agentType || row.agentType === 'claude') && row.claudeSessionId);
  if (claudeRows.length > 0) {
    const configDir = claudeConfigDir(context);
    storePaths.push(path.join(configDir, 'projects'), path.join(configDir, 'sessions'));
    const live = liveClaudeSessions(context, configDir);
    for (const row of claudeRows) {
      const sessionId = row.claudeSessionId ?? '';
      const folder = row.workspacePath ?? undefined;
      const transcript = findClaudeTranscript(configDir, sessionId, folder);
      sessions.push({
        source: 'conductor',
        agent: 'claude',
        sessionId,
        folder,
        branch: row.branch ?? undefined,
        title: sessionTitle(row),
        lastActiveMs: lastActive(row),
        running: settle(claudeRunning(live, sessionId, folder), busyInConductor(row)),
        unavailable: transcript ? undefined : 'its Claude Code transcript isn\'t on this computer',
      });
    }
  }

  const codexRows = withFolder.filter(row => row.agentType === 'codex');
  if (codexRows.length > 0) {
    const home = codexHome(context);
    const store = listCodexSessions(context, home);
    storePaths.push(...store.storePaths, path.join(home, 'thread-writer-locks'));
    const byFolder = new Map<string, ConductorRow[]>();
    for (const row of codexRows) {
      const folder = path.resolve(row.workspacePath ?? '');
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), row]);
    }
    for (const thread of store.threads) {
      // Conductor drives Codex through its TypeScript SDK (`codex exec`).
      const fromSdk = thread.originator?.startsWith('codex_sdk') || thread.source === 'exec';
      const rows = thread.folder && fromSdk && !thread.subagent ? byFolder.get(path.resolve(thread.folder)) : undefined;
      if (!rows) continue;
      sessions.push({
        source: 'conductor',
        agent: 'codex',
        sessionId: thread.id,
        folder: thread.folder,
        branch: rows[0].branch ?? undefined,
        title: (rows.length === 1 ? sessionTitle(rows[0]) : undefined) ?? thread.title ?? rows[0].workspaceName ?? undefined,
        lastActiveMs: thread.lastActiveMs,
        running: settle(codexRunning(home, thread.id, executables), rows.some(busyInConductor)),
      });
    }
  }

  return { status: 'ok', version: read.version, storePaths, workspaceRows: read.workspaceRows, sessions };
}
