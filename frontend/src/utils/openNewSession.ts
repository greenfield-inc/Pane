const OPEN_NEW_SESSION_EVENT = 'open-create-orchestration-session';

/**
 * Asks for New Session from anywhere in the window (the + beside Sessions, the shortcut, Search).
 * With Profiles off the Session nav's Create Session dialog answers; on, the Sidebar's Create New.
 */
export function requestOpenNewSession(): void {
  window.dispatchEvent(new Event(OPEN_NEW_SESSION_EVENT));
}

/** The Sidebar's side of requestOpenNewSession; returns the unsubscribe. */
export function onOpenNewSessionRequest(open: () => void): () => void {
  window.addEventListener(OPEN_NEW_SESSION_EVENT, open);
  return () => window.removeEventListener(OPEN_NEW_SESSION_EVENT, open);
}
