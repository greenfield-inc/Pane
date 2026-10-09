import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { OrchestrationSessionRecord, OrchestrationSessionView } from '../../../shared/types/orchestrationSession';
import type { PanelActivationRequest, ToolPanel, ToolPanelType } from '../../../shared/types/panels';
import type { RemotePaneConnectionProfile, RemotePaneConnectionStatus, RemotePwaAffordances } from '../../../shared/types/remoteDaemon';
import type { Session } from '../types/session';
import {
  RemoteConnectionScreen,
  type RemoteConnectionErrorKind,
} from './components/RemoteConnectionScreen';
import { RemoteCreateOrchestrationSessionDialog } from './components/RemoteCreateOrchestrationSessionDialog';
import { RemoteCreateSessionDialog } from './components/RemoteCreateSessionDialog';
import {
  RemotePanelTabs,
  type RemoteTerminalCreateOptions,
} from './components/RemotePanelTabs';
import { getRemotePanelTabId, getRemotePanelTabPanelId } from './components/remotePanelTabIds';
import { RemoteSessionList } from './components/RemoteSessionList';
import { RemoteSidebar, type RemoteSidebarActions } from './components/RemoteSidebar';
import { RemoteStatusBar } from './components/RemoteStatusBar';
import { RemoteTerminalPanel } from './components/RemoteTerminalPanel';
import { RemoteBrowserPanel } from './components/RemoteBrowserPanel';
import { RemoteExplorerPanel } from './components/RemoteExplorerPanel';
import { useRemoteListeningPorts } from './hooks/useRemoteListeningPorts';
import { decodeRemoteConnectionCode } from '../../../shared/remoteClient/pairing';
import { RemoteRuntimeAdapter, type RemoteProjectWithSessions } from './runtime/remoteRuntimeAdapter';
import { loadRemoteProfiles, saveRemoteProfiles } from './runtime/remoteProfileStorage';
import { addNativeAppListener, isNativeMobile } from './runtime/nativeMobile';
import { consumeNativePushRoute, getNativePushStatus, installNativePushRouting, revokeNativePush, setupNativePush, updateNativePushControls, type NativePushRoute } from './runtime/nativePush';
import { findFirstSessionId, phoneShows, useRemoteSessionStore, visibleTabs } from './stores/remoteSessionStore';
import { readRemoteView } from './stores/remoteViewMemory';
import { useRemoteBrowserHistory, type RemoteHistoryView } from './remoteBrowserHistory';
import { subscribeRemotePanelStatus } from './runtime/remotePanelStatus';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { ErrorDialog } from '../components/ErrorDialog';
import { UndoToast } from '../components/ui/UndoToast';
import { PortalContainerProvider } from '../contexts/PortalContainerContext';

const EMPTY_AFFORDANCES: RemotePwaAffordances = {
  terminalShortcuts: [],
  customCommands: [],
  voiceTranscription: {
    availableModes: [],
    defaultMode: 'streaming',
    configured: {
      cleanup: false,
      recorded: false,
      streaming: false,
      fal: false,
      deepgram: false,
      openRouter: false,
    },
    modes: {
      streaming: {
        label: 'Live',
        priceLabel: '~$0.462/hr ASR + cleanup',
        latencyLabel: 'Realtime text while speaking',
        recommended: true,
      },
      recorded: {
        label: 'Batch',
        priceLabel: '~$0.084/hr full pipeline',
        latencyLabel: 'Text appears after stop',
        recommended: false,
      },
    },
  },
};

const DEFAULT_PUSH_CONTROLS = { needsInputEnabled: true, completedEnabled: true };

/** Set by Disconnect so the next open shows the connect form; cleared by the next successful connect. */
const AUTO_CONNECT_PAUSED_KEY = 'pane.remotePwa.autoConnectPaused';
function setAutoConnectPaused(paused: boolean): void {
  try {
    if (paused) window.localStorage.setItem(AUTO_CONNECT_PAUSED_KEY, '1');
    else window.localStorage.removeItem(AUTO_CONNECT_PAUSED_KEY);
  } catch {
    // Without storage the PWA reconnects on every open, which is the default.
  }
}
function isAutoConnectPaused(): boolean {
  try { return window.localStorage.getItem(AUTO_CONNECT_PAUSED_KEY) === '1'; } catch { return false; }
}

interface ConnectionState {
  adapter: RemoteRuntimeAdapter | null;
  activeProfile: RemotePaneConnectionProfile | null;
  connectionStatus: RemotePaneConnectionStatus;
  lastError: string | null;
  connectionErrorKind: RemoteConnectionErrorKind | null;
  lastSeenAt: string | null;
}
const INITIAL_CONNECTION: ConnectionState = {
  adapter: null, activeProfile: null, connectionStatus: 'local', lastError: null,
  connectionErrorKind: null, lastSeenAt: null,
};
function connectionReducer(state: ConnectionState, update: Partial<ConnectionState>): ConnectionState {
  return { ...state, ...update };
}

export function RemotePwaApp() {
  const [savedProfiles, setSavedProfiles] = useState<RemotePaneConnectionProfile[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(true);
  const [pendingPushRoute, setPendingPushRoute] = useState<NativePushRoute | null>(null);
  const [pushStatus, setPushStatus] = useState<{ registration: 'registered' | 'not-registered' | 'revoked'; provider: string; message: string; needsInputEnabled?: boolean; completedEnabled?: boolean } | null>(null);
  const [pushControls, setPushControls] = useState(DEFAULT_PUSH_CONTROLS);
  const [{ adapter, activeProfile, connectionStatus, lastError, connectionErrorKind, lastSeenAt }, updateConnection] = useReducer(connectionReducer, INITIAL_CONNECTION);
  const setLastError = useCallback((error: string | null) => updateConnection({ lastError: error }), []);
  const [loading, setLoading] = useState(false);
  const [creatingTerminal, setCreatingTerminal] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [affordances, setAffordances] = useState<RemotePwaAffordances>(EMPTY_AFFORDANCES);
  const [affordancesLoading, setAffordancesLoading] = useState(false);
  const [sidebarActionId, setSidebarActionId] = useState<string | null>(null);
  const [createSessionProject, setCreateSessionProject] = useState<RemoteProjectWithSessions | null>(null);
  const [createOrchestrationOpen, setCreateOrchestrationOpen] = useState(false);
  const [creationFailure, setCreationFailure] = useState<{ name: string; error: string } | null>(null);
  const [mountedTerminalPanelIds, setMountedTerminalPanelIds] = useState<string[]>([]);
  /** The sidebar row the open Pane was tapped in, so only that copy is highlighted. */
  const [selectedPaneScope, setSelectedPaneScope] = useState<{ paneId: string; scope: string } | null>(null);
  const [archivedSessionToast, setArchivedSessionToast] = useState<OrchestrationSessionRecord | null>(null);
  /** The saved profile being reconnected to on open, until that attempt ends. */
  const [reconnectingProfile, setReconnectingProfile] = useState<RemotePaneConnectionProfile | null>(null);
  /** Whether the notification tap that launched the app, if any, has been read; reconnecting waits for it. */
  const [pushRouteChecked, setPushRouteChecked] = useState(() => !isNativeMobile());
  /** Menus opened from the drawer render inside it, so the drawer's focus trap and outside-click dismissal leave them alone. */
  const [drawerElement, setDrawerElement] = useState<HTMLDivElement | null>(null);
  const autoConnectStartedRef = useRef(false);
  const profilesLoadedRef = useRef(false);
  const activeRuntimeRef = useRef<RemoteRuntimeAdapter | null>(null);
  const panelLoadRequestRef = useRef(0);
  const sidebarOpenerRef = useRef<HTMLElement | null>(null);
  const createSessionOpenerRef = useRef<HTMLElement | null>(null);
  const createOrchestrationOpenerRef = useRef<HTMLElement | null>(null);
  /** Bumped by each Pane or Session open, so a slow Session open cannot replace a later choice. */
  const navigationRequestRef = useRef(0);
  const archivedLoadRequestRef = useRef(0);
  const pushRoutePanelRef = useRef<{ sessionId: string; panelId: string } | null>(null);

  useEffect(() => {
    void loadRemoteProfiles()
      .then(profiles => { profilesLoadedRef.current = true; setSavedProfiles(profiles); })
      .catch(error => setLastError(error instanceof Error ? error.message : 'Could not load saved remote connections.'))
      .finally(() => setProfilesLoading(false));
  }, [setLastError]);
  useEffect(() => {
    let mounted = true;
    void installNativePushRouting()
      .then(consumeNativePushRoute)
      .then(route => {
        if (!mounted) return;
        // Set together so the reconnect effect sees the route in the same render.
        if (route) setPendingPushRoute(route);
        setPushRouteChecked(true);
      })
      .catch(error => {
        if (!mounted) return;
        setLastError(error instanceof Error ? error.message : 'Native notification setup failed.');
        setPushRouteChecked(true);
      });
    return () => { mounted = false; };
  }, [setLastError]);
  useEffect(() => {
    if (!profilesLoading && profilesLoadedRef.current) {
      void saveRemoteProfiles(savedProfiles).catch(error => {
        setLastError(error instanceof Error ? error.message : 'Could not save remote connections.');
      });
    }
  }, [profilesLoading, savedProfiles, setLastError]);

  const openSidebar = useCallback(() => {
    sidebarOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSidebarOpen(true);
  }, []);

  /** Without a repository, starts in desktop's default one: the active repository, else the first. */
  const openCreateSession = useCallback((project?: RemoteProjectWithSessions) => {
    const { projects: hostProjects } = useRemoteSessionStore.getState();
    const initialProject = project ?? hostProjects.find(candidate => candidate.active) ?? hostProjects[0];
    if (!initialProject) return;
    createSessionOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSidebarOpen(false);
    setCreateSessionProject(initialProject);
  }, []);

  const openCreateOrchestrationSession = useCallback(() => {
    createOrchestrationOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSidebarOpen(false);
    setCreateOrchestrationOpen(true);
  }, []);

  const projects = useRemoteSessionStore(state => state.projects);
  const selectedSessionId = useRemoteSessionStore(state => state.selectedSessionId);
  const selectedPanelId = useRemoteSessionStore(state => state.selectedPanelId);
  const panelsBySessionId = useRemoteSessionStore(state => state.panelsBySessionId);
  const setProjects = useRemoteSessionStore(state => state.setProjects);
  const selectSession = useRemoteSessionStore(state => state.selectSession);
  const setPanels = useRemoteSessionStore(state => state.setPanels);
  const setSelectedPanel = useRemoteSessionStore(state => state.setSelectedPanel);
  const upsertPanel = useRemoteSessionStore(state => state.upsertPanel);
  const removePanel = useRemoteSessionStore(state => state.removePanel);
  const resetRemoteHost = useRemoteSessionStore(state => state.reset);
  const openSession = useRemoteSessionStore(state => state.openSession);
  const openOrchestrationSession = useRemoteSessionStore(state => state.openOrchestrationSession);
  const orchestrationSessions = useRemoteSessionStore(state => state.orchestrationSessions);
  const setOrchestrationSessions = useRemoteSessionStore(state => state.setOrchestrationSessions);
  const setOrchestrationFailure = useRemoteSessionStore(state => state.setOrchestrationFailure);
  const setArchivedProjects = useRemoteSessionStore(state => state.setArchivedProjects);

  useEffect(() => {
    let listener: { remove(): Promise<void> } | null = null;
    let cancelled = false;
    void addNativeAppListener('backButton', () => {
      if (sidebarOpen) {
        setSidebarOpen(false);
        return;
      }
      if (selectedPanelId) {
        setSelectedPanel(null);
        return;
      }
      if (selectedSessionId) selectSession(null);
    }).then(result => {
      if (cancelled) void result?.remove();
      else listener = result;
    }).catch(() => {});
    return () => { cancelled = true; void listener?.remove(); };
  }, [selectedPanelId, selectedSessionId, selectSession, setSelectedPanel, sidebarOpen]);

  useEffect(() => {
    const route = () => {
      void consumeNativePushRoute().then(detail => {
        if (detail) setPendingPushRoute(detail);
      }).catch(() => setLastError('Could not open the notification.'));
    };
    window.addEventListener('pane-native-push-route', route);
    return () => window.removeEventListener('pane-native-push-route', route);
  }, [setLastError]);

  useEffect(() => {
    if (!adapter || !isNativeMobile()) return;
    let listener: { remove(): Promise<void> } | null = null;
    let active = true;
    void addNativeAppListener('appStateChange', (event) => {
      const isActive = event.isActive === true;
      if (!isActive) adapter.disconnect();
      if (isActive && active) void adapter.connect().catch(() => {});
    }).then(result => {
      if (!active) void result?.remove();
      else listener = result;
    }).catch(() => setLastError('Could not monitor app activity.'));
    return () => { active = false; void listener?.remove(); };
  }, [adapter, setLastError]);

  const selectedSession = useMemo(() => {
    if (!selectedSessionId) return null;
    if (openOrchestrationSession?.internalSession.id === selectedSessionId) return openOrchestrationSession.internalSession;
    for (const project of projects) {
      const session = project.sessions?.find(candidate => candidate.id === selectedSessionId);
      if (session) return session;
    }
    return null;
  }, [openOrchestrationSession, projects, selectedSessionId]);

  const selectedPanels = useMemo(
    () => selectedSessionId ? visibleTabs(openOrchestrationSession, selectedSessionId, panelsBySessionId[selectedSessionId] ?? []) : [],
    [openOrchestrationSession, panelsBySessionId, selectedSessionId],
  );
  const terminalPanels = useMemo(
    () => selectedPanels.filter(panel => panel.type === 'terminal'),
    [selectedPanels],
  );
  const selectedPanel = selectedPanels.find(panel => panel.id === selectedPanelId) ?? firstSupportedPanel(selectedPanels);
  const listeningPorts = useRemoteListeningPorts(adapter);

  useEffect(() => {
    if (!selectedPanel || selectedPanel.type !== 'terminal') return;
    setMountedTerminalPanelIds(previous => previous.includes(selectedPanel.id)
      ? previous
      : [...previous, selectedPanel.id]);
  }, [selectedPanel]);

  useEffect(() => {
    const currentPanelIds = new Set(terminalPanels.map(panel => panel.id));
    setMountedTerminalPanelIds(previous => previous.filter(panelId => currentPanelIds.has(panelId)));
  }, [terminalPanels]);

  const refreshProjects = useCallback(async (runtime: RemoteRuntimeAdapter | null = adapter) => {
    if (!runtime) return null;
    setLoading(true);
    try {
      const nextProjects = await runtime.getProjectsWithSessions();
      if (runtime !== activeRuntimeRef.current) return null;
      setProjects(nextProjects);
      const { selectedSessionId: currentSessionId, openOrchestrationSession: openView, pendingSessionId } = useRemoteSessionStore.getState();
      const hasSelectedSession = Boolean(pendingSessionId) || Boolean(currentSessionId && (
        openView?.internalSession.id === currentSessionId
        || nextProjects.some(project => project.sessions?.some(session => session.id === currentSessionId))
      ));
      if (!hasSelectedSession) {
        selectSession(findFirstSessionId(nextProjects));
      }
      setLastError(null);
      return nextProjects;
    } catch (error) {
      if (runtime === activeRuntimeRef.current) setLastError(error instanceof Error ? error.message : 'Failed to load remote panes');
      return null;
    } finally {
      if (runtime === activeRuntimeRef.current) setLoading(false);
    }
  }, [adapter, selectSession, setProjects, setLastError]);

  const loadPanels = useCallback(async (sessionId: string, runtime: RemoteRuntimeAdapter | null = adapter) => {
    if (!runtime) return;
    const request = ++panelLoadRequestRef.current;
    try {
      const [panels, activePanel] = await Promise.all([
        runtime.getPanels(sessionId),
        runtime.getActivePanel(sessionId).catch(() => null),
      ]);
      if (runtime !== activeRuntimeRef.current || request !== panelLoadRequestRef.current || useRemoteSessionStore.getState().selectedSessionId !== sessionId) return;
      // Read before setPanels, which fills an empty selection with the first panel.
      const { selectedPanelId: currentPanelId, hostId, openOrchestrationSession: openView } = useRemoteSessionStore.getState();
      const rememberedPanelId = hostId ? readRemoteView(hostId).panelIdByPaneId[sessionId] : undefined;
      setPanels(sessionId, panels);
      const routedPanel = pushRoutePanelRef.current;
      const routeMatches = routedPanel?.sessionId === sessionId && panels.some(panel => panel.id === routedPanel.panelId);
      if (routedPanel?.sessionId === sessionId) pushRoutePanelRef.current = null;
      const strip = visibleTabs(openView, sessionId, panels);
      const shown = (panelId: string | null | undefined) => strip.some(panel => panel.id === panelId) ? panelId : null;
      // This client's own tab first; the host's last-used tab only for a Pane this client has not opened,
      // and only when the phone can show it; else the first tab it can.
      const hostPanelId = activePanel && phoneShows(activePanel) ? shown(activePanel.id) : null;
      setSelectedPanel(routeMatches ? routedPanel.panelId : shown(currentPanelId) ?? shown(rememberedPanelId) ?? hostPanelId ?? firstSupportedPanel(strip)?.id ?? null);
      if (routedPanel?.sessionId === sessionId && !routeMatches) {
        setLastError('The notified panel is no longer available on this Pane host.');
      } else {
        setLastError(null);
      }
    } catch (error) {
      if (runtime === activeRuntimeRef.current && request === panelLoadRequestRef.current) setLastError(error instanceof Error ? error.message : 'Failed to load remote panels');
    }
  }, [adapter, setPanels, setSelectedPanel, setLastError]);

  const loadAffordances = useCallback(async (runtime: RemoteRuntimeAdapter | null = adapter) => {
    if (!runtime) return;
    setAffordancesLoading(true);
    try {
      const nextAffordances = await runtime.getPwaAffordances();
      if (runtime === activeRuntimeRef.current) setAffordances(nextAffordances);
    } catch {
      if (runtime === activeRuntimeRef.current) setAffordances(EMPTY_AFFORDANCES);
    } finally {
      if (runtime === activeRuntimeRef.current) setAffordancesLoading(false);
    }
  }, [adapter]);

  const loadArchived = useCallback(async (runtime: RemoteRuntimeAdapter | null = adapter) => {
    if (!runtime) return;
    // Only the newest request applies, so an older snapshot never overwrites a later archive or restore.
    const request = ++archivedLoadRequestRef.current;
    try {
      const archived = await runtime.getArchivedProjectsWithSessions();
      if (runtime === activeRuntimeRef.current && request === archivedLoadRequestRef.current) setArchivedProjects(archived);
    } catch (error) {
      if (runtime !== activeRuntimeRef.current || request !== archivedLoadRequestRef.current) return;
      setArchivedProjects([]);
      setLastError(error instanceof Error ? error.message : 'Failed to load archived panes');
    }
  }, [adapter, setArchivedProjects, setLastError]);

  /** Resolves false when the Session failed to open. */
  const openRemoteOrchestrationSession = useCallback(async (sessionId: string, runtime: RemoteRuntimeAdapter | null = adapter): Promise<boolean> => {
    if (!runtime) return false;
    const request = ++navigationRequestRef.current;
    try {
      const view = await runtime.openOrchestrationSession(sessionId);
      if (runtime !== activeRuntimeRef.current || request !== navigationRequestRef.current) return true;
      openSession(view);
      setLastError(null);
      return true;
    } catch (error) {
      if (runtime !== activeRuntimeRef.current) return true;
      setLastError(error instanceof Error ? error.message : 'Failed to open Session');
      return false;
    }
  }, [adapter, openSession, setLastError]);

  const historyView: RemoteHistoryView = openOrchestrationSession
    ? `session:${openOrchestrationSession.session.id}`
    : selectedSessionId ? `pane:${selectedSessionId}` : null;
  const { requestView, cancelRequest } = useRemoteBrowserHistory({
    enabled: adapter !== null && !isNativeMobile(),
    host: activeProfile?.id ?? '',
    view: historyView,
    overlayOpen: sidebarOpen || createSessionProject !== null || createOrchestrationOpen,
    onNavigate: (view) => {
      // Back and Forward retire a Session still opening, even when they land on the view on screen.
      navigationRequestRef.current += 1;
      if (view === historyView) return;
      const state = useRemoteSessionStore.getState();
      if (view?.startsWith('session:')) {
        const sessionId = view.slice('session:'.length);
        if (state.orchestrationSessions.some(session => session.id === sessionId && session.archived !== true)) {
          void openRemoteOrchestrationSession(sessionId);
        }
        return;
      }
      const paneId = view?.slice('pane:'.length) ?? null;
      if (paneId && !state.projects.some(project => project.sessions?.some(session => session.id === paneId))) return;
      selectSession(paneId);
    },
    onCloseOverlays: () => {
      setSidebarOpen(false);
      setCreateSessionProject(null);
      setCreateOrchestrationOpen(false);
    },
  });

  const refreshOrchestrationSessions = useCallback(async (runtime: RemoteRuntimeAdapter | null = adapter) => {
    if (!runtime) return;
    try {
      const { sessions } = await runtime.listOrchestrationSessions();
      if (runtime !== activeRuntimeRef.current) return;
      setOrchestrationSessions(sessions);
      const state = useRemoteSessionStore.getState();
      const openView = state.openOrchestrationSession;
      if (!openView) return;
      const record = sessions.find(session => session.id === openView.session.id);
      if (!record || record.archived === true) {
        state.selectSession(findFirstSessionId(state.projects));
      } else if (record.agent !== openView.agent) {
        // Desktop switched the Session's agent; show the new agent's chat if the Session is still open.
        void runtime.openOrchestrationSession(record.id).then(view => {
          const stillOpen = useRemoteSessionStore.getState().openOrchestrationSession?.session.id === record.id;
          if (runtime === activeRuntimeRef.current && stillOpen) openSession(view, { showChat: true });
        }).catch(() => {});
      }
    } catch (error) {
      if (runtime !== activeRuntimeRef.current) return;
      const message = error instanceof Error ? error.message : 'Failed to load Sessions';
      if (message.includes('No Pane daemon command registered')) setOrchestrationFailure('unavailable', null);
      else setOrchestrationFailure('error', message);
    }
  }, [adapter, openSession, setOrchestrationFailure, setOrchestrationSessions]);

  const loadArchivedIfShown = useCallback(async (runtime: RemoteRuntimeAdapter) => {
    if (useRemoteSessionStore.getState().archivedProjects !== null) await loadArchived(runtime);
  }, [loadArchived]);

  /** Refetches the host's state, e.g. after the event stream was down and events were missed. */
  const resyncHost = useCallback(async (runtime: RemoteRuntimeAdapter | null) => {
    if (!runtime) return;
    await Promise.all([refreshProjects(runtime), refreshOrchestrationSessions(runtime), loadArchivedIfShown(runtime)]);
    const paneId = useRemoteSessionStore.getState().selectedSessionId;
    if (paneId && runtime === activeRuntimeRef.current) await loadPanels(paneId, runtime);
  }, [loadArchivedIfShown, loadPanels, refreshOrchestrationSessions, refreshProjects]);

  /** Clears everything that belongs to the previous host; `hostId` names the next one. */
  const resetHostState = useCallback((hostId: string | null = null) => {
    pushRoutePanelRef.current = null;
    archivedLoadRequestRef.current += 1;
    navigationRequestRef.current += 1;
    resetRemoteHost(hostId);
    setSidebarOpen(false);
    setSidebarActionId(null);
    setCreateSessionProject(null);
    setCreateOrchestrationOpen(false);
    setCreationFailure(null);
    setPushStatus(null);
    setPushControls(DEFAULT_PUSH_CONTROLS);
    setAffordances(EMPTY_AFFORDANCES);
    setAffordancesLoading(false);
    setMountedTerminalPanelIds([]);
    setSelectedPaneScope(null);
    setArchivedSessionToast(null);
  }, [resetRemoteHost]);

  const connectProfile = useCallback(async (profile: RemotePaneConnectionProfile) => {
    const runtime = new RemoteRuntimeAdapter(profile);
    activeRuntimeRef.current?.disconnect();
    activeRuntimeRef.current = runtime;
    updateConnection({ ...INITIAL_CONNECTION, connectionStatus: 'connecting' });
    resetHostState(profile.id);

    try {
      await runtime.connect();
      if (activeRuntimeRef.current !== runtime) return null;
      updateConnection({ adapter: runtime, activeProfile: profile });
      setAutoConnectPaused(false);
      saveProfile(profile, setSavedProfiles);
      await Promise.all([refreshProjects(runtime), refreshOrchestrationSessions(runtime), loadAffordances(runtime)]);
      // Reopen the Session this client had open, unless the person already went elsewhere.
      const { pendingSessionId, orchestrationSessions } = useRemoteSessionStore.getState();
      if (pendingSessionId && activeRuntimeRef.current === runtime) {
        if (orchestrationSessions.some(session => session.id === pendingSessionId && session.archived !== true)) {
          await openRemoteOrchestrationSession(pendingSessionId, runtime);
        }
        if (activeRuntimeRef.current === runtime && useRemoteSessionStore.getState().pendingSessionId === pendingSessionId) {
          useRemoteSessionStore.getState().cancelSessionRestore();
        }
      }
      return activeRuntimeRef.current === runtime ? runtime : null;
    } catch (error) {
      runtime.disconnect();
      if (activeRuntimeRef.current !== runtime) return null;
      activeRuntimeRef.current = null;
      updateConnection({
        ...INITIAL_CONNECTION,
        lastError: error instanceof Error ? error.message : 'Failed to connect to remote Pane',
        connectionErrorKind: 'connection',
      });
      throw error;
    }
  }, [loadAffordances, openRemoteOrchestrationSession, refreshOrchestrationSessions, refreshProjects, resetHostState]);

  useEffect(() => {
    if (!pendingPushRoute || profilesLoading) return;
    // Claim this route before connecting: profile/store updates must not start it again.
    const route = pendingPushRoute;
    setPendingPushRoute(null);
    const profile = savedProfiles.find(candidate => candidate.id === route.hostProfileId);
    if (!profile) {
      setLastError('The notification belongs to a connection that is no longer saved.');
      return;
    }
    const applyRoute = (runtime: RemoteRuntimeAdapter | null) => {
      if (!runtime || runtime !== activeRuntimeRef.current) return;
      if (route.paneId) {
        const state = useRemoteSessionStore.getState();
        if (!state.projects.some(project => project.sessions?.some(session => session.id === route.paneId))) {
          setLastError('The notified pane is no longer available on this Pane host.');
          return;
        }
        pushRoutePanelRef.current = route.panelId ? { sessionId: route.paneId, panelId: route.panelId } : null;
        requestView(`pane:${route.paneId}`);
        selectSession(route.paneId);
        // Selecting the same pane does not rerun the panel-loading effect.
        if (state.selectedSessionId === route.paneId) void loadPanels(route.paneId, runtime);
      }
    };
    if (activeProfile?.id === profile.id) {
      applyRoute(adapter);
      return;
    }
    void connectProfile(profile).then(applyRoute).catch(() => {});
  }, [activeProfile?.id, adapter, connectProfile, loadPanels, pendingPushRoute, profilesLoading, requestView, savedProfiles, selectSession, setLastError]);

  // Reconnects to the last used host once on open; a notification tap picks its own host instead.
  useEffect(() => {
    if (profilesLoading || !pushRouteChecked || autoConnectStartedRef.current) return;
    autoConnectStartedRef.current = true;
    // saveProfile keeps the last connected profile first.
    const profile = savedProfiles[0];
    if (!profile || pendingPushRoute || isAutoConnectPaused()) return;
    setReconnectingProfile(profile);
    void connectProfile(profile).catch(() => {}).finally(() => setReconnectingProfile(null));
  }, [connectProfile, pendingPushRoute, profilesLoading, pushRouteChecked, savedProfiles]);

  const connectCode = useCallback(async (code: string) => {
    setLastError(null);
    updateConnection({ connectionErrorKind: null });
    let profile: RemotePaneConnectionProfile;
    try {
      profile = decodeRemoteConnectionCode(code);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : 'Invalid remote Pane connection code');
      updateConnection({ connectionErrorKind: 'connection-code' });
      throw error;
    }

    forgetProfilesForBaseUrl(profile.baseUrl, setSavedProfiles);
    await connectProfile(profile);
  }, [connectProfile, setLastError]);

  const disconnect = useCallback(() => {
    activeRuntimeRef.current?.disconnect();
    activeRuntimeRef.current = null;
    setAutoConnectPaused(true);
    updateConnection(INITIAL_CONNECTION);
    resetHostState();
  }, [resetHostState]);

  /** Stops the reconnect on open and shows the connect form, without pausing the next one. */
  const cancelReconnect = useCallback(() => {
    activeRuntimeRef.current?.disconnect();
    activeRuntimeRef.current = null;
    setReconnectingProfile(null);
    updateConnection(INITIAL_CONNECTION);
  }, []);

  const forgetProfile = useCallback((profileId: string) => {
    const profile = savedProfiles.find(candidate => candidate.id === profileId);
    if (!profile) return;
    void (async () => {
      const runtime = activeProfile?.id === profile.id && adapter ? adapter : new RemoteRuntimeAdapter(profile);
      const ownsRuntime = runtime !== adapter;
      try {
        if (ownsRuntime) await runtime.connect();
        await revokeNativePush(profile, runtime);
      } catch {
        // Forget still removes the local bearer token; the host can revoke by pairing rotation.
      } finally {
        if (ownsRuntime) runtime.disconnect();
        setSavedProfiles(previous => previous.filter(candidate => candidate.id !== profileId));
      }
    })();
  }, [activeProfile?.id, adapter, savedProfiles]);

  const createTerminal = useCallback(async (options?: RemoteTerminalCreateOptions) => {
    if (!adapter || !selectedSessionId) return;
    setCreatingTerminal(true);
    try {
      const panel = await adapter.createTerminalPanel(selectedSessionId, options);
      upsertPanel(panel);
      setSelectedPanel(panel.id);
      await adapter.setActivePanel(selectedSessionId, panel.id);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : 'Failed to create terminal');
    } finally {
      setCreatingTerminal(false);
    }
  }, [adapter, selectedSessionId, setSelectedPanel, upsertPanel, setLastError]);

  const createBrowser = useCallback(async () => {
    if (!adapter || !selectedSessionId) return;
    setCreatingTerminal(true);
    const runtime = adapter;
    const sessionId = selectedSessionId;
    try {
      const panel = await runtime.createBrowserPanel(sessionId);
      // The host or the open Pane may have changed while the tab was created.
      if (runtime !== activeRuntimeRef.current) return;
      upsertPanel(panel);
      if (useRemoteSessionStore.getState().selectedSessionId !== sessionId) return;
      setSelectedPanel(panel.id);
      await runtime.setActivePanel(sessionId, panel.id);
    } catch (error) {
      if (runtime === activeRuntimeRef.current) setLastError(error instanceof Error ? error.message : 'Failed to create browser tab');
    } finally {
      setCreatingTerminal(false);
    }
  }, [adapter, selectedSessionId, setSelectedPanel, upsertPanel, setLastError]);

  /** Shows the new address at once, then saves it on the host for every client; a refused save goes back. */
  const navigateBrowser = useCallback((panel: ToolPanel, currentUrl: string) => {
    if (!adapter) return;
    const state = { ...panel.state, customState: { ...panel.state.customState, currentUrl } };
    const shown = { ...panel, state };
    upsertPanel(shown);
    adapter.updatePanelState(panel.id, state).catch((error: Error) => {
      if (adapter !== activeRuntimeRef.current) return;
      setLastError(error instanceof Error ? error.message : 'Could not open this address.');
      // Only undo this save: a newer address or a host update since then stays.
      const current = useRemoteSessionStore.getState().panelsBySessionId[panel.sessionId]?.find(candidate => candidate.id === panel.id);
      if (current === shown) upsertPanel(panel);
    });
  }, [adapter, upsertPanel, setLastError]);

  const requestPhoneAddress = useCallback((port: number) => {
    if (!adapter) return;
    adapter.requestPhoneAddress(port).catch((error: Error) => {
      if (adapter === activeRuntimeRef.current) setLastError(error instanceof Error ? error.message : 'Could not open this port.');
    });
  }, [adapter, setLastError]);

  const selectRemoteSession = useCallback((sessionId: string, scope: string) => {
    navigationRequestRef.current += 1;
    setSelectedPaneScope({ paneId: sessionId, scope });
    requestView(`pane:${sessionId}`);
    selectSession(sessionId);
    setSidebarOpen(false);
  }, [requestView, selectSession]);

  /** Runs one pin, archive or restore at a time, marking its row busy. */
  const runSidebarAction = useCallback(async (id: string, failure: string, action: (runtime: RemoteRuntimeAdapter) => Promise<void>) => {
    if (!adapter || sidebarActionId) return;
    setSidebarActionId(id);
    try {
      await action(adapter);
      if (adapter === activeRuntimeRef.current) setLastError(null);
    } catch (error) {
      if (adapter === activeRuntimeRef.current) setLastError(error instanceof Error ? error.message : failure);
    } finally {
      setSidebarActionId(null);
    }
  }, [adapter, sidebarActionId, setLastError]);

  const handleOrchestrationSessionCreated = useCallback((view: OrchestrationSessionView<Session>) => {
    // The create request can finish after a switch to another host.
    if (adapter !== activeRuntimeRef.current) return;
    navigationRequestRef.current += 1;
    requestView(`session:${view.session.id}`);
    openSession(view, { showChat: true });
    void refreshOrchestrationSessions(adapter);
  }, [adapter, openSession, refreshOrchestrationSessions, requestView]);

  const sidebarActions = useMemo<RemoteSidebarActions>(() => ({
    selectPane: selectRemoteSession,
    togglePanePinned: (paneId) => void runSidebarAction(paneId, 'Failed to update pinned pane', async (runtime) => {
      await runtime.toggleFavorite(paneId);
      await refreshProjects(runtime);
    }),
    archivePane: (paneId) => {
      const paneName = findSessionName(useRemoteSessionStore.getState().projects, paneId) ?? 'this pane';
      if (!window.confirm(`Archive pane "${paneName}"?`)) return;
      void runSidebarAction(paneId, 'Failed to archive pane', async (runtime) => {
        await runtime.archiveSession(paneId);
        await Promise.all([refreshProjects(runtime), loadArchivedIfShown(runtime)]);
      });
    },
    restorePane: (paneId) => void runSidebarAction(paneId, 'Failed to restore pane', async (runtime) => {
      await runtime.restoreSession(paneId);
      await Promise.all([refreshProjects(runtime), loadArchived(runtime)]);
    }),
    createPane: openCreateSession,
    openSession: (sessionId) => {
      requestView(`session:${sessionId}`);
      setSidebarOpen(false);
      void openRemoteOrchestrationSession(sessionId).then(opened => { if (!opened) cancelRequest(); });
    },
    createSession: openCreateOrchestrationSession,
    toggleSessionPinned: (session) => void runSidebarAction(session.id, 'Failed to update Session pin', async (runtime) => {
      await runtime.updateOrchestrationSession(session.id, { isPinned: session.isPinned !== true });
      await refreshOrchestrationSessions(runtime);
    }),
    setSessionArchived: (session, archived) => void runSidebarAction(session.id, archived ? 'Failed to archive Session' : 'Failed to restore Session', async (runtime) => {
      await runtime.updateOrchestrationSession(session.id, { archived });
      setArchivedSessionToast(current => archived ? session : current?.id === session.id ? null : current);
      await refreshOrchestrationSessions(runtime);
    }),
    reloadSessions: () => void refreshOrchestrationSessions(adapter),
    loadArchived: () => void loadArchived(adapter),
    refresh: () => void resyncHost(adapter),
  }), [adapter, cancelRequest, loadArchived, loadArchivedIfShown, openCreateOrchestrationSession, openCreateSession, openRemoteOrchestrationSession, refreshOrchestrationSessions, refreshProjects, requestView, resyncHost, runSidebarAction, selectRemoteSession]);

  const dismissArchivedSessionToast = useCallback(() => setArchivedSessionToast(null), []);
  const archivedSessionToastElement = archivedSessionToast && (
    <UndoToast
      key={archivedSessionToast.id}
      message={`Archived ${archivedSessionToast.name || 'Untitled'}`}
      onUndo={() => sidebarActions.setSessionArchived(archivedSessionToast, false)}
      onDismiss={dismissArchivedSessionToast}
    />
  );

  const handleRemoteSessionCreated = useCallback(async (projectId: number, sessionName: string) => {
    if (!adapter) return;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const nextProjects = await refreshProjects(adapter);
      const createdSessionId = nextProjects ? findSessionIdByName(nextProjects, projectId, sessionName) : null;
      if (createdSessionId) {
        requestView(`pane:${createdSessionId}`);
        selectSession(createdSessionId);
        setSidebarOpen(false);
        return;
      }
      await delay(500);
    }

    setSidebarOpen(false);
  }, [adapter, refreshProjects, requestView, selectSession]);

  const selectPanel = useCallback((panelId: string) => {
    if (!adapter || !selectedSessionId) return;
    setSelectedPanel(panelId);
    void adapter.setActivePanel(selectedSessionId, panelId).catch(error => {
      setLastError(error instanceof Error ? error.message : 'Failed to set active panel');
    });
  }, [adapter, selectedSessionId, setSelectedPanel, setLastError]);

  useEffect(() => {
    if (!adapter) return;
    // Events sent while the stream was down are lost: refetch once it is back.
    let streamDropped = false;
    return adapter.onStatus(state => {
      updateConnection({ connectionStatus: state.status, lastError: state.lastError, lastSeenAt: state.lastSeenAt });
      if (state.status === 'connected' && streamDropped) void resyncHost(adapter);
      if (state.status !== 'connecting') streamDropped = state.status !== 'connected';
    });
  }, [adapter, resyncHost]);

  useEffect(() => adapter ? subscribeRemotePanelStatus(adapter) : undefined, [adapter]);

  useEffect(() => {
    if (!adapter || !activeProfile || !isNativeMobile()) return;
    let cancelled = false;
    void (async () => {
      const pushError = await setupNativePush(activeProfile, adapter);
      const status = await getNativePushStatus(adapter);
      if (cancelled) return;
      setPushStatus(status);
      setPushControls({ needsInputEnabled: status?.needsInputEnabled ?? true, completedEnabled: status?.completedEnabled ?? true });
      if (pushError) setLastError(pushError);
    })().catch(error => {
      if (!cancelled) setLastError(error instanceof Error ? error.message : 'Could not set up notifications.');
    });
    return () => { cancelled = true; };
  }, [adapter, activeProfile, setLastError]);

  const changePushControl = useCallback((key: 'needsInputEnabled' | 'completedEnabled', value: boolean) => {
    if (!adapter) return;
    const next = { ...pushControls, [key]: value };
    setPushControls(next);
    void updateNativePushControls(adapter, { [key]: value }).then(status => {
      if (adapter !== activeRuntimeRef.current) return;
      if (status) {
        setPushStatus(status);
        setPushControls({ needsInputEnabled: status.needsInputEnabled ?? next.needsInputEnabled, completedEnabled: status.completedEnabled ?? next.completedEnabled });
      }
    }).catch(error => {
      if (adapter !== activeRuntimeRef.current) return;
      setPushControls(pushControls);
      setLastError(error instanceof Error ? error.message : 'Could not update notification settings.');
    });
  }, [adapter, pushControls, setLastError]);

  useEffect(() => {
    if (!adapter) return;
    return adapter.onEvent(event => {
      if (event.channel === 'session:creation-failed') {
        const failure = decodeBoundary(event.args[0], boundary.object({ name: boundary.string, error: boundary.string }));
        setCreationFailure(failure);
        return;
      }
      if (event.channel === 'panel:created' || event.channel === 'panel:updated') {
        // SAFETY: The surrounding typed producer establishes the narrower value shape consumed here.
        const panel = event.args[0] as ToolPanel | undefined;
        if (panel?.id && panel.sessionId) {
          upsertPanel(panel);
        }
        return;
      }

      if (event.channel === 'panel:deleted') {
        // SAFETY: The surrounding typed producer establishes the narrower value shape consumed here.
        const payload = event.args[0] as { panelId?: string; sessionId?: string } | undefined;
        if (payload?.panelId && payload.sessionId) {
          removePanel(payload.sessionId, payload.panelId);
        }
        return;
      }

      // The host or an agent asks clients to bring a tab forward; only a client showing that Pane follows.
      // Other clients' tab clicks send nothing.
      if (event.channel === 'panel:activeChanged') {
        // SAFETY: The surrounding typed producer establishes the narrower value shape consumed here.
        const payload = event.args[0] as Partial<PanelActivationRequest> | undefined;
        if (payload?.sessionId === selectedSessionId && payload.panelId) {
          setSelectedPanel(payload.panelId);
        }
        return;
      }

      if (event.channel.startsWith('session:') || event.channel.startsWith('project:')) {
        if (event.channel === 'session:created' || event.channel === 'session:deleted') void loadArchivedIfShown(adapter);
        void refreshProjects(adapter);
        return;
      }

      if (event.channel === 'orchestration-sessions:changed') {
        void refreshOrchestrationSessions(adapter);
      }
    });
  }, [adapter, loadArchivedIfShown, refreshOrchestrationSessions, refreshProjects, removePanel, selectedSessionId, setSelectedPanel, upsertPanel]);

  useEffect(() => {
    if (!selectedSessionId || !adapter) return;
    void loadPanels(selectedSessionId, adapter);
  }, [adapter, loadPanels, selectedSessionId]);

  if (profilesLoading) return <main className="flex min-h-dvh items-center justify-center bg-bg-primary text-text-secondary">Loading saved connections…</main>;
  if (reconnectingProfile && (!adapter || !activeProfile)) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-bg-primary px-4 text-center text-text-secondary">
        <p role="status" className="min-w-0 max-w-full truncate">Reconnecting to {reconnectingProfile.label}…</p>
        <button
          type="button"
          onClick={cancelReconnect}
          className="min-h-11 rounded-md px-3 text-sm font-medium text-text-tertiary hover:bg-surface-hover hover:text-text-primary md:min-h-9"
        >
          Cancel
        </button>
      </main>
    );
  }
  if (!adapter || !activeProfile) {
    return (
      <RemoteConnectionScreen
        savedProfiles={savedProfiles}
        error={lastError}
        errorKind={connectionErrorKind}
        onConnectCode={connectCode}
        onConnectProfile={async profile => { await connectProfile(profile); }}
        onForgetProfile={forgetProfile}
      />
    );
  }

  return (
    <div className="flex h-dvh min-h-dvh w-full overflow-hidden bg-bg-primary text-text-primary">
      <ErrorDialog
        isOpen={creationFailure !== null}
        onClose={() => setCreationFailure(null)}
        title="Failed to Create Pane"
        error={creationFailure?.error ?? ''}
        details={creationFailure ? `Pane: ${creationFailure.name}` : undefined}
      />
      <Dialog.Root open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="pane-scrim fixed inset-0 z-50 bg-black/60 md:hidden" />
          <Dialog.Content
            aria-describedby={undefined}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              requestAnimationFrame(() => {
                if (document.activeElement?.closest('[aria-modal="true"]')) return;
                if (sidebarOpenerRef.current?.isConnected) sidebarOpenerRef.current.focus();
              });
            }}
            ref={setDrawerElement}
            className="pane-drawer fixed inset-y-0 left-0 z-50 w-[min(22rem,calc(100vw-2rem))] max-w-full shadow-2xl outline-none md:hidden"
          >
            <Dialog.Title className="sr-only">Remote panes</Dialog.Title>
            <PortalContainerProvider value={drawerElement}>
              <RemoteSidebar
                loading={loading}
                actionId={sidebarActionId}
                actions={sidebarActions}
                selectedPane={selectedPaneScope}
                onClose={() => setSidebarOpen(false)}
                className="flex h-full w-full shadow-2xl"
              />
            </PortalContainerProvider>
            {/* Inside the drawer while it is open, or the scrim would cover it. */}
            {archivedSessionToastElement}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <RemoteSidebar
        loading={loading}
        actionId={sidebarActionId}
        actions={sidebarActions}
        selectedPane={selectedPaneScope}
        className="hidden w-80 shrink-0 md:flex"
      />
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <RemoteStatusBar
          profile={activeProfile}
          openName={openOrchestrationSession
            // The list carries renames (such as a first-message name); the open snapshot does not.
            ? (orchestrationSessions.find(session => session.id === openOrchestrationSession.session.id)?.name ?? openOrchestrationSession.session.name) || 'Untitled'
            : selectedSession ? selectedSession.name || 'Untitled' : null}
          status={connectionStatus}
          lastError={lastError}
          lastSeenAt={lastSeenAt}
          onDisconnect={disconnect}
          onOpenSidebar={openSidebar}
        />

        {isNativeMobile() && (
          <details className="border-b border-border-primary bg-surface-secondary px-3 py-2 text-sm">
            <summary className="cursor-pointer font-medium text-text-secondary">Notifications {pushStatus?.registration === 'registered' ? 'enabled' : 'setup'}</summary>
            <p className="mt-2 text-text-tertiary">{pushStatus?.message ?? 'Allow notifications to receive host attention alerts.'}</p>
            <label className="mt-2 flex items-center gap-2 text-text-secondary">
              <input type="checkbox" disabled={pushStatus?.registration !== 'registered'} checked={pushControls.needsInputEnabled} onChange={event => changePushControl('needsInputEnabled', event.target.checked)} />
              Alert when a Pane needs input
            </label>
            <label className="mt-2 flex items-center gap-2 text-text-secondary">
              <input type="checkbox" disabled={pushStatus?.registration !== 'registered'} checked={pushControls.completedEnabled} onChange={event => changePushControl('completedEnabled', event.target.checked)} />
              Alert when a turn completes
            </label>
          </details>
        )}

        {openOrchestrationSession && <SessionBlockers sessionId={openOrchestrationSession.session.id} fallback={openOrchestrationSession.session.blockers} />}

        <RemotePanelTabs
          panels={selectedPanels}
          selectedPanelId={selectedPanel?.id ?? null}
          creating={creatingTerminal}
          customCommands={affordances.customCommands}
          onSelectPanel={selectPanel}
          onCreateTerminal={createTerminal}
          onCreateBrowser={createBrowser}
        />

        <RemoteSessionList
          session={selectedSession}
          panels={selectedPanels}
          onCreateTerminal={createTerminal}
        />

        {selectedSession && terminalPanels
          .filter(panel => panel.id === selectedPanel?.id || mountedTerminalPanelIds.includes(panel.id))
          .map(panel => {
            const selected = panel.id === selectedPanel?.id;
            return (
              <div
                key={panel.id}
                id={getRemotePanelTabPanelId(panel.id)}
                role="tabpanel"
                aria-labelledby={getRemotePanelTabId(panel.id)}
                hidden={!selected}
                tabIndex={0}
                className={selected ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : undefined}
              >
                <RemoteTerminalPanel
                  adapter={adapter}
                  panel={panel}
                  sessionId={selectedSession.id}
                  connectionStatus={connectionStatus}
                  shortcuts={affordances.terminalShortcuts}
                  shortcutsLoading={affordancesLoading}
                  voiceTranscription={affordances.voiceTranscription}
                  onRefreshShortcuts={() => { void loadAffordances(adapter); }}
                />
              </div>
            );
          })}

        {selectedSession && selectedPanel && selectedPanel.type !== 'terminal' && (
          <div
            id={getRemotePanelTabPanelId(selectedPanel.id)}
            role="tabpanel"
            aria-labelledby={getRemotePanelTabId(selectedPanel.id)}
            tabIndex={0}
            className="flex min-h-0 flex-1 flex-col overflow-hidden"
          >
            {selectedPanel.type === 'browser' && (
              <RemoteBrowserPanel panel={selectedPanel} ports={listeningPorts} onNavigate={url => navigateBrowser(selectedPanel, url)} onRequestAddress={requestPhoneAddress} onError={setLastError} />
            )}
            {selectedPanel.type === 'explorer' && adapter && (
              <RemoteExplorerPanel key={selectedPanel.id} adapter={adapter} panelId={selectedPanel.id} sessionId={selectedPanel.sessionId} ports={listeningPorts} onError={setLastError} />
            )}
            {selectedPanel.type !== 'browser' && selectedPanel.type !== 'explorer' && <UnsupportedPanel session={selectedSession} panel={selectedPanel} />}
          </div>
        )}
      </section>

      {createSessionProject && (
        <RemoteCreateSessionDialog
          adapter={adapter}
          projects={projects}
          initialProject={createSessionProject}
          restoreFocusRef={createSessionOpenerRef}
          fallbackFocusRef={sidebarOpenerRef}
          onClose={() => setCreateSessionProject(null)}
          onCreated={handleRemoteSessionCreated}
        />
      )}

      {createOrchestrationOpen && (
        <RemoteCreateOrchestrationSessionDialog
          adapter={adapter}
          sessionAgents={affordances.sessionAgents}
          sessions={orchestrationSessions}
          restoreFocusRef={createOrchestrationOpenerRef}
          fallbackFocusRef={sidebarOpenerRef}
          onClose={() => setCreateOrchestrationOpen(false)}
          onCreated={handleOrchestrationSessionCreated}
        />
      )}

      {!sidebarOpen && archivedSessionToastElement}
    </div>
  );
}

const PANEL_TYPE_LABELS = {
  terminal: 'Terminal',
  diff: 'Diff',
  explorer: 'Explorer',
  editor: 'Editor',
  logs: 'Logs',
  dashboard: 'Dashboard',
  'setup-tasks': 'Setup task',
  browser: 'Browser',
  notes: 'Notes',
} satisfies Record<ToolPanelType, string>;

/** The open Session's recorded blockers, from the latest Session list. */
function SessionBlockers({ sessionId, fallback }: { sessionId: string; fallback: string[] }) {
  const blockers = useRemoteSessionStore(state => state.orchestrationSessions.find(session => session.id === sessionId)?.blockers) ?? fallback;
  if (blockers.length === 0) return null;
  return (
    <section aria-label="Blockers" className="max-h-28 shrink-0 overflow-y-auto border-b border-border-primary bg-surface-secondary px-4 py-2 text-sm">
      <p className="font-medium text-status-error">Blocked</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-text-secondary">
        {blockers.map((blocker, index) => <li key={`${index}:${blocker}`}>{blocker}</li>)}
      </ul>
    </section>
  );
}

function UnsupportedPanel({ session, panel }: { session: Session; panel: ToolPanel }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-bg-primary p-6">
      <div className="max-w-md rounded-lg border border-border-primary bg-surface-primary p-6">
        <p className="text-sm font-semibold text-text-primary">{panel.title}</p>
        <p className="mt-2 text-sm text-text-secondary">
          {PANEL_TYPE_LABELS[panel.type]} panels are visible in desktop Pane. Remote Pane PWA shows terminal, browser and explorer tabs for {session.name}.
        </p>
      </div>
    </div>
  );
}

function firstSupportedPanel(panels: ToolPanel[]): ToolPanel | null {
  return panels.find(phoneShows) ?? panels[0] ?? null;
}

function findSessionName(projects: Array<{ sessions?: Session[] }>, sessionId: string): string | null {
  for (const project of projects) {
    const session = project.sessions?.find(candidate => candidate.id === sessionId);
    if (session) {
      return session.name || 'Untitled';
    }
  }
  return null;
}

function findSessionIdByName(projects: Array<{ id?: number; sessions?: Session[] }>, projectId: number, sessionName: string): string | null {
  const project = projects.find(candidate => candidate.id === projectId);
  const session = project?.sessions?.find(candidate => candidate.name === sessionName);
  return session?.id ?? null;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function saveProfile(
  profile: RemotePaneConnectionProfile,
  setSavedProfiles: (updater: (profiles: RemotePaneConnectionProfile[]) => RemotePaneConnectionProfile[]) => void,
): void {
  setSavedProfiles(previous => {
    return [profile, ...previous.filter(candidate => (
      candidate.id !== profile.id && candidate.baseUrl !== profile.baseUrl
    ))];
  });
}

function forgetProfilesForBaseUrl(
  baseUrl: string,
  setSavedProfiles: (updater: (profiles: RemotePaneConnectionProfile[]) => RemotePaneConnectionProfile[]) => void,
): void {
  setSavedProfiles(previous => {
    return previous.filter(profile => profile.baseUrl !== baseUrl);
  });
}
