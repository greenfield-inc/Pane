const OPEN_NEW_SESSION_EVENT = 'open-create-orchestration-session';

/**
 * Asks for New Session from anywhere in the window (the + beside Sessions, the shortcut, Search).
 * With Profiles off the Session nav's Create Session dialog answers; on, the Sidebar's Create New.
 */
export function requestOpenNewSession(): void {
  window.dispatchEvent(new Event(OPEN_NEW_SESSION_EVENT));
}

const OPEN_NEW_PANE_EVENT = 'open-create-new-pane';

class OpenNewPaneEvent extends Event {
  constructor(readonly projectId: number) {
    super(OPEN_NEW_PANE_EVENT);
  }
}

/**
 * Asks Create New for a Pane in `projectId` (a project's + with Profiles on, T-63). Profiles off,
 * the project's + opens its own Create Pane dialog and never asks.
 */
export function requestOpenNewPane(projectId: number): void {
  window.dispatchEvent(new OpenNewPaneEvent(projectId));
}

/** The Sidebar's side of requestOpenNewPane; returns the unsubscribe. */
export function onOpenNewPaneRequest(open: (projectId: number) => void): () => void {
  const listener = (event: Event) => { if (event instanceof OpenNewPaneEvent) open(event.projectId); };
  window.addEventListener(OPEN_NEW_PANE_EVENT, listener);
  return () => window.removeEventListener(OPEN_NEW_PANE_EVENT, listener);
}

/** The Sidebar's side of requestOpenNewSession; returns the unsubscribe. */
export function onOpenNewSessionRequest(open: () => void): () => void {
  window.addEventListener(OPEN_NEW_SESSION_EVENT, open);
  return () => window.removeEventListener(OPEN_NEW_SESSION_EVENT, open);
}
