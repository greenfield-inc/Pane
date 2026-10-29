import { useEffect } from 'react';
import { AppState } from 'react-native';

import { syncSharedCredentials, type SharedCredentialHost, type SharedCredentials } from '@shared/types/sharedCredentials';

import { useHostsStore } from '@/auth/hostsStore';
import { createDaemonClient } from '@/daemon/createClient';
import { requestPushRegistration } from '@/features/notifications/usePushSetup';

const SYNC_DEBOUNCE_MS = 500;
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let pending = false;

/**
 * Copies the newest integration keys between every host this phone has saved.
 * The phone relays keys and keeps no copy. Hosts too old to share keys, out of
 * reach, or owned by someone else are skipped until a later sync.
 */
export function requestSharedCredentialSync(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void run();
  }, SYNC_DEBOUNCE_MS);
}

async function run(): Promise<void> {
  if (running) {
    pending = true;
    return;
  }
  running = true;
  try {
    // A computer reached over Tailscale shares keys only with its owner and refuses everyone else.
    const profiles = useHostsStore.getState().profiles;
    if (profiles.length < 2) return;
    const hosts = profiles.map((profile): SharedCredentialHost => {
      const client = createDaemonClient(profile);
      return {
        read: () => client.invoke<SharedCredentials>('credentials:shared:get', []),
        apply: async credentials => { await client.invoke('credentials:shared:apply', [credentials]); },
      };
    });
    // A computer that just got the push key can now register this phone.
    const { updated } = await syncSharedCredentials(hosts);
    if (updated > 0) requestPushRegistration();
  } finally {
    running = false;
    if (pending) {
      pending = false;
      requestSharedCredentialSync();
    }
  }
}

/** Syncs when the app opens or returns to the foreground, and when the host list changes. */
export function SharedCredentialSync() {
  const profiles = useHostsStore(state => state.profiles);

  useEffect(() => {
    requestSharedCredentialSync();
  }, [profiles]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', status => {
      if (status === 'active') requestSharedCredentialSync();
    });
    return () => subscription.remove();
  }, []);

  return null;
}
