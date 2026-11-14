import { useEffect } from 'react';

import { fetchNewRelayProfiles, isRelayProfile } from '@shared/remoteClient';

import { useHostsStore } from '@/auth/hostsStore';
import { useDaemon } from '@/daemon';

/**
 * "Your computers": each time the phone connects to a relay computer, it asks that computer for
 * the computers linked with it and saves the ones it doesn't have, each with its own token.
 */
export function RelayComputerSync() {
  const { client, profile, connection } = useDaemon();
  const addHosts = useHostsStore(state => state.addMany);
  const connected = connection.status === 'connected';
  useEffect(() => {
    if (!connected || !isRelayProfile(profile)) return;
    let cancelled = false;
    void fetchNewRelayProfiles(client, profile, useHostsStore.getState().profiles)
      .then(added => { if (!cancelled && added.length) return addHosts(added, null); })
      .catch((error: unknown) => console.info('[relay] could not refresh your computers', error));
    return () => { cancelled = true; };
  }, [connected, client, profile, addHosts]);
  return null;
}
