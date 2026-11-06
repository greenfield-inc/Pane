import { describe, expect, it } from 'vitest';
import { shouldForwardWebviewKey, type WebviewKeyContext, type WebviewKeyInput } from './webviewKeyForwarding';

function key(code: string, keyName: string, mods: Partial<WebviewKeyInput> = {}): WebviewKeyInput {
  return { key: keyName, code, control: false, meta: false, shift: false, alt: false, ...mods };
}

const browserTab: WebviewKeyContext = { config: {}, isBrowserTab: true, findActive: false };
const docsDialog: WebviewKeyContext = { config: {}, isBrowserTab: false, findActive: false };
const shortcutsOff: WebviewKeyContext = { config: { keyboardShortcutsEnabled: false }, isBrowserTab: true, findActive: true };

const cmdF = key('KeyF', 'f', { meta: true });
const ctrlF = key('KeyF', 'f', { control: true });
const cmdG = key('KeyG', 'g', { meta: true });
const shiftCmdG = key('KeyG', 'G', { meta: true, shift: true });
const ctrlShiftG = key('KeyG', 'G', { control: true, shift: true });
const escape = key('Escape', 'Escape');

describe('shouldForwardWebviewKey: find keys', () => {
  it('forwards Cmd/Ctrl+F, Cmd/Ctrl+G and Shift+Cmd/Ctrl+G from a browser tab', () => {
    for (const input of [cmdF, ctrlF, cmdG, shiftCmdG, ctrlShiftG]) {
      expect(shouldForwardWebviewKey(input, browserTab)).toBe(true);
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
