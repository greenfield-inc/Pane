import type { ProjectEnvironment, TerminalAgentReport, TerminalAgentReportState, ToolPanelType } from './panels';
import type { RunpaneAgent } from './generatedRunpaneContract';
import type { RemoteDaemonExecutableHealth } from './remoteDaemon';
import type { TerminalGraphicsProtocol } from '../constants/terminalGraphics';
import type { AgentState } from './agentStatus';
import type { UsageByPane, UsagePaneCostSlice, UsageTotals } from './usage';
import type {
  OrchestrationSessionOverview,
  OrchestrationSessionRecord,
} from './orchestrationSession';

export type RunpaneAgentId = RunpaneAgent;

export interface RunpaneSessionSelector {
  sessionId?: string;
  name?: string;
}

export interface RunpaneSessionListResult {
  ok: true;
  sessions: OrchestrationSessionRecord[];
  selectedSessionId?: string;
}

export interface RunpaneSessionResult {
  ok: true;
  session: OrchestrationSessionRecord;
  panelId?: string;
  internalSessionId?: string;
}

export interface RunpaneSessionOverviewResult extends OrchestrationSessionOverview {
  ok: true;
  /** Named locks scoped to this Session or held by one of its Panes. */
  locks: RunpaneLockRecord[];
}

/**
 * Who holds a named lock. A Pane owner is the calling Pane and, usually, its
 * panel; an external owner is a caller outside any Pane, identified by the
 * `--note` text it acquired with.
 */
export interface RunpaneLockOwner {
  kind: 'pane' | 'external';
  paneId?: string;
  panelId?: string;
  label?: string;
}

export interface RunpaneLockRecord {
  name: string;
  /** `session` when the owner Pane belonged to a Session at acquire time; otherwise `global`. */
  scope: 'session' | 'global';
  sessionId?: string;
  owner: RunpaneLockOwner;
  note?: string;
  acquiredAt: string;
  expiresAt: string;
  ttlMs: number;
}

export interface RunpaneLockOwnerInput {
  paneId?: string;
  panelId?: string;
  label?: string;
}

export interface RunpaneLockAcquireRequest {
  name: string;
  ttlMs: number;
  /** Block in the daemon for up to this long (clamped per call) while another owner holds the lock. */
  waitMs?: number;
  note?: string;
  owner: RunpaneLockOwnerInput;
}

export type RunpaneLockAcquireResult =
  | {
      ok: true;
      acquired: true;
      renewed: boolean;
      waitedMs: number;
      lock: RunpaneLockRecord;
    }
  | {
      ok: false;
      acquired: false;
      /** True when the call waited its whole wait window without the lock coming free. */
      timedOut: boolean;
      waitedMs: number;
      heldBy: RunpaneLockOwner;
      expiresAt: string;
      lock: RunpaneLockRecord;
    };

export interface RunpaneLockReleaseRequest {
  name: string;
  force?: boolean;
  /** Session selector (id or exact name) to release a Session-scoped lock from outside that Session. */
  sessionId?: string;
  owner: RunpaneLockOwnerInput;
}

export type RunpaneLockReleaseResult =
  | {
      ok: true;
      released: boolean;
      forced: boolean;
      lock?: RunpaneLockRecord;
    }
  | {
      ok: false;
      released: false;
      reason: 'not-owner';
      heldBy: RunpaneLockOwner;
      expiresAt: string;
      lock: RunpaneLockRecord;
    };

export interface RunpaneLockListRequest {
  /** Session selector (id or exact name); limits the list to that Session's locks. */
  sessionId?: string;
}

export interface RunpaneLockListResult {
  ok: true;
  locks: RunpaneLockRecord[];
}

export type RunpaneWorkspaceEntryKind =
  | 'agent.ready'
  | 'agent.busy'
  | 'agent.blocked'
  | 'agent.unknown'
  | 'agent.idle'
  | 'pane.created'
  | 'pane.gone'
  | 'panel.exited'
  /** A worker report, delivered only when explicitly requested in kinds. */
  | 'agent.report'
  /** The Pane joined a Session (`sessions associate`). */
  | 'pane.associated'
  /** The Pane left a Session (`sessions detach`). */
  | 'pane.detached'
  /** A Session member's open PR became conflicting with its base. */
  | 'pr.conflicted'
  /** A Session member's PR checks settled (`checks: passed | failed`) for its head commit. */
  | 'pr.checks'
  /** A Session member's PR was merged. */
  | 'pr.merged';

/** The PR a `pr.*` entry reports on. */
export interface RunpaneWorkspacePullRequest {
  number: number;
  url: string;
  headOid: string;
}

export interface RunpaneWorkspaceEntry {
  gen: number;
  at: string;
  kind: RunpaneWorkspaceEntryKind;
  paneId: string;
  paneName: string;
  repoId?: number;
  repoName?: string;
  worktreePath?: string;
  panelId?: string;
  panelTitle?: string;
  agentType?: string;
  from?: AgentState;
  to?: AgentState;
  source: 'agent' | 'exit' | 'session' | 'github';
  reason?: string | null;
  settledMs?: number;
  idleMs?: number;
  idleCount?: number;
  heldInput?: string;
  heldInputPresent?: boolean;
  exitCode?: number;
  baseline?: true;
  /**
   * Set on the baseline entries a wait delivers after a reset. A replayed entry restates current
   * state; it is never a new transition, so a replayed `agent.ready` is not READY.
   */
  replay?: true;
  changedWhileAway?: boolean;
  /** Named Session of a `pane.associated` or `pane.detached` entry. */
  sessionId?: string;
  sessionName?: string;
  /** PR of a `pr.conflicted`, `pr.checks`, or `pr.merged` entry. */
  pr?: RunpaneWorkspacePullRequest;
  /** Settled result of a `pr.checks` entry. */
  checks?: 'passed' | 'failed';
  /** Up to five failing check names of a failed `pr.checks` entry. */
  failingChecks?: string[];
  panels?: RunpaneWorkspacePanelSummary[];
  /** The report of an `agent.report` entry; its summary is cut to 2,000 characters (the panel keeps up to 16,000). */
  report?: TerminalAgentReport;
}

export interface RunpaneWorkspacePanelSummary {
  panelId: string;
  title: string;
  agentType?: string;
  agentState?: AgentState;
}

export interface RunpaneWorkspaceWaitRequest {
  since?: number;
  as?: string;
  from?: 'now' | 'earliest';
  timeoutMs?: number;
  limit?: number;
  kinds?: RunpaneWorkspaceEntryKind[];
  paneIds?: string[];
  /**
   * Named Session id or exact name. Limits the wait to the Session's associated Panes, resolved
   * on every read, and implies `pane.associated`/`pane.detached` entries. Cannot be combined with
   * `paneIds`.
   */
  session?: string;
  excludePaneIds?: string[];
  repo?: RunpaneRepoSelector;
  nameContains?: string;
  agentsOnly?: boolean;
  ackNow?: boolean;
  includeHeldInput?: boolean;
  includeHeldInputPresence?: boolean;
  idleAfterMs?: number;
  idleWindowStartMs?: number;
  /** Opt-in cadence shaping; each requires a named consumer (`as`). */
  settleMs?: number;
  blockedSettleMs?: number;
  minIntervalMs?: number;
  idleBackoff?: boolean;
}

export type RunpaneWorkspaceResetReason =
  | 'first-use'
  | 'epoch-changed'
  | 'cursor-truncated'
  | 'unknown-consumer';

export interface RunpaneWorkspaceWaitResult {
  ok: true;
  epoch: string;
  generation: number;
  entries: RunpaneWorkspaceEntry[];
  timedOut: boolean;
  dropped?: number;
  reset?: { reason: RunpaneWorkspaceResetReason };
  /** The Session a `session` request resolved to; its absence tells a client the daemon ignored `session`. */
  session?: { id: string; name: string };
  nextCommand: string;
}

export interface RunpaneWorkspaceStateResult {
  ok: true;
  epoch: string;
  generation: number;
  entries: RunpaneWorkspaceEntry[];
}

export type RunpaneRepoSelector =
  | string
  | { id: number }
  | { path: string }
  | { name: string }
  | { active: true };

export interface RunpaneRepoSummary {
  id: number;
  name: string;
  path: string;
  active: boolean;
  environment?: ProjectEnvironment;
  sessionCount: number;
}

export interface RunpaneRepoListResult {
  ok: true;
  repos: RunpaneRepoSummary[];
}

export interface RunpaneDoctorResult {
  ok: true;
  app: {
    version: string;
    isPackaged: boolean;
    platform: string;
    electronVersion?: string;
    nodeVersion?: string;
  };
  daemon: {
    channels: string[];
    executableHealth: RemoteDaemonExecutableHealth;
  };
  repos: {
    count: number;
    active?: RunpaneRepoSummary;
  };
  terminal: {
    /** Inline image protocols a Pane terminal decodes and draws. */
    graphicsProtocols: readonly TerminalGraphicsProtocol[];
    /** Whether the terminal answers CSI 14 t / 16 t / 18 t size queries. */
    sizeReports: boolean;
    imageLimits: {
      storageLimitMb: number;
      pixelLimit: number;
    };
  };
  agentContext: {
    recommendedFirstCommands: string[];
  };
}

export interface RunpaneRepoAddRequest {
  path: string;
  name?: string;
  dryRun?: boolean;
}

export interface RunpaneRepoAddPreview {
  name: string;
  path: string;
  alreadyExists: boolean;
  wouldCreate: boolean;
  environment?: ProjectEnvironment;
}

export interface RunpaneRepoAddResult {
  ok: true;
  created: boolean;
  dryRun?: boolean;
  repo?: RunpaneRepoSummary;
  preview?: RunpaneRepoAddPreview;
}

export interface RunpaneAgentToolSpec {
  agent: RunpaneAgentId;
  title?: string;
  initialInput?: string;
  /** Write initialInput to a prompt file and send `Read and follow <path>` instead (`--as-file-pointer`). */
  initialInputAsFilePointer?: boolean;
}

export interface RunpaneCommandToolSpec {
  command: string;
  /** The agent this command runs (a wrapper such as `agent-farm run`); set by `--agent` with `--tool-command`. */
  agentType?: RunpaneAgentId;
  title?: string;
  initialInput?: string;
  /** Write initialInput to a prompt file and send `Read and follow <path>` instead (`--as-file-pointer`). */
  initialInputAsFilePointer?: boolean;
}

export type RunpaneToolSpec = RunpaneAgentToolSpec | RunpaneCommandToolSpec;

export interface RunpanePaneCreateItem {
  name: string;
  worktreeName?: string;
  /** Exact new branch name for the Pane's worktree; defaults to the worktree name. */
  branch?: string;
  baseBranch?: string;
  sessionPrompt?: string;
  pinned?: boolean;
  tool: RunpaneToolSpec;
}

export interface RunpanePaneCreateRequest {
  repo: RunpaneRepoSelector;
  panes: RunpanePaneCreateItem[];
  dryRun?: boolean;
  timeoutMs?: number;
  waitReady?: boolean;
  readyTimeoutMs?: number;
  concurrency?: number;
  noFocus?: boolean;
  focus?: boolean;
  source?: RunpanePanelCreateSource;
  /** Session to associate each new Pane with (the calling orchestrator's PANE_ORCHESTRATION_SESSION_ID). */
  associateSession?: string;
}

export interface RunpanePaneAdoptItem {
  path: string;
  name: string;
  baseBranch?: string;
  folder?: string;
  pinned?: boolean;
  tool: RunpaneToolSpec;
  resume?: string;
  launch?: boolean;
}

export interface RunpanePaneAdoptRequest {
  repo: RunpaneRepoSelector;
  panes: RunpanePaneAdoptItem[];
  dryRun?: boolean;
  waitReady?: boolean;
  readyTimeoutMs?: number;
  noFocus?: boolean;
  focus?: boolean;
  source?: RunpanePanelCreateSource;
  associateSession?: string;
}

export type RunpanePaneAdoptResult = RunpanePaneCreateResult;

export interface RunpaneErrorPayload {
  message: string;
  code?: string;
}

export type RunpanePanelActivityStatus = 'active' | 'idle';
/** Rolled-up agent state for a Pane: the most urgent state of its live agent panels. */
export type RunpanePaneAgentState = 'ready' | 'working' | 'blocked' | 'none';
export type RunpaneAgentDetection = 'declared' | 'command' | 'process' | 'screen';
export type RunpanePanelScreenSource = 'alternateScreen' | 'scrollback' | 'persistedOutput' | 'empty';
export type RunpanePanelWaitCondition = 'initialized' | 'ready' | 'idle' | 'text';
export type RunpanePanelBlockerKind =
  | 'first-run-dialog'
  | 'codex-update'
  | 'agent-prompt'
  | 'submission_unverified'
  | 'composer-unknown'
  | 'unknown';

export interface RunpanePanelStateSummary {
  initialized: boolean;
  isAlternateScreen?: boolean;
  /** @deprecated Derived from the authoritative agent status for wire compatibility. */
  activityStatus?: RunpanePanelActivityStatus;
  isCliReady?: boolean;
  isCliPanel?: boolean;
  agentType?: RunpaneAgentId;
  lastActivity?: string;
}

export interface RunpanePanelBlockedState {
  kind: RunpanePanelBlockerKind;
  message: string;
  suggestedCommand?: string;
}

export interface RunpanePaneReadiness {
  ok: boolean;
  condition: RunpanePanelWaitCondition;
  matched: boolean;
  timedOut: boolean;
  elapsedMs: number;
  state: RunpanePanelStateSummary;
  blocked?: RunpanePanelBlockedState;
  nextCommand?: string;
}

export interface RunpaneInitialInputDeliveryResult {
  delivered: boolean;
  submitted: boolean;
  inputBytes: number;
  strategy?: 'codex-ctrl-enter' | 'enter' | 'tab' | 'argument';
  sequenceName?: 'codex-ctrl-enter-cr' | 'enter-cr' | 'tab' | 'argument';
  verifiedSubmitted?: boolean;
  verification?: RunpanePanelVerification;
  delivery?: RunpaneDelivery;
  staged?: boolean;
  attempts?: number;
  sentAt?: string;
  blocked?: RunpanePanelBlockedState;
  error?: RunpaneErrorPayload;
  nextCommand?: string;
}

/** A leading character Claude Code gives a meaning of its own; Pane sends the text unchanged. */
export type RunpanePromptWarningCode =
  | 'leading-bang-runs-shell'
  | 'leading-hash-memory'
  | 'leading-slash-command'
  | 'leading-at-mention';

export interface RunpanePromptWarning {
  code: RunpanePromptWarningCode;
  message: string;
}

export interface RunpanePaneCreateSuccessItem {
  ok: boolean;
  index: number;
  name: string;
  pinned: boolean;
  sessionId?: string;
  paneId?: string;
  panelId?: string;
  worktreePath?: string;
  nextCommand?: string;
  tool?: {
    title: string;
    command: string;
    agent?: RunpaneAgentId;
  };
  active?: boolean;
  focused?: boolean;
  readiness?: RunpanePaneReadiness;
  initialInput?: RunpaneInitialInputDeliveryResult;
  /** The prompt file Pane wrote for `--as-file-pointer`. */
  promptFile?: string;
  warnings?: RunpanePromptWarning[];
  association?: RunpanePaneAssociationOutcome;
}

/** Automatic Session association for a created or adopted Pane; failure never undoes the Pane. */
export interface RunpanePaneAssociationOutcome {
  sessionId: string;
  ok: boolean;
  error?: string;
}

export interface RunpanePaneCreateFailureItem {
  ok: false;
  index: number;
  name?: string;
  sessionId?: string;
  paneId?: string;
  worktreePath?: string;
  error: RunpaneErrorPayload;
}

export type RunpanePaneCreateResultItem =
  | RunpanePaneCreateSuccessItem
  | RunpanePaneCreateFailureItem;

export interface RunpanePaneCreateResult {
  ok: boolean;
  generation?: number;
  repo: RunpaneRepoSummary;
  items: RunpanePaneCreateResultItem[];
}

export interface RunpanePaneSummary {
  id: string;
  paneId: string;
  name: string;
  /** `running` while any terminal panel is live; otherwise the stored lifecycle status. */
  status: string;
  agentStatus: RunpanePanelActivityStatus;
  agentState: RunpanePaneAgentState;
  worktreePath: string;
  repoId: number;
  repoName?: string;
  panelCount: number;
  pinned: boolean;
  createdAt?: string;
  lastActivity?: string;
  archived?: boolean;
  ownership: 'pane' | 'external';
}

export interface RunpanePaneListRequest {
  repo?: RunpaneRepoSelector;
}

export interface RunpanePaneListResult {
  ok: true;
  repo?: RunpaneRepoSummary;
  panes: RunpanePaneSummary[];
}

export interface RunpanePaneCostRequest {
  repo?: RunpaneRepoSelector;
  paneId?: string;
}

export interface RunpanePaneCostResult {
  ok: true;
  fromMs: number;
  toMs: number;
  pricingAsOf: string;
  panes: UsageByPane[];
  unattributed?: UsagePaneCostSlice;
  totals?: UsageTotals;
}

export interface RunpanePanePinRequest {
  paneId: string;
  pinned: boolean;
  dryRun?: boolean;
}

export interface RunpanePanePinResult {
  ok: true;
  generation?: number;
  paneId: string;
  pinned: boolean;
  dryRun?: true;
  favoritePinnedAt?: string;
}

export interface RunpanePaneRenameRequest {
  paneId: string;
  name: string;
  dryRun?: boolean;
}

export interface RunpanePaneRenameResult {
  ok: true;
  generation?: number;
  dryRun?: true;
  pane: RunpanePaneSummary;
}

export interface RunpanePaneFocusRequest {
  paneId: string;
  panelId?: string;
  source?: RunpanePanelCreateSource;
}

export interface RunpanePaneFocusResult {
  ok: true;
  paneId: string;
  panelId?: string;
  focused: true;
}

export type RunpanePaneFocusRequestedEvent = Pick<
  RunpanePaneFocusRequest,
  'paneId' | 'panelId'
>;

export interface RunpanePaneArchiveRequest {
  paneId: string;
  force?: boolean;
  source?: RunpanePanelCreateSource;
  dryRun?: boolean;
  /** Also check and remove an adopted (externally owned) worktree. Pane-managed worktrees are always removed. */
  removeWorktree?: boolean;
}

/** Archives every Pane associated with a named Session whose work is safe to discard locally. */
export interface RunpanePaneArchiveBulkRequest {
  sessionId: string;
  /** The only bulk filter today: Panes that are clean and pushed, or merged via a pull request. */
  merged: true;
  source?: RunpanePanelCreateSource;
  dryRun?: boolean;
  removeWorktree?: boolean;
}

/**
 * Released runpane CLIs decode exactly these values, so never add one.
 * - `completed`: the worktree is gone from its path and from git.
 * - `failed`: removal failed; the worktree may still be on disk.
 * - `timeout`: removal (or the archive script before it) is still running in the background.
 * - `not-applicable`: nothing was removed (a main-repo Pane, or an adopted worktree without `removeWorktree`).
 */
export type RunpaneWorktreeCleanupState = 'completed' | 'failed' | 'timeout' | 'not-applicable';

/** After `completed`: whether the removed worktree's files are deleted, or still being deleted from the trash. */
export type RunpaneWorktreeTrashDeletion = 'pending' | 'done';

export type RunpanePaneArchiveBlockCode =
  | 'uncommitted-changes'
  | 'unpushed-commits'
  | 'uncommitted-and-unpushed'
  | 'status-unknown';

/**
 * Why the archive safety check was skipped or could not run. `external-worktree` (an adopted Pane
 * whose worktree Pane does not own), `main-repo`, and a Pane with no repository also mean archive
 * leaves the worktree on disk (`worktreeWillRemain`).
 */
export type RunpanePaneArchiveSafetyCheckReason =
  | 'external-worktree'
  | 'main-repo'
  | 'missing-project-context'
  | 'git-error';

export interface RunpanePaneArchiveSafetyCheck {
  performed: boolean;
  hasUncommittedChanges?: boolean;
  hasUntrackedFiles?: boolean;
  hasUpstream?: boolean;
  upstream?: string;
  upstreamRefreshed?: boolean;
  unpushedCommits?: number;
  unpushedCommitDetails?: RunpanePaneArchiveCommit[];
  reason?: RunpanePaneArchiveSafetyCheckReason;
  /** Set when archive will not remove the worktree because cleanup does not apply to this Pane. */
  worktreeWillRemain?: true;
  /** The branch had an upstream that no longer exists on the remote. */
  upstreamGone?: boolean;
  /** A merged pull request whose head is exactly this worktree's HEAD; its commits do not count as unpushed. */
  mergedViaPr?: RunpanePaneArchiveMergedPr;
}

export interface RunpanePaneArchiveMergedPr {
  number: number;
  headOid: string;
}

export interface RunpanePaneArchiveCommit {
  sha: string;
  subject: string;
}

export interface RunpanePaneArchiveBlockReason {
  code: RunpanePaneArchiveBlockCode;
  message: string;
  safetyCheck: RunpanePaneArchiveSafetyCheck;
}

export interface RunpanePaneArchiveBlockedResult {
  ok: false;
  generation?: number;
  paneId: string;
  blocked: RunpanePaneArchiveBlockReason;
  nextCommand: string;
}

export interface RunpanePaneArchiveSuccessResult {
  ok: boolean;
  generation?: number;
  paneId: string;
  archived: true;
  forced: boolean;
  worktreeCleanup: RunpaneWorktreeCleanupState;
  trashDeletion?: RunpaneWorktreeTrashDeletion;
  worktreePath?: string;
  safetyCheck: RunpanePaneArchiveSafetyCheck;
}

export interface RunpanePaneArchiveDryRunResult {
  ok: true;
  paneId: string;
  dryRun: true;
  wouldArchive: boolean;
  forced: boolean;
  safetyCheck: RunpanePaneArchiveSafetyCheck;
  blocked?: RunpanePaneArchiveBlockReason;
}

export type RunpanePaneArchiveResult =
  | RunpanePaneArchiveSuccessResult
  | RunpanePaneArchiveBlockedResult
  | RunpanePaneArchiveDryRunResult;

export type RunpanePaneArchiveBulkSkipCode =
  | RunpanePaneArchiveBlockCode
  | 'missing-pane'
  | 'already-archived'
  | 'main-repo';

export interface RunpanePaneArchiveBulkItem {
  paneId: string;
  name?: string;
  outcome: 'archived' | 'would-archive' | 'skipped' | 'failed';
  skipped?: { code: RunpanePaneArchiveBulkSkipCode; message: string };
  error?: string;
  safetyCheck?: RunpanePaneArchiveSafetyCheck;
  worktreeCleanup?: RunpaneWorktreeCleanupState;
  trashDeletion?: RunpaneWorktreeTrashDeletion;
  worktreePath?: string;
}

export interface RunpanePaneArchiveBulkResult {
  ok: boolean;
  sessionId: string;
  merged: true;
  dryRun?: true;
  removeWorktree: boolean;
  archived: number;
  skipped: number;
  failed: number;
  items: RunpanePaneArchiveBulkItem[];
}

export interface RunpanePanelSummary {
  id: string;
  panelId: string;
  paneId: string;
  type: ToolPanelType;
  title: string;
  active: boolean;
  initialized?: boolean;
  agentType?: RunpaneAgentId;
  agentDetection?: RunpaneAgentDetection;
  launchCommand?: string;
  isCliPanel?: boolean;
  position?: number;
  createdAt?: string;
  lastActiveAt?: string;
  /** Latest `runpane report` from this panel's agent. */
  report?: TerminalAgentReport;
}

export interface RunpanePanelListRequest {
  paneId: string;
}

export interface RunpanePanelListResult {
  ok: true;
  paneId: string;
  panels: RunpanePanelSummary[];
}

export type RunpanePanelCreateSource = 'user' | 'agent';

export interface RunpanePanelCreateRequest {
  paneId: string;
  type?: 'terminal';
  tool: RunpaneToolSpec;
  noFocus?: boolean;
  focus?: boolean;
  source?: RunpanePanelCreateSource;
  waitReady?: boolean;
  readyTimeoutMs?: number;
}

export interface RunpanePanelCreateResult {
  ok: boolean;
  generation?: number;
  paneId: string;
  panelId: string;
  title: string;
  active: boolean;
  focused: boolean;
  tool: {
    title: string;
    command: string;
    agent?: RunpaneAgentId;
  };
  readiness?: RunpanePaneReadiness;
  initialInput?: RunpaneInitialInputDeliveryResult;
  /** The prompt file Pane wrote for `--as-file-pointer`. */
  promptFile?: string;
  warnings?: RunpanePromptWarning[];
  nextCommand?: string;
}

export type RunpanePanelOpenPlacement = 'split' | 'tab';

/** Exactly one of url or filePath is set. */
export interface RunpanePanelOpenRequest {
  paneId: string;
  url?: string;
  filePath?: string;
  title?: string;
  placement?: RunpanePanelOpenPlacement;
  noFocus?: boolean;
  focus?: boolean;
  source?: RunpanePanelCreateSource;
}

export interface RunpanePanelOpenResult {
  ok: true;
  paneId: string;
  panelId: string;
  type: 'browser' | 'editor';
  title: string;
  url?: string;
  filePath?: string;
  placement: RunpanePanelOpenPlacement;
  active: boolean;
  reused: boolean;
}

export interface RunpanePanelOutputRecord {
  type: string;
  data: unknown;
  timestamp: string;
}

export interface RunpanePanelOutputRequest {
  panelId: string;
  limit?: number;
}

export interface RunpanePanelOutputResult {
  ok: true;
  panelId: string;
  paneId?: string;
  limit: number;
  returnedCount: number;
  hasMore: boolean;
  outputs: RunpanePanelOutputRecord[];
  text: string;
}

export interface RunpanePanelScreenRequest {
  panelId: string;
  limit?: number;
}

export interface RunpanePanelScreenResult {
  ok: true;
  panelId: string;
  paneId?: string;
  source: RunpanePanelScreenSource;
  limit: number;
  returnedLineCount: number;
  hasMore: boolean;
  text: string;
  state: RunpanePanelStateSummary;
  composer: {
    isPresent: boolean;
    hasUndeliveredText: boolean;
    /** Placeholder or suggestion text shown in the composer; it is not input. */
    ghostText?: string;
  };
  nextCommand?: string;
}

export interface RunpanePanelInputRequest {
  panelId: string;
  input: string;
  /** `user` when a person typed it; their next finished turn notifies the phone. */
  source?: 'user' | 'agent';
}

/** `runpane report`: a worker's structured hand-back for its panel. */
export interface RunpaneReportRequest {
  /** The panel's Pane; when given it must own `panelId`. */
  paneId?: string;
  panelId: string;
  state: TerminalAgentReportState;
  pr?: number;
  head?: string;
  summary?: string;
  summaryPath?: string;
  question?: string;
}

export interface RunpaneReportResult {
  ok: true;
  generation?: number;
  paneId: string;
  panelId: string;
  report: TerminalAgentReport;
  /** Named Sessions the Pane is associated with, which recorded the report as activity. */
  sessionIds: string[];
}

export interface RunpanePanelLastMessageRequest {
  panelId: string;
  /** Maximum characters to return; defaults to 20,000. */
  limit?: number;
}

export type RunpanePanelLastMessageResult =
  | {
    ok: true;
    panelId: string;
    paneId: string;
    agentType: 'claude' | 'codex';
    /** The agent's last reply, from its transcript; the tail is kept when it is longer than `limit`. */
    text: string;
    length: number;
    limit: number;
    truncated: boolean;
  }
  | {
    ok: false;
    panelId: string;
    paneId: string;
    reason: 'transcript-unavailable';
    message: string;
  };

export interface RunpanePanelInputResult {
  ok: true;
  generation?: number;
  panelId: string;
  paneId?: string;
  inputBytes: number;
  sentAt: string;
  nextCommand?: string;
}

export interface RunpanePanelSubmitRequest {
  panelId: string;
  input: string;
  /** Stop the current turn and wait for an empty idle composer before sending. */
  interrupt?: boolean;
  /** Write the text to a prompt file and submit `Read and follow <path>` instead. */
  asFilePointer?: boolean;
  /** `user` when a person typed it; their next finished turn notifies the phone. */
  source?: 'user' | 'agent';
}

export type RunpanePanelVerification = 'observed' | 'unverifiable';

/**
 * Where a prompt sent to a Claude or Codex composer went. `taken`: the agent
 * started a turn with it; `queued`: the agent holds it until its current turn
 * ends; `in-composer`: it is still in the composer; `unknown`: Pane saw
 * neither. `evidence` says what Pane read: the agent's transcript, the
 * screen, or (for a launch prompt) the launch arguments.
 */
export interface RunpaneDelivery {
  state: 'taken' | 'queued' | 'in-composer' | 'unknown';
  evidence: 'transcript' | 'screen' | 'argv';
  message?: string;
}

export interface RunpanePanelSubmitResult {
  ok: boolean;
  generation?: number;
  panelId: string;
  paneId?: string;
  inputBytes: number;
  enter: 'cr' | 'tab';
  sequenceName: 'codex-ctrl-enter-cr' | 'enter-cr' | 'tab';
  verifiedSubmitted: boolean;
  verification?: RunpanePanelVerification;
  /** Present for Claude and Codex composers; `verifiedSubmitted` is true when it is `taken` or `queued`. */
  delivery?: RunpaneDelivery;
  sentAt: string;
  blocked?: RunpanePanelBlockedState;
  /** The prompt file Pane wrote for `asFilePointer`. */
  promptFile?: string;
  warnings?: RunpanePromptWarning[];
  nextCommand?: string;
}

export type RunpanePanelSubmitComposerStrategy = 'auto' | 'codex-ctrl-enter' | 'enter' | 'tab';

export interface RunpanePanelSubmitComposerRequest {
  panelId: string;
  strategy?: RunpanePanelSubmitComposerStrategy;
}

export interface RunpanePanelSubmitComposerResult {
  ok: boolean;
  generation?: number;
  panelId: string;
  paneId?: string;
  inputBytes: number;
  strategy: 'codex-ctrl-enter' | 'enter' | 'tab';
  sequenceName: 'codex-ctrl-enter-cr' | 'enter-cr' | 'tab';
  verifiedSubmitted: boolean;
  verification?: RunpanePanelVerification;
  /** Present for Claude and Codex composers; `verifiedSubmitted` is true when it is `taken` or `queued`. */
  delivery?: RunpaneDelivery;
  sentAt: string;
  blocked?: RunpanePanelBlockedState;
  nextCommand?: string;
}

export interface RunpanePanelWaitRequest {
  panelId: string;
  condition?: RunpanePanelWaitCondition;
  contains?: string;
  timeoutMs?: number;
  intervalMs?: number;
}

export interface RunpanePanelWaitResult {
  ok: boolean;
  panelId: string;
  paneId?: string;
  condition: RunpanePanelWaitCondition;
  matched: boolean;
  timedOut: boolean;
  elapsedMs: number;
  state: RunpanePanelStateSummary;
  blocked?: RunpanePanelBlockedState;
  screen: Pick<RunpanePanelScreenResult, 'source' | 'text' | 'hasMore'>;
  nextCommand?: string;
}

export interface RunpaneAgentDoctorRequest {
  agent: RunpaneAgentId;
  repo?: RunpaneRepoSelector;
}

export interface RunpaneAgentDoctorCheck {
  name: string;
  ok: boolean;
  message: string;
}

export interface RunpaneAgentDoctorResult {
  ok: boolean;
  agent: RunpaneAgentId;
  command: string;
  repo?: RunpaneRepoSummary;
  environment?: ProjectEnvironment;
  available: boolean;
  executablePath?: string;
  version?: string;
  checks: RunpaneAgentDoctorCheck[];
  warnings?: string[];
}

export interface RunpaneResolvedTool {
  title: string;
  command: string;
  agent?: RunpaneAgentId;
  /** `wrapped` when `command` is a wrapper that runs `agent`; Pane launches it unchanged. */
  launchMode?: 'wrapped';
  initialInput?: string;
  initialInputAsFilePointer?: boolean;
}
