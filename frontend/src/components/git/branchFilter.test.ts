import { describe, it, expect } from 'vitest';
import { filterBranches } from './branchFilter';

describe('filterBranches', () => {
  const branches = [
    'main',
    'develop',
    'feature/maintenance-window',
    'fix/main-thread-hang',
    'release/2.4',
    'main-3',
  ];

  it('shows everything up to the limit when nothing is typed', () => {
    expect(filterBranches(branches, '')).toEqual(branches);
    expect(filterBranches(branches, '   ')).toEqual(branches);
    expect(filterBranches(branches, '', 2)).toEqual(['main', 'develop']);
  });

  it('puts the exact match first, then prefixes, then the rest', () => {
    // The bug this replaced: a native datalist filtered "main" down to
    // main-3/main-4 and hid every other branch entirely.
    expect(filterBranches(branches, 'main')).toEqual([
      'main',
      'main-3',
      // Both of these match right after a "/", so they keep their input order.
      'feature/maintenance-window',
      'fix/main-thread-hang',
    ]);
  });

  it('treats a match after a separator as a prefix', () => {
    expect(filterBranches(branches, 'thread')).toEqual(['fix/main-thread-hang']);
    expect(filterBranches(['a/beta', 'alphabeta'], 'beta')).toEqual(['a/beta', 'alphabeta']);
  });

  it('ignores case and keeps the incoming order within a rank', () => {
    expect(filterBranches(branches, 'RELEASE')).toEqual(['release/2.4']);
    expect(filterBranches(['b-x', 'a-x'], 'x')).toEqual(['b-x', 'a-x']);
  });

  it('returns nothing when there is no match', () => {
    expect(filterBranches(branches, 'nope')).toEqual([]);
  });
});
