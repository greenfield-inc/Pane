/**
 * Utility functions for displaying and organizing keyboard shortcuts.
 *
 * Provides:
 * - Platform-aware key display formatting (⌘ on Mac, Ctrl on Windows)
 * - Human-readable labels for hotkey categories
 *
 * Used by Search, the sidebar and Help to present shortcuts to users.
 *
 * @module hotkeyUtils
 */
import type { HotkeyDefinition } from '../stores/hotkeyStore';
import { isMac } from './platformUtils';

export const CATEGORY_LABELS = {
  navigation: 'Navigation',
  session: 'Projects',
  tabs: 'Tabs',
  view: 'View',
  tools: 'Add Tool',
  shortcuts: 'Shortcuts',
  debug: 'Debug',
} satisfies Record<HotkeyDefinition['category'], string>;

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
      default: return part.length === 1 ? part.toUpperCase() : part;
    }
  });
  return formatted.join(' + ');
}
