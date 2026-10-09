import { useEffect, useState } from 'react';
import type { ListeningPortsSnapshot } from '../../../shared/types/listeningPorts';

/** The host's listening ports, kept current by the host's `ports:changed` event. Null until the first read. */
export function useListeningPorts(): ListeningPortsSnapshot | null {
  const [snapshot, setSnapshot] = useState<ListeningPortsSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Bumped by every read and every event, so a read applies only if nothing newer landed meanwhile.
    let version = 0;
    const load = () => {
      const requested = ++version;
      window.electronAPI.invoke('ports:list').then(
        (next: ListeningPortsSnapshot) => { if (!cancelled && requested === version) setSnapshot(next); },
        (error: Error) => console.error('[Ports] Failed to list ports:', error),
      );
    };
    const unsubscribeChanges = window.electronAPI.events.onListeningPortsChanged(next => {
      version++;
      setSnapshot(next);
    });
    // Connecting to or leaving a remote host swaps whose ports these are.
    const unsubscribeResync = window.electronAPI.events.onRemoteDaemonResyncRequested?.(load);
    load();
    return () => {
      cancelled = true;
      unsubscribeChanges();
      unsubscribeResync?.();
    };
  }, []);

  return snapshot;
}
