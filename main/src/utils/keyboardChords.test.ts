import { describe, expect, it } from 'vitest';
import {
  chordFromElectronInput,
  chordFromKeyboardEvent,
  parseChord,
} from '../../../shared/utils/keyboardChords';

const domEvent = (overrides: Partial<Parameters<typeof chordFromKeyboardEvent>[0]> = {}) => ({
  key: 'a', code: 'KeyA', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false,
  getModifierState: () => false,
  ...overrides,
});

describe('keyboard chord grammar', () => {
  it.each([
    ['MOD+SHIFT+p', 'mod+shift+p'],
    ['mod+shift+a', 'mod+shift+a'],
    ['shift+arrowup', 'shift+ArrowUp'],
    ['alt+mod+\\', 'mod+alt+\\'],
  ])('canonicalizes %s', (input, expected) => {
    expect(parseChord(input)).toEqual({ ok: true, chord: expected });
  });

  it.each([
    ['', 'empty'],
    ['mod', 'modifier-only'],
    ['a', 'bare-printable'],
    ['shift+a', 'bare-printable'],
    ['alt+a', 'bare-printable'],
    ['mod+Hyper+a', 'unknown-modifier'],
  ])('rejects %s', (input, reason) => {
    expect(parseChord(input)).toEqual({ ok: false, reason });
  });

  it('normalizes shifted digits, backslash, Option letters, and AltGr safely', () => {
    expect(chordFromKeyboardEvent(domEvent({ key: '@', code: 'Digit2', shiftKey: true }))).toBe('mod+shift+2');
    expect(chordFromKeyboardEvent(domEvent({ key: '|', code: 'IntlBackslash', shiftKey: true }))).toBe('mod+shift+\\');
    expect(chordFromKeyboardEvent(domEvent({ key: 'å', code: 'KeyA', altKey: true }))).toBe('mod+alt+a');
    expect(chordFromKeyboardEvent(domEvent({ altKey: true, getModifierState: key => key === 'AltGraph' }))).toBe('');
  });

  it('keeps DOM and Electron adapters aligned for ordinary physical presses', () => {
    const dom = domEvent({ key: '!', code: 'Digit1', altKey: true, shiftKey: true });
    expect(chordFromKeyboardEvent(dom)).toBe(chordFromElectronInput({
      key: dom.key, code: dom.code, control: dom.ctrlKey, meta: dom.metaKey,
      alt: dom.altKey, shift: dom.shiftKey,
    }));
  });

  it('normalizes a physical Space key to the grammar named key', () => {
    const parsed = parseChord('mod+space');
    expect(parsed).toEqual({ ok: true, chord: 'mod+Space' });
    expect(chordFromKeyboardEvent(domEvent({ key: ' ', code: 'Space' }))).toBe('mod+Space');
    expect(chordFromElectronInput({
      key: ' ', code: 'Space', control: true, meta: false, alt: false, shift: false,
    })).toBe('mod+Space');
  });
});
