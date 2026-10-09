import { describe, expect, it } from 'vitest';
import {
  boundSanitizedLines,
  normalizeScrollbackBuffer,
  selectPanelScreenText,
} from './terminalScreenText';
import type { TerminalPanelSnapshot } from '../terminalPanelManager';
import type { TerminalPanelState } from '../../../../shared/types/panels';

function snapshot(overrides: Partial<TerminalPanelSnapshot> = {}): TerminalPanelSnapshot {
  // SAFETY: Only the buffer fields this module reads are exercised here.
  return {
    panelId: 'panel-1',
    sessionId: 'session-1',
    scrollbackBuffer: '',
    alternateScreenBuffer: '',
    isAlternateScreen: false,
    activityStatus: 'idle',
    lastActivityTime: '2026-08-20T00:00:00.000Z',
    currentCommand: '',
    ...overrides,
  } as TerminalPanelSnapshot;
}

describe('selectPanelScreenText', () => {
  it('prefers the live emulator viewport over either raw buffer', () => {
    const result = selectPanelScreenText(
      snapshot({ screenText: 'emulated', scrollbackBuffer: 'raw', alternateScreenBuffer: 'alt' }),
      {},
    );

    expect(result).toEqual({ source: 'scrollback', rawText: 'emulated' });
  });

  it('reports the emulator viewport as alternate screen when the agent is on one', () => {
    const result = selectPanelScreenText(
      snapshot({ screenText: 'emulated', isAlternateScreen: true }),
      {},
    );

    expect(result.source).toBe('alternateScreen');
  });

  it('falls back to the alternate-screen buffer before the scrollback', () => {
    const result = selectPanelScreenText(
      snapshot({ isAlternateScreen: true, alternateScreenBuffer: 'alt', scrollbackBuffer: 'raw' }),
      {},
    );

    expect(result).toEqual({ source: 'alternateScreen', rawText: 'alt' });
  });

  it('falls back to the scrollback buffer when no alternate screen is active', () => {
    const result = selectPanelScreenText(snapshot({ scrollbackBuffer: 'raw' }), {});

    expect(result).toEqual({ source: 'scrollback', rawText: 'raw' });
  });

  it('prefers the persisted screen text over the raw alternate-screen log', () => {
    const customState: TerminalPanelState = {
      isAlternateScreen: true,
      screenText: 'Name        Qty\nSprocket    5',
      alternateScreenBuffer: '\u001b[2J\u001b[HName\u001b[12GQty',
    };

    expect(selectPanelScreenText(null, customState)).toEqual({
      source: 'persistedOutput',
      rawText: 'Name        Qty\nSprocket    5',
    });
  });

  it('reads persisted state when the panel has no live terminal', () => {
    const customState: TerminalPanelState = {
      isAlternateScreen: true,
      screenText: undefined,
    };

    expect(selectPanelScreenText(null, customState, { alternate: 'stored alt', scrollback: null, serialized: null })).toEqual({
      source: 'persistedOutput',
      rawText: 'stored alt',
    });
  });

  it('reads the SQLite scrollback column without a live terminal', () => {
    expect(selectPanelScreenText(null, {}, { scrollback: 'one\ntwo', alternate: null, serialized: null })).toEqual({
      source: 'persistedOutput',
      rawText: 'one\ntwo',
    });
  });

  it('reports empty for a panel with neither a terminal nor persisted output', () => {
    expect(selectPanelScreenText(null, {})).toEqual({ source: 'empty', rawText: '' });
  });
});

describe('normalizeScrollbackBuffer', () => {
  it('passes a string through', () => {
    expect(normalizeScrollbackBuffer('text')).toBe('text');
  });

  it('joins an array with newlines', () => {
    expect(normalizeScrollbackBuffer(['a', 'b'])).toBe('a\nb');
  });

  it('returns empty for an absent buffer', () => {
    expect(normalizeScrollbackBuffer(undefined)).toBe('');
  });
});

describe('boundSanitizedLines', () => {
  it('strips ANSI and keeps every line when the text fits', () => {
    const result = boundSanitizedLines('[31mred[0m\nplain', 10);

    expect(result).toEqual({ text: 'red\nplain', hasMore: false, returnedLineCount: 2 });
  });

  it('keeps the last lines and flags the rest as more', () => {
    const result = boundSanitizedLines('one\ntwo\nthree\nfour', 2);

    expect(result).toEqual({ text: 'three\nfour', hasMore: true, returnedLineCount: 2 });
  });

  it('reports nothing for text that sanitizes away entirely', () => {
    expect(boundSanitizedLines('', 5)).toEqual({ text: '', hasMore: false, returnedLineCount: 0 });
  });
});
