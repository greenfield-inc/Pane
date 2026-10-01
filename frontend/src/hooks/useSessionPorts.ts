import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionPortOpenRequest, SessionPortsSnapshot } from '../../../shared/types/sessionPorts';
import {
  createSessionPortsSync,
  type SessionPortsState,
  type SessionPortsSync,
  type SessionPortsTransport,
} from '../services/sessionPortsSync';

interface SessionPortsView {
  sync: SessionPortsSync;
  host: string;
  snapshot: SessionPortsSnapshot;
}

interface SessionPortsController {
  /** The connected host's newest list, kept through a failed re-read; null until the first one and after a switch. */
  snapshot: SessionPortsSnapshot | null;
  /** The transport's key for the host `snapshot` came from. */
  host: string | null;
  state: SessionPortsState;
  /** Act on the host `snapshot` came from; refused once the connection has moved to another host. */
  open(request: SessionPortOpenRequest): Promise<void>;
  close(target: number | string): Promise<void>;
  retry(): void;
}

/** Subscribes to one daemon's Session ports for as long as `transport` is stable. */
export function useSessionPorts(transport: SessionPortsTransport | null): SessionPortsController {
  const [state, setState] = useState<SessionPortsState>({ status: 'loading' });
  const [view, setView] = useState<SessionPortsView | null>(null);
  const syncRef = useRef<SessionPortsSync | null>(null);

  useEffect(() => {
    setView(null);
    if (!transport) {
      setState({ status: 'unsupported' });
      return;
    }
    const sync = createSessionPortsSync(transport, next => {
      setState(next);
      if (next.status === 'ready') setView({ sync, host: next.host, snapshot: next.snapshot });
      if (next.status === 'unsupported' || next.status === 'loading') setView(null);
    });
    syncRef.current = sync;
    return () => {
      sync.dispose();
      if (syncRef.current === sync) syncRef.current = null;
    };
  }, [transport]);

  // Bound to the rendered list's sync and host, never to whichever host is connected at click time.
  const actions = useMemo(() => ({
    open: async (request: SessionPortOpenRequest) => { await view?.sync.open(view.host, request); },
    close: async (target: number | string) => { await view?.sync.close(view.host, target); },
  }), [view]);
  const retry = useCallback(() => { void syncRef.current?.refresh(); }, []);

  return { snapshot: view?.snapshot ?? null, host: view?.host ?? null, state, ...actions, retry };
}
