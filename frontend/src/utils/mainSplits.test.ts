import { describe, expect, it } from 'vitest';
import { MAIN_AREA, MAX_MAIN_SPLITS, NO_SPLIT_AREA, canOpenSplit } from './mainSplits';

describe('the main content area’s split rule (D-448)', () => {
  it('allows at most two splits', () => {
    expect(MAX_MAIN_SPLITS).toBe(2);
  });

  it('the full To-dos page: the to-do page and one file are the two splits, and a third is refused', () => {
    expect(canOpenSplit(MAIN_AREA, 1)).toBe(true);
    expect(canOpenSplit(MAIN_AREA, 2)).toBe(false);
  });

  it('a to-do already in one of the two splits (a Session’s chat beside it) never splits further', () => {
    expect(canOpenSplit({ max: MAX_MAIN_SPLITS, shown: 1 }, 1)).toBe(false);
  });

  it('an area with no split views (a Session’s split, a sidebar, an iPad) refuses any split', () => {
    expect(canOpenSplit(NO_SPLIT_AREA, 1)).toBe(false);
    expect(canOpenSplit(NO_SPLIT_AREA, 0)).toBe(true);
  });
});
