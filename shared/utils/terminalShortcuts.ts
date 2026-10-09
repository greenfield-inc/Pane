/** Desktop binds each enabled shortcut to ⌘⌥ (Ctrl+Alt) plus one of these letters. */
export const SHORTCUT_LETTER = /^[a-z]$/;

/** The first letter two enabled shortcuts share, or undefined when each is free. */
export function sharedShortcutLetter(shortcuts: readonly { key: string; enabled: boolean }[]): string | undefined {
  const letters = shortcuts.filter(shortcut => shortcut.enabled).map(shortcut => shortcut.key);
  return letters.find((letter, index) => letters.indexOf(letter) !== index);
}
