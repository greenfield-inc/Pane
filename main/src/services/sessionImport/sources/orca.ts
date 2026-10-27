import fs from 'fs';
import path from 'path';
import type { ImportRunning } from '../../../../../shared/types/sessionImport';
import type { FoundSession, ReaderContext, SourceReader } from './types';
import { absent, appDataDir, exists, hasColumns, isRecord, readJson, stringField, toMs, unreadable, withSqliteCopy } from './common';
import type { SqliteDatabase } from './common';

// Orca keeps each profile's state in `<userData>/profiles/<id>/profile-state.db`
// (PRAGMA user_version 3): `profile_state_documents` holds one JSON document
// per top-level state key. The local `workspaceSession` document's
// `sleepingAgentSessionsByPaneKey` records carry `agent`,
// `providerSession{id, cwd, transcriptPath}`, `worktreeId` (`<repoId>::<path>`),
// `terminalTitle`, `updatedAt` and `launchConfig.agentEnv`. `worktreeMeta` has
// `displayName` and `isArchived`; `repos` marks SSH and remote-host repos.
// `<userData>/agent-hooks/last-status.json` (version 2) holds the hook status
// per pane, with `providerSession`, `agentPresence.process.pid` and `receivedAt`.

const SOURCE = 'orca';
const PROFILE_DB_VERSION = 3;
const LAST_STATUS_VERSION = 2;
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

interface Candidate {
  agent: string | null;
  sessionId: string | null;
  cwd: string | null;
  transcriptPath: string | null;
  worktreeId: string | null;
  remote: number;
  title: string | null;
  lastActiveMs: number | null;
  claudeConfigDir: string | null;
  codexHome: string | null;
}

interface WorktreeRow {
  worktreeId: string;
  displayName: string | null;
  isArchived: number | null;
}

interface ProfileState {
  candidates: Candidate[];
  worktrees: WorktreeRow[];
  remoteRepoIds: string[];
}

export const readOrca: SourceReader = async context => {
  const userData = context.env.ORCA_USER_DATA_PATH || appDataDir(context, 'orca');
  if (!exists(userData)) return absent(SOURCE);

  const indexPath = path.join(userData, 'orca-profile-index.json');
  const profileId = activeProfileId(indexPath);
  if (!profileId) {
    const legacy = path.join(userData, 'orca-data.json');
    if (exists(legacy) || exists(indexPath)) {
      return unreadable(SOURCE, 'Orca\'s profile index is missing or in a layout Pane doesn\'t recognise', [indexPath, legacy]);
    }
    return { source: SOURCE, status: 'ok', storePaths: [indexPath], sessions: [] };
  }

  const profileDir = path.join(userData, 'profiles', profileId);
  const dbPath = path.join(profileDir, 'profile-state.db');
  const lastStatusPath = path.join(userData, 'agent-hooks', 'last-status.json');
  const storePaths = [indexPath, dbPath, lastStatusPath];
  if (!exists(dbPath)) {
    return unreadable(SOURCE, 'Orca keeps this profile in its older orca-data.json layout; open Orca once to update it', [...storePaths, path.join(profileDir, 'orca-data.json')]);
  }

  let read: { version: number; state?: ProfileState };
  try {
    read = withSqliteCopy(context, dbPath, db => {
      // SAFETY: PRAGMA user_version returns one integer.
      const version = db.pragma('user_version', { simple: true }) as number;
      if (version !== PROFILE_DB_VERSION || !hasColumns(db, 'profile_state_documents', ['domain', 'payload'])) return { version };
      return { version, state: readProfileState(db) };
    });
  } catch {
    return unreadable(SOURCE, 'Orca\'s profile store holds documents Pane couldn\'t parse', storePaths, String(PROFILE_DB_VERSION));
  }
  if (!read.state) return unreadable(SOURCE, `Orca's profile store has schema version ${read.version}`, storePaths, String(read.version));

  const lastStatus = readJson(lastStatusPath);
  if (exists(lastStatusPath) && (!isRecord(lastStatus) || lastStatus.version !== LAST_STATUS_VERSION || !isRecord(lastStatus.entries))) {
    return unreadable(SOURCE, 'Orca\'s agent status file is in a format Pane doesn\'t recognise', storePaths, isRecord(lastStatus) ? String(lastStatus.version) : undefined);
  }

  const host = orcaHostRunning(context, userData);
  const found: Array<{ candidate: Candidate; running: ImportRunning }> = read.state.candidates.map(candidate => ({
    candidate,
    // Orca or its terminal daemon may have restored the pane since the record was written.
    running: host === 'no' ? 'no' : 'unknown',
  }));
  if (isRecord(lastStatus) && isRecord(lastStatus.entries)) {
    for (const entry of Object.values(lastStatus.entries)) {
      if (!isRecord(entry)) continue;
      const provider = isRecord(entry.providerSession) ? entry.providerSession : undefined;
      const presence = isRecord(entry.agentPresence) ? entry.agentPresence : undefined;
      const agentProcess = isRecord(presence?.process) ? presence.process : undefined;
      const pid = Number.isInteger(agentProcess?.pid) ? Number(agentProcess?.pid) : undefined;
      found.push({
        candidate: {
          agent: stringField(entry, 'source') ?? stringField(presence, 'agent') ?? null,
          sessionId: stringField(provider, 'id') ?? null,
          cwd: stringField(provider, 'cwd') ?? null,
          transcriptPath: stringField(provider, 'transcriptPath') ?? null,
          worktreeId: stringField(entry, 'worktreeId') ?? null,
          remote: stringField(entry, 'connectionId') ? 1 : 0,
          title: null,
          lastActiveMs: toMs(entry.receivedAt) ?? null,
          claudeConfigDir: null,
          codexHome: null,
        },
        running: presenceRunning(context, presence?.ended === true, pid, host),
      });
    }
  }

  const worktrees = new Map(read.state.worktrees.map(row => [row.worktreeId, row]));
  const remoteRepoIds = new Set(read.state.remoteRepoIds);
  const sessions = new Map<string, FoundSession>();
  for (const { candidate, running } of found) {
    const { agent, sessionId, worktreeId, lastActiveMs } = candidate;
    if (!agent || !sessionId || lastActiveMs === null || lastActiveMs < context.sinceMs || candidate.remote) continue;
    const separator = worktreeId ? worktreeId.indexOf('::') : -1;
    if (worktreeId && separator > 0 && remoteRepoIds.has(worktreeId.slice(0, separator))) continue;
    const worktree = worktreeId ? worktrees.get(worktreeId) : undefined;
    if (worktree?.isArchived) continue;

    const session: FoundSession = {
      source: SOURCE,
      agent,
      sessionId,
      folder: candidate.cwd ?? (worktreeId && separator > 0 ? worktreeId.slice(separator + 2) : undefined),
      title: candidate.title ?? worktree?.displayName ?? undefined,
      lastActiveMs,
      running,
    };
    const transcript = managedTranscript(agent, candidate.transcriptPath, userData);
    if (transcript) session.transcript = transcript;
    else if (usesManagedHome(agent, candidate, userData)) {
      session.unavailable = 'Orca ran it with its own account folder and didn\'t record where the transcript is';
    }

    const key = `${agent}:${sessionId}`;
    const previous = sessions.get(key);
    sessions.set(key, previous ? merge(previous, session) : session);
  }

  return { source: SOURCE, status: 'ok', version: String(PROFILE_DB_VERSION), storePaths, sessions: [...sessions.values()] };
};

function readProfileState(db: SqliteDatabase): ProfileState {
  // SAFETY: each json_extract yields text, a number or null, aliased to Candidate's fields.
  const candidates = db.prepare(`
    SELECT json_extract(s.value, '$.agent') AS agent,
      json_extract(s.value, '$.providerSession.id') AS sessionId,
      json_extract(s.value, '$.providerSession.cwd') AS cwd,
      json_extract(s.value, '$.providerSession.transcriptPath') AS transcriptPath,
      json_extract(s.value, '$.worktreeId') AS worktreeId,
      json_extract(s.value, '$.connectionId') IS NOT NULL AS remote,
      json_extract(s.value, '$.terminalTitle') AS title,
      COALESCE(json_extract(s.value, '$.updatedAt'), json_extract(s.value, '$.capturedAt')) AS lastActiveMs,
      json_extract(s.value, '$.launchConfig.agentEnv.CLAUDE_CONFIG_DIR') AS claudeConfigDir,
      json_extract(s.value, '$.launchConfig.agentEnv.CODEX_HOME') AS codexHome
    FROM profile_state_documents d, json_each(d.payload, '$.sleepingAgentSessionsByPaneKey') s
    WHERE d.domain = 'workspaceSession'
  `).all() as Candidate[];
  // SAFETY: json_each keys of an object are text; the extracts yield text, 0/1 or null.
  const worktrees = db.prepare(`
    SELECT m.key AS worktreeId, json_extract(m.value, '$.displayName') AS displayName,
      json_extract(m.value, '$.isArchived') AS isArchived
    FROM profile_state_documents d, json_each(d.payload) m
    WHERE d.domain = 'worktreeMeta'
  `).all() as WorktreeRow[];
  // SAFETY: the query selects one text-or-null column.
  const repos = db.prepare(`
    SELECT json_extract(r.value, '$.id') AS id
    FROM profile_state_documents d, json_each(d.payload) r
    WHERE d.domain = 'repos' AND (json_extract(r.value, '$.connectionId') IS NOT NULL
      OR COALESCE(json_extract(r.value, '$.executionHostId'), 'local') <> 'local')
  `).all() as Array<{ id: string | null }>;
  return { candidates, worktrees, remoteRepoIds: repos.flatMap(repo => (repo.id ? [repo.id] : [])) };
}

function activeProfileId(indexPath: string): string | undefined {
  for (const candidate of [indexPath, `${indexPath}.bak`]) {
    const index = readJson(candidate);
    if (!isRecord(index) || !Array.isArray(index.profiles)) continue;
    const id = stringField(index, 'activeProfileId');
    if (id && PROFILE_ID.test(id) && index.profiles.some(profile => isRecord(profile) && profile.id === id)) return id;
  }
  return undefined;
}

function pidIn(file: string): number | undefined {
  const content = readJson(file);
  return isRecord(content) && Number.isInteger(content.pid) ? Number(content.pid) : undefined;
}

/**
 * Whether the Orca app or its terminal daemon, which keeps PTYs alive after the
 * window closes, is running. A marker Pane can't read leaves it unknown.
 */
function orcaHostRunning(context: ReaderContext, userData: string): ImportRunning {
  const pidFiles = [path.join(userData, 'orca-runtime.json')];
  try {
    for (const name of fs.readdirSync(path.join(userData, 'daemon'))) {
      if (/^daemon-v\d+\.pid$/u.test(name)) pidFiles.push(path.join(userData, 'daemon', name));
    }
  } catch (error) {
    // SAFETY: fs.readdirSync only throws errno errors.
    if (!isMissing(error as NodeJS.ErrnoException)) return 'unknown';
  }
  let unclear = false;
  for (const file of pidFiles) {
    try {
      // Follows links, so a marker reached through a folder Pane can't open is unclear, not missing.
      fs.statSync(file);
    } catch (error) {
      // SAFETY: fs.statSync only throws errno errors.
      if (isMissing(error as NodeJS.ErrnoException)) continue;
      unclear = true;
      continue;
    }
    const pid = pidIn(file);
    if (pid === undefined) unclear = true;
    else if (context.isPidAlive(pid)) return 'yes';
  }
  return unclear ? 'unknown' : 'no';
}

/** Only a path that isn't there counts as absent; any other error leaves the state unknown. */
function isMissing(error: NodeJS.ErrnoException): boolean {
  return error.code === 'ENOENT' || error.code === 'ENOTDIR';
}

/** A hook entry's agent: ended, or its process alive or gone; otherwise as sure as the host. */
function presenceRunning(context: ReaderContext, ended: boolean, pid: number | undefined, host: ImportRunning): ImportRunning {
  if (ended) return 'no';
  if (pid !== undefined) return context.isPidAlive(pid) ? 'yes' : 'no';
  return host === 'no' ? 'no' : 'unknown';
}

const RUNNING_RANK = { no: 0, unknown: 1, yes: 2 } satisfies Record<ImportRunning, number>;

/** The same session can sit in a sleep record and in last-status: keep the newer facts and the strongest running signal. */
function merge(a: FoundSession, b: FoundSession): FoundSession {
  const [newer, older] = b.lastActiveMs > a.lastActiveMs ? [b, a] : [a, b];
  const merged: FoundSession = {
    ...newer,
    folder: newer.folder ?? older.folder,
    title: newer.title ?? older.title,
    running: RUNNING_RANK[a.running] >= RUNNING_RANK[b.running] ? a.running : b.running,
  };
  const transcript = newer.transcript ?? older.transcript;
  if (transcript) {
    merged.transcript = transcript;
    delete merged.unavailable;
  } else if (older.unavailable) merged.unavailable = older.unavailable;
  return merged;
}

function isInside(target: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * The transcript, when it sits in an agent home Orca manages inside its own
 * data folder: Claude's <home>/projects/<slug>/<id>.jsonl, Codex's
 * <home>/sessions/YYYY/MM/DD/rollout-*.jsonl.
 */
function managedTranscript(agent: string, transcriptPath: string | null, userData: string): FoundSession['transcript'] {
  const layout = agent === 'claude' ? { folder: 'projects', depth: 2 } : agent === 'codex' ? { folder: 'sessions', depth: 4 } : undefined;
  if (!layout || !transcriptPath || !path.isAbsolute(transcriptPath)) return undefined;
  let folder = transcriptPath;
  for (let level = 0; level < layout.depth; level++) folder = path.dirname(folder);
  if (path.basename(folder) !== layout.folder) return undefined;
  const agentHome = path.dirname(folder);
  return isInside(agentHome, userData) ? { agentHome, path: transcriptPath } : undefined;
}

function usesManagedHome(agent: string, candidate: Candidate, userData: string): boolean {
  const home = agent === 'claude' ? candidate.claudeConfigDir : agent === 'codex' ? candidate.codexHome : null;
  return home !== null && isInside(home, userData);
}
