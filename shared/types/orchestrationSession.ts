import type { CustomCommandResume } from './customCommandResume';
import type { AgentState } from './agentStatus';
import type { PaneChatAgent } from './paneChat';
import type { ToolPanel } from './panels';

/** Stable identifier of the built-in orchestration session imported from Pane Chat. */
export const LEGACY_ORCHESTRATION_SESSION_ID = 'legacy-pane-chat';
export const ORCHESTRATION_SESSION_INTERNAL_ID_PREFIX = '__orchestration_session_';
export const ORCHESTRATION_SESSION_STORE_VERSION = 1 as const;
export const MAX_ORCHESTRATION_ACTIVITY = 100;
export const MAX_ORCHESTRATION_ITEMS = 100;
export const MAX_ORCHESTRATION_TEXT_LENGTH = 16_000;

export function isOrchestrationInternalSessionId(sessionId: string): boolean {
  return sessionId === '__pane_chat_session__' || sessionId.startsWith(ORCHESTRATION_SESSION_INTERNAL_ID_PREFIX);
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
  /** Durable recovery anchor for an in-place conversation transfer. */
  promotedFrom?: { paneId: string; panelId: string };
  id: string;
  name: string;
  /** Durable UI archive marker. Older records omit this field and read as active. */
  archived?: boolean;
  /** Durable UI pin marker. Older records omit this field and read as unpinned. */
  isPinned?: boolean;
  agent: PaneChatAgent;
  /** Empty uses the selected built-in agent command. */
  launchCommand?: string;
  customResume?: CustomCommandResume | null;
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
  agentType?: PaneChatAgent;
  state: AgentState;
  initialized: boolean;
  lastActivityAt?: string;
  missing?: boolean;
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
}

export interface OrchestrationSessionOverview {
  session: OrchestrationSessionRecord;
  status: OrchestrationSessionStatus;
  panes: OrchestrationPaneOverview[];
  activity: OrchestrationActivity[];
  report?: OrchestrationReport & { freshness: 'current' | 'stale' };
  refreshedAt: string;
}

export interface OrchestrationSessionCreateInput {
  name: string;
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
  source?: 'user' | 'agent';
}

export interface OrchestrationSessionSelector {
  sessionId?: string;
  name?: string;
}

export interface OrchestrationAssociationInput {
  paneId: string;
  panelIds?: string[];
}
