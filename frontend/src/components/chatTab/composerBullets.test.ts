import { describe, expect, it } from 'vitest';
import { applyBulletEdit, bulletKey } from './composerBullets';

/** Presses a key with the caret (or selection) marked by | (or [ and ]) in the text; returns the result the same way. */
function press(marked: string, key: 'Enter' | 'Tab', shift = false): string | undefined {
  const collapsed = marked.indexOf('|');
  const start = collapsed >= 0 ? collapsed : marked.indexOf('[');
  const end = collapsed >= 0 ? collapsed : marked.indexOf(']') - 1;
  const text = marked.replace(/[|[\]]/g, '');
  const edit = bulletKey(text, start, end, key, shift);
  if (!edit) return undefined;
  const next = applyBulletEdit(text, edit);
  return edit.selectionStart === edit.selectionEnd
    ? next.slice(0, edit.selectionStart) + '|' + next.slice(edit.selectionStart)
    : next.slice(0, edit.selectionStart) + '[' + next.slice(edit.selectionStart, edit.selectionEnd) + ']' + next.slice(edit.selectionEnd);
}

describe('bullet lists in the chat input', () => {
  it('Enter on a bullet starts the next bullet', () => {
    expect(press('Notes:\n- first|', 'Enter')).toBe('Notes:\n- first\n- |');
  });

  it('Enter keeps the bullet marker and its indent', () => {
    expect(press('- a\n  * nested|', 'Enter')).toBe('- a\n  * nested\n  * |');
  });

  it('Enter in the middle of a bullet moves the rest of the line to the new bullet', () => {
    expect(press('- one| two', 'Enter')).toBe('- one\n- |two');
  });

  it('Enter on an empty bullet ends the list, leaving an empty line', () => {
    expect(press('- a\n- |', 'Enter')).toBe('- a\n|');
    expect(press('- a\n  - |', 'Enter')).toBe('- a\n|');
  });

  it('Enter outside a list is left alone, so it still sends', () => {
    expect(press('hello|', 'Enter')).toBeUndefined();
    expect(press('- a\nplain text|', 'Enter')).toBeUndefined();
    expect(press('-not a bullet|', 'Enter')).toBeUndefined();
    expect(press('', 'Enter')).toBeUndefined();
  });

  it('Enter with a selection is left alone', () => {
    expect(press('- [one]', 'Enter')).toBeUndefined();
  });

  it('Enter with the caret before the marker inserts a plain line break', () => {
    expect(press('|- a', 'Enter')).toBe('\n|- a');
  });

  it('Tab indents the bullet line by two spaces, keeping the caret in its text', () => {
    expect(press('- a\n- b|c', 'Tab')).toBe('- a\n  - b|c');
  });

  it('Shift-Tab outdents by up to two spaces', () => {
    expect(press('- a\n    - b|', 'Tab', true)).toBe('- a\n  - b|');
    expect(press('- a\n - b|', 'Tab', true)).toBe('- a\n- b|');
  });

  it('Shift-Tab on an unindented bullet changes nothing but still keeps focus in the input', () => {
    expect(press('- a|', 'Tab', true)).toBe('- a|');
  });

  it('Tab indents every bullet line in a selection', () => {
    expect(press('- [a\n- b]', 'Tab')).toBe('  - [a\n  - b]');
  });

  it('Tab off a bullet is left alone, so focus moves as usual', () => {
    expect(press('hello|', 'Tab')).toBeUndefined();
    expect(press('[- a\nplain]', 'Tab')).toBeUndefined();
  });
});
