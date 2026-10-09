import type { SessionPanelLayout } from '../../../shared/types/panels';

/**
 * This desktop's own split and tabs per Pane, kept in its ui_state per host.
 * The host's stored layout is the last one used by any client, so a Pane opens
 * on this copy when there is one and on the host's only when there is not.
 * Undefined `hostId` means config has not loaded, so nothing is read or written.
 */
export async function readPaneLayout(hostId: string | null | undefined, paneId: string): Promise<SessionPanelLayout | null> {
  if (hostId === undefined) return null;
  try {
    const response = await window.electronAPI.uiState.getPaneLayout(hostId, paneId);
    return response.success ? response.data ?? null : null;
  } catch (error) {
    console.warn('[paneLayoutMemory] Failed to read the remembered layout:', error);
    return null;
  }
}

/** A null layout forgets the Pane. */
export function rememberPaneLayout(hostId: string | null | undefined, paneId: string, layout: SessionPanelLayout | null): void {
  if (hostId === undefined) return;
  // Memory is best effort: a failed write never interrupts opening a Pane.
  void (async () => {
    try {
      await window.electronAPI.uiState.savePaneLayout(hostId, paneId, layout);
    } catch (error) {
      console.warn('[paneLayoutMemory] Failed to remember the layout:', error);
    }
  })();
}
