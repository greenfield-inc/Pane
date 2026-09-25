export interface QuickKey {
  id: string;
  label: string;
  /** What VoiceOver and TalkBack read, from the web app's tooltip. */
  hint: string;
  /** Bytes sent to the terminal. */
  data: string;
}

/** The web app's control keys: the ones a phone keyboard lacks. Arrows and Enter answer agent prompts and menus. */
export const QUICK_KEYS: readonly QuickKey[] = [
  { id: 'ctrl-c', label: 'Stop', hint: 'Sends Ctrl-C to stop the running command', data: '\x03' },
  { id: 'esc', label: 'Esc', hint: 'Sends Escape', data: '\x1b' },
  { id: 'tab', label: 'Tab', hint: 'Sends Tab', data: '\t' },
  { id: 'enter', label: 'Enter', hint: 'Sends Enter', data: '\r' },
  { id: 'up', label: 'Up', hint: 'Sends Up Arrow', data: '\x1b[A' },
  { id: 'down', label: 'Down', hint: 'Sends Down Arrow', data: '\x1b[B' },
];
