import type { AgentDisplayStatus, AgentState } from '../types/agentStatus';

/**
 * Roll several panel {@link AgentState}s up into one, with precedence
 * blocked > working > idle. Returns `unknown` when no agent panel is tracked
 * (e.g. a session with only plain-shell panels), so callers can hide the badge.
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

/** Status reasons for a state a program reported itself (OSC 7501) start with this. */
export const PROGRAM_STATUS_REASON = 'program_status';

/** The status event's reason says a program reported this state itself (OSC 7501). */
export function isProgramStatusReason(reason: string | null | undefined): boolean {
  return reason?.startsWith(`${PROGRAM_STATUS_REASON}:`) ?? false;
}

/**
 * A program reported that it finished (OSC 7501 `done` or `error`). Main
 * announces each such report once, so it is a completed turn even when the
 * tab already read idle.
 */
export function isReportedFinish(reason: string | null | undefined): boolean {
  return reason === `${PROGRAM_STATUS_REASON}:done` || reason === `${PROGRAM_STATUS_REASON}:error`;
}
