/**
 * Remote Pane runs as a browser PWA, not inside Electron, so its create sheets
 * remember Start pinned in localStorage rather than the desktop preference store.
 */
export function loadStartPinnedPreference(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

export function saveStartPinnedPreference(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? 'true' : 'false');
  } catch {
    // Ignore storage failures so the current create flow can still use local state.
  }
}
