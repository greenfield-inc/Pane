import { useQueryClient } from '@tanstack/react-query';
import { createContext, use, useEffect, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import type { RemoteDaemonClient, RemoteDaemonConnectionState } from '@shared/remoteClient';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';

import { requestSharedCredentialSync } from '@/features/hosts/SharedCredentialSync';

import { createDaemonClient } from './createClient';

interface DaemonContextValue {
  client: RemoteDaemonClient;
  profile: RemotePaneConnectionProfile;
  connection: RemoteDaemonConnectionState;
}

const DaemonContext = createContext<DaemonContextValue | null>(null);

const OFFLINE_RETRY_MS = 15_000;

/**
 * Owns the connection to the active host. Render it with `key={profile.id}` so
 * switching hosts tears down the old client and its event stream.
 */
export function DaemonProvider({ profile, children }: { profile: RemotePaneConnectionProfile; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [binding, setBinding] = useState(() => ({ profile, client: createDaemonClient(profile) }));
  // Updating a saved host's password must replace its authenticated connection too.
  if (binding.profile.baseUrl !== profile.baseUrl || binding.profile.token !== profile.token) {
    setBinding({ profile, client: createDaemonClient(profile) });
  }
  const { client } = binding;
  const [connection, setConnection] = useState<RemoteDaemonConnectionState>(() => client.getState());

  useEffect(() => {
    // The stream does not replay missed events, so refetch everything once it
    // is back: after a drop, an error or a disconnect (app resume included).
    // Both transports report status; only some emit the host's `ready` event.
    // `onStatus` reports the new client's initial `local` state first; that is not a drop.
    let missedEvents: boolean | null = null;
    const unsubscribeStatus = client.onStatus(state => {
      if (missedEvents === null) missedEvents = false;
      else if (state.status === 'connected') {
        if (missedEvents) void queryClient.invalidateQueries({ queryKey: [profile.id] });
        missedEvents = false;
      } else if (state.status !== 'connecting') missedEvents = true;
      setConnection(state);
    });
    const connect = () => client.connect().catch(() => undefined);
    void connect();
    const appState = AppState.addEventListener('change', status => {
      const { status: current } = client.getState();
      if (status === 'active' && (current === 'error' || current === 'local')) void connect();
    });
    return () => {
      appState.remove();
      unsubscribeStatus();
      client.disconnect();
    };
  }, [client, profile.id, queryClient]);

  // Any client saved settings on the host (shortcuts, voice keys): refetch them once, and share any new key.
  useEffect(() => client.onEvent(event => {
    if (event.type !== 'daemon-event' || event.payload.channel !== 'remote:settings-changed') return;
    void queryClient.invalidateQueries({ queryKey: [profile.id, 'remote:pwa-affordances'] }, { cancelRefetch: false });
    requestSharedCredentialSync();
  }), [client, profile.id, queryClient]);

  // The client gives up after its reconnect backoff (about 30 s). A phone
  // changing networks or waking a sleeping Mac needs longer, so keep trying
  // while the app is open.
  useEffect(() => {
    if (connection.status !== 'error') return;
    const timer = setTimeout(() => {
      if (AppState.currentState === 'active') void client.connect().catch(() => undefined);
    }, OFFLINE_RETRY_MS);
    return () => clearTimeout(timer);
  }, [client, connection]);

  return <DaemonContext value={{ client, profile, connection }}>{children}</DaemonContext>;
}

export function useDaemon(): DaemonContextValue {
  const value = use(DaemonContext);
  if (!value) throw new Error('useDaemon must be used inside <DaemonProvider>');
  return value;
}
