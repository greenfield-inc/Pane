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
  /** What the sidebar lists: the config's hosts, then hosts the config dropped that still have a tab. */
  rows: string[];
  error: string | null;
  /** Re-reads the SSH config. The files are small, so every trigger reads them again. */
  refresh: () => Promise<void>;
  /** Shows the host's tab in the SSH view, creating it when it has none or when `newTab` asks for another. */
  open: (alias: string, newTab?: boolean) => Promise<void>;
}

let refreshGeneration = 0;

/** The Pane a config points this window at: undefined before config loads, null for this computer. */
function controlledHostId(config: ReturnType<typeof useConfigStore.getState>['config']): string | null | undefined {
  return config ? getActiveRemoteHostId(config.remoteDaemon) : undefined;
}

/**
 * Counts every switch of the Pane this window controls. An answer is only
 * applied if no switch happened while it was in flight, so switching away and
 * back still retires it.
 */
let hostSwitches = 0;
useConfigStore.subscribe((state, previous) => {
  if (controlledHostId(state.config) !== controlledHostId(previous.config)) hostSwitches += 1;
});

export const useSshHostsStore = create<SshHostsState>((set, get) => ({
  hosts: [],
  openHosts: new Set(),
  rows: [],
  error: null,

  refresh: async () => {
    const generation = ++refreshGeneration;
    const response = await window.electronAPI.sshHosts.list().catch(() => null);
    // A slower answer from before a host switch never overwrites a newer one.
    if (generation !== refreshGeneration) return;
    if (!response?.success || !response.data) {
      set({ hosts: [], openHosts: new Set(), rows: [] });
      return;
    }
    const { hosts, openHosts } = response.data;
    set({ hosts, openHosts: new Set(openHosts), rows: [...new Set([...hosts, ...openHosts])] });
  },

  open: async (alias, newTab = false) => {
    const switches = hostSwitches;
    set({ error: null });
    const response = await window.electronAPI.sshHosts.open(alias, newTab).catch(() => null);
    // The answer belongs to the Pane the click went to; after any switch it would move another view.
    if (hostSwitches !== switches) return;
    if (response?.success && response.data) {
      usePanelStore.getState().setActivePanel(SSH_HOSTS_SESSION_ID, response.data.panelId);
    } else {
      // The SSH view shows the message, so a failed click from anywhere still explains itself.
      set({ error: response?.error ?? `Could not open ${alias}. Try again, and if it keeps failing, check the connection to the machine this window controls.` });
      void get().refresh();
    }
    void useSessionStore.getState().setActiveSession(null);
    useNavigationStore.getState().navigateToSsh();
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
