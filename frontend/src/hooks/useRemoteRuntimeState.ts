import { useEffect, useState } from 'react';
import { API } from '../utils/api';
import {
  createDefaultRemoteDaemonHostRuntimeState,
  createDefaultRemotePaneConnectionState,
  type RemoteDaemonHostRuntimeState,
  type RemotePaneConnectionState,
} from '../../../shared/types/remoteDaemon';

/** Live Remote Pane connection + host state: fetched once, then pushed by main. */
export function useRemoteRuntimeState() {
  const [connectionState, setConnectionState] = useState<RemotePaneConnectionState>(createDefaultRemotePaneConnectionState);
  const [hostState, setHostState] = useState<RemoteDaemonHostRuntimeState>(createDefaultRemoteDaemonHostRuntimeState);

  useEffect(() => {
    let cancelled = false;
    let connectionUpdated = false;
    let hostUpdated = false;

    const fetchRemoteState = async () => {
      try {
        const [connectionResponse, hostResponse] = await Promise.all([
          API.remoteDaemon.getConnectionState(),
          API.remoteDaemon.getHostState(),
        ]);

        if (!cancelled && !connectionUpdated && connectionResponse.success && connectionResponse.data) {
          setConnectionState(connectionResponse.data);
        }
        if (!cancelled && !hostUpdated && hostResponse.success && hostResponse.data) {
          setHostState(hostResponse.data);
        }
      } catch (error) {
        console.error('Failed to fetch remote runtime state:', error);
      }
    };

    const unsubscribeConnectionState = API.remoteDaemon.onConnectionStateChanged(state => {
      connectionUpdated = true;
      setConnectionState(state);
    });
    const unsubscribeHostState = API.remoteDaemon.onHostStateChanged(state => {
      hostUpdated = true;
      setHostState(state);
    });
    void fetchRemoteState();

    return () => {
      cancelled = true;
      unsubscribeConnectionState();
      unsubscribeHostState();
    };
  }, []);

  return { connectionState, hostState };
}
