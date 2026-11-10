import { describe, expect, it } from 'vitest';
import {
  chordForPlatform,
  chordFromElectronInput,
  chordFromKeyboardEvent,
  parseChord,
} from '../../../shared/utils/keyboardChords';

const domEvent = (overrides: Partial<Parameters<typeof chordFromKeyboardEvent>[0]> = {}) => ({
  key: 'a', code: 'KeyA', ctrlKey: false, metaKey: true, altKey: false, shiftKey: false,
  getModifierState: () => false,
  ...overrides,
});

describe('keyboard chord grammar', () => {
  it.each([
    ['MOD+SHIFT+p', 'mod+shift+p'],
    ['mod+shift+a', 'mod+shift+a'],
    ['shift+arrowup', 'shift+ArrowUp'],
    ['alt+mod+\\', 'mod+alt+\\'],
    ['ctrl+mod+]', 'mod+ctrl+]'],
    ['ctrl+`', 'ctrl+`'],
    ['f6', 'F6'],
    ['shift+F6', 'shift+F6'],
    ['mod+k  mod+M', 'mod+k mod+m'],
    ['ctrl+shift+space', 'ctrl+shift+Space'],
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
    ['mod+k mod+s mod+x', 'too-many-steps'],
    ['F6 mod+s', 'bare-first-step'],
    ['mod+k a', 'bare-printable'],
  ])('rejects %s', (input, reason) => {
    expect(parseChord(input)).toEqual({ ok: false, reason });
  });

  it('keeps Command and Control apart on macOS', () => {
    expect(chordFromKeyboardEvent(domEvent({ key: 'b', code: 'KeyB' }), 'mac')).toBe('mod+b');
    expect(chordFromKeyboardEvent(domEvent({ key: 'b', code: 'KeyB', metaKey: false, ctrlKey: true }), 'mac')).toBe('ctrl+b');
    expect(chordFromKeyboardEvent(domEvent({ key: ']', code: 'BracketRight', ctrlKey: true }), 'mac')).toBe('mod+ctrl+]');
  });

  it('treats Control as mod off macOS and ignores the Windows key', () => {
    expect(chordFromKeyboardEvent(domEvent({ key: 'b', code: 'KeyB', metaKey: false, ctrlKey: true }), 'other')).toBe('mod+b');
    expect(chordFromKeyboardEvent(domEvent({ key: 'b', code: 'KeyB' }), 'other')).toBe('');
  });

  it('folds ctrl into mod off macOS', () => {
    expect(chordForPlatform('ctrl+`', 'other')).toBe('mod+`');
    expect(chordForPlatform('mod+ctrl+]', 'other')).toBe('mod+]');
    expect(chordForPlatform('ctrl+`', 'mac')).toBe('ctrl+`');
    expect(chordForPlatform('mod+k ctrl+s', 'other')).toBe('mod+k mod+s');
  });

  it('normalizes shifted digits and punctuation, backslash, Option letters, and AltGr safely', () => {
    expect(chordFromKeyboardEvent(domEvent({ key: '@', code: 'Digit2', shiftKey: true }), 'mac')).toBe('mod+shift+2');
    expect(chordFromKeyboardEvent(domEvent({ key: '{', code: 'BracketLeft', shiftKey: true }), 'mac')).toBe('mod+shift+[');
    expect(chordFromKeyboardEvent(domEvent({ key: '|', code: 'IntlBackslash', shiftKey: true }), 'mac')).toBe('mod+shift+\\');
    expect(chordFromKeyboardEvent(domEvent({ key: 'å', code: 'KeyA', altKey: true }), 'mac')).toBe('mod+alt+a');
    expect(chordFromKeyboardEvent(domEvent({ key: 'P', code: 'KeyR', shiftKey: true }), 'mac')).toBe('mod+shift+p');
    expect(chordFromKeyboardEvent(domEvent({ altKey: true, getModifierState: key => key === 'AltGraph' }), 'mac')).toBe('');
  });

  it('returns no chord for a modifier going down', () => {
    expect(chordFromKeyboardEvent(domEvent({ key: 'Meta', code: 'MetaLeft' }), 'mac')).toBe('');
  });

  it('keeps DOM and Electron adapters aligned for ordinary physical presses', () => {
    const dom = domEvent({ key: '!', code: 'Digit1', altKey: true, shiftKey: true });
    expect(chordFromKeyboardEvent(dom, 'mac')).toBe(chordFromElectronInput({
      key: dom.key, code: dom.code, control: dom.ctrlKey, meta: dom.metaKey,
      alt: dom.altKey, shift: dom.shiftKey,
    }, 'mac'));
  });

  it('normalizes a physical Space key to the grammar named key', () => {
    expect(parseChord('mod+space')).toEqual({ ok: true, chord: 'mod+Space' });
    expect(chordFromKeyboardEvent(domEvent({ key: ' ', code: 'Space' }), 'mac')).toBe('mod+Space');
    expect(chordFromElectronInput({
      key: ' ', code: 'Space', control: true, meta: false, alt: false, shift: false,
    }, 'other')).toBe('mod+Space');
  });

  it('names bare function keys', () => {
    expect(chordFromKeyboardEvent(domEvent({ key: 'F6', code: 'F6', metaKey: false }), 'mac')).toBe('F6');
    expect(chordFromKeyboardEvent(domEvent({ key: 'F6', code: 'F6', metaKey: false, shiftKey: true }), 'mac')).toBe('shift+F6');
  });
});
