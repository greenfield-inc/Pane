import type { PanelBuffers } from '../../database/panelBuffers';
import { sanitizeTerminalOutput } from '../../utils/terminalOutputSanitizer';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import type { TerminalPanelState } from '../../../../shared/types/panels';
import type { TerminalPanelSnapshot } from '../terminalPanelManager';
import type { RunpanePanelScreenSource } from '../../../../shared/types/runpaneOrchestration';

/**
 * Shared plain-text extraction for terminal panels.
 *
 * Two very different consumers need the same answer to "what does this
 * terminal currently show as text?": the RunPane CLI (`panels screen`) and the
 * Mission Control's snapshot tiles. Keeping one implementation means a fix to the
 * alternate-screen / persisted-buffer precedence benefits both.
 */

export function normalizeScrollbackBuffer(value: TerminalPanelState['scrollbackBuffer']): string {
  if (Array.isArray(value)) return value.join('\n');
  return decodeOptionalBoundary(value, boundary.string) ?? '';
}

export interface PanelScreenText {
  source: RunpanePanelScreenSource;
  rawText: string;
}

/**
 * Pick the best available text for a panel, preferring the live emulator's
 * viewport and falling back to persisted buffers for panels with no PTY.
 */
export function selectPanelScreenText(
  snapshot: TerminalPanelSnapshot | null,
  customState: TerminalPanelState,
  persisted: PanelBuffers | null = null,
): PanelScreenText {
  if (snapshot) {
    if (snapshot.screenText !== undefined) {
      return {
        source: snapshot.isAlternateScreen ? 'alternateScreen' : 'scrollback',
        rawText: snapshot.screenText,
      };
    }
    if (snapshot.isAlternateScreen && snapshot.alternateScreenBuffer) {
      return { source: 'alternateScreen', rawText: snapshot.alternateScreenBuffer };
    }
    if (snapshot.scrollbackBuffer) {
      return { source: 'scrollback', rawText: snapshot.scrollbackBuffer };
    }
    return { source: 'empty', rawText: '' };
  }

  // The emulator's own text first: it is already laid out. The raw buffers below
  // are a byte log, and a full-screen TUI paints those with absolute cursor
  // positioning, so stripping their escapes runs every word together.
  const persistedScreenText = customState.screenText;
  if (persistedScreenText) {
    return { source: 'persistedOutput', rawText: persistedScreenText };
  }

  const persistedAlternate = persisted?.alternate;
  if (customState.isAlternateScreen && persistedAlternate) {
    return { source: 'persistedOutput', rawText: persistedAlternate };
  }

  const persistedScrollback = persisted?.scrollback;
  if (persistedScrollback) {
    return { source: 'persistedOutput', rawText: persistedScrollback };
  }

  return { source: 'empty', rawText: '' };
}


export interface BoundedSanitizedLines {
  text: string;
  hasMore: boolean;
  returnedLineCount: number;
}

/** Strip ANSI and keep at most the last `limit` lines. */
export function boundSanitizedLines(rawText: string, limit: number): BoundedSanitizedLines {
  // Trim to the tail before stripping. Sanitizing is nine full-string passes,
  // and a caller asking for the last 16 lines of a 500KB scrollback would
  // otherwise pay for all of it. Escape sequences never span a newline, so
  // cutting on line boundaries cannot split one. The extra headroom keeps
  // lines that sanitize away from eating into the limit.
  const rawLines = rawText.split('\n');
  const tail = rawLines.length > limit * 4 ? rawLines.slice(-limit * 4).join('\n') : rawText;
  const stripped = sanitizeTerminalOutput(tail);
  if (!stripped) {
    return { text: '', hasMore: false, returnedLineCount: 0 };
  }

  const allLines = stripped.split('\n');
  const hasMore = allLines.length > limit || rawLines.length > allLines.length;
  const lines = allLines.length > limit ? allLines.slice(-limit) : allLines;
  return {
    text: lines.join('\n'),
    hasMore,
    returnedLineCount: lines.length,
  };
}
