import type { AppConfig } from '../types/config';
import { areKeyboardShortcutsEnabled, shouldForwardCommandPaletteShortcut } from './keyboardShortcuts';

/**
 * Which keys pressed inside an embedded <webview> page are re-sent to Pane's
 * window. Webviews are separate processes, so their key events never reach
 * the renderer's hotkey listener; main intercepts them in before-input-event.
 * Only Pane's own shortcuts are taken, so pages keep Ctrl+R, Ctrl+A and the rest.
 */
export interface WebviewKeyInput {
  key: string;
  code: string;
  control: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

export interface WebviewKeyContext {
  config: Pick<AppConfig, 'keyboardShortcutsEnabled' | 'commandPaletteShortcutEnabled'>;
  /** The guest belongs to a browser tab (not the Docs dialog). */
  isBrowserTab: boolean;
  /** That browser tab's Pane find bar is open. */
  findActive: boolean;
}

// mod+key (no extra modifiers):
const PANE_HOTKEYS: ReadonlySet<string> = new Set([
  'b', ',', 'n', 'a', 'd', 'w', 't', '`',
  // mod+1..9 switch session, mod+Tab/ArrowDown cycle next
  '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'tab', 'arrowdown', 'arrowup',
]);
// mod+shift+key — matched by physical key code (Digit/Key) because
// input.key reports the shifted symbol (e.g. '!' for Shift+1) which
// varies by keyboard layout.
const PANE_SHIFT_CODES: ReadonlySet<string> = new Set([
  'KeyE', 'KeyN', 'KeyK', 'KeyP', 'KeyZ', 'KeyL', 'KeyR', 'KeyM', 'KeyU',
  'KeyB', 'KeyW', 'KeyD',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5',
  'Digit6', 'Digit7', 'Digit8', 'Digit9',
  'Tab', // mod+shift+Tab cycles prev session
]);

/**
 * Pane's find (Cmd/Ctrl+F, Cmd/Ctrl+G, Shift+Cmd/Ctrl+G) wins over a page's
 * own Cmd+F in browser tabs: Electron has no built-in find bar, so leaving
 * the key to the page did nothing on most pages.
 */
function isFindKey(input: WebviewKeyInput): boolean {
  if (input.alt) return false;
  if (input.code === 'KeyG') return true;
  return !input.shift && input.code === 'KeyF';
}

export function shouldForwardWebviewKey(input: WebviewKeyInput, context: WebviewKeyContext): boolean {
  const shortcutsOn = areKeyboardShortcutsEnabled(context.config);

  // Escape closes an open find bar even while the page has focus; otherwise
  // the page keeps it (dialogs, full-screen video).
  if (input.key === 'Escape' && !input.control && !input.meta && !input.alt) {
    return shortcutsOn && context.isBrowserTab && context.findActive;
  }

  const mod = input.control || input.meta;
  if (!mod) return false;
  if (!shortcutsOn && !shouldForwardCommandPaletteShortcut(context.config, input)) return false;

  if (isFindKey(input)) return shortcutsOn && context.isBrowserTab;

  // Skip AltGr: on Windows/Linux international layouts, AltGr reports
  // control+alt simultaneously. We detect this as control+alt without
  // meta, and only forward when the physical key is a letter, digit,
  // or slash (the patterns used by Pane's mod+alt shortcuts). This
  // prevents blocking character input like @, €, or \ on those layouts.
  const isAltGr = input.control && input.alt && !input.meta
    && !/^(Key[A-Z]|Digit[0-9]|Slash)$/.test(input.code);

  // mod+alt combos are forwarded (user-configurable terminal shortcuts
  // use mod+alt+<key>), but AltGr character input is excluded above.
  return (input.alt && !isAltGr)
    || (input.shift && !input.alt && PANE_SHIFT_CODES.has(input.code))
    || (!input.shift && !input.alt && PANE_HOTKEYS.has(input.key.toLowerCase()));
}
