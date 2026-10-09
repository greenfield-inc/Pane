import { useEffect, useState } from 'react';
import type { ListeningPortsSnapshot } from '../../../../shared/types/listeningPorts';
import type { RemoteRuntimeAdapter } from '../runtime/remoteRuntimeAdapter';

/** The host's listening ports with their phone addresses, kept current by `ports:changed`. Null until the first read. */
export function useRemoteListeningPorts(adapter: RemoteRuntimeAdapter | null): ListeningPortsSnapshot | null {
  // Kept with the host it came from, so switching hosts never shows the previous host's ports.
  const [read, setRead] = useState<{ adapter: RemoteRuntimeAdapter; snapshot: ListeningPortsSnapshot } | null>(null);

  useEffect(() => {
    if (!adapter) return;
    let cancelled = false;
    const load = () => {
      adapter.getListeningPorts().then(
        next => { if (!cancelled) setRead({ adapter, snapshot: next }); },
        (error: Error) => console.error('[Ports] Failed to list host ports:', error),
      );
    };
    load();
    const unsubscribeEvents = adapter.onEvent(event => {
      if (event.channel !== 'ports:changed' || !event.args[0]) return;
      // SAFETY: the host publishes ports:changed with one ListeningPortsSnapshot.
      const next = event.args[0] as ListeningPortsSnapshot;
      setRead({ adapter, snapshot: next });
    });
    // Events sent while the stream was down are lost: read again once it is back.
    const unsubscribeStatus = adapter.onStatus(state => { if (state.status === 'connected') load(); });
    return () => {
      cancelled = true;
      unsubscribeEvents();
      unsubscribeStatus();
    };
  }, [adapter]);

  return read?.adapter === adapter ? read.snapshot : null;
}
