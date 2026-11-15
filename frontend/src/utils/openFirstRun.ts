const OPEN_FIRST_RUN_EVENT = 'pane:open-first-run';

/** Reopens the first-run screen from anywhere in the window; App owns it. */
export function requestOpenFirstRun(): void {
  window.dispatchEvent(new Event(OPEN_FIRST_RUN_EVENT));
}

/** App's side of requestOpenFirstRun; returns the unsubscribe. */
export function onOpenFirstRunRequest(open: () => void): () => void {
  window.addEventListener(OPEN_FIRST_RUN_EVENT, open);
  return () => window.removeEventListener(OPEN_FIRST_RUN_EVENT, open);
}
