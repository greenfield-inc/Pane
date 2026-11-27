/*
 * Adapted from T3 Code (https://github.com/pingdotgg/t3code, commit 2808e878d), packages/shared/src/searchRanking.test.ts.
 *
 * MIT License
 *
 * Copyright (c) 2026 T3 Tools Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { describe, expect, it } from 'vitest';

import {
  insertRankedSearchResult,
  scoreQueryMatch,
  scoreSubsequenceMatch,
} from '../../../../shared/searchRanking';

describe('scoreQueryMatch', () => {
  it('treats boundary matches as stronger than generic contains matches', () => {
    const boundaryScore = scoreQueryMatch({
      value: 'gh-fix-ci',
      query: 'fix',
      exactBase: 0,
      prefixBase: 10,
      boundaryBase: 20,
      includesBase: 30,
      boundaryMarkers: ['-'],
    });
    const containsScore = scoreQueryMatch({
      value: 'highfixci',
      query: 'fix',
      exactBase: 0,
      prefixBase: 10,
      boundaryBase: 20,
      includesBase: 30,
      boundaryMarkers: ['-'],
    });

    expect(boundaryScore).not.toBeNull();
    expect(containsScore).not.toBeNull();
    expect(boundaryScore!).toBeLessThan(containsScore!);
  });
});

describe('scoreSubsequenceMatch', () => {
  it('scores tighter subsequences ahead of looser ones', () => {
    const compact = scoreSubsequenceMatch('ghfixci', 'gfc');
    const spread = scoreSubsequenceMatch('github-fix-ci', 'gfc');

    expect(compact).not.toBeNull();
    expect(spread).not.toBeNull();
    expect(compact!).toBeLessThan(spread!);
  });
});

describe('insertRankedSearchResult', () => {
  it('keeps the best-ranked candidates within the limit', () => {
    const ranked = [
      { item: 'b', score: 20, tieBreaker: 'b' },
      { item: 'd', score: 40, tieBreaker: 'd' },
    ];

    insertRankedSearchResult(ranked, { item: 'a', score: 10, tieBreaker: 'a' }, 2);
    insertRankedSearchResult(ranked, { item: 'c', score: 30, tieBreaker: 'c' }, 2);

    expect(ranked.map((entry) => entry.item)).toEqual(['a', 'b']);
  });
});
