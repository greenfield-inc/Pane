import { describe, expect, it } from 'vitest';
import { decodeOsc52Write, isTerminalCopyShortcut } from './terminalClipboard';

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

describe('decodeOsc52Write', () => {
  it('decodes UTF-8 clipboard writes for any target', () => {
    expect(decodeOsc52Write('c;aGVsbG8gd29ybGQ=')).toBe('hello world');
    expect(decodeOsc52Write(';aMOpbGxv')).toBe('héllo');
  });

  it('refuses clipboard reads and empty or malformed payloads', () => {
    expect(decodeOsc52Write('c;?')).toBeNull();
    expect(decodeOsc52Write('c;')).toBeNull();
    expect(decodeOsc52Write('c;not base64!')).toBeNull();
    expect(decodeOsc52Write('aGVsbG8=')).toBeNull();
  });
});
