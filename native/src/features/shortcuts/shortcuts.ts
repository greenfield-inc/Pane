import type { RemotePwaTerminalShortcut } from '@shared/types/remoteDaemon';
import { SHORTCUT_LETTER, sharedShortcutLetter } from '@shared/utils/terminalShortcuts';

type Shortcut = RemotePwaTerminalShortcut;

/** Enabled shortcuts whose name or text contains every word of `query`, in list order. */
export function filterShortcuts(shortcuts: readonly Shortcut[], query: string): Shortcut[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return shortcuts.filter(shortcut => {
    if (!shortcut.enabled || !shortcut.text.trim()) return false;
    const haystack = `${shortcut.label}\n${shortcut.text}`.toLowerCase();
    return words.every(word => haystack.includes(word));
  });
}

export interface ShortcutProblems {
  label?: string;
  text?: string;
  key?: string;
}

/**
 * What stops `draft` from saving into `list`, by field: the host refuses a
 * hotkey letter outside a to z, or one another enabled shortcut uses.
 */
export function shortcutProblems(draft: Shortcut, list: readonly Shortcut[]): ShortcutProblems {
  const problems: ShortcutProblems = {};
  if (!draft.label.trim()) problems.label = 'Add a name';
  if (!draft.text.trim()) problems.text = 'Add the text to insert';
  if (!SHORTCUT_LETTER.test(draft.key)) problems.key = 'Pick a letter from A to Z';
  else if (sharedShortcutLetter([draft, ...list.filter(other => other.id !== draft.id)]) === draft.key) {
    problems.key = `${draft.key.toUpperCase()} is taken by another shortcut`;
  }
  return problems;
}

/** The first letter no enabled shortcut uses, for a new one. */
export function freeLetter(list: readonly Shortcut[]): string {
  const taken = new Set(list.filter(shortcut => shortcut.enabled).map(shortcut => shortcut.key));
  return 'abcdefghijklmnopqrstuvwxyz'.split('').find(letter => !taken.has(letter)) ?? '';
}
