import { useCallback, useEffect, useMemo, useState } from 'react';
import { Server } from 'lucide-react';
import type { SessionPanelLayout, ToolPanel } from '../../../shared/types/panels';
import { SSH_HOSTS_SESSION_ID } from '../../../shared/types/sshHosts';
import { SessionProvider } from '../contexts/SessionProvider';
import { panelApi } from '../services/panelApi';
import type { Session } from '../types/session';
import { API } from '../utils/api';
import { usePanelStore } from '../stores/panelStore';
import { useSshHostsStore } from '../stores/sshHostsStore';
import { PanelTabStrip } from './panels/PanelTabStrip';
import { SplitLayout } from './panels/SplitLayout';
import { SelectionLoading } from './ui/SelectionLoading';

const EMPTY_PANELS: ToolPanel[] = [];
const GROUP_ID = 'ssh-hosts';
const noop = () => {};

/**
 * The built-in SSH view: one terminal tab per opened host, owned by a hidden
 * project-free Session. With no tabs open it lists the hosts to pick from.
 */
export function SshView() {
  const panels = usePanelStore(state => state.panels[SSH_HOSTS_SESSION_ID] ?? EMPTY_PANELS);
  const storedActiveId = usePanelStore(state => state.activePanels[SSH_HOSTS_SESSION_ID]);
  const hosts = useSshHostsStore(state => state.hosts);
  const openError = useSshHostsStore(state => state.error);
  const refreshHosts = useSshHostsStore(state => state.refresh);
  const openHost = useSshHostsStore(state => state.open);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refreshHosts();
    let cancelled = false;
    void panelApi.loadPanelsForSession(SSH_HOSTS_SESSION_ID).then(saved => {
      if (cancelled) return;
      const store = usePanelStore.getState();
      store.setPanels(SSH_HOSTS_SESSION_ID, saved);
      const active = store.activePanels[SSH_HOSTS_SESSION_ID];
      if (!active || !saved.some(panel => panel.id === active)) {
        const remembered = saved.find(panel => panel.state.isActive) ?? saved[0];
        if (remembered) store.setActivePanel(SSH_HOSTS_SESSION_ID, remembered.id);
      }
      setLoaded(true);
    }).catch(() => {
      if (!cancelled) setError('Could not load your SSH tabs');
    });
    const events = window.electronAPI.events;
    const created = events.onPanelCreated(panel => {
      if (panel.sessionId === SSH_HOSTS_SESSION_ID) usePanelStore.getState().addPanel(panel);
    });
    const updated = events.onPanelUpdated(panel => {
      if (panel.sessionId === SSH_HOSTS_SESSION_ID) usePanelStore.getState().updatePanelState(panel);
    });
    const deleted = events.onPanelDeleted(event => {
      if (event.sessionId === SSH_HOSTS_SESSION_ID) usePanelStore.getState().removePanel(SSH_HOSTS_SESSION_ID, event.panelId);
    });
    return () => {
      cancelled = true;
      created();
      updated();
      deleted();
    };
  }, [refreshHosts]);

  const tabs = useMemo(() => panels.filter(panel => panel.type === 'terminal'), [panels]);
  // The Session exists once a host has been opened; its terminals read it from context.
  const [session, setSession] = useState<Session | null>(null);
  const hasTabs = tabs.length > 0;
  useEffect(() => {
    if (!hasTabs || session) return;
    let cancelled = false;
    void API.sessions.get(SSH_HOSTS_SESSION_ID).then(response => {
      if (!cancelled && response.success && response.data) setSession(response.data);
    });
    return () => { cancelled = true; };
  }, [hasTabs, session]);
  const activePanelId = tabs.some(panel => panel.id === storedActiveId) ? storedActiveId ?? null : tabs[0]?.id ?? null;
  const layout = useMemo<SessionPanelLayout>(() => ({
    version: 1,
    root: { type: 'group', id: GROUP_ID, panelIds: tabs.map(panel => panel.id), activePanelId },
    focusedGroupId: GROUP_ID,
  }), [tabs, activePanelId]);

  const selectPanel = useCallback((panel: ToolPanel) => {
    usePanelStore.getState().setActivePanel(SSH_HOSTS_SESSION_ID, panel.id);
    void panelApi.setActivePanel(SSH_HOSTS_SESSION_ID, panel.id).catch(() => {});
  }, []);
  const selectGroupPanel = useCallback((_groupId: string, panel: ToolPanel) => selectPanel(panel), [selectPanel]);
  const closePanel = useCallback((panel: ToolPanel) => {
    void panelApi.deletePanel(panel.id).then(() => {
      usePanelStore.getState().removePanel(SSH_HOSTS_SESSION_ID, panel.id);
      void refreshHosts();
    }).catch(() => setError('Could not close the tab. Please try again.'));
  }, [refreshHosts]);

  if (!loaded) {
    return <div className="flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden bg-bg-primary">
      {error ? <p role="alert" className="p-6 text-text-secondary">{error}</p> : <SelectionLoading name="SSH" />}
    </div>;
  }

  const alert = error ?? openError;
  return (
    <div data-testid="ssh-view" className="ph-no-capture flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden bg-bg-primary">
      {hasTabs && <div className="flex min-h-9 items-center border-b border-border-primary bg-bg-chrome px-2">
        <PanelTabStrip panels={tabs} activePanelId={activePanelId} idNamespace="top" alwaysShowClose
          onPanelSelect={selectPanel} onPanelClose={closePanel} />
      </div>}
      {alert && <p role="alert" className="px-3 py-1 text-xs text-status-error">{alert}</p>}
      {hasTabs ? (
        <div className="relative min-h-0 flex-1">
          {session && <SessionProvider session={session}>
            <SplitLayout layout={layout} panels={tabs} focusedGroupId={GROUP_ID} isMainRepo={false}
              onSizesChange={noop} onPanelSelect={selectGroupPanel} onPanelClose={closePanel} onFocusGroup={noop}
              showAddTool={false} alwaysShowClose />
          </SessionProvider>}
        </div>
      ) : (
        <SshHostPicker hosts={hosts} onOpen={alias => { void openHost(alias); }} />
      )}
    </div>
  );
}

function SshHostPicker({ hosts, onOpen }: { hosts: string[]; onOpen: (alias: string) => void }) {
  return (
    <div className="flex flex-1 flex-col items-center overflow-y-auto px-6 py-12">
      <div className="w-full max-w-md">
        <h2 className="text-base font-semibold text-text-primary">SSH hosts</h2>
        <p className="mt-1 text-sm text-text-secondary">
          {hosts.length > 0
            ? 'Hosts from your SSH config. Pick one to open a terminal that runs ssh with your own keys.'
            : 'No hosts found. Add a Host entry to ~/.ssh/config and it shows up here.'}
        </p>
        {hosts.length > 0 && <ul className="mt-4 flex flex-col gap-1" aria-label="SSH hosts">
          {hosts.map(alias => (
            <li key={alias}>
              <button type="button" onClick={() => onOpen(alias)}
                className="flex h-9 w-full items-center gap-2 rounded-md border border-border-primary bg-surface-primary px-3 text-left text-sm text-text-primary hover:bg-surface-hover focus:outline-none focus:ring-2 focus:ring-interactive">
                <Server className="h-4 w-4 flex-shrink-0 text-text-tertiary" aria-hidden="true" />
                <span className="truncate">{alias}</span>
              </button>
            </li>
          ))}
        </ul>}
      </div>
    </div>
  );
}
