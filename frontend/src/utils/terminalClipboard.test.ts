import { describe, expect, it } from 'vitest';
import { decodeOsc52Copy, isTerminalCopyShortcut, isTerminalSelectionCopyKey } from './terminalClipboard';

function key(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  // SAFETY: The surrounding typed producer establishes the narrower value shape consumed here.
  return {
    key: 'c',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  } as KeyboardEvent;
}

describe('isTerminalCopyShortcut', () => {
  it('uses Cmd+C on macOS', () => {
    expect(isTerminalCopyShortcut(key({ metaKey: true }), true)).toBe(true);
    expect(isTerminalCopyShortcut(key({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isTerminalCopyShortcut(key({ ctrlKey: true, shiftKey: true }), true)).toBe(false);
  });

  it('uses Ctrl+Shift+C outside macOS', () => {
    expect(isTerminalCopyShortcut(key({ ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(isTerminalCopyShortcut(key({ ctrlKey: true }), false)).toBe(false);
    expect(isTerminalCopyShortcut(key({ metaKey: true }), false)).toBe(false);
  });

  it('does not intercept modified copy shortcuts', () => {
    expect(isTerminalCopyShortcut(key({ metaKey: true, altKey: true }), true)).toBe(false);
    expect(isTerminalCopyShortcut(key({ ctrlKey: true, shiftKey: true, altKey: true }), false)).toBe(false);
  });
});

describe('isTerminalSelectionCopyKey', () => {
  it('copies with plain Ctrl+C outside macOS only while text is selected', () => {
    expect(isTerminalSelectionCopyKey(key({ ctrlKey: true }), false, true)).toBe(true);
    expect(isTerminalSelectionCopyKey(key({ ctrlKey: true }), false, false)).toBe(false);
    expect(isTerminalSelectionCopyKey(key({ ctrlKey: true }), true, true)).toBe(false);
    expect(isTerminalSelectionCopyKey(key({ ctrlKey: true, shiftKey: true }), false, true)).toBe(false);
    expect(isTerminalSelectionCopyKey(key({ ctrlKey: true, altKey: true }), false, true)).toBe(false);
  });
});

describe('decodeOsc52Copy', () => {
  const encode = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

  it('decodes the clipboard text Claude Code sends for a fullscreen selection', () => {
    // Captured from Claude Code 2.1.287: ESC ] 52 ; c ; <base64> BEL after a mouse drag.
    expect(decodeOsc52Copy(`c;${encode('ROW388')}`)).toBe('ROW388');
    expect(decodeOsc52Copy(`;${encode('héllo 🙂\nline 2')}`)).toBe('héllo 🙂\nline 2');
  });

  it('refuses clipboard reads and malformed or empty payloads', () => {
    expect(decodeOsc52Copy('c;?')).toBeNull();
    expect(decodeOsc52Copy('c;')).toBeNull();
    expect(decodeOsc52Copy('no-separator')).toBeNull();
    expect(decodeOsc52Copy('c;not base64!')).toBeNull();
    expect(decodeOsc52Copy(`c;${btoa(String.fromCharCode(0xff, 0xfe))}`)).toBeNull();
    expect(decodeOsc52Copy(`c;${'A'.repeat(1024 * 1024 + 4)}`)).toBeNull();
  });
});

