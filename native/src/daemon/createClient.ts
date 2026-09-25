import { fetch as expoFetch } from 'expo/fetch';
import { Platform } from 'react-native';

import {
  createFetchEventStreamTransport,
  getOrCreateRuntimeId,
  RemoteDaemonClient,
} from '@shared/remoteClient';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';

import { secureStore } from '@/auth/secureStore';

// expo/fetch streams response bodies, which the /events stream needs.
const streamingFetch = expoFetch;

const CLIENT_LABEL = Platform.OS === 'ios' ? 'Pane for iOS' : 'Pane for Android';

function getRuntimeId(): Promise<string> {
  return getOrCreateRuntimeId(
    { getItem: secureStore.getItem, setItem: secureStore.setItem },
    createInstallId,
  );
}

export function createDaemonClient(profile: RemotePaneConnectionProfile): RemoteDaemonClient {
  return new RemoteDaemonClient({
    profile,
    transport: createFetchEventStreamTransport(streamingFetch),
    fetch: streamingFetch,
    runtimeId: getRuntimeId,
    clientLabel: CLIENT_LABEL,
    // Mobile networks drop idle sockets silently; the host heartbeats every 5 s.
    staleStreamTimeoutMs: 20_000,
  });
}

/** Random per-install ID. It identifies this install to the host and is not a secret. */
function createInstallId(): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `pane-native-${hex}`;
}
