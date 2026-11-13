/**
 * Pure PTY-stream filter shared by terminalPanelManager. Kept separate so the
 * scanning rules are unit-testable without spawning a terminal.
 */
export interface SyncBlockClearFilterState {
  /** Inside a DEC 2026 synchronized-output block — persists across chunks. */
  inSyncBlock: boolean;
  /** Alternate screen active, tracked in stream order — persists across chunks. */
  filterInAltScreen: boolean;
}

/** Ends a DEC 2026 synchronized-output block: the frame before it is complete. */
export const SYNC_END = '\x1b[?2026l';

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
 * in stream order. State (inSyncBlock, filterInAltScreen) persists across
 * chunk boundaries on the terminal object.
 */
export function filterSyncBlockClears(terminal: SyncBlockClearFilterState, data: string): string {
  const SYNC_START = '\x1b[?2026h';
  const ALT_ENTER  = '\x1b[?1049h';
  const ALT_LEAVE  = '\x1b[?1049l';
  const CLEAR      = '\x1b[2J';

  const hasAltTransition = data.includes(ALT_ENTER) || data.includes(ALT_LEAVE);

  // Fast path: nothing to strip and no state to update. (No alt-screen fast
  // path: sync-block state must stay exact so it is correct on 1049l.)
  if (!terminal.inSyncBlock && !data.includes(SYNC_START) && !hasAltTransition) {
    return data;
  }

  let result = '';
  let i = 0;

  while (i < data.length) {
    if (data.startsWith(SYNC_START, i)) {
      terminal.inSyncBlock = true;
      result += SYNC_START;
      i += SYNC_START.length;
    } else if (data.startsWith(SYNC_END, i)) {
      terminal.inSyncBlock = false;
      result += SYNC_END;
      i += SYNC_END.length;
    } else if (data.startsWith(ALT_ENTER, i)) {
      terminal.filterInAltScreen = true;
      result += ALT_ENTER;
      i += ALT_ENTER.length;
    } else if (data.startsWith(ALT_LEAVE, i)) {
      terminal.filterInAltScreen = false;
      result += ALT_LEAVE;
      i += ALT_LEAVE.length;
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
