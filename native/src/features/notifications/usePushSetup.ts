import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { create } from 'zustand';

import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';
import { boundary, decodeOptionalBoundary } from '@shared/validation/boundaryDecoder';

import { useHostsStore } from '@/auth/hostsStore';
import { secureStore } from '@/auth/secureStore';
import { invokeChannel } from '@/daemon';
import { createDaemonClient } from '@/daemon/createClient';
import { isDemoProfile } from '@/features/demo/demoHost';

import { devicePush, getInstallationId } from './device';
import { registerEverywhere, type PushHost, type PushPreferences, type PushSetupResult } from './registration';

/** Per phone, not per computer: every computer gets the same switches. */
const PREFERENCES_KEY = 'pane.native.pushPreferences';
const DEFAULT_PREFERENCES: PushPreferences = { needsInputEnabled: true, completedEnabled: true };
const REGISTER_DEBOUNCE_MS = 500;

interface PushState {
  preferences: PushPreferences;
  /** The last result per saved computer, by profile id. Missing means not checked yet. */
  results: Record<string, PushSetupResult>;
  setPreference(key: keyof PushPreferences, value: boolean): void;
}

export const usePushStore = create<PushState>(set => ({
  preferences: DEFAULT_PREFERENCES,
  results: {},
  setPreference: (key, value) => {
    set(state => {
      const preferences = { ...state.preferences, [key]: value };
      void secureStore.setItem(PREFERENCES_KEY, JSON.stringify(preferences)).catch(() => undefined);
      return { preferences };
    });
    requestPushRegistration();
  },
}));

const preferencesSchema = boundary.object({ needsInputEnabled: boundary.boolean, completedEnabled: boundary.boolean });
// Registration waits for the saved switches, so a default never overwrites one turned off.
const preferencesLoaded = secureStore.getItem(PREFERENCES_KEY).then(saved => {
  const preferences = saved ? decodeOptionalBoundary(JSON.parse(saved), preferencesSchema) : undefined;
  if (preferences) usePushStore.setState({ preferences });
}).catch(() => undefined);

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let pending = false;

/** Registers this phone with every saved computer, sending the current switches. Debounced. */
export function requestPushRegistration(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void run();
  }, REGISTER_DEBOUNCE_MS);
}

async function run(): Promise<void> {
  if (running) {
    pending = true;
    return;
  }
  running = true;
  try {
    await preferencesLoaded;
    const profiles = useHostsStore.getState().profiles.filter(profile => !isDemoProfile(profile));
    const saved = new Set(profiles.map(profile => profile.id));
    usePushStore.setState(state => ({
      results: Object.fromEntries(Object.entries(state.results).filter(([id]) => saved.has(id))),
    }));
    await registerEverywhere(devicePush, profiles.map(pushHost), usePushStore.getState().preferences, (id, result) => {
      if (!useHostsStore.getState().profiles.some(profile => profile.id === id)) return;
      usePushStore.setState(state => ({ results: { ...state.results, [id]: result } }));
    });
  } finally {
    running = false;
    if (pending) {
      pending = false;
      requestPushRegistration();
    }
  }
}

function pushHost(profile: RemotePaneConnectionProfile): PushHost {
  // Registration needs no workspace stream: each call is one request to that computer.
  const client = createDaemonClient(profile);
  return { profileId: profile.id, invoke: (channel, args) => invokeChannel(client, channel, args) };
}

/**
 * Keeps every saved computer's registration current: when the app opens or
 * returns to the foreground (notifications may have been turned on in
 * Settings), when the saved computers change, and when APNs or FCM rotates
 * this phone's token. Render it once, after saved hosts have loaded.
 */
export function PushRegistrationSync() {
  const profiles = useHostsStore(state => state.profiles);

  useEffect(() => {
    requestPushRegistration();
  }, [profiles]);

  useEffect(() => {
    const appState = AppState.addEventListener('change', status => {
      if (status === 'active') requestPushRegistration();
    });
    const token = Notifications.addPushTokenListener(() => requestPushRegistration());
    return () => {
      appState.remove();
      token.remove();
    };
  }, []);

  return null;
}

/** Best effort: stops this host from sending to this phone before its token is deleted. */
export async function revokePush(client: Parameters<typeof invokeChannel>[0], hostProfileId: string): Promise<void> {
  const revoke = getInstallationId().then(installationId =>
    invokeChannel(client, 'mobile:push-revoke', [{ platform: devicePush.platform, installationId, hostProfileId }]));
  await Promise.race([revoke, new Promise(resolve => setTimeout(resolve, 3_000))]).catch(() => undefined);
}
