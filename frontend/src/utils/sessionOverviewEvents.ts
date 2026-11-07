/** The window events after which a Session's overview may differ: status updates, and membership or report changes. */
const SESSION_OVERVIEW_EVENTS = ['orchestration-sessions-overview-updated', 'orchestration-sessions-changed'] as const;

/** Calls `callback` whenever a Session overview should be read again; returns the unsubscribe. */
export function onSessionOverviewChange(callback: () => void, target: EventTarget = window): () => void {
  for (const name of SESSION_OVERVIEW_EVENTS) target.addEventListener(name, callback);
  return () => { for (const name of SESSION_OVERVIEW_EVENTS) target.removeEventListener(name, callback); };
}
