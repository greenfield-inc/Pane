import * as SecureStore from 'expo-secure-store';
import { useState } from 'react';

const HIDDEN_KEY = 'composer.controllerHidden';

/**
 * Whether the floating controller shows, remembered on this device. Shown
 * until someone turns it off. Stored with expo-secure-store, the app's one
 * on-device store, which reads synchronously.
 */
export function useControllerShown(): [boolean, (shown: boolean) => void] {
  const [shown, setShown] = useState(() => SecureStore.getItem(HIDDEN_KEY) !== 'true');
  const save = (next: boolean) => {
    setShown(next);
    void (next ? SecureStore.deleteItemAsync(HIDDEN_KEY) : SecureStore.setItemAsync(HIDDEN_KEY, 'true')).catch(() => undefined);
  };
  return [shown, save];
}
