/**
 * Runpane Cloud daemon surface: the safe-to-stop check, `/health` readiness and the
 * upgrade-on-wake hook. The coordinator (`runpane cloud`) calls these over `/invoke`
 * and `/health`; agents inside the sandbox reach safe-to-stop through the local socket.
 */

/** Why a daemon refuses to be stopped. Peers never count toward any of these. */
export type CloudSafeToStopCondition =
  | 'agent-working'
  | 'command-running'
  | 'recent-terminal-output'
  | 'lock-held'
  | 'watcher-active'
  | 'pr-checks-pending'
  | 'user-client-attached'
  /** A stop lease was asked for while other calls to this daemon were still running. */
  | 'call-in-flight'
  /** The flush ran but could not be verified durable (`flush.failures` says why). */
  | 'flush-failed';

export interface CloudSafeToStopBlocker {
  condition: CloudSafeToStopCondition;
  message: string;
  paneId?: string;
  panelId?: string;
}

/**
 * When to make the daemon's state durable before answering. `if-safe` (default) flushes
 * only when nothing blocks; `always` suits a stop the user asked for; `never` only checks.
 */
export type CloudSafeToStopFlushMode = 'if-safe' | 'always' | 'never';

export interface CloudSafeToStopRequest {
  flush?: CloudSafeToStopFlushMode;
  /** A terminal that printed within this window blocks the stop. */
  recentOutputMs?: number;
  /** A user client that invoked within this window blocks the stop. */
  clientWindowMs?: number;
  /**
   * The coordinator's stop lease: when the answer is safe, the daemon refuses every other call
   * (`ERR_SESSION_STOPPING`) for this long, so nothing new starts between "safe" and the provider's stop.
   * 0 (default): no lease.
   */
  stopLeaseMs?: number;
}

/** A stop lease the daemon granted with a safe answer; released by `runpane:cloud:stop-lease:release` or expiry. */
export interface CloudStopLease {
  expiresAt: string;
  ms: number;
}

export interface CloudWalCheckpoint {
  busy: number;
  log: number;
  checkpointed: number;
}

export interface CloudDurableFlushResult {
  walCheckpoint: CloudWalCheckpoint | null;
  /** Files and directories fsync'd, in order. */
  fsynced: string[];
  /** Whether the whole filesystem holding the Pane directory was synced. */
  syncedFilesystem: boolean;
  /**
   * True only when every required step succeeded: WAL checkpoint, database/WAL and Pane directory
   * fsyncs, the tailnet-state backup where installed, and the filesystem sync. Stop only on true.
   */
  durable: boolean;
  /** What kept the flush from being durable; empty when `durable`. */
  failures: string[];
  durationMs: number;
}

export interface CloudSafeToStopResult {
  ok: true;
  safe: boolean;
  checkedAt: string;
  version: string;
  blockers: CloudSafeToStopBlocker[];
  /** Null when no flush ran (blocked under `if-safe`, or `never`). */
  flush: CloudDurableFlushResult | null;
  /** Granted only with a safe answer to a request with `stopLeaseMs`; null otherwise. */
  stopLease: CloudStopLease | null;
}

export type CloudReadinessState = 'starting' | 'ready' | 'degraded';
export type CloudAgentRestorePhase = 'none' | 'pending' | 'done';

export interface CloudAgentReadinessCounts {
  /** Agent panels of non-archived Panes. */
  expected: number;
  /** Running, with a detected idle or working agent. */
  ready: number;
  /** Running, agent not detected yet. */
  starting: number;
  /** Running, waiting on a human (a trust or permission prompt). */
  blocked: number;
  /** No terminal behind the panel. */
  notRunning: number;
}

export interface CloudDaemonReadiness {
  state: CloudReadinessState;
  daemon: 'starting' | 'ready';
  agentRestore: CloudAgentRestorePhase;
  agents: CloudAgentReadinessCounts;
}

export interface CloudUpgradeRequest {
  version: string;
  url: string;
  sha256: string;
}

export type CloudUpgradeResult =
  | { ok: true; upgraded: false; from: string; to: string }
  | { ok: true; upgraded: 'scheduled'; from: string; to: string; packagePath: string };
