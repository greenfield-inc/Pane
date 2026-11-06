import { useCallback, useEffect, useState } from 'react';
import { API, type IPCResponse } from '../utils/api';
import {
  createDefaultCloudSandboxesSnapshot,
  type CloudSandboxesSnapshot,
} from '../../../shared/types/cloudSandboxes';

/** The outcome of a cloud sandbox request; row failures arrive on the row itself. */
type CloudSandboxRequestResult = { ok: true; snapshot: CloudSandboxesSnapshot } | { ok: false; error: string };

/** Live cloud sandboxes: fetched once while enabled, then pushed by main after every change. */
export function useCloudSandboxes(enabled = true) {
  const [snapshot, setSnapshot] = useState<CloudSandboxesSnapshot>(createDefaultCloudSandboxesSnapshot);
  const [loaded, setLoaded] = useState(false);

  // Saved host profiles reach the config store through remote-daemon:profiles-changed (see Sidebar).
  const applySnapshot = useCallback((next: CloudSandboxesSnapshot) => {
    setSnapshot(next);
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const unsubscribe = API.remoteDaemon.onCloudSandboxesChanged((next) => {
      if (!cancelled) applySnapshot(next);
    });
    void API.remoteDaemon.getCloudSandboxes().then((response) => {
      if (!cancelled && response.success && response.data) applySnapshot(response.data);
    }).catch((error) => {
      console.error('Failed to load cloud sandboxes:', error);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [applySnapshot, enabled]);

  const request = useCallback(async (
    send: () => Promise<IPCResponse<CloudSandboxesSnapshot>>,
  ): Promise<CloudSandboxRequestResult> => {
    try {
      const response = await send();
      if (!response.success || !response.data) return { ok: false, error: response.error || 'Cloud sandbox request failed' };
      applySnapshot(response.data);
      return { ok: true, snapshot: response.data };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Cloud sandbox request failed' };
    }
  }, [applySnapshot]);

  return { snapshot, loaded, request };
}
