const OPEN_NEW_SESSION_EVENT = 'open-create-orchestration-session';

/** Opens the New Session palette from anywhere in the window (the + beside Sessions, the shortcut, Search); the Sidebar owns it. */
export function requestOpenNewSessionPalette(): void {
  window.dispatchEvent(new Event(OPEN_NEW_SESSION_EVENT));
}

/** The Sidebar's side of requestOpenNewSessionPalette; returns the unsubscribe. */
export function onOpenNewSessionPaletteRequest(open: () => void): () => void {
  window.addEventListener(OPEN_NEW_SESSION_EVENT, open);
  return () => window.removeEventListener(OPEN_NEW_SESSION_EVENT, open);
}
