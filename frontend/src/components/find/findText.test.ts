import { describe, expect, it } from 'vitest';
import { countOccurrences, findInSegments, stepMatchIndex } from './findText';

describe('findInSegments', () => {
  it('finds a word that spans inline elements, ignoring case', () => {
    // "Hello **Wor**ld" renders as three text nodes in one paragraph.
    const matches = findInSegments([
      { text: 'Hello ', breakBefore: false },
      { text: 'Wor', breakBefore: false },
      { text: 'ld again, world', breakBefore: false },
    ], 'WORLD');

    expect(matches).toEqual([
      { start: { segment: 1, offset: 0 }, end: { segment: 2, offset: 2 } },
      { start: { segment: 2, offset: 10 }, end: { segment: 2, offset: 15 } },
    ]);
  });

  it('does not join text across block boundaries', () => {
    const matches = findInSegments([
      { text: 'needle in a heading foo', breakBefore: false },
      { text: 'bar needle in a paragraph', breakBefore: true },
    ], 'foobar');

    expect(matches).toEqual([]);
  });

  it('counts heading, paragraph and code block hits separately', () => {
    const matches = findInSegments([
      { text: 'Install', breakBefore: false },
      { text: 'Run install first.', breakBefore: true },
      { text: 'pnpm install', breakBefore: true },
    ], 'install');

    expect(matches.map(match => match.start)).toEqual([
      { segment: 0, offset: 0 },
      { segment: 1, offset: 4 },
      { segment: 2, offset: 5 },
    ]);
  });

  it('returns no matches for an empty query', () => {
    expect(findInSegments([{ text: 'anything', breakBefore: false }], '')).toEqual([]);
  });

  it('does not count overlapping matches twice', () => {
    expect(findInSegments([{ text: 'aaaa', breakBefore: false }], 'aa')).toHaveLength(2);
  });
});

describe('countOccurrences', () => {
  it('counts every occurrence on a line, not just the line', () => {
    expect(countOccurrences('error: retry after error', 'ERROR')).toBe(2);
    expect(countOccurrences('nothing here', 'error')).toBe(0);
  });
});

describe('stepMatchIndex', () => {
  it('wraps from the last match to the first and back', () => {
    expect(stepMatchIndex(12, 12, 'next')).toBe(1);
    expect(stepMatchIndex(1, 12, 'prev')).toBe(12);
    expect(stepMatchIndex(3, 12, 'next')).toBe(4);
  });

  it('stays at zero when nothing matched', () => {
    expect(stepMatchIndex(0, 0, 'next')).toBe(0);
  });
});
