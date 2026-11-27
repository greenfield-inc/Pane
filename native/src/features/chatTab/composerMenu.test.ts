import { describe, expect, it } from 'vitest';

import { CLOSED_MENU, menuAfterCaret, menuAfterEdit, type ComposerMenuState } from './composerMenu';

/** Types `text` one character at a time at the end of `from`. */
function type(text: string, from = '', state: ComposerMenuState = CLOSED_MENU): ComposerMenuState {
  let current = from;
  let next = state;
  for (const char of text) {
    next = menuAfterEdit(next, current, current + char);
    current += char;
  }
  return next;
}

describe('the composer menu', () => {
  it('opens as a word is typed, and a space closes it', () => {
    expect(type('see @comp').open).toMatchObject({ kind: 'file', query: 'comp', rangeStart: 4 });
    expect(type('see @comp ').open).toBeNull();
  });
  it('opens in the middle of a message', () => {
    expect(menuAfterEdit(CLOSED_MENU, 'fix  now', 'fix $ now').open).toMatchObject({ kind: 'skill', query: '', rangeStart: 4 });
  });
  it('stays closed for pasted text, and for typing on in the pasted word', () => {
    const pasted = menuAfterEdit(CLOSED_MENU, '', 'look at @src/a');
    expect(pasted.open).toBeNull();
    expect(type('b', 'look at @src/a', pasted).open).toBeNull();
    expect(type(' @b', 'look at @src/a', pasted).open).toMatchObject({ query: 'b' });
  });
  it('keeps an open menu when a suggestion replaces the word', () => {
    expect(menuAfterEdit(type('@com'), '@com', '@composer').open).toMatchObject({ query: 'composer' });
  });
  it('closes when the caret leaves the word, and moving back does not reopen it', () => {
    const left = menuAfterCaret(type('see @comp'), 'see @comp', 2);
    expect(left.open).toBeNull();
    expect(menuAfterCaret(left, 'see @comp', 9).open).toBeNull();
    expect(menuAfterEdit(left, 'see @comp', 'see @compo').open).toMatchObject({ query: 'compo' });
  });
});
