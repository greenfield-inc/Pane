import { useCallback, useEffect, useState } from 'react';
import type { ComputerUseEngineChoice, ComputerUseReadiness } from '../../../shared/types/computerUse';

const CLOCK_TICK_MS = 30_000;

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

  const refresh = useCallback(async () => {
    try {
      setReadiness(await window.electronAPI.computerUseReadiness.get());
      setUnsupported(false);
      setError(null);
    } catch {
      setReadiness(null);
      setUnsupported(true);
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
    try {
      setReadiness(await action());
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
