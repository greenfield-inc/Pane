import type { ProjectEnvironment, ToolPanelType } from './panels';
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
}

export type RunpaneWorkspaceEntryKind =
  | 'agent.ready'
  | 'agent.busy'
  | 'agent.blocked'
  | 'agent.unknown'
  | 'agent.idle'
  | 'pane.created'
  | 'pane.gone'
  | 'panel.exited';

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
  source: 'agent' | 'exit' | 'session';
  reason?: string | null;
  settledMs?: number;
  idleMs?: number;
  idleCount?: number;
  heldInput?: string;
  heldInputPresent?: boolean;
  exitCode?: number;
  baseline?: true;
  changedWhileAway?: boolean;
  panels?: RunpaneWorkspacePanelSummary[];
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
}

export interface RunpaneCommandToolSpec {
  command: string;
  title?: string;
  initialInput?: string;
}

export type RunpaneToolSpec = RunpaneAgentToolSpec | RunpaneCommandToolSpec;

export interface RunpanePaneCreateItem {
  name: string;
  worktreeName?: string;
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
  noFocus?: boolean;
  focus?: boolean;
  source?: RunpanePanelCreateSource;
}

export type RunpanePaneAdoptResult = RunpanePaneCreateResult;

export interface RunpaneErrorPayload {
  message: string;
  code?: string;
}

export type RunpanePanelActivityStatus = 'active' | 'idle';
export type RunpanePanelScreenSource = 'alternateScreen' | 'scrollback' | 'persistedOutput' | 'empty';
export type RunpanePanelWaitCondition = 'initialized' | 'ready' | 'idle' | 'text';
export type RunpanePanelBlockerKind =
  | 'codex-update'
  | 'agent-prompt'
  | 'submission_unverified'
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
  strategy?: 'codex-ctrl-enter' | 'enter' | 'argument';
  sequenceName?: 'codex-ctrl-enter-cr' | 'enter-cr' | 'argument';
  verifiedSubmitted?: boolean;
  verification?: RunpanePanelVerification;
  staged?: boolean;
  attempts?: number;
  sentAt?: string;
  blocked?: RunpanePanelBlockedState;
  error?: RunpaneErrorPayload;
  nextCommand?: string;
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
  status: string;
  agentStatus: RunpanePanelActivityStatus;
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
}

export type RunpaneWorktreeCleanupState = 'completed' | 'failed' | 'timeout' | 'not-applicable';

export type RunpanePaneArchiveBlockCode =
  | 'uncommitted-changes'
  | 'unpushed-commits'
  | 'uncommitted-and-unpushed'
  | 'status-unknown';

export interface RunpanePaneArchiveSafetyCheck {
  performed: boolean;
  hasUncommittedChanges?: boolean;
  hasUntrackedFiles?: boolean;
  hasUpstream?: boolean;
  upstream?: string;
  upstreamRefreshed?: boolean;
  unpushedCommits?: number;
  unpushedCommitDetails?: RunpanePaneArchiveCommit[];
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

export interface RunpanePanelSummary {
  id: string;
  panelId: string;
  paneId: string;
  type: ToolPanelType;
  title: string;
  active: boolean;
  initialized?: boolean;
  agentType?: RunpaneAgentId;
  isCliPanel?: boolean;
  position?: number;
  createdAt?: string;
  lastActiveAt?: string;
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
  nextCommand?: string;
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
  };
  nextCommand?: string;
}

export interface RunpanePanelInputRequest {
  panelId: string;
  input: string;
}

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
}

export type RunpanePanelVerification = 'observed' | 'unverifiable';

export interface RunpanePanelSubmitResult {
  ok: boolean;
  generation?: number;
  panelId: string;
  paneId?: string;
  inputBytes: number;
  enter: 'cr';
  sequenceName: 'codex-ctrl-enter-cr' | 'enter-cr';
  verifiedSubmitted: boolean;
  verification?: RunpanePanelVerification;
  sentAt: string;
  blocked?: RunpanePanelBlockedState;
  nextCommand?: string;
}

export type RunpanePanelSubmitComposerStrategy = 'auto' | 'codex-ctrl-enter' | 'enter';

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
  strategy: 'codex-ctrl-enter' | 'enter';
  sequenceName: 'codex-ctrl-enter-cr' | 'enter-cr';
  verifiedSubmitted: boolean;
  verification?: RunpanePanelVerification;
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
  initialInput?: string;
}
