import { afterEach, describe, expect, it } from 'vitest';
import {
  forgetHistorySelections,
  isHistoryRowSelected,
  recallHistorySelection,
  rememberHistorySelection,
  selectHistoryRow,
  type HistorySelection,
} from './gitHistorySelection';

// Newest first, as the history graph lists them: the uncommitted row, then commits c3 (newest) to c1 (oldest).
const hashes = ['index', 'c3', 'c2', 'c1'];
const single = (hash: string): HistorySelection => ({ anchor: hash, olderHash: hash, newerHash: hash });

describe('selectHistoryRow', () => {
  it('selects one row and anchors there on a plain click', () => {
    expect(selectHistoryRow(hashes, null, 'c2', false)).toEqual(single('c2'));
  });

  it('spans from an older anchor up to a newer shift-clicked commit', () => {
    expect(selectHistoryRow(hashes, single('c1'), 'c3', true)).toEqual({ anchor: 'c1', olderHash: 'c1', newerHash: 'c3' });
  });

  it('orders a shift-click below the anchor oldest first', () => {
    expect(selectHistoryRow(hashes, single('c3'), 'c1', true)).toEqual({ anchor: 'c3', olderHash: 'c1', newerHash: 'c3' });
  });

  it('makes the uncommitted row the newer end of a shift-click range', () => {
    expect(selectHistoryRow(hashes, single('c2'), 'index', true)).toEqual({ anchor: 'c2', olderHash: 'c2', newerHash: 'index' });
    expect(selectHistoryRow(hashes, single('index'), 'c1', true)).toEqual({ anchor: 'index', olderHash: 'c1', newerHash: 'index' });
  });

  it('keeps the anchor across shift-clicks and moves it on a plain click', () => {
    const range = selectHistoryRow(hashes, single('c2'), 'c3', true);
    expect(selectHistoryRow(hashes, range, 'c1', true)).toEqual({ anchor: 'c2', olderHash: 'c1', newerHash: 'c2' });

    const reset = selectHistoryRow(hashes, range, 'c1', false);
    expect(reset).toEqual(single('c1'));
    expect(selectHistoryRow(hashes, reset, 'c3', true)).toEqual({ anchor: 'c1', olderHash: 'c1', newerHash: 'c3' });
  });

  it('falls back to a single row without a usable anchor', () => {
    expect(selectHistoryRow(hashes, null, 'c3', true)).toEqual(single('c3'));
    expect(selectHistoryRow(hashes, single('gone'), 'c3', true)).toEqual(single('c3'));
    expect(selectHistoryRow(hashes, single('c3'), 'c3', true)).toEqual(single('c3'));
  });
});

describe('isHistoryRowSelected', () => {
  it('marks every row between the ends, both included', () => {
    const range = { anchor: 'c1', olderHash: 'c1', newerHash: 'c3' };
    expect(hashes.map((_, i) => isHistoryRowSelected(hashes, range, i))).toEqual([false, true, true, true]);
  });

  it('marks nothing without a selection or once an end has left the graph', () => {
    expect(hashes.map((_, i) => isHistoryRowSelected(hashes, null, i))).toEqual([false, false, false, false]);
    const stale = { anchor: 'c2', olderHash: 'gone', newerHash: 'c2' };
    expect(hashes.map((_, i) => isHistoryRowSelected(hashes, stale, i))).toEqual([false, false, false, false]);
  });
});

describe('remembered history selection', () => {
  afterEach(() => forgetHistorySelections());

  it('keeps each session\'s selection while the Details history is unmounted', () => {
    rememberHistorySelection('session-a', single('c2'));
    expect(recallHistorySelection('session-a')).toEqual(single('c2'));
    expect(recallHistorySelection('session-b')).toBeNull();
  });
});
