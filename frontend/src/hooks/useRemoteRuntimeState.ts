import { useEffect, useState } from 'react';
import { API } from '../utils/api';
import {
  createDefaultRemoteDaemonHostRuntimeState,
  createDefaultRemotePaneConnectionState,
  type RemoteDaemonHostRuntimeState,
  type RemotePaneConnectionState,
} from '../../../shared/types/remoteDaemon';

/**
 * Live Remote Pane connection + host state: fetched once, then pushed by main.
 * `connectionKnown` is false until the first connection state arrives; until
 * then `connectionState` is only the local default.
 */
export function useRemoteRuntimeState() {
  const [connectionState, setConnectionState] = useState<RemotePaneConnectionState>(createDefaultRemotePaneConnectionState);
  const [connectionKnown, setConnectionKnown] = useState(false);
  const [hostState, setHostState] = useState<RemoteDaemonHostRuntimeState>(createDefaultRemoteDaemonHostRuntimeState);

  useEffect(() => {
    let cancelled = false;
    let connectionUpdated = false;
    let hostUpdated = false;
    const applyConnectionState = (state: RemotePaneConnectionState) => {
      setConnectionState(state);
      setConnectionKnown(true);
    };

    // Fetched separately: the host read waits on slower executable-health checks.
    const fetchConnectionState = async () => {
      try {
        const response = await API.remoteDaemon.getConnectionState();
        if (!cancelled && !connectionUpdated && response.success && response.data) applyConnectionState(response.data);
      } catch (error) {
        console.error('Failed to fetch remote connection state:', error);
      }
    };
    const fetchHostState = async () => {
      try {
        const response = await API.remoteDaemon.getHostState();
        if (!cancelled && !hostUpdated && response.success && response.data) setHostState(response.data);
      } catch (error) {
        console.error('Failed to fetch remote host state:', error);
      }
    };

    const unsubscribeConnectionState = API.remoteDaemon.onConnectionStateChanged(state => {
      connectionUpdated = true;
      applyConnectionState(state);
    });
    const unsubscribeHostState = API.remoteDaemon.onHostStateChanged(state => {
      hostUpdated = true;
      setHostState(state);
    });
    void fetchConnectionState();
    void fetchHostState();

    return () => {
      cancelled = true;
      unsubscribeConnectionState();
      unsubscribeHostState();
    };
  }, []);

  return { connectionState, connectionKnown, hostState };
}
