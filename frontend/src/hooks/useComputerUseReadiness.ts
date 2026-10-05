import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComputerUseEngineChoice, ComputerUseReadiness } from '../../../shared/types/computerUse';

const CLOCK_TICK_MS = 30_000;
// A host whose Pane predates computer use has no handler for the channel.
const UNSUPPORTED_HOST = /No Pane daemon command registered/;

/**
 * Computer-use readiness of the machine Pane is connected to, pushed by its daemon.
 * `connectionKey` changes when the host switcher picks another machine, which refetches.
 * `readiness` stays null while loading; `unsupported` is set when the host's Pane predates computer use.
 */
export function useComputerUseReadiness(connectionKey: string) {
  const [readiness, setReadiness] = useState<ComputerUseReadiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Bumped per request, so a response from before a host switch never lands under the new host.
  const latestRequest = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++latestRequest.current;
    try {
      const next = await window.electronAPI.computerUseReadiness.get();
      if (request !== latestRequest.current) return;
      setReadiness(next);
      setUnsupported(false);
      setError(null);
    } catch (cause) {
      if (request !== latestRequest.current) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      setReadiness(null);
      setUnsupported(UNSUPPORTED_HOST.test(message));
      setError(UNSUPPORTED_HOST.test(message) ? null : message);
    }
  }, []);

  useEffect(() => {
    setReadiness(null);
    void refresh();
    return window.electronAPI.events.onComputerUseReadinessChanged(() => void refresh());
  }, [connectionKey, refresh]);

  // Keeps "checked 5 min ago" current.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const run = useCallback(async (action: () => Promise<ComputerUseReadiness>) => {
    const request = ++latestRequest.current;
    try {
      const next = await action();
      if (request !== latestRequest.current) return;
      setReadiness(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  return {
    readiness,
    unsupported,
    error,
    now,
    setEnabled: (enabled: boolean, engine?: ComputerUseEngineChoice) =>
      run(() => window.electronAPI.computerUseReadiness.set({ enabled, engine })),
    recheck: () => run(() => window.electronAPI.computerUseReadiness.recheck()),
    openPermissionSettings: () => void window.electronAPI.computerUseReadiness.openPermissionSettings(),
  };
}
