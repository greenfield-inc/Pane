import type { AgentDisplayStatus, AgentState, PanelAgentStatusEvent } from '@shared/types/agentStatus';
import type { RunpaneWorkspaceStateResult } from '@shared/types/runpaneOrchestration';
import { rollupSessionAgentState, toAgentDisplayStatus } from '@shared/utils/agentStatus';

/**
 * Live agent status for every pane on a host: a snapshot from
 * `runpane:workspace:state`, kept current by `panel:agentStatus` events.
 */
export interface AgentStatusSnapshot {
  /** panelId → raw state. */
  agentStatus: Record<string, AgentState>;
  /** panelId → pane (session) ID. */
  agentStatusSession: Record<string, string>;
  /** Pane ID → agent that runs in it (claude, codex, cursor). */
  agentType: Record<string, string>;
  /** Pane IDs whose agent finished while nobody looked at the pane here. */
  unseen: Record<string, true>;
}

export const emptyAgentStatus: AgentStatusSnapshot = { agentStatus: {}, agentStatusSession: {}, agentType: {}, unseen: {} };

export function agentStatusFromWorkspace(workspace: RunpaneWorkspaceStateResult, previous = emptyAgentStatus): AgentStatusSnapshot {
  const next: AgentStatusSnapshot = { agentStatus: {}, agentStatusSession: {}, agentType: {}, unseen: {} };
  for (const entry of workspace.entries) {
    if (entry.kind !== 'pane.created' || !entry.panels) continue;
    for (const panel of entry.panels) {
      // Plain shells have no agentType; the desktop leaves them without a badge too.
      if (!panel.agentType || !panel.agentState) continue;
      next.agentStatus[panel.panelId] = panel.agentState;
      next.agentStatusSession[panel.panelId] = entry.paneId;
      next.agentType[entry.paneId] ??= panel.agentType;
    }
  }
  for (const paneId of Object.keys(previous.unseen)) {
    if (rawState(next, paneId) === 'idle') next.unseen[paneId] = true;
  }
  return next;
}

export function applyAgentStatusEvent(snapshot: AgentStatusSnapshot, event: PanelAgentStatusEvent): AgentStatusSnapshot {
  const before = rawState(snapshot, event.sessionId);
  const next: AgentStatusSnapshot = {
    ...snapshot,
    agentStatus: { ...snapshot.agentStatus, [event.panelId]: event.state },
    agentStatusSession: { ...snapshot.agentStatusSession, [event.panelId]: event.sessionId },
    unseen: { ...snapshot.unseen },
  };
  const after = rawState(next, event.sessionId);
  if (after !== 'idle') delete next.unseen[event.sessionId];
  else if (before === 'working') next.unseen[event.sessionId] = true;
  return next;
}

export function markSeen(snapshot: AgentStatusSnapshot, paneId: string): AgentStatusSnapshot {
  if (!snapshot.unseen[paneId]) return snapshot;
  const unseen = { ...snapshot.unseen };
  delete unseen[paneId];
  return { ...snapshot, unseen };
}

/** `done` is the desktop's name for an unseen finish; the app labels it Ready. */
export function paneDisplayStatus(snapshot: AgentStatusSnapshot, paneId: string): AgentDisplayStatus {
  return toAgentDisplayStatus(rawState(snapshot, paneId), Boolean(snapshot.unseen[paneId]));
}

export function paneAgent(snapshot: AgentStatusSnapshot, paneId: string): string | undefined {
  return snapshot.agentType[paneId];
}

function rawState(snapshot: AgentStatusSnapshot, paneId: string): AgentState {
  return rollupSessionAgentState(snapshot.agentStatus, snapshot.agentStatusSession, paneId);
}
