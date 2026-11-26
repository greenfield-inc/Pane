import type { OrchestrationSessionRecord } from './types/orchestrationSession';

/**
 * Whether a Session has a message from its own agent the person has not read: the host's
 * read state says a reply came after the last view. The host orders the two itself
 * (OrchestrationSessionManager), so clocks, rounding and two events in the same instant never
 * decide it. Pane lines, worker tabs, the person's own messages and turns that ended without text
 * never record a reply.
 */
export function sessionIsUnread(session: Pick<OrchestrationSessionRecord, 'readState'>): boolean {
  const state = session.readState;
  return state !== undefined && state.replied > state.viewed;
}
