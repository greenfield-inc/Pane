import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { ToolPanel } from '../../../shared/types/panels';
import type { RemotePaneConnectionProfile, RemotePaneConnectionStatus, RemotePwaAffordances } from '../../../shared/types/remoteDaemon';
import type { Session } from '../types/session';
import {
  RemoteConnectionScreen,
  type RemoteConnectionErrorKind,
} from './components/RemoteConnectionScreen';
import { RemoteCreateSessionDialog } from './components/RemoteCreateSessionDialog';
import {
  RemotePanelTabs,
  type RemoteTerminalCreateOptions,
} from './components/RemotePanelTabs';
import { getRemotePanelTabId, getRemotePanelTabPanelId } from './components/remotePanelTabIds';
import { RemoteSessionList } from './components/RemoteSessionList';
import { RemoteSidebar } from './components/RemoteSidebar';
import { RemoteStatusBar } from './components/RemoteStatusBar';
import { RemoteTerminalPanel } from './components/RemoteTerminalPanel';
import { decodeRemoteConnectionCode } from './runtime/remoteProfile';
import { RemoteRuntimeAdapter, type RemoteProjectWithSessions } from './runtime/remoteRuntimeAdapter';
import { loadRemoteProfiles, saveRemoteProfiles } from './runtime/remoteProfileStorage';
import { addNativeAppListener, isNativeMobile } from './runtime/nativeMobile';
import { consumeNativePushRoute, getNativePushStatus, installNativePushRouting, revokeNativePush, setupNativePush, updateNativePushControls, type NativePushRoute } from './runtime/nativePush';
import { useRemoteSessionStore } from './stores/remoteSessionStore';
import { decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import { remoteCreationFailureSchema, remotePanelReferenceSchema, remotePanelSchema } from './runtime/remotePayloadSchemas';
import { ErrorDialog } from '../components/ErrorDialog';

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
  const [pushControls, setPushControls] = useState({ needsInputEnabled: true, completedEnabled: true });
  const [{ adapter, activeProfile, connectionStatus, lastError, connectionErrorKind, lastSeenAt }, updateConnection] = useReducer(connectionReducer, INITIAL_CONNECTION);
  const setLastError = useCallback((error: string | null) => updateConnection({ lastError: error }), []);
  const [loading, setLoading] = useState(false);
  const [creatingTerminal, setCreatingTerminal] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [affordances, setAffordances] = useState<RemotePwaAffordances>(EMPTY_AFFORDANCES);
  const [affordancesLoading, setAffordancesLoading] = useState(false);
  const [sidebarActionSessionId, setSidebarActionSessionId] = useState<string | null>(null);
  const [createSessionProject, setCreateSessionProject] = useState<RemoteProjectWithSessions | null>(null);
  const [creationFailure, setCreationFailure] = useState<{ name: string; error: string } | null>(null);
  const [mountedTerminalPanelIds, setMountedTerminalPanelIds] = useState<string[]>([]);
  const profilesLoadedRef = useRef(false);
  const activeRuntimeRef = useRef<RemoteRuntimeAdapter | null>(null);
  const panelLoadRequestRef = useRef(0);
  const sidebarOpenerRef = useRef<HTMLElement | null>(null);
  const createSessionOpenerRef = useRef<HTMLElement | null>(null);
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
      .then(route => { if (mounted && route) setPendingPushRoute(route); })
      .catch(error => { if (mounted) setLastError(error instanceof Error ? error.message : 'Native notification setup failed.'); });
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

  const openCreateSession = useCallback((project: RemoteProjectWithSessions) => {
    createSessionOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setCreateSessionProject(project);
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
    for (const project of projects) {
      const session = project.sessions?.find(candidate => candidate.id === selectedSessionId);
      if (session) return session;
    }
    return null;
  }, [projects, selectedSessionId]);

  const selectedPanels = useMemo(
    () => selectedSessionId ? panelsBySessionId[selectedSessionId] ?? [] : [],
    [panelsBySessionId, selectedSessionId],
  );
  const terminalPanels = useMemo(
    () => selectedPanels.filter(panel => panel.type === 'terminal'),
    [selectedPanels],
  );
  const selectedPanel = selectedPanels.find(panel => panel.id === selectedPanelId) ?? selectedPanels[0] ?? null;

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
      const currentSessionId = useRemoteSessionStore.getState().selectedSessionId;
      const hasSelectedSession = Boolean(currentSessionId && nextProjects.some(project =>
        project.sessions?.some(session => session.id === currentSessionId),
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
      setPanels(sessionId, panels);
      const routedPanel = pushRoutePanelRef.current;
      const routeMatches = routedPanel?.sessionId === sessionId && panels.some(panel => panel.id === routedPanel.panelId);
      if (routedPanel?.sessionId === sessionId) pushRoutePanelRef.current = null;
      setSelectedPanel(routeMatches ? routedPanel.panelId : activePanel?.id ?? panels[0]?.id ?? null);
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

  const connectProfile = useCallback(async (profile: RemotePaneConnectionProfile) => {
    const runtime = new RemoteRuntimeAdapter(profile);
    activeRuntimeRef.current?.disconnect();
    activeRuntimeRef.current = runtime;
    pushRoutePanelRef.current = null;
    updateConnection({ ...INITIAL_CONNECTION, connectionStatus: 'connecting' });
    setPushStatus(null);
    setProjects([]);
    selectSession(null);

    try {
      await runtime.connect();
      if (activeRuntimeRef.current !== runtime) return null;
      updateConnection({ adapter: runtime, activeProfile: profile });
      saveProfile(profile, setSavedProfiles);
      await refreshProjects(runtime);
      await loadAffordances(runtime);
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
  }, [loadAffordances, refreshProjects, selectSession, setProjects]);

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
  }, [activeProfile?.id, adapter, connectProfile, loadPanels, pendingPushRoute, profilesLoading, savedProfiles, selectSession, setLastError]);

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
    pushRoutePanelRef.current = null;
    updateConnection(INITIAL_CONNECTION);
    setCreationFailure(null);
    setPushStatus(null);
    setAffordances(EMPTY_AFFORDANCES);
    setAffordancesLoading(false);
    setProjects([]);
    selectSession(null);
  }, [selectSession, setProjects]);

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

  const selectRemoteSession = useCallback((sessionId: string) => {
    selectSession(sessionId);
    setSidebarOpen(false);
  }, [selectSession]);

  const toggleRemotePinnedSession = useCallback(async (sessionId: string) => {
    if (!adapter || sidebarActionSessionId) return;
    setSidebarActionSessionId(sessionId);
    try {
      await adapter.toggleFavorite(sessionId);
      await refreshProjects(adapter);
      setLastError(null);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : 'Failed to update pinned pane');
    } finally {
      setSidebarActionSessionId(null);
    }
  }, [adapter, refreshProjects, sidebarActionSessionId, setLastError]);

  const archiveRemoteSession = useCallback(async (sessionId: string) => {
    if (!adapter || sidebarActionSessionId) return;
    const sessionName = findSessionName(projects, sessionId) ?? 'this pane';
    if (!window.confirm(`Archive pane "${sessionName}"?`)) {
      return;
    }

    setSidebarActionSessionId(sessionId);
    try {
      await adapter.archiveSession(sessionId);
      const nextProjects = await refreshProjects(adapter);
      if (selectedSessionId === sessionId && nextProjects) {
        selectSession(findFirstSessionId(nextProjects));
      }
      setLastError(null);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : 'Failed to archive pane');
    } finally {
      setSidebarActionSessionId(null);
    }
  }, [adapter, projects, refreshProjects, selectSession, selectedSessionId, sidebarActionSessionId, setLastError]);

  const handleRemoteSessionCreated = useCallback(async (projectId: number, sessionName: string) => {
    if (!adapter) return;

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const nextProjects = await refreshProjects(adapter);
      const createdSessionId = nextProjects ? findSessionIdByName(nextProjects, projectId, sessionName) : null;
      if (createdSessionId) {
        selectSession(createdSessionId);
        setSidebarOpen(false);
        return;
      }
      await delay(500);
    }

    setSidebarOpen(false);
  }, [adapter, refreshProjects, selectSession]);

  const selectPanel = useCallback((panelId: string) => {
    if (!adapter || !selectedSessionId) return;
    setSelectedPanel(panelId);
    void adapter.setActivePanel(selectedSessionId, panelId).catch(error => {
      setLastError(error instanceof Error ? error.message : 'Failed to set active panel');
    });
  }, [adapter, selectedSessionId, setSelectedPanel, setLastError]);

  useEffect(() => {
    if (!adapter) return;
    return adapter.onStatus(state => {
      updateConnection({ connectionStatus: state.status, lastError: state.lastError, lastSeenAt: state.lastSeenAt });
    });
  }, [adapter]);

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
        const failure = decodeOptionalBoundary(event.args[0], remoteCreationFailureSchema);
        if (failure) setCreationFailure(failure);
        else setLastError('The remote host sent invalid pane creation data.');
        return;
      }
      if (event.channel === 'panel:created' || event.channel === 'panel:updated') {
        const panel = decodeOptionalBoundary(event.args[0], remotePanelSchema);
        if (panel) upsertPanel(panel);
        else setLastError('The remote host sent invalid panel data.');
        return;
      }

      if (event.channel === 'panel:deleted') {
        const payload = decodeOptionalBoundary(event.args[0], remotePanelReferenceSchema);
        if (payload) removePanel(payload.sessionId, payload.panelId);
        else setLastError('The remote host sent invalid panel data.');
        return;
      }

      if (event.channel === 'panel:activeChanged') {
        const payload = decodeOptionalBoundary(event.args[0], remotePanelReferenceSchema);
        if (!payload) { setLastError('The remote host sent invalid panel data.'); return; }
        if (payload?.sessionId === selectedSessionId && payload.panelId) {
          setSelectedPanel(payload.panelId);
        }
        return;
      }

      if (event.channel.startsWith('session:') || event.channel.startsWith('project:')) {
        void refreshProjects(adapter);
      }
    });
  }, [adapter, refreshProjects, removePanel, selectedSessionId, setSelectedPanel, upsertPanel, setLastError]);

  useEffect(() => {
    if (!selectedSessionId || !adapter) return;
    void loadPanels(selectedSessionId, adapter);
  }, [adapter, loadPanels, selectedSessionId]);

  if (profilesLoading) return <main className="flex min-h-dvh items-center justify-center bg-bg-primary text-text-secondary">Loading saved connections…</main>;
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
            className="pane-drawer fixed inset-y-0 left-0 z-50 w-[min(22rem,calc(100vw-2rem))] max-w-full shadow-2xl outline-none md:hidden"
          >
            <Dialog.Title className="sr-only">Remote panes</Dialog.Title>
            <RemoteSidebar
              projects={projects}
              selectedSessionId={selectedSessionId}
              loading={loading}
              actionSessionId={sidebarActionSessionId}
              onSelectSession={selectRemoteSession}
              onTogglePinned={toggleRemotePinnedSession}
              onArchiveSession={archiveRemoteSession}
              onCreateSession={(project) => {
                setSidebarOpen(false);
                openCreateSession(project);
              }}
              onRefresh={() => { void refreshProjects(adapter); }}
              onClose={() => setSidebarOpen(false)}
              className="flex h-full w-full shadow-2xl"
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <RemoteSidebar
        projects={projects}
        selectedSessionId={selectedSessionId}
        loading={loading}
        actionSessionId={sidebarActionSessionId}
        onSelectSession={selectRemoteSession}
        onTogglePinned={toggleRemotePinnedSession}
        onArchiveSession={archiveRemoteSession}
        onCreateSession={openCreateSession}
        onRefresh={() => { void refreshProjects(adapter); }}
        className="hidden w-80 shrink-0 md:flex"
      />
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <RemoteStatusBar
          profile={activeProfile}
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

        <RemotePanelTabs
          panels={selectedPanels}
          selectedPanelId={selectedPanel?.id ?? null}
          creating={creatingTerminal}
          customCommands={affordances.customCommands}
          onSelectPanel={selectPanel}
          onCreateTerminal={createTerminal}
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
            <UnsupportedPanel session={selectedSession} panel={selectedPanel} />
          </div>
        )}
      </section>

      {createSessionProject && (
        <RemoteCreateSessionDialog
          adapter={adapter}
          project={createSessionProject}
          restoreFocusRef={createSessionOpenerRef}
          fallbackFocusRef={sidebarOpenerRef}
          onClose={() => setCreateSessionProject(null)}
          onCreated={(sessionName) => handleRemoteSessionCreated(createSessionProject.id, sessionName)}
        />
      )}
    </div>
  );
}

function UnsupportedPanel({ session, panel }: { session: Session; panel: ToolPanel }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-bg-primary p-6">
      <div className="max-w-md rounded-lg border border-border-primary bg-surface-primary p-6">
        <p className="text-sm font-semibold text-text-primary">{panel.title}</p>
        <p className="mt-2 text-sm text-text-secondary">
          {panel.type} panels are visible in desktop Pane. Remote Pane PWA currently supports terminal panels for {session.name}.
        </p>
      </div>
    </div>
  );
}

function findFirstSessionId(projects: Array<{ sessions?: Session[] }>): string | null {
  for (const project of projects) {
    const session = project.sessions?.[0];
    if (session) {
      return session.id;
    }
  }
  return null;
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
