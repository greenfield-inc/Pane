import { describe, expect, it } from 'vitest';
import { endRange, keepFocused, rangeHolds, remapRange, visibleRange } from './turnWindow';

// Ten turns of 100 px: turn n spans [100n, 100n + 100).
const tens = Array.from({ length: 10 }, () => 100);

describe('visibleRange', () => {
  it('renders the turns that cross the viewport, and overscan past each edge', () => {
    expect(visibleRange(tens, 250, 200, 0)).toEqual({ start: 2, end: 5 });
    expect(visibleRange(tens, 250, 200, 100)).toEqual({ start: 1, end: 6 });
  });

  it('stops at the list ends', () => {
    expect(visibleRange(tens, 0, 300, 1000)).toEqual({ start: 0, end: 10 });
    expect(visibleRange(tens, 900, 300, 0)).toEqual({ start: 9, end: 10 });
  });

  it('keeps one turn when the viewport is above or below the list', () => {
    expect(visibleRange(tens, -500, 100, 0)).toEqual({ start: 0, end: 1 });
    expect(visibleRange(tens, 5000, 100, 0)).toEqual({ start: 9, end: 10 });
  });

  it('is empty for an empty list', () => {
    expect(visibleRange([], 0, 500)).toEqual({ start: 0, end: 0 });
  });
});

describe('endRange', () => {
  it('takes turns from the end until the viewport and overscan are full', () => {
    expect(endRange(tens, 250, 0)).toEqual({ start: 7, end: 10 });
    expect(endRange(tens, 250, 100)).toEqual({ start: 6, end: 10 });
    expect(endRange(tens, 5000, 0)).toEqual({ start: 0, end: 10 });
  });
});

describe('rangeHolds', () => {
  it('holds while the rendered turns still cover the viewport', () => {
    expect(rangeHolds({ start: 1, end: 6 }, { start: 2, end: 5 }, { start: 1, end: 6 })).toBe(true);
    expect(rangeHolds({ start: 3, end: 6 }, { start: 2, end: 5 }, { start: 1, end: 6 })).toBe(false);
  });

  it('lets go of a range far larger than wanted (find closed after rendering every turn)', () => {
    expect(rangeHolds({ start: 0, end: 200 }, { start: 100, end: 102 }, { start: 98, end: 104 })).toBe(false);
  });
});

describe('remapRange', () => {
  it('keeps the same turns rendered when a page loads above them', () => {
    expect(remapRange(['c', 'd', 'e'], { start: 1, end: 3 }, ['a', 'b', 'c', 'd', 'e'])).toEqual({ start: 3, end: 5 });
  });

  it('keeps them when the window trims turns off its start', () => {
    expect(remapRange(['a', 'b', 'c', 'd'], { start: 2, end: 3 }, ['c', 'd', 'e'])).toEqual({ start: 0, end: 1 });
  });

  it('widens by one at an edge whose turn was renamed (an earlier page merged into it)', () => {
    // "turn:start:m5" became "turn:m4" once the page with m4 loaded; it is the turn just before c.
    expect(remapRange(['turn:start:m5', 'c', 'd'], { start: 0, end: 2 }, ['a', 'turn:m4', 'c', 'd'])).toEqual({ start: 1, end: 3 });
  });

  it('keeps reaching the last turn when a turn arrives at the live end', () => {
    expect(remapRange(['a', 'b', 'c'], { start: 1, end: 3 }, ['a', 'b', 'c', 'd'])).toEqual({ start: 1, end: 4 });
    expect(remapRange(['a', 'b', 'c'], { start: 0, end: 2 }, ['a', 'b', 'c', 'd'])).toEqual({ start: 0, end: 2 });
  });

  it('is null when none of the rendered turns is left (jumped to the latest window)', () => {
    expect(remapRange(['a', 'b'], { start: 0, end: 2 }, ['x', 'y'])).toBeNull();
  });
});

describe('keepFocused', () => {
  it('widens the range to the focused turn, above or below', () => {
    expect(keepFocused({ start: 10, end: 15 }, 4)).toEqual({ start: 4, end: 15 });
    expect(keepFocused({ start: 10, end: 15 }, 20)).toEqual({ start: 10, end: 21 });
  });

  it('leaves the range alone with no focused turn, or one already in it', () => {
    expect(keepFocused({ start: 10, end: 15 }, undefined)).toEqual({ start: 10, end: 15 });
    expect(keepFocused({ start: 10, end: 15 }, 12)).toEqual({ start: 10, end: 15 });
  });
});
