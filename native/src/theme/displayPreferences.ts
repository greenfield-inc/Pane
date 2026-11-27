import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';

import { parseTerminalFont, parseUiScale } from './display';

const UI_SCALE_KEY = 'display.uiScale';
const TERMINAL_FONT_KEY = 'display.terminalFontSize';

interface DisplayPreferences {
  uiScale: number;
  terminalFontSize: number;
  setUiScale(scale: number): void;
  setTerminalFontSize(size: number): void;
}

/**
 * Settings › Display, kept on this device only (expo-secure-store, read synchronously so the
 * first frame already has them). The desktop and other phones keep their own.
 */
export const useDisplayPreferences = create<DisplayPreferences>(set => ({
  uiScale: parseUiScale(SecureStore.getItem(UI_SCALE_KEY)),
  terminalFontSize: parseTerminalFont(SecureStore.getItem(TERMINAL_FONT_KEY)),
  setUiScale: uiScale => {
    set({ uiScale });
    save(UI_SCALE_KEY, String(uiScale));
  },
  setTerminalFontSize: terminalFontSize => {
    set({ terminalFontSize });
    save(TERMINAL_FONT_KEY, String(terminalFontSize));
  },
}));

function save(key: string, value: string): void {
  void SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }).catch(() => undefined);
}
