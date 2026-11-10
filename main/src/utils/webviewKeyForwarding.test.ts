import { describe, expect, it } from 'vitest';
import {
  createWebviewSequenceState,
  shouldForwardWebviewKey,
  WEBVIEW_SEQUENCE_TIMEOUT_MS,
  webviewKeysToForward,
  type WebviewKeyContext,
  type WebviewKeyInput,
} from './webviewKeyForwarding';

function key(code: string, keyName: string, mods: Partial<WebviewKeyInput> = {}): WebviewKeyInput {
  return { key: keyName, code, control: false, meta: false, shift: false, alt: false, ...mods };
}

const browserTab: WebviewKeyContext = { config: {}, isBrowserTab: true, findActive: false, platform: 'mac' };
const docsDialog: WebviewKeyContext = { config: {}, isBrowserTab: false, findActive: false, platform: 'mac' };
const shortcutsOff: WebviewKeyContext = { config: { keyboardShortcutsEnabled: false }, isBrowserTab: true, findActive: true, platform: 'mac' };
const windowsTab: WebviewKeyContext = { ...browserTab, platform: 'other' };

const cmdF = key('KeyF', 'f', { meta: true });
const ctrlF = key('KeyF', 'f', { control: true });
const cmdG = key('KeyG', 'g', { meta: true });
const shiftCmdG = key('KeyG', 'G', { meta: true, shift: true });
const ctrlShiftG = key('KeyG', 'G', { control: true, shift: true });
const escape = key('Escape', 'Escape');

describe('shouldForwardWebviewKey: find keys', () => {
  it('forwards ⌘F, ⌘G and ⇧⌘G on macOS, and Ctrl+F, Ctrl+G and Ctrl+Shift+G elsewhere, from a browser tab', () => {
    for (const input of [cmdF, cmdG, shiftCmdG]) {
      expect(shouldForwardWebviewKey(input, browserTab)).toBe(true);
    }
    for (const input of [ctrlF, ctrlShiftG]) {
      expect(shouldForwardWebviewKey(input, { ...browserTab, platform: 'other' })).toBe(true);
      // macOS Control+F is the page's own (Find is ⌘F there).
      expect(shouldForwardWebviewKey(input, browserTab)).toBe(false);
    }
  });

  it('leaves them to the page in the Docs dialog webview', () => {
    for (const input of [cmdF, ctrlF, cmdG, shiftCmdG]) {
      expect(shouldForwardWebviewKey(input, docsDialog)).toBe(false);
    }
  });

  it('leaves them to the page when keyboard shortcuts are off', () => {
    for (const input of [cmdF, ctrlF, cmdG, shiftCmdG, escape]) {
      expect(shouldForwardWebviewKey(input, shortcutsOff)).toBe(false);
    }
  });

  it('does not take Shift+Cmd+F or Alt+Cmd+F', () => {
    expect(shouldForwardWebviewKey(key('KeyF', 'F', { meta: true, shift: true }), browserTab)).toBe(false);
    expect(shouldForwardWebviewKey(key('KeyF', 'ƒ', { meta: true, alt: true }), browserTab)).toBe(false);
  });

  it('forwards Escape only while the tab’s find bar is open', () => {
    expect(shouldForwardWebviewKey(escape, browserTab)).toBe(false);
    expect(shouldForwardWebviewKey(escape, { ...browserTab, findActive: true })).toBe(true);
    expect(shouldForwardWebviewKey(escape, { ...docsDialog, findActive: true })).toBe(false);
  });

  it('does not forward plain letters', () => {
    expect(shouldForwardWebviewKey(key('KeyF', 'f'), { ...browserTab, findActive: true })).toBe(false);
  });
});

describe('shouldForwardWebviewKey: existing Pane hotkeys', () => {
  it('still forwards Cmd+W and Shift+Cmd+P, and leaves Cmd+R to the page', () => {
    expect(shouldForwardWebviewKey(key('KeyW', 'w', { meta: true }), docsDialog)).toBe(true);
    expect(shouldForwardWebviewKey(key('KeyP', 'P', { meta: true, shift: true }), browserTab)).toBe(true);
    expect(shouldForwardWebviewKey(key('KeyR', 'r', { meta: true }), browserTab)).toBe(false);
  });

  it('keeps forwarding Shift+Cmd+P with shortcuts off when the palette shortcut is on', () => {
    expect(shouldForwardWebviewKey(key('KeyP', 'P', { meta: true, shift: true }), shortcutsOff)).toBe(true);
    expect(shouldForwardWebviewKey(key('KeyW', 'w', { meta: true }), shortcutsOff)).toBe(false);
  });

  it('does not swallow AltGr character input', () => {
    expect(shouldForwardWebviewKey(key('Backslash', '\\', { control: true, alt: true }), browserTab)).toBe(false);
  });
});

describe('webviewKeysToForward: the VS Code keymap', () => {
  it.each([
    ['⌘0 focus sidebar', key('Digit0', '0', { meta: true })],
    ['⌘⌥→ focus right', key('ArrowRight', 'ArrowRight', { meta: true, alt: true })],
    ['F6 next region', key('F6', 'F6')],
    ['⇧F6 previous region', key('F6', 'F6', { shift: true })],
    ['⌘⇧M minimize', key('KeyM', 'M', { meta: true, shift: true })],
    ['⌘⌥O machine switcher', key('KeyO', 'ø', { meta: true, alt: true })],
    ['⌃⌘] next machine', key('BracketRight', ']', { meta: true, control: true })],
    ['⌃⌘0 all machines', key('Digit0', '0', { meta: true, control: true })],
    ['⌘⇧] next tab', key('BracketRight', '}', { meta: true, shift: true })],
    ['⌘⌥B right panel', key('KeyB', '∫', { meta: true, alt: true })],
    ['⌃` terminal', key('Backquote', '`', { control: true })],
  ])('forwards %s from a page', (_label, input) => {
    expect(webviewKeysToForward(input, browserTab)).toEqual([input]);
  });

  it('leaves moved keys to the page: ⌘A, ⌘⇧Z, ⌘⇧E', () => {
    for (const input of [key('KeyA', 'a', { meta: true }), key('KeyZ', 'Z', { meta: true, shift: true }), key('KeyE', 'E', { meta: true, shift: true })]) {
      expect(webviewKeysToForward(input, browserTab)).toEqual([]);
    }
  });

  it('leaves macOS Control+letter to the page', () => {
    expect(webviewKeysToForward(key('KeyB', 'b', { control: true }), browserTab)).toEqual([]);
  });

  it('keeps ⌘K for the page, then sends ⌘K ⌘M together when the second step follows', () => {
    const state = createWebviewSequenceState();
    const cmdK = key('KeyK', 'k', { meta: true });
    const cmdM = key('KeyM', 'm', { meta: true });
    expect(webviewKeysToForward(cmdK, browserTab, state, 1000)).toEqual([]);
    expect(webviewKeysToForward(key('MetaLeft', 'Meta', { meta: true }), browserTab, state, 1100)).toEqual([]);
    expect(webviewKeysToForward(cmdM, browserTab, state, 1200)).toEqual([cmdK, cmdM]);
    expect(webviewKeysToForward(cmdM, browserTab, state, 1300)).toEqual([]);
  });

  it('drops a stale or interrupted first step', () => {
    const state = createWebviewSequenceState();
    const cmdK = key('KeyK', 'k', { meta: true });
    const cmdS = key('KeyS', 's', { meta: true });
    webviewKeysToForward(cmdK, browserTab, state, 0);
    expect(webviewKeysToForward(cmdS, browserTab, state, WEBVIEW_SEQUENCE_TIMEOUT_MS + 1)).toEqual([]);
    webviewKeysToForward(cmdK, browserTab, state, 0);
    webviewKeysToForward(key('KeyX', 'x'), browserTab, state, 10);
    expect(webviewKeysToForward(cmdS, browserTab, state, 20)).toEqual([]);
  });

  it('uses Ctrl on Windows and Linux, with Ctrl+PgDn for the next tab', () => {
    expect(webviewKeysToForward(key('Digit0', '0', { control: true }), windowsTab)).toHaveLength(1);
    expect(webviewKeysToForward(key('PageDown', 'PageDown', { control: true }), windowsTab)).toHaveLength(1);
    expect(webviewKeysToForward(key('ArrowRight', 'ArrowRight', { control: true, alt: true }), windowsTab)).toHaveLength(1);
    expect(webviewKeysToForward(key('BracketRight', ']', { control: true, alt: true, shift: true }), windowsTab)).toHaveLength(1);
  });

  it('follows the person\'s overrides', () => {
    const remapped: WebviewKeyContext = { ...browserTab, config: { keyboardShortcutOverrides: { 'focus-sidebar': 'mod+shift+e' } } };
    expect(webviewKeysToForward(key('KeyE', 'E', { meta: true, shift: true }), remapped)).toHaveLength(1);
    expect(webviewKeysToForward(key('Digit0', '0', { meta: true }), remapped)).toEqual([]);
  });
});

describe('webviewKeysToForward: remapped Find', () => {
  it('takes the remapped Find key from a browser page and leaves the old one to the page', () => {
    const remapped: WebviewKeyContext = { ...browserTab, config: { keyboardShortcutOverrides: { 'find-in-tab': 'mod+shift+h' } } };
    const newKey = key('KeyH', 'H', { meta: true, shift: true });
    expect(webviewKeysToForward(newKey, remapped)).toEqual([newKey]);
    expect(webviewKeysToForward(cmdF, remapped)).toEqual([]);
    // Next and previous keep their defaults; the Docs dialog keeps every key.
    expect(webviewKeysToForward(cmdG, remapped)).toEqual([cmdG]);
    expect(webviewKeysToForward(newKey, { ...remapped, isBrowserTab: false })).toEqual([]);
  });
});
