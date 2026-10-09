import { describe, expect, it } from 'vitest';

import { filterShortcuts, freeLetter, shortcutProblems } from './shortcuts';

const rootCause = { id: '1', label: 'Root cause or symptom?', key: 'e', text: 'Think hard: is this the root cause or a symptom?', enabled: true };
const review = { id: '2', label: 'Codex review loop', key: 'r', text: 'Prepare a PR once done with changes.', enabled: true };
const release = { id: '3', label: 'Review and release loop', key: 's', text: 'Prepare a PR once done, then release.', enabled: false };

describe('filterShortcuts', () => {
  it('matches the name or the text, ignoring case, and hides disabled ones', () => {
    expect(filterShortcuts([rootCause, review, release], 'ROOT')).toEqual([rootCause]);
    expect(filterShortcuts([rootCause, review, release], 'prepare')).toEqual([review]);
    expect(filterShortcuts([rootCause, review, release], '')).toEqual([rootCause, review]);
  });

  it('needs every word, in any order', () => {
    expect(filterShortcuts([rootCause, review], 'symptom think')).toEqual([rootCause]);
    expect(filterShortcuts([rootCause, review], 'symptom codex')).toEqual([]);
  });
});

describe('shortcutProblems', () => {
  it('accepts a complete shortcut on a free letter', () => {
    expect(shortcutProblems({ ...review, id: 'new', key: 'a' }, [rootCause, review])).toEqual({});
  });

  it('names each missing field', () => {
    expect(shortcutProblems({ id: 'new', label: ' ', key: '', text: '', enabled: true }, [])).toEqual({
      label: 'Add a name',
      text: 'Add the text to insert',
      key: 'Pick a letter from A to Z',
    });
  });

  it('refuses a letter another enabled shortcut uses, unless one of them is off', () => {
    expect(shortcutProblems({ ...review, id: 'new', key: 'e' }, [rootCause]).key).toBe('E is taken by another shortcut');
    expect(shortcutProblems({ ...review, id: 'new', key: 'e', enabled: false }, [rootCause])).toEqual({});
    expect(shortcutProblems({ ...review, id: 'new', key: 's' }, [release])).toEqual({});
  });
});

describe('freeLetter', () => {
  it('skips letters enabled shortcuts use', () => {
    expect(freeLetter([{ ...rootCause, key: 'a' }, { ...review, key: 'b' }, { ...release, key: 'c' }])).toBe('c');
  });
});
