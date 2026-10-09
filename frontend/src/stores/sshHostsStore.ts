import { useEffect } from 'react';
import { create } from 'zustand';
import { getActiveRemoteHostId } from '../../../shared/types/remoteDaemon';
import { SSH_HOSTS_SESSION_ID } from '../../../shared/types/sshHosts';
import { useConfigStore } from './configStore';
import { useNavigationStore } from './navigationStore';
import { usePanelStore } from './panelStore';
import { useSessionStore } from './sessionStore';

interface SshHostsState {
  /** Concrete Host aliases from the SSH config of the Pane this window drives. */
  hosts: string[];
  /** Aliases with an open tab in the SSH view. */
  openHosts: ReadonlySet<string>;
  error: string | null;
  /** Re-reads the SSH config. The files are small, so every trigger reads them again. */
  refresh: () => Promise<void>;
  /** Shows the host's tab in the SSH view, creating it when it has none or when `newTab` asks for another. */
  open: (alias: string, newTab?: boolean) => Promise<void>;
}

let refreshGeneration = 0;

export const useSshHostsStore = create<SshHostsState>((set, get) => ({
  hosts: [],
  openHosts: new Set(),
  error: null,

  refresh: async () => {
    const generation = ++refreshGeneration;
    const response = await window.electronAPI.sshHosts.list().catch(() => null);
    // A slower answer from before a host switch never overwrites a newer one.
    if (generation !== refreshGeneration) return;
    if (!response?.success || !response.data) {
      set({ hosts: [], openHosts: new Set() });
      return;
    }
    set({ hosts: response.data.hosts, openHosts: new Set(response.data.openHosts) });
  },

  open: async (alias, newTab = false) => {
    set({ error: null });
    const response = await window.electronAPI.sshHosts.open(alias, newTab).catch(() => null);
    if (!response?.success || !response.data) {
      set({ error: response?.error ?? `Could not open ${alias}` });
      void get().refresh();
      return;
    }
    usePanelStore.getState().setActivePanel(SSH_HOSTS_SESSION_ID, response.data.panelId);
    void useSessionStore.getState().setActiveSession(null);
    useNavigationStore.getState().navigateToSsh();
    void get().refresh();
  },
}));

/**
 * Keeps the host list current while the sidebar is mounted: on start, when the
 * window regains focus (the user may have just edited the config), when this
 * window starts driving another Pane, and when an SSH tab opens or closes.
 */
export function useSshHostsRefresh(): void {
  const refresh = useSshHostsStore(state => state.refresh);
  const hostId = useConfigStore(state => state.config ? getActiveRemoteHostId(state.config.remoteDaemon) : undefined);
  useEffect(() => {
    void refresh();
  }, [refresh, hostId]);
  useEffect(() => {
    const reread = () => { void refresh(); };
    window.addEventListener('focus', reread);
    const events = window.electronAPI.events;
    const created = events.onPanelCreated(panel => { if (panel.sessionId === SSH_HOSTS_SESSION_ID) reread(); });
    const deleted = events.onPanelDeleted(event => { if (event.sessionId === SSH_HOSTS_SESSION_ID) reread(); });
    return () => {
      window.removeEventListener('focus', reread);
      created();
      deleted();
    };
  }, [refresh]);
}
