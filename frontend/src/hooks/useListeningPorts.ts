import { useCallback, useEffect, useRef, useState } from 'react';
import type { ListeningPortsSnapshot } from '../../../shared/types/listeningPorts';

/**
 * The host's listening ports, kept current by the host's `ports:changed` event. Null until the first read.
 * `refresh` asks the host to read them now; the host reads them only every minute while its terminals are quiet.
 */
export function useListeningPorts() {
  const [snapshot, setSnapshot] = useState<ListeningPortsSnapshot | null>(null);
  const loadRef = useRef<() => void>(() => {});

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
    loadRef.current = load;
    const unsubscribeChanges = window.electronAPI.events.onListeningPortsChanged(next => {
      version++;
      setSnapshot(next);
    });
    // Connecting to or leaving a remote host swaps whose ports these are.
    const unsubscribeResync = window.electronAPI.events.onRemoteDaemonResyncRequested?.(load);
    load();
    return () => {
      cancelled = true;
      loadRef.current = () => {};
      unsubscribeChanges();
      unsubscribeResync?.();
    };
  }, []);

  const refresh = useCallback(() => loadRef.current(), []);
  return { snapshot, refresh };
}
