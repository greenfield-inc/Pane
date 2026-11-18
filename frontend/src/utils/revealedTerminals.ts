/**
 * Terminal panels this window has revealed, kept across unmounts: switching
 * Sessions or Panes unmounts their terminals. A terminal revealed before is
 * cached content: when it mounts again it shows no loading skeleton (its mask
 * stays plain), and neither do the Session and Pane skeletons drawn before it
 * mounts. Forgotten when the panel or its session is deleted.
 */
const revealed = new Map<string, string>();

export function markTerminalRevealed(panelId: string, sessionId: string): void {
  revealed.set(panelId, sessionId);
}

export function wasTerminalRevealed(panelId: string): boolean {
  return revealed.has(panelId);
}

export function forgetRevealedTerminal(panelId: string): void {
  revealed.delete(panelId);
}

export function forgetRevealedTerminalsInSession(sessionId: string): void {
  for (const [panelId, panelSessionId] of revealed) {
    if (panelSessionId === sessionId) revealed.delete(panelId);
  }
}
