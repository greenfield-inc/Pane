import { useCallback, useEffect, useRef, useState } from 'react';
import { PORTS_QUIET_INTERVAL_MS, type ListeningPortsSnapshot } from '../../../shared/types/listeningPorts';

/**
 * The host's listening ports, kept current by the host's `ports:changed` event. Null until the first read.
 * While its terminals are quiet the host reads ports only when asked: `refresh` asks now, and `onScreen`
 * asks once a minute while the window is visible, so a shown list finds ports opened outside Pane.
 */
export function useListeningPorts({ onScreen = false }: { onScreen?: boolean } = {}) {
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

  useEffect(() => {
    if (!onScreen) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') loadRef.current();
    }, PORTS_QUIET_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [onScreen]);

  const refresh = useCallback(() => loadRef.current(), []);
  return { snapshot, refresh };
}
