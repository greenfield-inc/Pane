import fs from 'fs';
import path from 'path';
import type { FoundSession, ReaderContext, SourceReadResult, SourceReader } from './types';
import type { ImportRunning } from '../../../../../shared/types/sessionImport';
import { absent, claudeConfigDir, codexHome, exists, findClaudeTranscript, findCodexTranscript, hasColumns, isRecord, listDir, readJson, stringField, tableColumns, toMs, type SqliteDatabase, unreadable, withSqliteCopy } from './common';

const SOURCE = 'superset';

/** host.db (v2) columns this reader needs; `transcript_path` and `archived_at` are newer and optional. */
const HOST_COLUMNS: ReadonlyArray<[string, readonly string[]]> = [
  ['terminal_agent_bindings', ['workspace_id', 'agent_id', 'agent_session_id', 'started_at', 'last_event_at', 'ended_at', 'end_reason']],
  ['workspaces', ['id', 'project_id', 'worktree_path', 'branch', 'name']],
  ['projects', ['id', 'repo_path']],
];

/** local.db (v1) columns that place an app-state.json pane's workspace on disk. */
const LOCAL_COLUMNS: ReadonlyArray<[string, readonly string[]]> = [
  ['workspaces', ['id', 'project_id', 'worktree_id', 'branch', 'name', 'deleting_at']],
  ['worktrees', ['id', 'path']],
  ['projects', ['id', 'main_repo_path']],
];

interface BindingRow {
  agent_id: string;
  agent_session_id: string;
  started_at: number | null;
  last_event_at: number | null;
  ended_at: number | null;
  transcript_path: string | null;
  name: string | null;
  worktree_path: string | null;
  branch: string | null;
  repo_path: string | null;
}

interface LocalWorkspaceRow {
  id: string;
  name: string | null;
  branch: string | null;
  folder: string | null;
}

interface ProfileDirs {
  claude?: string;
  codex?: string;
}

/** Superset's home: `SUPERSET_HOME_DIR`, else `~/.superset` on every OS. */
function supersetHome(context: ReaderContext): string {
  return context.env.SUPERSET_HOME_DIR || path.join(context.home, '.superset');
}

/** Pane's names for Superset's agent ids; others keep Superset's id. */
function agentFor(agentId: string): string {
  return agentId === 'cursor-agent' ? 'cursor' : agentId;
}

/** Whether the process recorded in a pid file or manifest is alive; undefined when the record can't be read. */
function pidAlive(context: ReaderContext, pid: number): boolean | undefined {
  return Number.isInteger(pid) && pid > 0 ? context.isPidAlive(pid) : undefined;
}

function migrationCount(db: SqliteDatabase, file: string): string | undefined {
  if (!hasColumns(db, '__drizzle_migrations', ['hash'])) return undefined;
  // SAFETY: COUNT(*) always returns one row with a numeric `count`.
  const row = db.prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations').get() as { count: number };
  return `${file} with ${row.count} migrations`;
}

function missingColumns(db: SqliteDatabase, required: ReadonlyArray<[string, readonly string[]]>): string | undefined {
  const missing = required.find(([table, columns]) => !hasColumns(db, table, columns));
  return missing ? missing[0] : undefined;
}

/**
 * The agent home a transcript sits in, from its layout:
 * Claude `<home>/projects/<folder>/<id>.jsonl`, Codex `<home>/sessions/YYYY/MM/DD/<file>.jsonl`.
 */
function agentHomeOf(agent: string, transcript: string): string | undefined {
  if (agent === 'claude') {
    const projects = path.dirname(path.dirname(transcript));
    return path.basename(projects) === 'projects' ? path.dirname(projects) : undefined;
  }
  if (agent === 'codex') {
    const sessions = path.dirname(path.dirname(path.dirname(path.dirname(transcript))));
    return path.basename(sessions) === 'sessions' ? path.dirname(sessions) : undefined;
  }
  return undefined;
}

/**
 * The transcript when Superset ran the agent under its own CLAUDE_CONFIG_DIR /
 * CODEX_HOME: the path the agent's hook reported, else a search of the host's
 * default profile folder.
 */
function transcriptFor(
  context: ReaderContext,
  agent: string,
  sessionId: string,
  reported: string | null,
  profiles: ProfileDirs,
): FoundSession['transcript'] {
  const own = agent === 'claude' ? claudeConfigDir(context) : agent === 'codex' ? codexHome(context) : undefined;
  if (!own) return undefined;
  if (reported) {
    const agentHome = agentHomeOf(agent, reported);
    if (!agentHome || path.resolve(agentHome) === path.resolve(own)) return undefined;
    return { agentHome, path: reported };
  }
  const profile = agent === 'claude' ? profiles.claude : profiles.codex;
  if (!profile || path.resolve(profile) === path.resolve(own)) return undefined;
  const file = agent === 'claude' ? findClaudeTranscript(profile, sessionId) : findCodexTranscript(profile, sessionId);
  return file ? { agentHome: profile, path: file } : undefined;
}

function readProfiles(db: SqliteDatabase): ProfileDirs {
  if (!hasColumns(db, 'host_settings', ['default_claude_config_dir', 'default_codex_home'])) return {};
  // SAFETY: both columns are TEXT; the row may be missing.
  const row = db.prepare('SELECT default_claude_config_dir, default_codex_home FROM host_settings LIMIT 1').get() as
    | { default_claude_config_dir: string | null; default_codex_home: string | null }
    | undefined;
  return { claude: row?.default_claude_config_dir || undefined, codex: row?.default_codex_home || undefined };
}

type HostRead = { rows: BindingRow[]; profiles: ProfileDirs } | { reason: string; version?: string };

function readHostDb(db: SqliteDatabase): HostRead {
  const version = migrationCount(db, 'host.db');
  const missing = missingColumns(db, HOST_COLUMNS);
  if (!version || missing) return { reason: `host.db has no ${missing ?? '__drizzle_migrations'} table in the shape Pane reads`, version };
  const bindingColumns = tableColumns(db, 'terminal_agent_bindings');
  const transcript = bindingColumns.has('transcript_path') ? 'b.transcript_path' : 'NULL';
  const notArchived = tableColumns(db, 'workspaces').has('archived_at') ? 'AND w.archived_at IS NULL' : '';
  const notDeleted = tableColumns(db, 'projects').has('deleted_at') ? 'AND p.deleted_at IS NULL' : '';
  // SAFETY: the selected columns were checked above.
  const rows = db.prepare(`
    SELECT b.agent_id, b.agent_session_id, b.started_at, b.last_event_at, b.ended_at,
           ${transcript} AS transcript_path,
           w.name, w.worktree_path, w.branch, p.repo_path
    FROM terminal_agent_bindings b
    LEFT JOIN workspaces w ON w.id = b.workspace_id
    LEFT JOIN projects p ON p.id = w.project_id
    WHERE b.agent_session_id IS NOT NULL AND b.agent_session_id <> ''
      AND (b.end_reason IS NULL OR b.end_reason <> 'resumed')
      ${notArchived} ${notDeleted}
  `).all() as BindingRow[];
  return { rows, profiles: readProfiles(db) };
}

type LocalRead = { workspaces: Map<string, LocalWorkspaceRow> } | { reason: string; version?: string };

function readLocalDb(db: SqliteDatabase): LocalRead {
  const version = migrationCount(db, 'local.db');
  const missing = missingColumns(db, LOCAL_COLUMNS);
  if (!version || missing) return { reason: `local.db has no ${missing ?? '__drizzle_migrations'} table in the shape Pane reads`, version };
  // SAFETY: the selected columns were checked above.
  const rows = db.prepare(`
    SELECT w.id, w.name, w.branch, COALESCE(t.path, p.main_repo_path) AS folder
    FROM workspaces w
    LEFT JOIN worktrees t ON t.id = w.worktree_id
    LEFT JOIN projects p ON p.id = w.project_id
    WHERE w.deleting_at IS NULL
  `).all() as LocalWorkspaceRow[];
  return { workspaces: new Map(rows.map(row => [row.id, row])) };
}

interface V1Session {
  paneId: string;
  agentId: string;
  sessionId: string;
  endedAt?: number;
  lastActiveMs: number;
}

interface V1Pane {
  workspaceId?: string;
  cwd?: string;
}

/**
 * app-state.json: prompted agent sessions per v1 pane (`v1AgentSessions`) and
 * each pane's workspace id and cwd from every saved tab layout. Undefined when
 * the file is not a JSON object.
 */
function readAppState(file: string): { sessions: V1Session[]; panes: Map<string, V1Pane> } | undefined {
  const appState = readJson(file);
  if (!isRecord(appState)) return undefined;
  const sessions: V1Session[] = [];
  for (const [paneId, entry] of Object.entries(isRecord(appState.v1AgentSessions) ? appState.v1AgentSessions : {})) {
    if (!isRecord(entry) || entry.prompted !== true) continue;
    const agentId = stringField(entry, 'agentId');
    const sessionId = stringField(entry, 'agentSessionId');
    if (!agentId || !sessionId) continue;
    const endedAt = toMs(entry.endedAt);
    sessions.push({ paneId, agentId, sessionId, endedAt, lastActiveMs: Math.max(toMs(entry.updatedAt) ?? 0, endedAt ?? 0) });
  }
  const layouts = [appState.tabsState, ...(isRecord(appState.tabsStateByWindow) ? Object.values(appState.tabsStateByWindow) : [])];
  const panes = new Map<string, V1Pane>();
  for (const layout of layouts) {
    if (!isRecord(layout) || !isRecord(layout.panes)) continue;
    const tabs = Array.isArray(layout.tabs) ? layout.tabs.filter(isRecord) : [];
    const workspaceByTab = new Map(tabs.map(tab => [stringField(tab, 'id'), stringField(tab, 'workspaceId')]));
    for (const [paneId, pane] of Object.entries(layout.panes)) {
      if (!isRecord(pane)) continue;
      const tabId = stringField(pane, 'tabId');
      panes.set(paneId, {
        workspaceId: tabId ? workspaceByTab.get(tabId) : undefined,
        cwd: stringField(pane, 'cwd') ?? stringField(pane, 'initialCwd'),
      });
    }
  }
  return { sessions, panes };
}

export const readSuperset: SourceReader = async context => {
  const base = supersetHome(context);
  const hostRoot = path.join(base, 'host');
  const hostDbs = listDir(hostRoot)
    .map(org => path.join(hostRoot, org, 'host.db'))
    .filter(exists);
  const localDb = path.join(base, 'local.db');
  const appStateFile = path.join(base, 'app-state.json');
  const v1PidFile = path.join(base, 'terminal-host.pid');
  const hasLocalDb = exists(localDb);
  const hasAppState = exists(appStateFile);
  if (hostDbs.length === 0 && !hasLocalDb && !hasAppState) return absent(SOURCE, [base]);

  const storePaths = [...hostDbs, ...(hasLocalDb ? [localDb] : []), ...(hasAppState ? [appStateFile] : [])];
  const fail = (reason: string, version?: string): SourceReadResult => unreadable(SOURCE, reason, storePaths, version);
  const commands = await context.processCommands();
  const inCommandLine = (sessionId: string) => commands.some(command => command.includes(sessionId));
  const found = new Map<string, FoundSession>();

  // v2: one host.db per organization, the source of truth for agent bindings.
  for (const dbPath of hostDbs) {
    const read = withSqliteCopy(context, dbPath, readHostDb);
    if ('reason' in read) return fail(read.reason, read.version);
    const manifestFile = path.join(path.dirname(dbPath), 'manifest.json');
    const manifest = readJson(manifestFile);
    const hostAlive = exists(manifestFile) ? pidAlive(context, Number(isRecord(manifest) ? manifest.pid : NaN)) : false;
    storePaths.push(manifestFile);
    for (const row of read.rows) {
      const lastActiveMs = Math.max(toMs(row.last_event_at) ?? 0, toMs(row.ended_at) ?? 0, toMs(row.started_at) ?? 0);
      if (lastActiveMs < context.sinceMs) continue;
      const agent = agentFor(row.agent_id);
      const sessionId = row.agent_session_id;
      // An unended binding with the host-service down may still live in Superset's pty-daemon.
      const running: ImportRunning = inCommandLine(sessionId) ? 'yes'
        : row.ended_at !== null ? 'no'
          : hostAlive === true ? 'yes' : 'unknown';
      const session: FoundSession = {
        source: SOURCE,
        agent,
        sessionId,
        folder: row.worktree_path || row.repo_path || undefined,
        branch: row.branch || undefined,
        title: row.name || undefined,
        lastActiveMs,
        running,
        transcript: transcriptFor(context, agent, sessionId, row.transcript_path, read.profiles),
      };
      const key = `${agent}:${sessionId}`;
      const previous = found.get(key);
      if (!previous || previous.lastActiveMs < lastActiveMs) found.set(key, session);
    }
  }

  // v1: agent sessions per pane in app-state.json, placed through local.db.
  if (hasAppState) {
    const appState = readAppState(appStateFile);
    if (!appState) return fail('app-state.json is not a JSON object');
    if (appState.sessions.length > 0) {
      let workspaces = new Map<string, LocalWorkspaceRow>();
      if (hasLocalDb) {
        const read = withSqliteCopy(context, localDb, readLocalDb);
        if ('reason' in read) return fail(read.reason, read.version);
        workspaces = read.workspaces;
      }
      const hasPidFile = exists(v1PidFile);
      const daemonAlive = hasPidFile ? pidAlive(context, Number(fs.readFileSync(v1PidFile, 'utf8').trim())) : false;
      if (hasPidFile) storePaths.push(v1PidFile);
      for (const v1 of appState.sessions) {
        const agent = agentFor(v1.agentId);
        const key = `${agent}:${v1.sessionId}`;
        if (found.has(key) || v1.lastActiveMs < context.sinceMs) continue;
        const pane = appState.panes.get(v1.paneId);
        const workspace = pane?.workspaceId ? workspaces.get(pane.workspaceId) : undefined;
        const running: ImportRunning = inCommandLine(v1.sessionId) ? 'yes'
          : v1.endedAt !== undefined || daemonAlive === false ? 'no' : 'unknown';
        found.set(key, {
          source: SOURCE,
          agent,
          sessionId: v1.sessionId,
          folder: workspace?.folder || pane?.cwd,
          branch: workspace?.branch || undefined,
          title: workspace?.name || undefined,
          lastActiveMs: v1.lastActiveMs,
          running,
        });
      }
    }
  }

  return { source: SOURCE, status: 'ok', storePaths, sessions: [...found.values()] };
};
