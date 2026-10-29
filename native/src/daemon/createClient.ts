import Constants from 'expo-constants';
import { fetch as expoFetch } from 'expo/fetch';
import { Platform } from 'react-native';

import {
  createFetchEventStreamTransport,
  getOrCreateRuntimeId,
  RemoteDaemonClient,
} from '@shared/remoteClient';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';

import { secureStore } from '@/auth/secureStore';
import { demoConnection, isDemoProfile } from '@/features/demo/demoHost';

// expo/fetch streams response bodies, which the /events stream needs.
export const streamingFetch = expoFetch;

export const CLIENT_LABEL = Platform.OS === 'ios' ? 'Pane for iOS' : 'Pane for Android';

/**
 * The phone's own name, so desktops say "Answered on Parsa's iPhone". iOS 16+ reports only
 * "iPhone" without Apple's user-assigned-device-name entitlement; Android reports the name set
 * in Settings.
 */
export const DEVICE_LABEL = Constants.deviceName?.trim() || undefined;

export function getRuntimeId(): Promise<string> {
  return getOrCreateRuntimeId(
    { getItem: secureStore.getItem, setItem: secureStore.setItem },
    createInstallId,
  );
}

export function createDaemonClient(profile: RemotePaneConnectionProfile): RemoteDaemonClient {
  return new RemoteDaemonClient({
    profile,
    // The demo's sample computers answer in the app, whichever screen builds the client.
    ...(isDemoProfile(profile)
      ? demoConnection()
      : { transport: createFetchEventStreamTransport(streamingFetch), fetch: streamingFetch }),
    runtimeId: getRuntimeId,
    clientLabel: CLIENT_LABEL,
    deviceLabel: DEVICE_LABEL,
    // Mobile networks drop idle sockets silently; the host heartbeats every 5 s.
    staleStreamTimeoutMs: 20_000,
  });
}

/** Random per-install ID. It identifies this install to the host and is not a secret. */
function createInstallId(): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `pane-native-${hex}`;
}
