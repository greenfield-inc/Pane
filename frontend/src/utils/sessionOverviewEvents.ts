import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';

/** The window events after which a Session's overview may differ: status updates, and membership or report changes. */
const SESSION_OVERVIEW_EVENTS = ['orchestration-sessions-overview-updated', 'orchestration-sessions-changed'] as const;

/** Both events name the Session that changed; an event without one may concern any Session. */
const changeSchema = boundary.object({ sessionId: boundary.nonEmptyString });

/**
 * Calls `callback` whenever a Session overview should be read again, with the id of the Session
 * that changed when the event names one; returns the unsubscribe.
 */
export function onSessionOverviewChange(callback: (sessionId?: string) => void, target: EventTarget = window): () => void {
  const listener = (event: Event) => {
    const change = event instanceof CustomEvent ? decodeOptionalBoundary(event.detail, changeSchema) : undefined;
    callback(change?.sessionId);
  };
  for (const name of SESSION_OVERVIEW_EVENTS) target.addEventListener(name, listener);
  return () => { for (const name of SESSION_OVERVIEW_EVENTS) target.removeEventListener(name, listener); };
}
