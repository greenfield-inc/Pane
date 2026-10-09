import { describe, expect, it } from 'vitest';
import { applyTerminalInput, sessionNameFromMessage } from './sessionAutoName';

describe('sessionNameFromMessage', () => {
  it('keeps a short message as typed', () => {
    expect(sessionNameFromMessage('fix the flaky checkout test please')).toBe('fix the flaky checkout test please');
  });

  it('uses the first non-empty line and collapses whitespace', () => {
    expect(sessionNameFromMessage('\n  add   dark mode\tto settings  \nmore detail here')).toBe('add dark mode to settings');
  });

  it('cuts long messages on a word boundary and drops trailing punctuation', () => {
    expect(sessionNameFromMessage('Investigate why the release workflow, the one on main, fails on Windows'))
      .toBe('Investigate why the release workflow');
    expect(sessionNameFromMessage('Why does the login page crash?')).toBe('Why does the login page crash');
  });

  it('cuts a single long word at 40 characters', () => {
    expect(sessionNameFromMessage('a'.repeat(50))).toBe('a'.repeat(40));
  });

  it('gives no name for slash commands, menu choices and symbols', () => {
    expect(sessionNameFromMessage('/model opus')).toBeUndefined();
    expect(sessionNameFromMessage('1')).toBeUndefined();
    expect(sessionNameFromMessage('   ')).toBeUndefined();
    expect(sessionNameFromMessage('123 456')).toBeUndefined();
  });
});

describe('applyTerminalInput', () => {
  it('collects keystrokes until Enter', () => {
    const typed = applyTerminalInput('', 'fix');
    expect(typed).toEqual({ draft: 'fix', submitted: [] });
    expect(applyTerminalInput(typed.draft, ' it\r')).toEqual({ draft: '', submitted: ['fix it'] });
  });

  it('applies Backspace and Ctrl-U', () => {
    expect(applyTerminalInput('', 'fox\x7f\x7fix\r')).toEqual({ draft: '', submitted: ['fix'] });
    expect(applyTerminalInput('', 'oops\x15hello\r')).toEqual({ draft: '', submitted: ['hello'] });
  });

  it('submits no text for a line edited with cursor keys, until the next clean line', () => {
    // The composer would send "fix cuts"; replaying at the end would give "fix catu".
    const edited = applyTerminalInput('', 'fix cats\x1b[D\x1b[D\x7fu');
    expect(edited.draft).toBeNull();
    expect(applyTerminalInput(edited.draft, '\rnext message\r')).toEqual({ draft: '', submitted: ['next message'] });
    expect(applyTerminalInput('', 'fix\x1b[3~ it\r').submitted).toEqual([]);
    expect(applyTerminalInput('', 'oops\x1b[H\x15hello\r').submitted).toEqual(['hello']);
  });

  it('ignores focus reports', () => {
    expect(applyTerminalInput('', 'fix\x1b[O\x1b[I it\r')).toEqual({ draft: '', submitted: ['fix it'] });
  });

  it('reads a bracketed paste with ESC CR newlines as one message', () => {
    expect(applyTerminalInput('', '\x1b[200~first line\x1b\rsecond\x1b[201~\r'))
      .toEqual({ draft: '', submitted: ['first line\nsecond'] });
  });

  it('keeps CR newlines inside a bracketed paste in the draft', () => {
    expect(applyTerminalInput('', '\x1b[200~first line\rsecond line\r\nthird\x1b[201~'))
      .toEqual({ draft: 'first line\nsecond line\nthird', submitted: [] });
  });

  it('keeps the start of a draft longer than 4000 characters', () => {
    const { draft } = applyTerminalInput('', `fix the build ${'x'.repeat(5_000)}`);
    expect(draft).toHaveLength(4_000);
    expect(draft.startsWith('fix the build ')).toBe(true);
  });
});
