import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import {
  isResumableImportAgent,
  type ImportRunning,
  type ImportSession,
  type ImportSourceSummary,
  type SessionImportScan,
  type SessionImportSource,
} from '../../../../shared/types/sessionImport';
import type { FoundSession, ReaderContext, SourceReader, SourceReadResult } from './sources/types';
import { isValidOpenCodeSessionId } from '../agents/opencodeLaunch';

const LISTED_DAYS = 30;
const PRESELECTED_DAYS = 7;
const PRESELECTED_PER_CHECKOUT = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const READER_TIMEOUT_MS = 10_000;
const GIT_TIMEOUT_MS = 5_000;
const GIT_CONCURRENCY = 8;

const AGENT_NAMES = {
  claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', opencode: 'OpenCode', amp: 'Amp', gemini: 'Gemini', copilot: 'Copilot',
} as const satisfies Record<string, string>;

export const SOURCE_NAMES = {
  claude: 'Claude Code', codex: 'Codex', conductor: 'Conductor', superset: 'Superset', herdr: 'Herdr', emdash: 'Emdash', orca: 'Orca', t3code: 'T3 Code',
} as const satisfies Record<SessionImportSource, string>;

interface GitCheckout {
  /** Top of the working tree that holds the folder. */
  checkout: string;
  /** The repository's main checkout. */
  repoRoot: string;
  branch?: string;
}

export interface ScanOptions {
  context: ReaderContext;
  readers: ReadonlyArray<{ source: SessionImportSource; read: SourceReader }>;
  /** `<agent>:<session id>` of every session a Pane tab already runs or the shared record names. */
  alreadyInPane: ReadonlySet<string>;
  /** Folders whose sessions never appear: temp folders, Pane's data folder, Pane-made worktrees. */
  excludedRoots: readonly string[];
}

/** A scanned session with what placement needs beyond the card's view. */
export interface ScannedSession extends ImportSession {
  transcript?: FoundSession['transcript'];
}

export interface ScanOutcome {
  scan: SessionImportScan;
  sessions: Map<string, ScannedSession>;
}

function sessionKey(agent: string, sessionId: string): string {
  return `${agent}:${sessionId}`;
}

function agentName(agent: string): string {
  const known = Object.entries(AGENT_NAMES).find(([id]) => id === agent)?.[1];
  return known ?? agent.charAt(0).toUpperCase() + agent.slice(1);
}

/** Run every reader, merge what they found, and work out what the card can offer. */
export async function scanSessions(options: ScanOptions): Promise<ScanOutcome> {
  const { context } = options;
  const results = await Promise.all(options.readers.map(({ source, read }) => runReader(source, read, context)));
  const listedSince = Math.max(context.sinceMs, context.now - LISTED_DAYS * DAY_MS);
  const merged = mergeSessions(results.flatMap(result => result.status === 'ok' ? result.sessions : []))
    .filter(found => found.lastActiveMs >= listedSince)
    .filter(found => !found.folder || !isUnder(found.folder, options.excludedRoots));

  // Live sessions too old to list still occupy their checkout; one Pane already runs doesn't.
  const busy = results.flatMap(result => result.status === 'ok' ? (result.busy ?? []).map(entry => ({ ...entry, source: result.source })) : [])
    .filter(entry => !entry.sessionId || !options.alreadyInPane.has(sessionKey(entry.agent, entry.sessionId)));
  const checkouts = await probeFolders([...merged.map(found => found.folder), ...busy.map(entry => entry.folder)]);
  const sessions = merged
    .map(found => toImportSession(found, found.folder ? checkouts.get(found.folder) : undefined, options.alreadyInPane))
    .filter(session => !session.checkout || !isUnder(session.checkout, options.excludedRoots));
  const occupied = new Map<string, SessionImportSource>();
  for (const entry of busy) {
    const checkout = checkouts.get(entry.folder)?.checkout;
    if (checkout) occupied.set(checkout, entry.source);
  }
  markOccupiedCheckouts(sessions, occupied);
  preselect(sessions, context.now);
  sessions.sort((left, right) => right.lastActiveMs - left.lastActiveMs);

  return {
    scan: {
      scannedAt: context.now,
      sources: results.filter(result => result.status !== 'absent').map(toSourceSummary),
      sessions: sessions.map(({ transcript: _transcript, ...session }) => session),
    },
    sessions: new Map(sessions.map(session => [session.key, session])),
  };
}

async function runReader(source: SessionImportSource, reader: SourceReader, context: ReaderContext): Promise<SourceReadResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader(context),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('took too long to read')), READER_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    // A reader that throws or stalls disables only its own source.
    return { source, status: 'unreadable', reason: error instanceof Error ? error.message : String(error), storePaths: [], sessions: [] };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toSourceSummary(result: SourceReadResult): ImportSourceSummary {
  return {
    source: result.source,
    status: result.status === 'ok' ? 'ok' : 'unreadable',
    version: result.version,
    reason: result.reason,
    storePaths: result.storePaths,
  };
}

const RUNNING_RANK = { no: 0, unknown: 1, yes: 2 } as const satisfies Record<ImportRunning, number>;

/**
 * One entry per agent session id. A wrapper tool's entry wins over the raw
 * Claude Code or Codex one because it knows the workspace; the running signal
 * is the most cautious of the two.
 */
function mergeSessions(found: FoundSession[]): FoundSession[] {
  const byKey = new Map<string, FoundSession>();
  for (const session of found) {
    const key = sessionKey(session.agent, session.sessionId);
    const previous = byKey.get(key);
    if (!previous) {
      byKey.set(key, session);
      continue;
    }
    const preferred = preferEntry(previous, session);
    const other = preferred === previous ? session : previous;
    byKey.set(key, {
      ...preferred,
      folder: preferred.folder ?? other.folder,
      branch: preferred.branch ?? other.branch,
      title: preferred.title ?? other.title,
      transcript: preferred.transcript ?? other.transcript,
      lastActiveMs: Math.max(preferred.lastActiveMs, other.lastActiveMs),
      running: RUNNING_RANK[other.running] > RUNNING_RANK[preferred.running] ? other.running : preferred.running,
    });
  }
  return [...byKey.values()];
}

function isWrapper(source: SessionImportSource): boolean {
  return source !== 'claude' && source !== 'codex';
}

function preferEntry(left: FoundSession, right: FoundSession): FoundSession {
  if (isWrapper(left.source) !== isWrapper(right.source)) return isWrapper(left.source) ? left : right;
  return right.lastActiveMs > left.lastActiveMs ? right : left;
}

function toImportSession(found: FoundSession, checkout: GitCheckout | undefined, alreadyInPane: ReadonlySet<string>): ScannedSession {
  const key = sessionKey(found.agent, found.sessionId);
  const session: ScannedSession = {
    key,
    source: found.source,
    agent: found.agent,
    sessionId: found.sessionId,
    title: found.title,
    branch: found.branch ?? checkout?.branch,
    folder: found.folder,
    checkout: checkout?.checkout,
    repoRoot: checkout?.repoRoot,
    repoName: checkout ? path.basename(checkout.repoRoot) : undefined,
    lastActiveMs: found.lastActiveMs,
    running: found.running,
    alreadyInPane: alreadyInPane.has(key),
    preselected: false,
    transcript: found.transcript,
  };
  if (!session.alreadyInPane && found.running === 'no') session.unavailable = unavailableReason(found, checkout);
  return session;
}

function unavailableReason(found: FoundSession, checkout: GitCheckout | undefined): string | undefined {
  if (!isResumableImportAgent(found.agent)) return `Pane can't resume ${agentName(found.agent)} yet`;
  if (!isValidSessionId(found.agent, found.sessionId)) return `its session id isn't one ${agentName(found.agent)} would write`;
  if (!found.folder || !fs.existsSync(found.folder)) return 'folder no longer exists';
  if (!checkout) return "folder isn't in a git repository";
  if (found.agent === 'claude' && !samePath(found.folder, checkout.checkout)) {
    return "started in a subfolder; say 'migrate to Pane' in Pane Chat";
  }
  return found.unavailable;
}

/**
 * A checkout with a session still running (or maybe running) outside Pane is
 * busy: bringing in another of its sessions would put two agents in one folder.
 */
function markOccupiedCheckouts(sessions: ScannedSession[], occupied: Map<string, SessionImportSource>): void {
  for (const session of sessions) {
    if (session.checkout && session.running !== 'no' && !session.alreadyInPane) occupied.set(session.checkout, session.source);
  }
  for (const session of sessions) {
    const busyIn = session.checkout ? occupied.get(session.checkout) : undefined;
    if (busyIn && session.running === 'no' && !session.alreadyInPane && !session.unavailable) {
      session.unavailable = `another session is running in this checkout in ${SOURCE_NAMES[busyIn]}`;
    }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Session ids come from other tools' files and end up on a terminal command
 * line, so only the shape each agent itself writes is accepted.
 */
function isValidSessionId(agent: string, sessionId: string): boolean {
  return agent === 'opencode' ? isValidOpenCodeSessionId(sessionId) : UUID.test(sessionId);
}

/** Whether the card lets the person tick this session. */
export function isSelectable(session: ImportSession): boolean {
  return !session.alreadyInPane && session.running === 'no' && !session.unavailable;
}

/** Last 7 days, at most the 3 most recent per checkout. */
function preselect(sessions: ScannedSession[], now: number): void {
  const recent = sessions
    .filter(session => isSelectable(session) && session.lastActiveMs >= now - PRESELECTED_DAYS * DAY_MS)
    .sort((left, right) => right.lastActiveMs - left.lastActiveMs);
  const perCheckout = new Map<string, number>();
  for (const session of recent) {
    const checkout = session.checkout ?? '';
    const count = perCheckout.get(checkout) ?? 0;
    if (count >= PRESELECTED_PER_CHECKOUT) continue;
    perCheckout.set(checkout, count + 1);
    session.preselected = true;
  }
}

async function probeFolders(folders: Array<string | undefined>): Promise<Map<string, GitCheckout | undefined>> {
  const unique = [...new Set(folders.filter((folder): folder is string => Boolean(folder)))]
    .filter(folder => fs.existsSync(folder));
  const results = new Map<string, GitCheckout | undefined>();
  let next = 0;
  const worker = async () => {
    while (next < unique.length) {
      const folder = unique[next++];
      results.set(folder, await probeGitCheckout(folder).catch(() => undefined));
    }
  };
  await Promise.all(Array.from({ length: Math.min(GIT_CONCURRENCY, unique.length) }, worker));
  return results;
}

function runGit(folder: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', folder, ...args], { timeout: GIT_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/** The checkout, main repository and branch of a folder, from git itself. */
async function probeGitCheckout(folder: string): Promise<GitCheckout | undefined> {
  const output = await runGit(folder, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']);
  const [checkout, commonDir] = output.trim().split(/\r?\n/u);
  if (!checkout || !commonDir) return undefined;
  const repoRoot = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
  const branch = (await runGit(folder, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')).trim() || undefined;
  return { checkout: path.normalize(checkout), repoRoot: path.normalize(repoRoot), branch };
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value).replace(/[\\/]+$/u, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(left: string, right: string): boolean {
  return normalizePath(realpathOr(left)) === normalizePath(realpathOr(right));
}

function realpathOr(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return target;
  }
}

/** Whether `target` is one of `roots` or inside one. */
function isUnder(target: string, roots: readonly string[]): boolean {
  const normalized = normalizePath(realpathOr(target));
  return roots.some(root => {
    const normalizedRoot = normalizePath(realpathOr(root));
    return normalized === normalizedRoot || normalized.startsWith(normalizedRoot + path.sep);
  });
}
