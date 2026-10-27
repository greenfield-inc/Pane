import fs from 'fs';
import path from 'path';
import type { FoundSession, ReaderContext, SourceReader } from './types';
import type { ImportRunning } from '../../../../../shared/types/sessionImport';
import { absent, claudeConfigDir, codexHome, exists, findClaudeTranscript, findCodexTranscript, hasColumns, isRecord, listDir, readJson, stringField, toMs, type SqliteDatabase, unreadable, withSqliteCopy } from './common';

const SOURCE = 't3code';

const THREADS = 'orchestration_v2_projection_threads';
const PROVIDER_THREADS = 'orchestration_v2_projection_provider_threads';
const RUNS = 'orchestration_v2_projection_runs';
const PROJECTS = 'projection_projects';

const REQUIRED_COLUMNS: ReadonlyArray<[string, readonly string[]]> = [
  [THREADS, ['thread_id', 'project_id', 'title', 'active_provider_thread_id', 'updated_at', 'archived_at', 'deleted_at', 'payload_json']],
  [PROVIDER_THREADS, ['provider_thread_id', 'provider', 'driver', 'provider_instance_id', 'status', 'payload_json']],
  [RUNS, ['thread_id', 'ordinal', 'status']],
  [PROJECTS, ['project_id', 'workspace_root', 'deleted_at']],
];

const ACTIVE_RUN_STATUSES = new Set(['preparing', 'queued', 'starting', 'running', 'waiting']);
const ENDED_RUN_STATUSES = new Set(['completed', 'interrupted', 'failed', 'cancelled', 'rolled_back']);

interface ThreadRow {
  thread_id: string;
  title: string | null;
  updated_at: string | null;
  branch: string | null;
  folder: string | null;
  relationship: string | null;
  driver: string | null;
  instance_id: string | null;
  native_id: string | null;
  provider_thread_status: string | null;
  run_status: string | null;
}

/** T3 Code's data folder: `T3CODE_HOME`, else `~/.t3` on every OS. */
function t3Base(context: ReaderContext): string {
  return context.env.T3CODE_HOME || path.join(context.home, '.t3');
}

/** Agent names Pane uses for T3 Code's driver kinds. */
function agentFor(driver: string): string {
  return driver === 'claudeAgent' ? 'claude' : driver;
}

/** Whether T3 Code's server is up: yes, no, or undefined when the marker can't be read. */
function serverAlive(context: ReaderContext, runtimeFile: string): boolean | undefined {
  if (!exists(runtimeFile)) return false;
  const runtime = readJson(runtimeFile);
  // The marker's `pid` is an integer; anything else is unreadable.
  const pid = isRecord(runtime) && Number.isInteger(runtime.pid) ? Number(runtime.pid) : 0;
  if (pid <= 0) return undefined;
  return context.isPidAlive(pid);
}

function runningFor(row: ThreadRow, server: boolean | undefined): ImportRunning {
  if (server === false) return 'no';
  if (server === undefined) return 'unknown';
  if (row.provider_thread_status === 'active') return 'yes';
  if (row.run_status === null) return 'no';
  if (ACTIVE_RUN_STATUSES.has(row.run_status)) return 'yes';
  return ENDED_RUN_STATUSES.has(row.run_status) ? 'no' : 'unknown';
}

/** `homePath` per provider instance id from T3 Code's settings.json. */
function instanceHomes(settingsFile: string, home: string): Map<string, string> {
  const homes = new Map<string, string>();
  const settings = readJson(settingsFile);
  const instances = isRecord(settings) ? settings.providerInstances : undefined;
  if (!isRecord(instances)) return homes;
  for (const [id, instance] of Object.entries(instances)) {
    const config = isRecord(instance) && isRecord(instance.config) ? instance.config : undefined;
    const homePath = stringField(config, 'homePath')?.trim();
    if (!homePath) continue;
    const expanded = homePath === '~' || homePath.startsWith('~/') ? path.join(home, homePath.slice(1)) : homePath;
    homes.set(id, path.resolve(expanded));
  }
  return homes;
}

/**
 * Where the transcript lives when the thread's provider instance sets its own
 * CLAUDE_CONFIG_DIR / CODEX_HOME (`homePath`) apart from the person's own.
 */
function transcriptFor(
  context: ReaderContext,
  agent: string,
  sessionId: string,
  instanceHome: string | undefined,
): Pick<FoundSession, 'transcript' | 'unavailable'> {
  if (!instanceHome) return {};
  if (agent === 'claude' && instanceHome !== path.resolve(claudeConfigDir(context))) {
    const file = findClaudeTranscript(instanceHome, sessionId);
    return file
      ? { transcript: { agentHome: instanceHome, path: file } }
      : { unavailable: `its transcript isn't in ${instanceHome}` };
  }
  if (agent === 'codex' && instanceHome !== path.resolve(codexHome(context))) {
    const file = findCodexTranscript(instanceHome, sessionId);
    return file
      ? { transcript: { agentHome: instanceHome, path: file } }
      : { unavailable: `its transcript isn't in ${instanceHome}` };
  }
  return {};
}

function schemaVersion(db: SqliteDatabase): string | undefined {
  if (!hasColumns(db, 'effect_sql_migrations', ['migration_id'])) return undefined;
  // SAFETY: MAX over an integer column returns a number or null.
  const row = db.prepare('SELECT MAX(migration_id) AS id FROM effect_sql_migrations').get() as { id: number | null };
  return row.id === null ? undefined : `schema ${row.id}`;
}

function readThreads(db: SqliteDatabase): ThreadRow[] {
  // SAFETY: the columns were checked with hasColumns; json_extract yields text or null.
  return db.prepare(`
    SELECT
      t.thread_id,
      t.title,
      t.updated_at,
      json_extract(t.payload_json, '$.branch') AS branch,
      COALESCE(json_extract(t.payload_json, '$.worktreePath'), p.workspace_root) AS folder,
      json_extract(t.payload_json, '$.lineage.relationshipToParent') AS relationship,
      COALESCE(pt.driver, pt.provider) AS driver,
      pt.provider_instance_id AS instance_id,
      json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') AS native_id,
      pt.status AS provider_thread_status,
      (SELECT r.status FROM ${RUNS} r WHERE r.thread_id = t.thread_id ORDER BY r.ordinal DESC LIMIT 1) AS run_status
    FROM ${THREADS} t
    JOIN ${PROVIDER_THREADS} pt ON pt.provider_thread_id = t.active_provider_thread_id
    LEFT JOIN ${PROJECTS} p ON p.project_id = t.project_id
    WHERE t.deleted_at IS NULL
      AND t.archived_at IS NULL
      AND p.deleted_at IS NULL
    ORDER BY t.updated_at DESC, t.thread_id
  `).all() as ThreadRow[];
}

/**
 * T3 Code threads from `<T3CODE_HOME or ~/.t3>/userdata/statev2.sqlite` (v0.1.0 on).
 * Each thread resumes by its active provider thread's `nativeThreadRef.nativeId`.
 */
export const readT3Code: SourceReader = async context => {
  const userdata = path.join(t3Base(context), 'userdata');
  const dbPath = path.join(userdata, 'statev2.sqlite');
  const legacyDbPath = path.join(userdata, 'state.sqlite');
  const runtimeFile = path.join(userdata, 'server-runtime.json');
  const settingsFile = path.join(userdata, 'settings.json');

  if (!exists(dbPath)) {
    if (exists(legacyDbPath)) {
      return unreadable(SOURCE, 'T3 Code before 0.1.0 doesn\'t store the agent\'s own session ids', [legacyDbPath], 'before 0.1.0');
    }
    return absent(SOURCE);
  }
  const storePaths = [dbPath, runtimeFile, settingsFile];

  const read = withSqliteCopy(context, dbPath, db => {
    const version = schemaVersion(db);
    const missing = REQUIRED_COLUMNS.find(([table, columns]) => !hasColumns(db, table, columns));
    if (missing) return { version, missingTable: missing[0], rows: [] };
    return { version, missingTable: undefined, rows: readThreads(db) };
  });
  if (read.missingTable) {
    return unreadable(SOURCE, `T3 Code's ${read.missingTable} table isn't in a shape Pane knows`, storePaths, read.version);
  }

  const server = serverAlive(context, runtimeFile);
  const homes = instanceHomes(settingsFile, context.home);
  const sessions: FoundSession[] = [];
  for (const row of read.rows) {
    if (!row.native_id || !row.driver || row.relationship === 'subagent') continue;
    const lastActiveMs = toMs(row.updated_at);
    if (lastActiveMs === undefined || lastActiveMs < context.sinceMs) continue;
    const agent = agentFor(row.driver);
    sessions.push({
      source: SOURCE,
      agent,
      sessionId: row.native_id,
      folder: row.folder ?? undefined,
      branch: row.branch ?? undefined,
      title: row.title || undefined,
      lastActiveMs,
      running: runningFor(row, server),
      ...transcriptFor(context, agent, row.native_id, row.instance_id ? homes.get(row.instance_id) : undefined),
    });
  }
  return { source: SOURCE, status: 'ok', version: read.version, storePaths, sessions };
};
