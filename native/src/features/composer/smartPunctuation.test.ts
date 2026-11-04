import { describe, expect, it } from 'vitest';

import { straightenKeyboardEdit, straightenSmartPunctuation } from './smartPunctuation';

describe('straightenSmartPunctuation', () => {
  it('turns curly quotes back into the straight ones a shell reads', () => {
    expect(straightenSmartPunctuation('git commit -m “fix it” && echo ‘done’'))
      .toBe('git commit -m "fix it" && echo \'done\'');
  });

  it('keeps apostrophes straight', () => {
    expect(straightenSmartPunctuation('don’t')).toBe('don\'t');
  });

  it('turns the em dash iOS makes from two hyphens back into them', () => {
    expect(straightenSmartPunctuation('ls —all')).toBe('ls --all');
  });

  it('turns the ellipsis character back into three dots', () => {
    expect(straightenSmartPunctuation('git diff main…HEAD')).toBe('git diff main...HEAD');
  });

  it('returns plain text unchanged', () => {
    const text = 'fix the teh typo';
    expect(straightenSmartPunctuation(text)).toBe(text);
  });
});

describe('straightenKeyboardEdit', () => {
  it('straightens what the keyboard just typed', () => {
    expect(straightenKeyboardEdit('ls -', 'ls —')).toBe('ls --');
    expect(straightenKeyboardEdit('echo ', 'echo “')).toBe('echo "');
    expect(straightenKeyboardEdit('dont', 'don’t ')).toBe('don\'t ');
  });

  it('leaves pasted text alone when a later edit types elsewhere', () => {
    const pasted = 'Read /tmp/design—final.md';
    expect(straightenKeyboardEdit(pasted, `${pasted} x`)).toBe(`${pasted} x`);
    expect(straightenKeyboardEdit(`a ${pasted}`, `ab ${pasted}`)).toBe(`ab ${pasted}`);
  });

  it('keeps earlier literal quotes and ellipses when straightening a new one', () => {
    expect(straightenKeyboardEdit('say “hi” main…HEAD ', 'say “hi” main…HEAD “'))
      .toBe('say “hi” main…HEAD "');
  });

  it('handles a deletion without touching the rest', () => {
    expect(straightenKeyboardEdit('a—b c', 'a—b ')).toBe('a—b ');
  });
});
