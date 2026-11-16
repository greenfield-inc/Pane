/**
 * Terminal panels that have finished their first load, kept across unmounts:
 * switching Panes unmounts a Pane's terminals, and a terminal that loaded once
 * covers later refits with a plain mask instead of the loading skeleton.
 * Forgotten when the panel or its session is deleted.
 */
const shownPanelSessions = new Map<string, string>();

export function markTerminalShown(panelId: string, sessionId: string): void {
  shownPanelSessions.set(panelId, sessionId);
}

export function wasTerminalShown(panelId: string): boolean {
  return shownPanelSessions.has(panelId);
}

export function forgetShownTerminal(panelId: string): void {
  shownPanelSessions.delete(panelId);
}

export function forgetShownTerminalsInSession(sessionId: string): void {
  for (const [panelId, panelSessionId] of shownPanelSessions) {
    if (panelSessionId === sessionId) shownPanelSessions.delete(panelId);
  }
}
