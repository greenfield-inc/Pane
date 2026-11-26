import type { OrchestrationSessionRecord } from './types/orchestrationSession';
import type { MachineConnectionsEvent } from './types/machineConnections';
import { boundary, decodeOptionalBoundary } from './validation/boundaryDecoder';

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

const changeKind = boundary.object({ kind: boundary.string });

/**
 * Whether a machine's event only moved a Session's read state (a view cleared it, or its agent
 * replied): its Session list changes, and nothing else needs reading.
 */
export function isReadStateChange(event: Extract<MachineConnectionsEvent, { type: 'event' }>): boolean {
  if (event.channel !== 'orchestration-sessions:changed') return false;
  const kind = decodeOptionalBoundary(event.args[0], changeKind)?.kind;
  return kind === 'viewed' || kind === 'replied';
}
