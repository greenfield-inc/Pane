// Ports and shared types for the always-on part of `runpane cloud` (the coordinator).
// The coordinator never destroys anything: the provider port has no delete by construction.

export type ProviderSandboxState =
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed'
  | 'missing';

export interface ProviderSandbox {
  id: string;
  name: string;
  state: ProviderSandboxState;
  /** The provider's own state string, kept for alerts and debugging. */
  rawState: string;
  createdAt: string | null;
  updatedAt: string | null;
  /** The boat wallet it bills (org id, or `personal`); null when the provider did not say. */
  org?: string | null;
}

export interface CoordinatorProvider {
  readonly kind: string;
  list(): Promise<ProviderSandbox[]>;
  /** Returns state 'missing' when the provider no longer knows the sandbox. */
  get(sandboxId: string, org?: string | null): Promise<ProviderSandbox>;
  /** `org`: the wallet the sandbox bills; omitted, the provider's configured wallet. */
  stop(sandboxId: string, org?: string | null): Promise<void>;
  resume(sandboxId: string, org?: string | null): Promise<void>;
}

export interface DirectoryEntry {
  sessionId: string;
  label: string;
  provider: string;
  sandboxId: string;
  /** Tailnet base URL of the Session's Pane daemon, e.g. https://rp-abc.tailnet.ts.net */
  baseUrl: string;
  nodeId: string | null;
  pinnedVersion: string | null;
  /** Bearer token of the coordinator's own paired-client record on that daemon. */
  coordinatorToken: string | null;
  /** The boat wallet the Session's sandbox bills (org id or `personal`); null: the coordinator's own. */
  org: string | null;
  /** owner/name repos this Session may use through the GitHub broker (`github.repos`); empty: none. */
  githubRepos: string[];
  /**
   * Where the coordinator reads this Session's secrets manifest (`.runpane/secrets.json`): its repository
   * and the ref it was created from (null: the default branch). Null: no manifest source.
   */
  secretsManifest: { repo: string; ref: string | null } | null;
}

export type DirectoryReadResult =
  | { ok: true; generatedAt: string | null; entries: DirectoryEntry[] }
  | { ok: false; error: string };

export interface SessionDirectory {
  read(): Promise<DirectoryReadResult>;
}

export type DaemonHealth =
  | { reachable: false; error: string }
  | { reachable: true; ready: boolean; version: string | null; detail: string | null };

export type SafeToStopAnswer =
  /**
   * `checkpointed`: the daemon verified its flush durable; the coordinator never stops without it.
   * `lease`: the stop lease the daemon took for this answer (it refuses every other call meanwhile);
   * null when none was asked for, or from a daemon without stop leases.
   */
  | { kind: 'safe'; checkpointed: boolean; lease: { ms: number } | null }
  | { kind: 'unsafe'; reasons: string[] }
  | { kind: 'unsupported'; error: string }
  | { kind: 'error'; error: string };

export interface UpgradeTarget {
  version: string;
  url: string;
  sha256: string;
}

export type UpgradeAnswer =
  | { kind: 'started' }
  | { kind: 'unsupported'; error: string }
  | { kind: 'error'; error: string };

export interface DaemonProbe {
  /** GET /health; the daemon reports version and readiness only to a paired client, so pass the token when there is one. */
  health(baseUrl: string, token: string | null): Promise<DaemonHealth>;
  /** `stopLeaseMs`: ask the daemon to fence itself for that long if it answers safe. */
  safeToStop(baseUrl: string, token: string, options?: { stopLeaseMs?: number }): Promise<SafeToStopAnswer>;
  /** Lifts a stop lease the coordinator no longer needs (it did not stop). Never throws. */
  releaseStopLease(baseUrl: string, token: string): Promise<void>;
  upgrade(baseUrl: string, token: string, target: UpgradeTarget): Promise<UpgradeAnswer>;
}

type AlertLevel = 'info' | 'warn' | 'error';

export interface CoordinatorAlert {
  at: string;
  level: AlertLevel;
  code: string;
  message: string;
  sandboxId?: string;
  sessionId?: string;
}

export interface AlertSink {
  emit(alert: Omit<CoordinatorAlert, 'at'>): void;
  recent(limit: number): CoordinatorAlert[];
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Sandboxes the coordinator counts as live (billing) for the runaway guard. */
export function isLiveState(state: ProviderSandboxState): boolean {
  return state === 'starting' || state === 'running' || state === 'stopping';
}
