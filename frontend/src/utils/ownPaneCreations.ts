/**
 * Pane creations this desktop asked for. The host echoes each request's id on
 * session:created, and the desktop switches only to Panes it created itself.
 * A multi-Pane request shares one id, so ids are kept for the window's life.
 */
const ownRequestIds = new Set<string>();

export function startOwnPaneCreation(): string {
  const id = crypto.randomUUID();
  ownRequestIds.add(id);
  return id;
}

export function isOwnPaneCreation(clientRequestId: string | undefined): boolean {
  return clientRequestId !== undefined && ownRequestIds.has(clientRequestId);
}
