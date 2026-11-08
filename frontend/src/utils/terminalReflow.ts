/**
 * Maximize and restore (P4) resize visible terminals in one step. A terminal's
 * own resize path is debounced and unmasked, so for a moment it would show
 * its old grid clipped or wrapped. Callers announce the change just before
 * applying it; each active terminal raises its loading overlay in the same
 * render, refits once the new size settles, and lowers it (AGENTS.md: refits
 * stay behind `isRefreshing`).
 */
const REFLOW_EVENT = 'pane:terminal-layout-reflow';

export function announceTerminalReflow(): void {
  window.dispatchEvent(new Event(REFLOW_EVENT));
}

export function onTerminalReflow(listener: () => void): () => void {
  window.addEventListener(REFLOW_EVENT, listener);
  return () => window.removeEventListener(REFLOW_EVENT, listener);
}
