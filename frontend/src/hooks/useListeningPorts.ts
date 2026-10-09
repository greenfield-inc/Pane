import { useEffect, useState } from 'react';
import type { ListeningPortsSnapshot } from '../../../shared/types/listeningPorts';

/** The host's listening ports, kept current by the host's `ports:changed` event. Null until the first read. */
export function useListeningPorts(): ListeningPortsSnapshot | null {
  const [snapshot, setSnapshot] = useState<ListeningPortsSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      window.electronAPI.invoke('ports:list').then(
        (next: ListeningPortsSnapshot) => { if (!cancelled) setSnapshot(next); },
        (error: Error) => console.error('[Ports] Failed to list ports:', error),
      );
    };
    load();
    const unsubscribeChanges = window.electronAPI.events.onListeningPortsChanged(setSnapshot);
    // Connecting to or leaving a remote host swaps whose ports these are.
    const unsubscribeResync = window.electronAPI.events.onRemoteDaemonResyncRequested?.(load);
    return () => {
      cancelled = true;
      unsubscribeChanges();
      unsubscribeResync?.();
    };
  }, []);

  return snapshot;
}
