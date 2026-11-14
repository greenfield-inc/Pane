/**
 * Pure PTY-stream filter shared by terminalPanelManager. Kept separate so the
 * scanning rules are unit-testable without spawning a terminal.
 */
export interface SyncBlockClearFilterState {
  /** Inside a DEC 2026 synchronized-output block — persists across chunks. */
  inSyncBlock: boolean;
  /** Alternate screen active, tracked in stream order — persists across chunks. */
  filterInAltScreen: boolean;
  /** The previous chunk's unfinished escape sequence, so a marker split across two reads still counts. */
  filterSequenceTail?: string;
}

/** Ends a DEC 2026 synchronized-output block: the frame before it is complete. */
export const SYNC_END = '\x1b[?2026l';

/** The sequences that change filter state, each with the change it makes. All are the same length. */
const STATE_MARKERS: ReadonlyArray<readonly [string, (state: SyncBlockClearFilterState) => void]> = [
  ['\x1b[?2026h', state => { state.inSyncBlock = true; }],
  [SYNC_END, state => { state.inSyncBlock = false; }],
  ['\x1b[?1049h', state => { state.filterInAltScreen = true; }],
  ['\x1b[?1049l', state => { state.filterInAltScreen = false; }],
];
const MARKER_LENGTH = SYNC_END.length;

/**
 * Strips \x1b[2J (clear-screen) sequences that appear inside DEC Mode 2026
 * synchronized-output blocks while the NORMAL buffer is active. Claude Code
 * uses these blocks for its inline (normal-buffer) redraws; the clear-screen
 * causes xterm.js to reset scroll position, yanking users away from where
 * they were reading.
 *
 * On the ALTERNATE screen (Claude Code fullscreen mode, vim, etc.) the clear
 * is passed through untouched: there is no scrollback to protect, and the
 * app relies on \x1b[2J to wipe the previous frame when it repaints after a
 * resize. Stripping it left stale glyphs from the old geometry behind the new
 * frame — visible as duplicated/overlapping text after resizing the pane.
 *
 * Alt-screen transitions (\x1b[?1049h / \x1b[?1049l) are tracked inside the
 * scan so a chunk containing both an alt-screen enter and a clear is handled
 * in stream order. State (inSyncBlock, filterInAltScreen, and a marker cut
 * off at the end of a chunk) persists across chunk boundaries on the
 * terminal object.
 */
export function filterSyncBlockClears(terminal: SyncBlockClearFilterState, data: string): string {
  const CLEAR = '\x1b[2J';

  // A marker split across two reads: its first bytes already went out with
  // the previous chunk, so only its state change applies here.
  let i = 0;
  const tail = terminal.filterSequenceTail ?? '';
  const joined = tail + data;
  if (tail) {
    const split = STATE_MARKERS.find(([marker]) => marker.startsWith(tail) && joined.startsWith(marker));
    if (split) {
      split[1](terminal);
      i = split[0].length - tail.length;
    }
  }
  const escape = joined.lastIndexOf('\x1b');
  terminal.filterSequenceTail = escape >= 0 && joined.length - escape < MARKER_LENGTH ? joined.slice(escape) : '';

  // Fast path: nothing to strip and no state to update. (No alt-screen fast
  // path: sync-block state must stay exact so it is correct on 1049l.)
  if (!terminal.inSyncBlock && !STATE_MARKERS.some(([marker]) => data.includes(marker, i))) {
    return data;
  }

  let result = data.slice(0, i);

  while (i < data.length) {
    const marker = data[i] === '\x1b' ? STATE_MARKERS.find(([m]) => data.startsWith(m, i)) : undefined;
    if (marker) {
      marker[1](terminal);
      result += marker[0];
      i += marker[0].length;
    } else if (terminal.inSyncBlock && !terminal.filterInAltScreen && data.startsWith(CLEAR, i)) {
      // Strip the clear-screen — scroll position preserved in xterm.js
      i += CLEAR.length;
    } else {
      result += data[i];
      i++;
    }
  }

  return result;
}
