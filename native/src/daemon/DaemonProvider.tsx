import { useQueryClient } from '@tanstack/react-query';
import { createContext, use, useEffect, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import type { RemoteDaemonClient, RemoteDaemonConnectionState } from '@shared/remoteClient';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';

import { requestSharedCredentialSync } from '@/features/hosts/SharedCredentialSync';
import { requestPushRegistration } from '@/features/notifications/usePushSetup';

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
  const [binding, setBinding] = useState(() => ({ profile, client: createDaemonClient(profile) }));
  // Updating a saved host's password must replace its authenticated connection too.
  if (binding.profile.baseUrl !== profile.baseUrl || binding.profile.token !== profile.token) {
    setBinding({ profile, client: createDaemonClient(profile) });
  }
  const { client } = binding;
  const [connection, setConnection] = useState<RemoteDaemonConnectionState>(() => client.getState());

  useEffect(() => {
    const unsubscribeRestore = client.onRestore(async signal => {
      await queryClient.refetchQueries({ queryKey: [profile.id], type: 'active' }, { throwOnError: true });
      if (signal.aborted) return;
      // A switch changed while this computer was away reaches it now.
      requestPushRegistration();
    }, 'workspace lists');
    const unsubscribeStatus = client.onStatus(setConnection);
    const connect = () => client.connect().catch(() => undefined);
    void connect();
    // Only a real trip to the background suspends. Control Center, Notification
    // Center and Face ID pass through 'inactive' and leave the connection live.
    const appState = AppState.addEventListener('change', status => {
      if (status === 'background') client.suspend();
      else if (status === 'active') {
        if (client.getState().status === 'local') void connect();
        else client.resume();
      }
    });
    return () => {
      appState.remove();
      unsubscribeStatus();
      unsubscribeRestore();
      client.disconnect();
    };
  }, [client, profile.id, queryClient]);

  // Any client saved settings on the host (shortcuts, voice keys): refetch them once, and share any new key.
  useEffect(() => client.onEvent(event => {
    if (event.type !== 'daemon-event' || event.payload.channel !== 'remote:settings-changed') return;
    void queryClient.invalidateQueries({ queryKey: [profile.id, 'remote:pwa-affordances'] }, { cancelRefetch: false });
    requestSharedCredentialSync();
  }), [client, profile.id, queryClient]);


  return <DaemonContext value={{ client, profile, connection }}>{children}</DaemonContext>;
}

export function useDaemon(): DaemonContextValue {
  const value = use(DaemonContext);
  if (!value) throw new Error('useDaemon must be used inside <DaemonProvider>');
  return value;
}
