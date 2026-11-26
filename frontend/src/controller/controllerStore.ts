/**
 * What the desktop controller layer shows: the pad in use, the cheat sheet
 * and the key pad, plus the two preferences (button letters
 * and whether the cheat sheet has been seen on this install).
 */
import { create } from 'zustand';
import { BUTTON_LETTERS_OVERRIDES, type ButtonLettersOverride, type ControllerFamily } from '../../../shared/controller/profiles';
import type { ControllerDevice } from '../../../shared/controller/types';
import { API } from '../utils/api';

const CONTROLLER_PREFERENCE_KEYS = {
  buttonLetters: 'controller_button_letters',
  cheatSheetSeen: 'controller_cheat_sheet_seen',
} as const;

/** `held` closes when − comes up; `open` stays until B, A or a click. */
type CheatSheetState = 'closed' | 'open' | 'held';

interface ControllerState {
  device: ControllerDevice | null;
  family: ControllerFamily;
  cheatSheet: CheatSheetState;
  keyPadOpen: boolean;
  buttonLetters: ButtonLettersOverride;
  cheatSheetSeen: boolean;
  preferencesLoaded: boolean;
}

export const useControllerStore = create<ControllerState>(() => ({
  device: null,
  family: 'generic',
  cheatSheet: 'closed',
  keyPadOpen: false,
  buttonLetters: 'auto',
  cheatSheetSeen: false,
  preferencesLoaded: false,
}));

function parseButtonLetters(value: string | null): ButtonLettersOverride {
  return BUTTON_LETTERS_OVERRIDES.find(option => option === value) ?? 'auto';
}

export async function loadControllerPreferences(): Promise<void> {
  const [letters, seen] = await Promise.all([
    API.preferences.get(CONTROLLER_PREFERENCE_KEYS.buttonLetters),
    API.preferences.get(CONTROLLER_PREFERENCE_KEYS.cheatSheetSeen),
  ]);
  useControllerStore.setState({ buttonLetters: parseButtonLetters(letters), cheatSheetSeen: seen === 'true', preferencesLoaded: true });
}

export function setButtonLetters(value: ButtonLettersOverride): void {
  useControllerStore.setState({ buttonLetters: value });
  void API.preferences.set(CONTROLLER_PREFERENCE_KEYS.buttonLetters, value);
}

export function markCheatSheetSeen(): void {
  if (useControllerStore.getState().cheatSheetSeen) return;
  useControllerStore.setState({ cheatSheetSeen: true });
  void API.preferences.set(CONTROLLER_PREFERENCE_KEYS.cheatSheetSeen, 'true');
}
