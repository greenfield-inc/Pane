/** What `terminal:getState` returns that a remote viewer replays (a subset of `TerminalPanelState`). */
export interface HostTerminalSnapshot {
  scrollbackBuffer?: string | string[];
  alternateScreenBuffer?: string;
  isAlternateScreen?: boolean;
  serializedBuffer?: string;
}

/** The text a fresh remote terminal writes to show what the host's terminal shows now. */
export function terminalSnapshotText(state: HostTerminalSnapshot | null): string {
  if (!state) return '';
  if (state.isAlternateScreen) return state.serializedBuffer ?? state.alternateScreenBuffer ?? '';
  const scrollback = Array.isArray(state.scrollbackBuffer)
    ? state.scrollbackBuffer.join('')
    : state.scrollbackBuffer ?? '';
  return scrollback || state.serializedBuffer || '';
}
