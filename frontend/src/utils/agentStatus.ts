import type { AgentDisplayStatus, AgentState } from '../../../shared/types/agentStatus';

/**
 * Roll several panel {@link AgentState}s up into one, with precedence
 * blocked > working > idle. Returns `unknown` before any terminal status is
 * available. Plain shells participate through generic activity detection.
 */
export function rollupAgentState(states: Array<AgentState | undefined>): AgentState {
  let sawWorking = false;
  let sawIdle = false;
  for (const state of states) {
    if (state === 'blocked') return 'blocked';
    if (state === 'working') sawWorking = true;
    else if (state === 'idle') sawIdle = true;
  }
  if (sawWorking) return 'working';
  return sawIdle ? 'idle' : 'unknown';
}

/**
 * Roll up every tracked panel belonging to `sessionId` (matched via the sessionId
 * carried on each status event), independent of whether the session's panels are
 * loaded into the store — so background sessions and Pane Chat still light up.
 */
export function rollupSessionAgentState(
  agentStatus: Record<string, AgentState>,
  agentStatusSession: Record<string, string>,
  sessionId: string,
): AgentState {
  const states: AgentState[] = [];
  for (const panelId of Object.keys(agentStatus)) {
    if (agentStatusSession[panelId] === sessionId) states.push(agentStatus[panelId]);
  }
  return rollupAgentState(states);
}

const DISPLAY_PRECEDENCE: readonly AgentDisplayStatus[] = ['blocked', 'working', 'done', 'idle'];

/**
 * Roll several {@link AgentDisplayStatus}es up into one, with precedence
 * blocked > working > done > idle. Unlike {@link rollupAgentState} this keeps
 * unseen completion visible: a group whose members are all freshly finished
 * reads as `done`, not `idle`. Used for the project-level dot.
 */
export function rollupAgentDisplayStatus(statuses: AgentDisplayStatus[]): AgentDisplayStatus {
  for (const status of DISPLAY_PRECEDENCE) {
    if (statuses.includes(status)) return status;
  }
  return 'unknown';
}

/**
 * Map a raw {@link AgentState} to the status shown in the UI. A finished agent
 * the user hasn't looked at yet reads as `done`; once seen it is plain `idle`.
 */
export function toAgentDisplayStatus(
  raw: AgentState | undefined,
  unseen: boolean,
): AgentDisplayStatus {
  if (!raw || raw === 'unknown') return 'unknown';
  if (raw === 'idle') return unseen ? 'done' : 'idle';
  return raw;
}
