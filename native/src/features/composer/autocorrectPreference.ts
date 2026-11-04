import * as SecureStore from 'expo-secure-store';
import type { TextInputProps } from 'react-native';
import { create } from 'zustand';

const OFF_KEY = 'composer.autocorrectOff';

interface AutocorrectState {
  /** The phone's autocorrect and spell check in the boxes people write to agents in. On until turned off. */
  enabled: boolean;
  setEnabled(enabled: boolean): void;
}

/**
 * Settings › General › Autocorrect, remembered on this device (expo-secure-store,
 * read synchronously so the first frame already has it).
 */
export const useAutocorrect = create<AutocorrectState>(set => ({
  enabled: SecureStore.getItem(OFF_KEY) !== 'true',
  setEnabled: enabled => {
    set({ enabled });
    void (enabled ? SecureStore.deleteItemAsync(OFF_KEY) : SecureStore.setItemAsync(OFF_KEY, 'true')).catch(() => undefined);
  },
}));

/** Spread onto a box people write to agents in: `<TextInput {...useAutocorrectInputProps()} />`. */
export function useAutocorrectInputProps(): Pick<TextInputProps, 'autoCorrect' | 'spellCheck'> {
  const enabled = useAutocorrect(state => state.enabled);
  return { autoCorrect: enabled, spellCheck: enabled };
}
