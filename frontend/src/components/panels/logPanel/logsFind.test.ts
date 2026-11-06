import { describe, expect, it } from 'vitest';
import { findLogOccurrences, splitLineByQuery, stripAnsi } from './logsFind';

describe('findLogOccurrences', () => {
  it('counts a word twice when it appears twice on one line', () => {
    const occurrences = findLogOccurrences(['retry after error, error again', 'ok', 'ERROR'], 'error');
    expect(occurrences).toEqual([
      { line: 0, start: 12 },
      { line: 0, start: 19 },
      { line: 2, start: 0 },
    ]);
  });

  it('matches the text a person sees, not ANSI colour codes', () => {
    expect(findLogOccurrences(['\x1b[31merror\x1b[0m: 31m'], '31m')).toEqual([{ line: 0, start: 7 }]);
  });
});

describe('splitLineByQuery', () => {
  it('splits a line into plain text and hits', () => {
    expect(splitLineByQuery('a needle and a Needle', 'needle')).toEqual([
      { text: 'a ', hit: false },
      { text: 'needle', hit: true },
      { text: ' and a ', hit: false },
      { text: 'Needle', hit: true },
    ]);
  });
});

describe('stripAnsi', () => {
  it('removes colour and OSC sequences', () => {
    expect(stripAnsi('\x1b[1;32mok\x1b[0m \x1b]0;title\x07done')).toBe('ok done');
  });
});
