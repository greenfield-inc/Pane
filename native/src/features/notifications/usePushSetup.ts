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
import { createWriteGate, preferencesFrom, registerEverywhere, type PushHost, type PushPreferences, type PushSetupResult } from './registration';

/** Per phone, not per computer: every computer gets the same switches. */
const PREFERENCES_KEY = 'pane.native.pushPreferences';
const DEFAULT_PREFERENCES: PushPreferences = { needsInputEnabled: true, completedEnabled: true };
const REGISTER_DEBOUNCE_MS = 500;

interface PushState {
  preferences: PushPreferences;
  /**
   * `saved`: the phone's own switches, sent to every computer. `absent`: never chosen on this phone,
   * so the first pass adopts what the computers had. `unreadable`: storage failed, so nothing is sent.
   */
  preferencesSource: 'saved' | 'absent' | 'unreadable';
  /** The last result per saved computer, by profile id. Missing means not checked yet. */
  results: Record<string, PushSetupResult>;
  setPreference(key: keyof PushPreferences, value: boolean): void;
}

export const usePushStore = create<PushState>(set => ({
  preferences: DEFAULT_PREFERENCES,
  preferencesSource: 'absent',
  results: {},
  setPreference: (key, value) => {
    set(state => {
      const preferences = { ...state.preferences, [key]: value };
      savePreferences(preferences);
      return { preferences, preferencesSource: 'saved' };
    });
    requestPushRegistration();
  },
}));

const preferencesSchema = boundary.object({ needsInputEnabled: boundary.boolean, completedEnabled: boundary.boolean });
// Registration waits for the saved switches, so a default never overwrites one turned off.
const preferencesLoaded = secureStore.getItem(PREFERENCES_KEY).then(saved => {
  if (!saved) return;
  const preferences = decodeOptionalBoundary(JSON.parse(saved), preferencesSchema);
  usePushStore.setState(preferences ? { preferences, preferencesSource: 'saved' } : { preferencesSource: 'unreadable' });
}).catch(() => usePushStore.setState({ preferencesSource: 'unreadable' }));

function savePreferences(preferences: PushPreferences): void {
  void secureStore.setItem(PREFERENCES_KEY, JSON.stringify(preferences)).catch(() => undefined);
}

/** Orders Sign Out after any registration write to that computer. */
const gate = createWriteGate();

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
    const { preferences, preferencesSource } = usePushStore.getState();
    const results = await registerEverywhere(devicePush, profiles.map(pushHost), preferencesSource === 'saved' ? preferences : null, (id, result) => {
      if (!isSaved(id)) return;
      usePushStore.setState(state => ({ results: { ...state.results, [id]: result } }));
    });
    if (preferencesSource !== 'saved') adoptPreferences(results, preferencesSource);
  } finally {
    running = false;
    if (pending) {
      pending = false;
      requestPushRegistration();
    }
  }
}

/**
 * Shows the switches the computers already had. A phone that never chose them saves that as its
 * own and sends it everywhere; one whose storage failed shows it without saving or sending.
 */
function adoptPreferences(results: Record<string, PushSetupResult>, source: 'absent' | 'unreadable'): void {
  if (!Object.values(results).some(result => result.state === 'registered')) return;
  const preferences = preferencesFrom(results);
  if (source === 'unreadable') {
    usePushStore.setState({ preferences });
    return;
  }
  savePreferences(preferences);
  usePushStore.setState({ preferences, preferencesSource: 'saved' });
  const differs = Object.values(results).some(result => result.state === 'registered'
    && (result.status.needsInputEnabled !== preferences.needsInputEnabled || result.status.completedEnabled !== preferences.completedEnabled));
  if (differs) requestPushRegistration();
}

function isSaved(profileId: string): boolean {
  return useHostsStore.getState().profiles.some(profile => profile.id === profileId);
}

function pushHost(profile: RemotePaneConnectionProfile): PushHost {
  // Registration needs no workspace stream: each call is one request to that computer.
  const client = createDaemonClient(profile);
  return gate.host(profile.id, (channel, args) => invokeChannel(client, channel, args), () => isSaved(profile.id));
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

/**
 * Signs this phone out of a computer: stops its alerts here, best effort within 3 s, then
 * `remove` forgets the profile. A registration already on its way lands before the revoke.
 */
export function signOutPush(profile: RemotePaneConnectionProfile, remove: () => void): Promise<void> {
  const revoke = async () => {
    const installationId = await getInstallationId();
    await invokeChannel(createDaemonClient(profile), 'mobile:push-revoke', [{ platform: devicePush.platform, installationId, hostProfileId: profile.id }]);
  };
  const bounded = () => Promise.race([revoke(), new Promise(resolve => setTimeout(resolve, 3_000))]).then(() => undefined, () => undefined);
  return gate.close(profile.id, bounded, remove);
}
