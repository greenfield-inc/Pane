import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';

import { BUTTON_LETTERS_OVERRIDES, type ButtonLettersOverride, type ControllerFamily } from '@shared/controller/profiles';

const LETTERS_KEY = 'controller.buttonLetters';
const SHEET_SEEN_KEY = 'controller.cheatSheetSeen';

interface ControllerState {
  /** A pad is connected and has been pressed since. */
  active: boolean;
  family: ControllerFamily;
  /** The ring shows after a controller press and hides on touch or disconnect. */
  ringShown: boolean;
  /** The cheat sheet is open: − held, the first press after install, or Settings' button. */
  cheatSheet: 'held' | 'open' | null;
  /** Settings › Controller › Button letters, kept on this phone. */
  letters: ButtonLettersOverride;
  /** The cheat sheet showed once on this install; it never opens on its own again. */
  sheetSeen: boolean;
  setLetters(letters: ButtonLettersOverride): void;
  markSheetSeen(): void;
}

function storedLetters(): ButtonLettersOverride {
  const value = SecureStore.getItem(LETTERS_KEY);
  return BUTTON_LETTERS_OVERRIDES.find(option => option === value) ?? 'auto';
}

export const useControllerState = create<ControllerState>(set => ({
  active: false,
  family: 'generic',
  ringShown: false,
  cheatSheet: null,
  letters: storedLetters(),
  sheetSeen: SecureStore.getItem(SHEET_SEEN_KEY) === 'true',
  setLetters: letters => {
    set({ letters });
    void (letters === 'auto' ? SecureStore.deleteItemAsync(LETTERS_KEY) : SecureStore.setItemAsync(LETTERS_KEY, letters)).catch(() => undefined);
  },
  markSheetSeen: () => {
    set({ sheetSeen: true });
    void SecureStore.setItemAsync(SHEET_SEEN_KEY, 'true').catch(() => undefined);
  },
}));
