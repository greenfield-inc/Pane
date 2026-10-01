import type { AgentState } from '../../../../shared/types/agentStatus';
import type {
  CloudDurableFlushResult,
  CloudSafeToStopBlocker,
  CloudSafeToStopFlushMode,
  CloudSafeToStopRequest,
  CloudSafeToStopResult,
  CloudStopLease,
} from '../../../../shared/types/cloudDaemon';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';
import type { PaneCommandValue } from '../commandRegistry';
import { MAX_STOP_LEASE_MS } from './stopLease';

/** A terminal that printed within this window is not idle. */
export const DEFAULT_RECENT_OUTPUT_MS = 2 * 60_000;
/** A user client that invoked within this window is still using the Session. */
export const DEFAULT_CLIENT_WINDOW_MS = 15 * 60_000;
/** A watch loop re-issues its wait right after one returns; the gap between calls is still watching. */
export const WATCHER_GAP_GRACE_MS = 30_000;

export interface SafeToStopTerminal {
  panelId: string;
  paneId?: string;
  /** Detected agent state; undefined for plain shells. */
  agentState?: AgentState;
  lastOutputAt?: number;
}

/** A command still running without printing: an agent's (background) shell, or a program in a shell panel. */
export interface SafeToStopRunningCommand {
  panelId: string;
  paneId?: string;
  kind: 'agent-shell' | 'foreground';
  command: string;
}

interface SafeToStopLock {
  name: string;
  ownerLabel?: string;
  paneId?: string;
  panelId?: string;
}

interface SafeToStopWatcher {
  channel: string;
  inFlight: number;
  lastFinishedAt?: number;
}

interface SafeToStopPendingPr {
  paneId: string;
  prNumber: number;
}

export interface SafeToStopUserClient {
  kind: 'events-stream' | 'recent-invoke';
  clientId: string | null;
  label: string | null;
  at: number;
}

/** Live daemon state the check reads. Every source excludes peers already. */
export interface SafeToStopSources {
  terminals(): SafeToStopTerminal[];
  runningCommands(): SafeToStopRunningCommand[];
  locks(): SafeToStopLock[];
  watchers(): SafeToStopWatcher[];
  pendingPrChecks(): Promise<SafeToStopPendingPr[]>;
  userClients(since: number): SafeToStopUserClient[];
}

/** The daemon's stop fence (stopLease.ts) and the calls it can't fence because they already started. */
interface SafeToStopLeasing {
  grant(ms: number): { expiresAt: number; ms: number };
  release(): void;
  /** Calls now running, other than safe-to-stop itself and the waits counted as watchers. */
  inFlightCalls(): number;
}

export interface SafeToStopDependencies {
  sources: SafeToStopSources;
  flush(): Promise<CloudDurableFlushResult>;
  version: string;
  /** Absent: a request's `stopLeaseMs` is ignored and the answer carries no lease. */
  lease?: SafeToStopLeasing;
  now?: () => number;
}

const safeToStopRequestSchema = boundary.object({
  flush: boundary.optional(boundary.enumeration('if-safe', 'always', 'never')),
  recentOutputMs: boundary.optional(boundary.number),
  clientWindowMs: boundary.optional(boundary.number),
  stopLeaseMs: boundary.optional(boundary.number),
});

export function parseSafeToStopRequest(value: PaneCommandValue): Required<CloudSafeToStopRequest> {
  const decoded = decodeBoundary(value ?? {}, safeToStopRequestSchema);
  return {
    flush: decoded.flush ?? 'if-safe',
    recentOutputMs: nonNegative(decoded.recentOutputMs, DEFAULT_RECENT_OUTPUT_MS, 'recentOutputMs'),
    clientWindowMs: nonNegative(decoded.clientWindowMs, DEFAULT_CLIENT_WINDOW_MS, 'clientWindowMs'),
    stopLeaseMs: Math.min(nonNegative(decoded.stopLeaseMs, 0, 'stopLeaseMs'), MAX_STOP_LEASE_MS),
  };
}

/** Every reason the daemon should not be stopped right now; empty means safe. */
async function collectSafeToStopBlockers(
  sources: SafeToStopSources,
  request: Required<CloudSafeToStopRequest>,
  now: number,
): Promise<CloudSafeToStopBlocker[]> {
  const blockers: CloudSafeToStopBlocker[] = [];

  for (const terminal of sources.terminals()) {
    const where = { paneId: terminal.paneId, panelId: terminal.panelId };
    if (terminal.agentState === 'working') {
      blockers.push({ condition: 'agent-working', message: `Agent in panel ${terminal.panelId} is working`, ...where });
    }
    if (terminal.lastOutputAt !== undefined && now - terminal.lastOutputAt < request.recentOutputMs) {
      const seconds = Math.round((now - terminal.lastOutputAt) / 1000);
      blockers.push({
        condition: 'recent-terminal-output',
        message: `Panel ${terminal.panelId} printed output ${seconds}s ago`,
        ...where,
      });
    }
  }

  for (const command of sources.runningCommands()) {
    blockers.push({
      condition: 'command-running',
      message: command.kind === 'agent-shell'
        ? `Agent in panel ${command.panelId} still runs a shell (${command.command})`
        : `Panel ${command.panelId} is running ${command.command}`,
      paneId: command.paneId,
      panelId: command.panelId,
    });
  }

  for (const lock of sources.locks()) {
    blockers.push({
      condition: 'lock-held',
      message: `Lock "${lock.name}" is held${lock.ownerLabel ? ` by ${lock.ownerLabel}` : ''}`,
      paneId: lock.paneId,
      panelId: lock.panelId,
    });
  }

  for (const watcher of sources.watchers()) {
    if (watcher.inFlight > 0) {
      blockers.push({ condition: 'watcher-active', message: `${watcher.inFlight} ${watcher.channel} call(s) waiting` });
    } else if (watcher.lastFinishedAt !== undefined && now - watcher.lastFinishedAt < WATCHER_GAP_GRACE_MS) {
      blockers.push({ condition: 'watcher-active', message: `A ${watcher.channel} call returned moments ago (watch loop)` });
    }
  }

  for (const pr of await sources.pendingPrChecks()) {
    blockers.push({ condition: 'pr-checks-pending', message: `PR #${pr.prNumber} has checks still running`, paneId: pr.paneId });
  }

  for (const client of sources.userClients(now - request.clientWindowMs)) {
    const who = client.label ?? client.clientId ?? 'an unpaired client';
    blockers.push({
      condition: 'user-client-attached',
      message: client.kind === 'events-stream'
        ? `${who} has an open event stream`
        : `${who} used the daemon ${Math.round((now - client.at) / 1000)}s ago`,
    });
  }

  return blockers.map(stripUndefined);
}

/**
 * Checks every stop condition and, per the flush mode, makes the daemon's state durable
 * before answering (a flush that is not verified durable makes the answer unsafe): boat's stop
 * is a power-off after a disk snapshot, so anything still in the page cache or the SQLite WAL
 * at that point is lost.
 */
export async function runSafeToStop(
  dependencies: SafeToStopDependencies,
  rawRequest: PaneCommandValue,
): Promise<CloudSafeToStopResult> {
  const now = dependencies.now ?? Date.now;
  const request = parseSafeToStopRequest(rawRequest);
  // The fence goes up before the check, so nothing can start while the check and the flush run; a call
  // that started before it is still running and blocks like any other condition.
  const lease = request.stopLeaseMs > 0 ? dependencies.lease : undefined;
  const granted = lease?.grant(request.stopLeaseMs);
  const blockers = await collectSafeToStopBlockers(dependencies.sources, request, now());
  const inFlight = lease?.inFlightCalls() ?? 0;
  if (inFlight > 0) {
    blockers.push({ condition: 'call-in-flight', message: `${inFlight} call(s) to this daemon are still running` });
  }
  const flush = shouldFlush(request.flush, blockers.length === 0) ? await dependencies.flush() : null;
  // A stop right after an unverified flush can lose the last writes, so it blocks like any other condition.
  if (flush && !flush.durable) {
    blockers.push({ condition: 'flush-failed', message: `State is not durable: ${flush.failures.join('; ')}` });
  }
  const safe = blockers.length === 0;
  if (!safe) lease?.release();
  const stopLease: CloudStopLease | null = safe && granted
    ? { expiresAt: new Date(granted.expiresAt).toISOString(), ms: granted.ms }
    : null;
  return {
    ok: true,
    safe,
    checkedAt: new Date(now()).toISOString(),
    version: dependencies.version,
    blockers,
    flush,
    stopLease,
  };
}

function shouldFlush(mode: CloudSafeToStopFlushMode, safe: boolean): boolean {
  return mode === 'always' || (mode === 'if-safe' && safe);
}

function nonNegative(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
}

function stripUndefined(blocker: CloudSafeToStopBlocker): CloudSafeToStopBlocker {
  const result: CloudSafeToStopBlocker = { condition: blocker.condition, message: blocker.message };
  if (blocker.paneId !== undefined) result.paneId = blocker.paneId;
  if (blocker.panelId !== undefined) result.panelId = blocker.panelId;
  return result;
}
