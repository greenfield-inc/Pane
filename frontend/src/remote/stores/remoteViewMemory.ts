import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';

/**
 * What this browser profile showed last on one host: the Pane (or the open
 * Session) and the tab in each Pane. Browser tabs of one profile share it, so
 * a reload restores whichever tab was used last.
 */
export interface RemoteViewMemory {
  paneId: string | null;
  /** The Session that was open, restored before its workspace Pane. */
  sessionId: string | null;
  panelIdByPaneId: Record<string, string>;
}

const STORAGE_KEY_PREFIX = 'pane.remotePwa.view@';
/** Keeps the stored list bounded; the least recently used Panes drop first. */
const MAX_REMEMBERED_PANES = 200;
const EMPTY_MEMORY: RemoteViewMemory = { paneId: null, sessionId: null, panelIdByPaneId: {} };
const savedMemorySchema = boundary.object({
  paneId: boundary.optional(boundary.nullable(boundary.string)),
  sessionId: boundary.optional(boundary.nullable(boundary.string)),
  /** Oldest first, so trimming drops the least recently used Panes. */
  panels: boundary.optional(boundary.array(boundary.object({ paneId: boundary.string, panelId: boundary.string }))),
});

export function readRemoteView(hostId: string): RemoteViewMemory {
  try {
    const saved = decodeOptionalBoundary(JSON.parse(window.localStorage.getItem(STORAGE_KEY_PREFIX + hostId) ?? 'null'), savedMemorySchema);
    return {
      paneId: saved?.paneId ?? null,
      sessionId: saved?.sessionId ?? null,
      panelIdByPaneId: Object.fromEntries((saved?.panels ?? []).map(entry => [entry.paneId, entry.panelId])),
    };
  } catch {
    return EMPTY_MEMORY;
  }
}

/** Records the Pane on screen and, when given, its tab. */
export function rememberRemoteView(hostId: string, view: { paneId: string; sessionId: string | null; panelId?: string }): void {
  const memory = readRemoteView(hostId);
  const panelIdByPaneId = { ...memory.panelIdByPaneId };
  if (view.panelId) {
    delete panelIdByPaneId[view.paneId];
    panelIdByPaneId[view.paneId] = view.panelId;
  }
  const paneIds = Object.keys(panelIdByPaneId);
  for (const paneId of paneIds.slice(0, Math.max(0, paneIds.length - MAX_REMEMBERED_PANES))) delete panelIdByPaneId[paneId];
  try {
    const panels = Object.entries(panelIdByPaneId).map(([paneId, panelId]) => ({ paneId, panelId }));
    window.localStorage.setItem(STORAGE_KEY_PREFIX + hostId, JSON.stringify({ paneId: view.paneId, sessionId: view.sessionId, panels }));
  } catch {
    // Storage can be unavailable (private mode); the view still works, it is just not remembered.
  }
}
