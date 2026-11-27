/**
 * Utility functions for displaying and organizing keyboard shortcuts.
 *
 * Provides:
 * - Platform-aware key display formatting (⌘⇧P on Mac, Ctrl+Shift+P elsewhere)
 * - Category ordering and labels for Help, the palette and Keyboard Shortcuts
 *
 * @module hotkeyUtils
 */
import type { ShortcutCategory } from '../../../shared/constants/keyboardShortcuts';
import { isMac } from './platformUtils';

/** Canonical display order for hotkey categories */
export const CATEGORY_ORDER: ShortcutCategory[] = [
  'navigation',
  'session',
  'tabs',
  'approvals',
  'view',
  'machines',
  'tools',
  'controller',
  'shortcuts',
  'debug',
];

export const CATEGORY_LABELS = {
  navigation: 'Navigation',
  session: 'Projects',
  tabs: 'Tabs',
  view: 'View',
  machines: 'Machines',
  tools: 'Add Tool',
  shortcuts: 'Shortcuts',
  debug: 'Debug',
  approvals: 'Approvals',
  controller: 'Controller',
} satisfies Record<ShortcutCategory, string>;

const MAC_SYMBOLS = new Map([
  ['mod', '⌘'], ['ctrl', '⌃'], ['alt', '⌥'], ['shift', '⇧'],
  ['enter', '↩'], ['backspace', '⌫'], ['delete', '⌦'],
]);
const OTHER_NAMES = new Map([
  ['mod', 'Ctrl'], ['ctrl', 'Ctrl'], ['alt', 'Alt'], ['shift', 'Shift'],
  ['enter', 'Enter'], ['backspace', 'Backspace'], ['delete', 'Del'],
]);
const SHARED_NAMES = new Map([
  ['arrowleft', '←'], ['arrowright', '→'], ['arrowup', '↑'], ['arrowdown', '↓'],
  ['tab', 'Tab'], ['escape', 'Esc'], ['space', 'Space'], ['pageup', 'PgUp'], ['pagedown', 'PgDn'],
  ['home', 'Home'], ['end', 'End'],
]);

function formatPart(part: string, mac: boolean): string {
  const lower = part.toLowerCase();
  const platformName = (mac ? MAC_SYMBOLS : OTHER_NAMES).get(lower);
  if (platformName) return platformName;
  const shared = SHARED_NAMES.get(lower);
  if (shared) return shared;
  return part.length === 1 ? part.toUpperCase() : part;
}

function formatStep(step: string, mac: boolean): string {
  const parts = step.split('+').map(part => formatPart(part, mac));
  // macOS writes chords as one glyph run (⌘⇧P); elsewhere keys are joined (Ctrl+Shift+P).
  return mac ? parts.join('') : parts.join('+');
}

/**
 * Formats a binding for people: one chord, or a two-step key with its steps
 * separated by a space ("⌘K ⌘S"). A trailing modifier-only string such as
 * `mod+alt` (the hints overlay prefix) formats as its symbols.
 */
export function formatKeyDisplay(keys: string, mac: boolean = isMac()): string {
  return keys.trim().split(/\s+/).filter(Boolean).map(step => formatStep(step, mac)).join(' ');
}

/**
 * Whether focus is in a file editor that can be typed into: there ⌘/ toggles
 * a comment, so Pane leaves the key to the editor. A read-only editor
 * (a preview or a diff) has no comment command, so Pane takes the key.
 */
export function isWritableCodeEditorFocused(active: Element | null = document.activeElement): boolean {
  if (!active?.closest('.monaco-editor')) return false;
  if (active instanceof HTMLTextAreaElement) {
    return !active.readOnly && active.getAttribute('aria-autocomplete') !== 'none';
  }
  return active.closest('[aria-readonly="true"]') === null;
}
