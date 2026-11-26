import type { SessionMoveMark } from './sessionMove';
import type { CustomCommandResume } from './customCommandResume';
import type { AgentState } from './agentStatus';
import type { PaneChatAgent } from './paneChat';
import type { SessionPanelLayout, TerminalAgentReport, TerminalPausedMark, ToolPanel, ToolPanelType } from './panels';
import type { ChatTabView } from './chatTab';
import type { RunpanePaneArchiveBlockCode } from './runpaneOrchestration';
import { boundary, decodeOptionalBoundary, type JsonObject } from '../validation/boundaryDecoder';

/** Stable identifier of the built-in orchestration session imported from Pane Chat. */
export const LEGACY_ORCHESTRATION_SESSION_ID = 'legacy-pane-chat';
export const ORCHESTRATION_SESSION_INTERNAL_ID_PREFIX = '__orchestration_session_';
export const ORCHESTRATION_SESSION_STORE_VERSION = 1 as const;

/** How many entries each Session keeps before the oldest are dropped; `retention` in config.json overrides each one. */
export interface SessionRetention {
  /** Activity entries kept per Session. */
  sessionActivity: number;
  /** Inbox items kept per Session. */
  sessionInbox: number;
}
const positiveIntegerSchema = boundary.refine(boundary.number, value => Number.isInteger(value) && value > 0, 'expected a positive integer');
export const DEFAULT_SESSION_RETENTION: SessionRetention = { sessionActivity: 500, sessionInbox: 1000 };

/** The configured retention, with the default for any value that is missing or not a positive integer. */
export function resolveSessionRetention(configured: Partial<SessionRetention> | undefined): SessionRetention {
  const pick = (key: keyof SessionRetention): number =>
    decodeOptionalBoundary(configured?.[key], positiveIntegerSchema) ?? DEFAULT_SESSION_RETENTION[key];
  return { sessionActivity: pick('sessionActivity'), sessionInbox: pick('sessionInbox') };
}

export function isOrchestrationInternalSessionId(sessionId: string): boolean {
  return sessionId === '__pane_chat_session__' || sessionId.startsWith(ORCHESTRATION_SESSION_INTERNAL_ID_PREFIX);
}

/** Default name for a new Session: "New chat", then "New chat 2", "New chat 3", ... */
export function nextOrchestrationSessionName(sessions: readonly { name: string }[]): string {
  const existingNames = new Set(sessions.map(session => session.name.trim().toLocaleLowerCase()));
  if (!existingNames.has('new chat')) return 'New chat';

  let suffix = 2;
  while (existingNames.has(`new chat ${suffix}`)) suffix += 1;
  return `New chat ${suffix}`;
}

export type OrchestrationSessionStatus = 'working' | 'blocked' | 'idle' | 'unknown' | 'unassociated';

export interface OrchestrationLink {
  label: string;
  url: string;
  kind?: 'evidence' | 'output' | 'ticket' | 'pull-request' | 'other';
  provenance?: string;
  addedAt: string;
}

export interface OrchestrationReport {
  summary: string;
  status: 'reported' | 'verified';
  evidence: OrchestrationLink[];
  reportedAt: string;
  provenance: string;
}

export interface OrchestrationAssociation {
  paneId: string;
  /** An empty list means the whole Pane. Tabs share a Pane worktree. */
  panelIds: string[];
  attachedAt: string;
  /** Set for a Pane on another saved machine: that machine's saved profile id and label. */
  machine?: OrchestrationMemberMachine;
  /** A remote Pane's name when it joined; a local Pane's name is read from this computer. */
  name?: string;
}

export interface OrchestrationMemberMachine {
  id: string;
  label: string;
}

export type OrchestrationActivityKind =
  | 'created'
  | 'updated'
  | 'associated'
  | 'detached'
  | 'working'
  | 'blocked'
  | 'idle'
  | 'unknown'
  /** The Session's own report, or (with a panelId) a worker's `runpane report`. */
  | 'report';

export interface OrchestrationActivity {
  id: string;
  kind: OrchestrationActivityKind;
  message: string;
  at: string;
  source: 'user' | 'agent' | 'system';
  paneId?: string;
  panelId?: string;
}

export interface OrchestrationSessionRecord {
  /** Omitted means the native host. 'windows' is a legacy alias for native and is dropped on read. */
  runtime?: 'windows' | 'wsl';
  wslDistribution?: string;
  /** Durable recovery anchor for an in-place conversation transfer. */
  promotedFrom?: { paneId: string; panelId: string };
  /** Set while the Session moves to or from another machine, and on the source once it moved. */
  move?: SessionMoveMark;
  id: string;
  name: string;
  /** The name is the default one; the Session agent renames it once (see sessionWorkspace.ts). */
  nameIsDefault?: boolean;
  /** Durable UI archive marker. Older records omit this field and read as active. */
  archived?: boolean;
  /** When the Session was archived; Pane deletes its folder the retention period later. Startup sets it for Sessions archived before it existed. */
  archivedAt?: string;
  /** Durable UI pin marker. Older records omit this field and read as unpinned. */
  isPinned?: boolean;
  /**
   * The to-do this Session belongs to (T-n), written with the record's first write so no list shows
   * it as a Session of its own, even before the to-do stores the Session's id. Older records omit it.
   */
  todoNumber?: number;
  /** Set while the Session's chat and every Pane in it are paused. Computed when read, never stored. */
  paused?: TerminalPausedMark;
  agent: PaneChatAgent;
  /** Empty uses the selected built-in agent command. */
  launchCommand?: string;
  customResume?: CustomCommandResume | null;
  /**
   * A native conversation of `agent` the Session's tab resumes (`runpane handoff` moving a
   * Session). Saved with the record, so a tab created or repaired at startup still resumes it.
   */
  resume?: string;
  /**
   * The agent's first message in a new conversation, kept until a terminal has sent it
   * so a tab created or repaired before launch still sends it. Dropped once sent.
   */
  openingPrompt?: string;
  /** Snapshot of the behavior profile, independent of app defaults. */
  profile?: string;
  /** Hidden detached Pane session that owns the durable terminal conversation. */
  internalSessionId: string;
  /** Deterministic terminal panel for each supported agent. */
  panelIds: Record<PaneChatAgent, string>;
  goal: string;
  context: string;
  decisions: string[];
  blockers: string[];
  nextAction: string;
  evidence: OrchestrationLink[];
  outputs: OrchestrationLink[];
  associations: OrchestrationAssociation[];
  activity: OrchestrationActivity[];
  report?: OrchestrationReport;
  /** Server generated marker for the report activity used for freshness checks. */
  reportActivityId?: string;
  /** Server time at which the report was accepted, independent of reportedAt. */
  reportAcceptedAt?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface OrchestrationSessionStoreData {
  version: typeof ORCHESTRATION_SESSION_STORE_VERSION;
  selectedSessionId?: string;
  /**
   * The order people arranged Sessions in, oldest first when absent. Sessions it does not name
   * (new ones, or any written by a Pane that predates ordering) follow it by creation time.
   * Optional so the store stays at version 1: an older Pane ignores it and drops it on its next write.
   */
  order?: string[];
  sessions: OrchestrationSessionRecord[];
}

export interface OrchestrationSessionListResult {
  sessions: OrchestrationSessionRecord[];
  selectedSessionId?: string;
}

export interface OrchestrationSessionView<TSession = unknown> {
  session: OrchestrationSessionRecord;
  internalSession: TSession;
  panel: ToolPanel;
  agent: PaneChatAgent;
  cwd: string;
  guidePath: string;
  started: boolean;
}

/**
 * Everything a desktop needs to show a Session, in one call (T-87): what `get`,
 * `panels:list`, `panels:get-layout` and `chat-tab:get` returned one after another.
 *
 * - `orchestration-sessions:peek` (the sidebar cursor passing over a Session) only reads:
 *   it saves nothing, creates nothing and starts no agent. `view` is null when the
 *   Session's tab has not been created yet; opening it creates it.
 * - `orchestration-sessions:open` (the cursor settled, Enter, a click) is `get` plus the
 *   rest, starts the chat's agent as `chat-tab:get` does, and with `select` saves the
 *   selection and returns the list `select` returns.
 */
export interface OrchestrationSessionOpenResult<TSession = unknown> {
  view: OrchestrationSessionView<TSession> | null;
  /** The Session's tabs, as `panels:list` returns them for this client. */
  panels: ToolPanel[];
  /** The host's last-used tab layout, as `panels:get-layout` returns it. */
  layout: SessionPanelLayout | null;
  /** The agent's chat with its newest messages, when the agent tab is a chat. */
  chat?: ChatTabView;
  /** With `select`: the Session list after saving the selection. */
  list?: OrchestrationSessionListResult;
}

export interface OrchestrationSessionOpenOptions {
  /** Save this Session as the selected one, as `select` does. */
  select?: boolean;
}

export interface OrchestrationGitSummary {
  state: string;
  ahead?: number;
  behind?: number;
  hasUncommittedChanges?: boolean;
  hasUntrackedFiles?: boolean;
  prNumber?: number;
  prUrl?: string;
  prTitle?: string;
  prState?: string;
}

export interface OrchestrationPanelOverview {
  panelId: string;
  title: string;
  /** The tab's panel type; absent on a missing panel. */
  type?: ToolPanelType;
  agentType?: PaneChatAgent;
  state: AgentState;
  initialized: boolean;
  lastActivityAt?: string;
  missing?: boolean;
  /** This panel's latest `runpane report`. */
  report?: OrchestrationPanelReport;
}

/**
 * A panel's report as the overview returns it. `data` is the summary parsed as
 * given when it is a complete JSON object; a plain-text, array, scalar, invalid,
 * truncated, or more than 64 levels deep summary has no `data`.
 */
export interface OrchestrationPanelReport extends TerminalAgentReport {
  data?: JsonObject;
}

export interface OrchestrationPaneOverview {
  paneId: string;
  name: string;
  worktreePath?: string;
  branch?: string;
  archived: boolean;
  missing: boolean;
  panels: OrchestrationPanelOverview[];
  git?: OrchestrationGitSummary;
  /** The newest `runpane report` among the Pane's panels, with the panel that sent it. */
  report?: TerminalAgentReport & { panelId: string };
  /**
   * Set for a Pane on another saved machine. `unreachable`: that machine did not answer, so the
   * rest of the row is what was known when it joined. `older-pane`: its Pane predates remote
   * members, so its reports don't reach this computer until it is updated.
   */
  machine?: OrchestrationMemberMachine & { state: 'online' | 'unreachable' | 'older-pane' };
}

export interface OrchestrationSessionOverview {
  session: OrchestrationSessionRecord;
  status: OrchestrationSessionStatus;
  panes: OrchestrationPaneOverview[];
  activity: OrchestrationActivity[];
  report?: OrchestrationReport & { freshness: 'current' | 'stale' };
  refreshedAt: string;
  /** With chat tabs on, why this Session's orchestrator runs in a terminal instead of a chat. */
  terminalReason?: string;
}

export interface OrchestrationSessionCreateInput {
  /** Omit for the native host. 'windows' is accepted as a legacy alias for native. */
  runtime?: 'windows' | 'wsl';
  wslDistribution?: string;
  name: string;
  /** The person left the name blank; the Session agent names the Session once it understands the work. */
  nameFromFirstMessage?: boolean;
  isPinned?: boolean;
  /** The to-do (T-n) this Session is created for; see `OrchestrationSessionRecord.todoNumber`. */
  todoNumber?: number;
  agent?: PaneChatAgent;
  launchCommand?: string;
  customResume?: CustomCommandResume | null;
  /**
   * A native session id of `agent` to resume: the Session's agent tab resumes that conversation
   * when it first opens, instead of starting a new one. `runpane handoff` uses it to move a Session.
   */
  resume?: string;
  /**
   * Sent once as the agent's first message; must begin with `PANE_ONE_TIME_PROMPT_OPENING`.
   * The desktop's Pane Chat offer uses it; it is not part of the runpane contract.
   */
  openingPrompt?: string;
  profile?: string;
  goal?: string;
  context?: string;
  decisions?: string[];
  blockers?: string[];
  nextAction?: string;
  evidence?: OrchestrationLink[];
  outputs?: OrchestrationLink[];
}

export interface OrchestrationSessionUpdateInput {
  name?: string;
  archived?: boolean;
  isPinned?: boolean;
  agent?: PaneChatAgent;
  launchCommand?: string;
  customResume?: CustomCommandResume | null;
  profile?: string;
  goal?: string;
  context?: string;
  decisions?: string[];
  blockers?: string[];
  nextAction?: string;
  evidence?: OrchestrationLink[];
  outputs?: OrchestrationLink[];
  report?: OrchestrationReport | null;
  expectedRevision?: number;
  source?: OrchestrationActivity['source'];
}

/** A Pane archiving its Session would take along; `blocked` is why a plain archive keeps it open. */
export interface OrchestrationSessionArchivePane {
  paneId: string;
  name: string;
  blocked?: RunpanePaneArchiveBlockCode;
}

/** `orchestration-sessions:archive-preview`: the Panes archiving the Session would take, unsafe ones flagged. Changes nothing. */
export interface OrchestrationSessionArchivePreview {
  sessionId: string;
  panes: OrchestrationSessionArchivePane[];
}

/**
 * `orchestration-sessions:archive`: the Panes the person approved in the archive dialog.
 * `archivePaneIds` were safe in the preview and are checked again, so one that became unsafe stays
 * open; `forcePaneIds` were shown as unsafe and archived anyway. Every other Pane stays open.
 */
export interface OrchestrationSessionArchiveSelection {
  archivePaneIds: string[];
  forcePaneIds: string[];
}

/** What archiving a Session did with each Pane it considered. */
export interface OrchestrationSessionArchivedPanes {
  archivedPaneIds: string[];
  keptPanes: Array<{ paneId: string; name: string; code: RunpanePaneArchiveBlockCode }>;
  failedPanes: Array<{ paneId: string; name: string; error: string }>;
}

export interface OrchestrationSessionArchiveResult extends OrchestrationSessionArchivedPanes {
  session: OrchestrationSessionRecord;
}

export interface OrchestrationSessionSelector {
  sessionId?: string;
  name?: string;
}

export interface OrchestrationAssociationInput {
  paneId: string;
  panelIds?: string[];
}

/**
 * A Session's live activity, decided on the host that runs its agents (sessionActivity.ts):
 * `working` while its orchestrator or one of its Panes is really mid-turn, else `idle`.
 * Sent as `orchestration-sessions:activity` and read as a baseline with
 * `orchestration-sessions:activity-list`. A host without them reads as idle.
 */
export interface SessionActivity {
  sessionId: string;
  state: 'working' | 'idle';
  /** Panes of the Session with a tab working, for the "N working" label. */
  workingPanes: number;
}
