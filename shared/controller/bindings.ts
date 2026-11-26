/**
 * The approved controller scheme as data: which action each button runs in
 * each screen context. Actions are ids from the shortcut catalog
 * (shared/constants/keyboardShortcuts.ts), so a keyboard key, a pad button and
 * later glasses all run the same command. The terminal arrow keys are the one
 * set of controller-only actions: a keyboard already has arrows.
 */
import type { KeyboardShortcutId } from '../constants/keyboardShortcuts';
import { keyLabel, type ControllerFamily, type ControllerKey } from './profiles';

/** Catalog commands a controller runs. */
export type ControllerCatalogActionId = Extract<KeyboardShortcutId,
  | 'controller-focus-up' | 'controller-focus-down' | 'controller-focus-left' | 'controller-focus-right'
  | 'controller-activate' | 'controller-back'
  | 'cycle-tab-prev-a' | 'cycle-tab-next-d' | 'controller-switch-column'
  | 'toggle-sidebar' | 'open-command-palette'
  | 'dictate-hold' | 'send-draft' | 'open-key-pad'
  | 'scroll-focused-surface-up' | 'scroll-focused-surface-down' | 'jump-to-bottom'
  | 'next-needs-you' | 'open-recent' | 'show-controller-help'>;

export type TerminalArrowActionId = 'terminal-arrow-up' | 'terminal-arrow-down' | 'terminal-arrow-left' | 'terminal-arrow-right';
export type ControllerActionId = ControllerCatalogActionId | TerminalArrowActionId;

/** Actions that start when the button goes down and end when it comes up. */
export type ControllerHoldActionId = Extract<ControllerActionId, 'dictate-hold' | 'show-controller-help'>;

/**
 * Where focus is. `terminal` sends the D-pad to the agent as arrow keys; every
 * other context moves the focus ring with it. The rest differ only in what the
 * handlers do, and in the cheat sheet's wording.
 */
export type ControllerContext = 'home' | 'tab' | 'terminal' | 'sheet' | 'keypad' | 'search';

export const HOLD_MS = 450;

/** The scheme's one-shot buttons (the sticks, L1+R1, R2 and − have their own rules in the interpreter). */
const BASE_PRESS = new Map<ControllerKey, ControllerActionId>([
  ['up', 'controller-focus-up'],
  ['down', 'controller-focus-down'],
  ['left', 'controller-focus-left'],
  ['right', 'controller-focus-right'],
  ['A', 'controller-activate'],
  ['B', 'controller-back'],
  ['X', 'open-key-pad'],
  ['Y', 'send-draft'],
  ['L2', 'toggle-sidebar'],
  ['L3', 'open-command-palette'],
  ['R3', 'jump-to-bottom'],
  ['plus', 'next-needs-you'],
]);

const TERMINAL_PRESS = new Map<ControllerKey, ControllerActionId>([
  ...BASE_PRESS,
  ['up', 'terminal-arrow-up'],
  ['down', 'terminal-arrow-down'],
  ['left', 'terminal-arrow-left'],
  ['right', 'terminal-arrow-right'],
]);

/** The action a button runs on press in `context`, or null when the button has a timed rule or none. */
export function pressAction(context: ControllerContext, key: ControllerKey): ControllerActionId | null {
  return (context === 'terminal' ? TERMINAL_PRESS : BASE_PRESS).get(key) ?? null;
}

/** L1 and R1 run on release (unless pressed together); − is a tap or a hold; R2 is a hold. */
export const RELEASE_ACTIONS = { L1: 'cycle-tab-prev-a', R1: 'cycle-tab-next-d' } as const satisfies Partial<Record<ControllerKey, ControllerActionId>>;
export const CHORD_ACTION = 'controller-switch-column' satisfies ControllerActionId;
export const MINUS_TAP_ACTION = 'open-recent' satisfies ControllerActionId;
export const MINUS_HOLD_ACTION = 'show-controller-help' satisfies ControllerHoldActionId;
export const R2_HOLD_ACTION = 'dictate-hold' satisfies ControllerHoldActionId;

/** One row of the cheat sheet: the pad's own labels for the buttons, and what they do. */
export interface CheatSheetRow {
  keys: readonly string[];
  label: string;
}

export interface CheatSheet {
  family: ControllerFamily;
  /** Shown instead of rows when Pane can't read the pad's layout. */
  note: string | null;
  rows: readonly CheatSheetRow[];
}

/** The scheme, in the order the cheat sheet lists it. Each key's action is checked against the tables above by test. */
export const CHEAT_SHEET_SCHEME: ReadonlyArray<{ keys: readonly ControllerKey[]; action: ControllerActionId; label: string }> = [
  { keys: ['up', 'down', 'left', 'right'], action: 'controller-focus-up', label: 'Move focus (left stick too). In a terminal: arrow keys' },
  { keys: ['A'], action: 'controller-activate', label: 'Open or pick. In a terminal: Enter' },
  { keys: ['B'], action: 'controller-back', label: 'Back' },
  { keys: ['L1', 'R1'], action: 'cycle-tab-prev-a', label: 'Previous or next tab. Hold both: other column' },
  { keys: ['L2'], action: 'toggle-sidebar', label: 'Show or hide the sidebar' },
  { keys: ['L3'], action: 'open-command-palette', label: 'Search' },
  { keys: ['R2'], action: 'dictate-hold', label: 'Hold to talk; let go to put the words in the box' },
  { keys: ['Y'], action: 'send-draft', label: 'Send' },
  { keys: ['X'], action: 'open-key-pad', label: 'Key pad: Esc, ^C, Tab, Shift+Tab' },
  { keys: ['R3'], action: 'jump-to-bottom', label: 'Right stick scrolls. Click: jump to the bottom' },
  { keys: ['plus'], action: 'next-needs-you', label: 'Next thing that needs you' },
  { keys: ['minus'], action: 'open-recent', label: 'Recent. Hold: this sheet' },
];

export const UNRECOGNISED_PAD_NOTE = "Pane can't read this controller's layout. Switch the pad to its Xbox or Switch mode, then press a button.";

/** The cheat sheet for a pad of `family`, in that pad's own button labels. */
export function cheatSheet(family: ControllerFamily): CheatSheet {
  if (family === 'unrecognised') return { family, note: UNRECOGNISED_PAD_NOTE, rows: [] };
  return {
    family,
    note: null,
    rows: CHEAT_SHEET_SCHEME.map(row => ({ keys: row.keys.map(key => keyLabel(family, key)), label: row.label })),
  };
}
