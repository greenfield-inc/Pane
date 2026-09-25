import { useQueryClient } from '@tanstack/react-query';
import { createContext, use, useEffect, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import type { RemoteDaemonClient, RemoteDaemonConnectionState } from '@shared/remoteClient';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';

import { createDaemonClient } from './createClient';

interface DaemonContextValue {
  client: RemoteDaemonClient;
  profile: RemotePaneConnectionProfile;
  connection: RemoteDaemonConnectionState;
}

const DaemonContext = createContext<DaemonContextValue | null>(null);

/**
 * Owns the connection to the active host. Render it with `key={profile.id}` so
 * switching hosts tears down the old client and its event stream.
 */
export function DaemonProvider({ profile, children }: { profile: RemotePaneConnectionProfile; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [client] = useState(() => createDaemonClient(profile));
  const [connection, setConnection] = useState<RemoteDaemonConnectionState>(() => client.getState());

  useEffect(() => {
    const unsubscribeStatus = client.onStatus(setConnection);
    // The stream does not replay missed events, so refetch everything on (re)connect.
    const unsubscribeEvents = client.onEvent(event => {
      if (event.type === 'ready') void queryClient.invalidateQueries({ queryKey: [profile.id] });
    });
    const connect = () => client.connect().catch(() => undefined);
    void connect();
    const appState = AppState.addEventListener('change', status => {
      const { status: current } = client.getState();
      if (status === 'active' && (current === 'error' || current === 'local')) void connect();
    });
    return () => {
      appState.remove();
      unsubscribeEvents();
      unsubscribeStatus();
      client.disconnect();
    };
  }, [client, profile.id, queryClient]);

  return <DaemonContext value={{ client, profile, connection }}>{children}</DaemonContext>;
}

export function useDaemon(): DaemonContextValue {
  const value = use(DaemonContext);
  if (!value) throw new Error('useDaemon must be used inside <DaemonProvider>');
  return value;
}
