import type { NotifyUi } from '../../../../shared/types/notify';

export const NOTIFY_KIND_LABEL = {
  options: 'Needs a choice',
  approve: 'Needs approval',
  ask: 'Needs an answer',
  info: 'Update',
} satisfies Record<NotifyUi, string>;

/** Blue asks for a choice or answer, amber for approval, green for an update. */
export const NOTIFY_KIND_DOT = {
  options: 'bg-status-info',
  approve: 'bg-status-warning',
  ask: 'bg-status-info',
  info: 'bg-status-success',
} satisfies Record<NotifyUi, string>;

/** "now", "4m", "2h" or "3d" since the epoch-ms time. */
export function relativeAge(since: number, now: number): string {
  const minutes = Math.floor((now - since) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const MAC_MODIFIERS = new Map<string, string>([
  ['control', '⌃'], ['ctrl', '⌃'], ['shift', '⇧'], ['alt', '⌥'],
  ['option', '⌥'], ['altgr', '⌥'], ['command', '⌘'], ['cmd', '⌘'],
  ['commandorcontrol', '⌘'], ['cmdorctrl', '⌘'], ['super', '⌘'], ['meta', '⌘'],
]);

const OTHER_MODIFIERS = new Map<string, string>([
  ['control', 'Ctrl'], ['ctrl', 'Ctrl'], ['commandorcontrol', 'Ctrl'], ['cmdorctrl', 'Ctrl'],
  ['shift', 'Shift'], ['alt', 'Alt'], ['option', 'Alt'], ['altgr', 'AltGr'],
  ['command', 'Super'], ['cmd', 'Super'], ['super', 'Super'], ['meta', 'Super'],
]);

/**
 * An Electron accelerator as people read it: `⌃⇧Space` on macOS,
 * `Ctrl+Shift+Space` on Windows and Linux.
 */
export function shortcutLabel(accelerator: string, mac: boolean): string {
  const parts = accelerator.split('+').filter(Boolean);
  const modifiers = mac ? MAC_MODIFIERS : OTHER_MODIFIERS;
  const labels = parts.map((part) => modifiers.get(part.toLowerCase()) ?? part);
  return mac ? labels.join('') : labels.join('+');
}

const NAMED_KEYS = new Map<string, string>([
  ['Space', 'Space'], ['Enter', 'Enter'], ['Tab', 'Tab'], ['Backspace', 'Backspace'],
  ['Delete', 'Delete'], ['ArrowUp', 'Up'], ['ArrowDown', 'Down'], ['ArrowLeft', 'Left'],
  ['ArrowRight', 'Right'], ['Home', 'Home'], ['End', 'End'], ['PageUp', 'PageUp'],
  ['PageDown', 'PageDown'], ['Insert', 'Insert'], ['Minus', '-'], ['Equal', '='],
  ['BracketLeft', '['], ['BracketRight', ']'], ['Backslash', '\\'], ['Semicolon', ';'],
  ['Quote', "'"], ['Comma', ','], ['Period', '.'], ['Slash', '/'],
  ['Backquote', '`'],
]);

export interface KeyChord {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/**
 * The Electron accelerator a key press spells, or null until the press has at
 * least one modifier and one ordinary key. A global shortcut needs both.
 */
export function acceleratorFromKeys(chord: KeyChord, mac: boolean): string | null {
  let key: string | undefined;
  if (/^Key[A-Z]$/.test(chord.code)) key = chord.code.slice(3);
  else if (/^Digit\d$/.test(chord.code)) key = chord.code.slice(5);
  else if (/^F\d{1,2}$/.test(chord.code)) key = chord.code;
  else key = NAMED_KEYS.get(chord.code);
  if (!key) return null;
  const modifiers = [
    chord.ctrlKey && 'Control',
    chord.altKey && 'Alt',
    chord.shiftKey && 'Shift',
    chord.metaKey && (mac ? 'Command' : 'Super'),
  ].filter((modifier): modifier is string => Boolean(modifier));
  if (modifiers.length === 0) return null;
  return [...modifiers, key].join('+');
}

