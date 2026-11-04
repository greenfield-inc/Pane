import { useEffect, useState } from 'react';
import {
  CONNECTION_GRACE_MS,
  connectionNotice,
  connectionPresence,
  type ConnectionNotice,
  type ConnectionPresence,
} from '../../../shared/remoteClient/connectionPresence';
import type { RemotePaneConnectionState } from '../../../shared/types/remoteDaemon';

const TICK_MS = 1_000;
/** Renderer timers stop while the machine sleeps, so a tick this late means it just woke. */
const WAKE_GAP_MS = 5_000;

export interface RemoteConnectionPresence {
  presence: ConnectionPresence;
  /** The bar's wording once the grace window has passed, else null. */
  notice: ConnectionNotice | null;
}

/**
 * The machine dot and grace-window notice for the remote connection. The window
 * counts only time the person could see: it restarts when the machine wakes or
 * the window becomes visible again. Local mode is always connected.
 */
export function useConnectionPresence(state: RemotePaneConnectionState): RemoteConnectionPresence {
  const remote = state.mode === 'remote';
  const down = remote && state.status !== 'connected';
  const [pastGrace, setPastGrace] = useState(false);

  useEffect(() => {
    if (!down) return;
    let downSince = Date.now();
    let lastTick = downSince;
    const timer = setInterval(() => {
      const now = Date.now();
      if (now - lastTick > WAKE_GAP_MS) downSince = now;
      lastTick = now;
      setPastGrace(now - downSince >= CONNECTION_GRACE_MS);
    }, TICK_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      downSince = Date.now();
      lastTick = downSince;
      setPastGrace(false);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      setPastGrace(false);
    };
  }, [down]);

  if (!remote) return { presence: 'connected', notice: null };
  // The shared rule only compares against the grace window, so its edge stands in for the elapsed time.
  const downForMs = down && pastGrace ? CONNECTION_GRACE_MS : 0;
  return {
    presence: connectionPresence(state.status, downForMs),
    notice: connectionNotice(state, downForMs, state.activeProfileLabel ?? 'the remote host'),
  };
}
