import { useNavigationContainerRef } from 'expo-router';
import { useSyncExternalStore } from 'react';

/**
 * Whether the root navigator can take `router` calls. A screen's first effects run before the
 * navigator registers itself, so a screen the app starts on (a link, a tap, a restart) waits for it.
 */
export function useNavigatorReady(): boolean {
  const navigation = useNavigationContainerRef();
  return useSyncExternalStore(
    changed => {
      const ready = navigation.addListener('ready', changed);
      const state = navigation.addListener('state', changed);
      return () => {
        ready();
        state();
      };
    },
    () => navigation.isReady(),
  );
}
