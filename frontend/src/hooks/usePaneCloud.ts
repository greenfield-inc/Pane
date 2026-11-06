import { useCallback, useEffect, useState } from 'react';
import { API, type IPCResponse } from '../utils/api';
import { SIGNED_OUT_PANE_CLOUD, type PaneCloudSnapshot } from '../../../shared/types/paneCloud';

/** Live Pane Cloud state: fetched once while enabled, then pushed by main after every change. */
export function usePaneCloud(enabled = true) {
  const [snapshot, setSnapshot] = useState<PaneCloudSnapshot>(SIGNED_OUT_PANE_CLOUD);
  const [loaded, setLoaded] = useState(false);

  const apply = useCallback((next: PaneCloudSnapshot) => {
    setSnapshot(next);
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const unsubscribe = API.paneCloud.onChanged((next) => {
      if (!cancelled) apply(next);
    });
    void API.paneCloud.get().then((response) => {
      if (!cancelled && response.success && response.data) apply(response.data);
    }).catch((error) => {
      console.error('Failed to load Pane Cloud:', error);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [apply, enabled]);

  /** Main answers every call with the new snapshot; failures arrive in its `error`. */
  const run = useCallback(async (call: () => Promise<IPCResponse<PaneCloudSnapshot>>) => {
    try {
      const response = await call();
      if (response.success && response.data) apply(response.data);
    } catch (error) {
      setSnapshot((current) => ({ ...current, busy: null, error: { message: error instanceof Error ? error.message : String(error), next: null } }));
    }
  }, [apply]);

  return { snapshot, loaded, run };
}
