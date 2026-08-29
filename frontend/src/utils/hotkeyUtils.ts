/**
 * Utility functions for displaying and organizing keyboard shortcuts.
 *
 * Provides:
 * - Platform-aware key display formatting (⌘ on Mac, Ctrl on Windows)
 * - Category ordering for consistent Help dialog presentation
 * - Human-readable labels for hotkey categories
 *
 * Used by CommandPalette and Help components to present shortcuts to users.
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
  'view',
  'tools',
  'shortcuts',
  'debug',
];

export const CATEGORY_LABELS = {
  navigation: 'Navigation',
  session: 'Projects',
  tabs: 'Tabs',
  view: 'View',
  tools: 'Add Tool',
  shortcuts: 'Shortcuts',
  debug: 'Debug',
} satisfies Record<ShortcutCategory, string>;

export function formatKeyDisplay(keys: string): string {
  const isMacPlatform = isMac();
  const parts = keys.split('+');
  const formatted = parts.map((part) => {
    switch (part.toLowerCase()) {
      case 'mod': return isMacPlatform ? '⌘' : 'Ctrl';
      case 'alt': return isMacPlatform ? '⌥' : 'Alt';
      case 'shift': return isMacPlatform ? '⇧' : 'Shift';
      case 'arrowleft': return '←';
      case 'arrowright': return '→';
      case 'arrowup': return '↑';
      case 'arrowdown': return '↓';
      case 'tab': return 'Tab';
      case 'enter': return isMacPlatform ? '↩' : 'Enter';
      case 'escape': return 'Esc';
      case 'backspace': return isMacPlatform ? '⌫' : 'Backspace';
      case 'delete': return isMacPlatform ? '⌦' : 'Del';
      case 'space': return 'Space';
      case 'pageup': return 'PgUp';
      case 'pagedown': return 'PgDn';
      case 'home': return 'Home';
      case 'end': return 'End';
      default: return part.length === 1 ? part.toUpperCase() : part;
    }
  });
  return formatted.join(' + ');
}
