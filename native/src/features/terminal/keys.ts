import type { AndroidSymbol, SFSymbol } from 'expo-symbols';

export interface QuickKey {
  id: string;
  label: string;
  /** Bytes sent to the terminal. */
  data: string;
  icon?: { ios: SFSymbol; android: AndroidSymbol };
}

/** Keys a phone keyboard lacks. Arrows and Enter answer agent prompts and menus. */
export const QUICK_KEYS: readonly QuickKey[] = [
  { id: 'ctrl-c', label: 'Ctrl-C', data: '\x03' },
  { id: 'esc', label: 'Esc', data: '\x1b' },
  { id: 'tab', label: 'Tab', data: '\t' },
  { id: 'enter', label: 'Enter', data: '\r', icon: { ios: 'return', android: 'keyboard_return' } },
  { id: 'up', label: 'Up', data: '\x1b[A', icon: { ios: 'arrow.up', android: 'arrow_upward' } },
  { id: 'down', label: 'Down', data: '\x1b[B', icon: { ios: 'arrow.down', android: 'arrow_downward' } },
  { id: 'left', label: 'Left', data: '\x1b[D', icon: { ios: 'arrow.left', android: 'arrow_back' } },
  { id: 'right', label: 'Right', data: '\x1b[C', icon: { ios: 'arrow.right', android: 'arrow_forward' } },
];
