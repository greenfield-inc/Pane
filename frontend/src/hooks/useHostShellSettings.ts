import { useCallback, useEffect, useState } from 'react';
import type { PreferredShell } from '../types/config';

interface AvailableShell {
  id: PreferredShell;
  name: string;
  path: string;
}

interface HostShellSettings {
  shells: AvailableShell[];
  preferredShell: PreferredShell;
}

/**
 * The active host's terminal shells. Terminals spawn on the host, so the shell is a host setting.
 * `shells` is empty unless the host runs Windows.
 */
export function useHostShellSettings(enabled = true) {
  const [settings, setSettings] = useState<HostShellSettings | null>(null);

  const load = useCallback(async () => {
    try {
      // SAFETY: `terminal:get-shell-settings` returns HostShellSettings.
      setSettings(await window.electronAPI.invoke('terminal:get-shell-settings') as HostShellSettings);
    } catch (error) {
      console.error('Failed to load host shell settings:', error);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void load();
    return window.electronAPI.events.onRemoteDaemonResyncRequested?.(() => void load());
  }, [enabled, load]);

  const setPreferredShell = useCallback(async (preferredShell: PreferredShell) => {
    await window.electronAPI.invoke('terminal:set-preferred-shell', preferredShell);
    setSettings(current => current && { ...current, preferredShell });
  }, []);

  return {
    shells: settings?.shells ?? [],
    preferredShell: settings?.preferredShell ?? 'auto',
    setPreferredShell,
  };
}
