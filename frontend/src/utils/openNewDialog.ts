const OPEN_NEW_DIALOG_EVENT = 'pane:open-new-dialog';

/** Opens the sidebar's New dialog from anywhere in the window; the Sidebar owns it. */
export function requestOpenNewDialog(): void {
  window.dispatchEvent(new Event(OPEN_NEW_DIALOG_EVENT));
}

/** The Sidebar's side of requestOpenNewDialog; returns the unsubscribe. */
export function onOpenNewDialogRequest(open: () => void): () => void {
  window.addEventListener(OPEN_NEW_DIALOG_EVENT, open);
  return () => window.removeEventListener(OPEN_NEW_DIALOG_EVENT, open);
}
