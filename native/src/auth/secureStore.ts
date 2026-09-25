import * as SecureStore from 'expo-secure-store';

import type { KeyValueStore } from './hosts';

/** Keychain on iOS, Keystore-backed storage on Android. Items stay on this device. */
export const secureStore: KeyValueStore = {
  getItem: key => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value, {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  }),
  deleteItem: key => SecureStore.deleteItemAsync(key),
};
