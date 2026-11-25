import { useQueryClient, type Query } from '@tanstack/react-query';
import { createContext, use, useEffect, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import type { RemoteDaemonClient, RemoteDaemonConnectionState } from '@shared/remoteClient';
import type { RemotePaneConnectionProfile } from '@shared/types/remoteDaemon';

import { isReadOnlyProfile, useAccessStore } from '@/auth/access';
import { requestSharedCredentialSync } from '@/features/hosts/SharedCredentialSync';
import { AFTER_RETURN_MS, requestPushRegistration } from '@/features/notifications/usePushSetup';
import { connectionMark, markNextFrame, startJourney } from '@/features/perf/perfMarks';

import { createDaemonClient, streamingFetch } from './createClient';
import { startDirectRoute } from './direct/directRoute';
import { readOnScreen } from './screenFocus';

interface DaemonContextValue {
  client: RemoteDaemonClient;
  profile: RemotePaneConnectionProfile;
  connection: RemoteDaemonConnectionState;
}

const DaemonContext = createContext<DaemonContextValue | null>(null);

/** The first provider is the launch; every later one is a machine switch. */
let providersMounted = 0;


/**
 * Owns the connection to the active host. Render it with `key={profile.id}` so
 * switching hosts tears down the old client and its event stream.
 */
export function DaemonProvider({ profile, children }: { profile: RemotePaneConnectionProfile; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [binding, setBinding] = useState(() => {
    providersMounted += 1;
    if (providersMounted > 1) {
      startJourney('switch');
      markNextFrame(['switch']);
    }
    return { profile, client: createDaemonClient(profile) };
  });
  // Updating a saved host's password must replace its authenticated connection too.
  if (binding.profile.baseUrl !== profile.baseUrl || binding.profile.token !== profile.token) {
    setBinding({ profile, client: createDaemonClient(profile) });
  }
  const { client } = binding;
  const [connection, setConnection] = useState<RemoteDaemonConnectionState>(() => client.getState());

  useEffect(() => {
    // When the connection last stopped being live: lists answered before then may have missed events.
    let since = Date.now();
    const unsubscribeRestore = client.onRestore(async () => {
      // The stream replays nothing, so each open list reads again: once. A read already on its way
      // since the return (the focus refetch) is joined, a list answered since then is skipped, and
      // one list failing (a channel an older host lacks) fails only itself. Nothing here holds up
      // the connection: screens show what they have and update as the answers land.
      // Lists only a screen out of view reads (Home under a Pane) wait until it is in view again,
      // so the screen in view gets the connection first.
      const missed = (query: Query) => query.state.dataUpdatedAt < since;
      void queryClient.invalidateQueries({ queryKey: [profile.id], refetchType: 'none', predicate: query => missed(query) && !readOnScreen(query) });
      void queryClient.refetchQueries(
        { queryKey: [profile.id], type: 'active', predicate: query => missed(query) && readOnScreen(query) },
        { cancelRefetch: false },
      ).then(() => connectionMark('restored=workspace-lists', { repeat: true }));
      // A switch changed while this computer was away reaches it, after the screen's own reads.
      requestPushRegistration(AFTER_RETURN_MS);
    }, 'workspace lists');
    let lastStatus = client.getState().status;
    const unsubscribeStatus = client.onStatus(state => {
      connectionMark(`status=${state.status}`, { changes: true });
      // A trip to the background suspends the connection, and a drop with the app open (the host
      // slept or restarted, the network changed) reconnects it: either way the stream missed events.
      if (lastStatus === 'connected' && state.status !== 'connected') since = Date.now();
      lastStatus = state.status;
      setConnection(state);
    });
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

  // A relay computer's direct connection lives as long as its client.
  useEffect(() => startDirectRoute(binding.profile, client, streamingFetch), [binding.profile, client]);

  // Any client saved settings on the host (shortcuts, voice keys): refetch them once, and share any new key.
  useEffect(() => client.onEvent(event => {
    if (event.type !== 'daemon-event' || event.payload.channel !== 'remote:settings-changed') return;
    void queryClient.invalidateQueries({ queryKey: [profile.id, 'remote:pwa-affordances'] }, { cancelRefetch: false });
    requestSharedCredentialSync();
  }), [client, profile.id, queryClient]);

  // The computer's answer changed what this phone may read there: lists read under the old level read again.
  useEffect(() => useAccessStore.subscribe((now, before) => {
    if (isReadOnlyProfile(profile, now.levels) !== isReadOnlyProfile(profile, before.levels)) void queryClient.invalidateQueries({ queryKey: [profile.id] });
  }), [profile, queryClient]);

  return <DaemonContext value={{ client, profile, connection }}>{children}</DaemonContext>;
}

export function useDaemon(): DaemonContextValue {
  const value = use(DaemonContext);
  if (!value) throw new Error('useDaemon must be used inside <DaemonProvider>');
  return value;
}
