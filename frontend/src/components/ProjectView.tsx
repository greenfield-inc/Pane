import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { API } from '../utils/api';
import { useSessionStore } from '../stores/sessionStore';
import type { Session } from '../types/session';
import { PanelTabBar } from './panels/PanelTabBar';
import { PanelContainer } from './panels/PanelContainer';
import { usePanelStore } from '../stores/panelStore';
import { panelApi } from '../services/panelApi';
import { useConfigStore } from '../stores/configStore';
import { readPaneLayout, rememberPaneLayout } from '../utils/paneLayoutMemory';
import { createSingleGroupLayout } from '../utils/panelLayout';
import { getActiveRemoteHostId } from '../../../shared/types/remoteDaemon';
import type { PanelActivationRequest, ToolPanel, ToolPanelType, TerminalPanelState } from '../../../shared/types/panels';
import type { PanelCreateOptions } from '../types/panelComponents';
import { SessionProvider } from '../contexts/SessionContext';
import { DetailPanel } from './DetailPanel';
import type { InspectorTab } from './InspectorTabs';
import { useObservedContentBox } from '../hooks/useObservedContentBox';
import { useOuterPanelResize } from '../hooks/useOuterPanelResize';
import { OUTER_PANEL_CONFIGS } from '../utils/outerPanelSizing';
import { CommitMessageDialog } from './session/CommitMessageDialog';
import { SetTrackingBranchDialog } from './session/SetTrackingBranchDialog';
import { useMainRepoGitActions } from '../hooks/useMainRepoGitActions';
import { useProjectViewActionsStore } from '../stores/projectViewActionsStore';
import { useNavigationStore } from '../stores/navigationStore';
import { PANEL_CAPABILITIES } from '../../../shared/types/panels';
import type { ProjectEnvironment } from '../../../shared/types/panels';

interface ProjectViewProps {
  projectId: number;
  projectName: string;
  projectEnvironment: ProjectEnvironment | undefined;
  configuredIDECommand?: string | null;
  onConfigureIDE: () => void;
}

export const ProjectView: React.FC<ProjectViewProps> = ({ 
  projectId, 
  projectName,
  projectEnvironment,
  configuredIDECommand,
  onConfigureIDE,
}) => {
  const [mainRepoSessionId, setMainRepoSessionId] = useState<string | null>(null);
  const [mainRepoSession, setMainRepoSession] = useState<Session | null>(null);
  const [branchState, setBranchState] = useState<{
    projectId: number;
    worktreePath: string | null;
    branch: string | null;
  }>({ projectId, worktreePath: null, branch: null });
  const [sessionLoadingState, setSessionLoadingState] = useState({ projectId, isLoading: true });
  const sessionRequestGeneration = useRef(0);
  const isLoadingSession = sessionLoadingState.projectId !== projectId || sessionLoadingState.isLoading;
  const activeMainRepoSession = mainRepoSession?.projectId === projectId ? mainRepoSession : null;
  const activeWorktreePath = activeMainRepoSession?.worktreePath ?? null;
  const detectedBranch = branchState.projectId === projectId
    && branchState.worktreePath === activeWorktreePath
    ? branchState.branch
    : null;
  const displayBranch = activeMainRepoSession?.baseBranch ?? detectedBranch;
  // Panel store state and actions
  const {
    panels,
    activePanels,
    setPanels,
    setActivePanel: setActivePanelInStore,
    addPanel,
    removePanel,
    updatePanelState,
  } = usePanelStore(useShallow(state => ({
    panels: state.panels,
    activePanels: state.activePanels,
    setPanels: state.setPanels,
    setActivePanel: state.setActivePanel,
    addPanel: state.addPanel,
    removePanel: state.removePanel,
    updatePanelState: state.updatePanelState,
  })));

  // Detail panel state
  const [detailVisible, setDetailVisible] = useState(() => {
    const stored = localStorage.getItem('pane-project-detail-panel-visible');
    return stored !== null ? stored === 'true' : true;
  });
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>(() => {
    const stored = localStorage.getItem('pane-project-inspector-tab');
    return stored === 'files' || stored === 'details' ? stored : 'changes';
  });
  useEffect(() => {
    localStorage.setItem('pane-project-inspector-tab', inspectorTab);
  }, [inspectorTab]);
  const openInspector = useCallback((tab: InspectorTab) => {
    setInspectorTab(tab);
    setDetailVisible(true);
  }, []);

  // Persist detail panel visibility
  useEffect(() => {
    localStorage.setItem('pane-project-detail-panel-visible', String(detailVisible));
  }, [detailVisible]);

  const immersiveMode = useNavigationStore(s => s.immersiveMode);
  const projectContentBox = useObservedContentBox<HTMLDivElement>();
  const detailResize = useOuterPanelResize({
    config: OUTER_PANEL_CONFIGS.projectInspector,
    containerPx: projectContentBox.width,
    enabled: detailVisible && !immersiveMode,
  });

  // This desktop's own tab for the repository Pane, kept like a worktree
  // Pane's layout memory as a single group.
  const hostId = useConfigStore(state => state.config ? getActiveRemoteHostId(state.config.remoteDaemon) : undefined);
  const shownPanelId = usePanelStore(state => mainRepoSessionId ? state.activePanels[mainRepoSessionId] : undefined);
  // Read when the repository opens; the remembered tab belongs to that host.
  const hostIdRef = useRef(hostId);
  useEffect(() => {
    hostIdRef.current = hostId;
  }, [hostId]);
  useEffect(() => {
    if (!mainRepoSessionId || !shownPanelId) return;
    rememberPaneLayout(hostIdRef.current, mainRepoSessionId, createSingleGroupLayout([shownPanelId], shownPanelId));
  }, [mainRepoSessionId, shownPanelId]);

  // Load panels when main repo session changes (no auto-creation, matches worktree session behavior)
  // The repository whose tab this visit has restored; activation requests wait for it.
  const [restoredSessionId, setRestoredSessionId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setRestoredSessionId(null);
    if (mainRepoSessionId) {
      const loadHostId = hostIdRef.current;
      const ownsLoad = () => !cancelled && hostIdRef.current === loadHostId;
      panelApi.loadPanelsForSession(mainRepoSessionId).then(async (loadedPanels) => {
        if (!ownsLoad()) return;
        setPanels(mainRepoSessionId, loadedPanels);

        // This desktop's remembered tab wins; the host's last-used tab and
        // the default are only for a repository it has not shown.
        const remembered = await readPaneLayout(loadHostId, mainRepoSessionId);
        if (!ownsLoad()) return;
        const rememberedId = remembered?.root.type === 'group' ? remembered.root.activePanelId : null;
        if (rememberedId && loadedPanels.some(p => p.id === rememberedId)) {
          setActivePanelInStore(mainRepoSessionId, rememberedId);
          setRestoredSessionId(mainRepoSessionId);
          return;
        }

        // Pick default active: the first working panel (Explorer and Review
        // live in the inspector, not the stage).
        const fallback = loadedPanels.find(p => p.type !== 'diff' && p.type !== 'explorer');

        const activePanel = await panelApi.getActivePanel(mainRepoSessionId);
        if (!ownsLoad()) return;
        if (activePanel) {
          setActivePanelInStore(mainRepoSessionId, activePanel.id);
        } else if (fallback) {
          setActivePanelInStore(mainRepoSessionId, fallback.id);
          await panelApi.setActivePanel(mainRepoSessionId, fallback.id);
          if (!ownsLoad()) return;
        }
        setRestoredSessionId(mainRepoSessionId);
      });
    }
    return () => { cancelled = true; };
  }, [mainRepoSessionId, setPanels, setActivePanelInStore]);

  // A tab the host or an agent brought forward applies after this visit's
  // restore, so a slower memory read cannot replace it.
  const activationRequest = usePanelStore(state => mainRepoSessionId ? state.activationRequests[mainRepoSessionId] : undefined);
  useEffect(() => {
    if (!activationRequest || !mainRepoSessionId || restoredSessionId !== mainRepoSessionId) return;
    const store = usePanelStore.getState();
    store.clearActivationRequest(mainRepoSessionId);
    if (store.panels[mainRepoSessionId]?.some(p => p.id === activationRequest.panelId)) {
      setActivePanelInStore(mainRepoSessionId, activationRequest.panelId);
    }
  }, [activationRequest, mainRepoSessionId, restoredSessionId, setActivePanelInStore]);
  
  // Get panels for current main repo session
  const sessionPanels = useMemo(
    () => panels[mainRepoSessionId || ''] || [],
    [panels, mainRepoSessionId]
  );

  const filesPanel = useMemo(() => sessionPanels.find(p => p.type === 'explorer'), [sessionPanels]);
  const changesPanel = useMemo(() => sessionPanels.find(p => p.type === 'diff'), [sessionPanels]);
  const workingPanels = useMemo(
    () => sessionPanels.filter(p => p.type !== 'explorer' && p.type !== 'diff'),
    [sessionPanels]
  );

  const currentActivePanel = useMemo(
    () => workingPanels.find(p => p.id === activePanels[mainRepoSessionId || '']),
    [workingPanels, activePanels, mainRepoSessionId]
  );

  // A persisted active panel that now lives in the inspector opens that tab
  // and hands the stage to the first working panel.
  const staleActiveHandledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!mainRepoSessionId) return;
    const activeId = activePanels[mainRepoSessionId];
    const stale = activeId ? sessionPanels.find(p => p.id === activeId && (p.type === 'explorer' || p.type === 'diff')) : undefined;
    if (!stale) return;
    const key = `${mainRepoSessionId}:${stale.id}`;
    if (staleActiveHandledRef.current === key) return;
    staleActiveHandledRef.current = key;
    setInspectorTab(stale.type === 'diff' ? 'changes' : 'files');
    const next = workingPanels[0];
    if (next) {
      setActivePanelInStore(mainRepoSessionId, next.id);
      void panelApi.setActivePanel(mainRepoSessionId, next.id);
    }
  }, [mainRepoSessionId, activePanels, sessionPanels, workingPanels, setActivePanelInStore]);

  const detailSession = useMemo(() => {
    if (!activeMainRepoSession || !displayBranch) return activeMainRepoSession;
    if (activeMainRepoSession.baseBranch === displayBranch) return activeMainRepoSession;
    return { ...activeMainRepoSession, baseBranch: displayBranch };
  }, [activeMainRepoSession, displayBranch]);

  useEffect(() => {
    if (!activeWorktreePath) {
      setBranchState({ projectId, worktreePath: null, branch: null });
      return;
    }

    setBranchState({ projectId, worktreePath: activeWorktreePath, branch: null });
    let cancelled = false;
    window.electronAPI.projects.detectBranch(activeWorktreePath).then(result => {
      if (cancelled) return;
      setBranchState({
        projectId,
        worktreePath: activeWorktreePath,
        branch: result.success ? result.data ?? null : null,
      });
    }).catch(() => {
      if (!cancelled) {
        setBranchState({ projectId, worktreePath: activeWorktreePath, branch: null });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [activeWorktreePath, projectId]);
  
  // Panel event handlers
  const handlePanelSelect = useCallback(
    async (panel: ToolPanel) => {
      if (!mainRepoSessionId) return;
      setActivePanelInStore(mainRepoSessionId, panel.id);
      await panelApi.setActivePanel(mainRepoSessionId, panel.id);
    },
    [mainRepoSessionId, setActivePanelInStore]
  );

  const handlePanelClose = useCallback(
    async (panel: ToolPanel) => {
      if (!mainRepoSessionId) return;

      // Activate the neighbouring working tab (never an inspector panel).
      const panelIndex = workingPanels.findIndex(p => p.id === panel.id);
      const nextPanel = workingPanels[panelIndex + 1] || workingPanels[panelIndex - 1];

      // Remove from store first for immediate UI update
      removePanel(mainRepoSessionId, panel.id);

      // Set next active panel if available
      if (nextPanel) {
        setActivePanelInStore(mainRepoSessionId, nextPanel.id);
        await panelApi.setActivePanel(mainRepoSessionId, nextPanel.id);
      }

      // Delete on backend
      await panelApi.deletePanel(panel.id);
    },
    [mainRepoSessionId, workingPanels, removePanel, setActivePanelInStore]
  );

  const handlePanelCreate = useCallback(
    async (type: ToolPanelType, options?: PanelCreateOptions) => {
      if (!mainRepoSessionId) return;

      // For terminal panels with initialCommand (e.g., Terminal (Claude))
      let initialState = options?.initialState;
      if (type === 'terminal' && options?.initialCommand) {
        const customState: Pick<TerminalPanelState, 'initialCommand' | 'customResume'> = {
          initialCommand: options.initialCommand,
        };
        if (options.customResume !== undefined) customState.customResume = options.customResume;
        initialState = { customState };
      }

      const newPanel = await panelApi.createPanel({
        sessionId: mainRepoSessionId,
        type,
        title: options?.title,
        initialState
      });

      // Immediately add the panel and set it as active
      // The panel:created event will also fire, but addPanel checks for duplicates
      addPanel(newPanel);
      setActivePanelInStore(mainRepoSessionId, newPanel.id);
      return newPanel;
    },
    [mainRepoSessionId, addPanel, setActivePanelInStore]
  );

  const handleOpenUrlInBrowser = useCallback(async (url: string, title: string) => {
    if (!mainRepoSessionId) return;
    const existingPanel = workingPanels.find((candidate) => candidate.type === 'browser');
    if (existingPanel) {
      const updatedPanel = {
        ...existingPanel,
        title,
        state: { ...existingPanel.state, customState: { ...existingPanel.state.customState, currentUrl: url } },
      };
      await panelApi.updatePanel(existingPanel.id, { title, state: updatedPanel.state });
      updatePanelState(updatedPanel);
      await handlePanelSelect(updatedPanel);
      window.dispatchEvent(new CustomEvent('browser-panel:navigate', {
        detail: { url, sessionId: mainRepoSessionId },
      }));
      return;
    }

    await handlePanelCreate('browser', {
      title,
      initialState: { customState: { currentUrl: url } },
    });
  }, [handlePanelCreate, handlePanelSelect, mainRepoSessionId, updatePanelState, workingPanels]);

  const handleShowExplorer = useCallback(async () => {
    if (!filesPanel) await handlePanelCreate('explorer');
    setInspectorTab('files');
    setDetailVisible(true);
  }, [filesPanel, handlePanelCreate]);
  
  // Expose this view's tab / inspector actions to the global hotkeys.
  const setProjectViewActions = useProjectViewActionsStore((state) => state.setActions);
  useEffect(() => {
    setProjectViewActions({
      toggleDetail: () => setDetailVisible((v) => !v),
      showInspector: (tab) => { setInspectorTab(tab); setDetailVisible(true); },
      addTerminal: () => { void handlePanelCreate('terminal'); },
      tabCount: () => workingPanels.length,
      selectTab: (index) => { const panel = workingPanels[index]; if (panel) handlePanelSelect(panel); },
      cycleTab: (direction) => {
        if (workingPanels.length < 2) return;
        const current = workingPanels.findIndex((p) => p.id === currentActivePanel?.id);
        const next = direction === 'next'
          ? (current + 1) % workingPanels.length
          : (current - 1 + workingPanels.length) % workingPanels.length;
        handlePanelSelect(workingPanels[next]);
      },
      canCloseActiveTab: () => !!currentActivePanel
        && !PANEL_CAPABILITIES[currentActivePanel.type]?.permanent
        && !currentActivePanel.metadata?.permanent,
      closeActiveTab: () => { if (currentActivePanel) handlePanelClose(currentActivePanel); },
    });
    return () => setProjectViewActions(null);
  }, [setProjectViewActions, workingPanels, currentActivePanel, handlePanelCreate, handlePanelSelect, handlePanelClose]);

  // Get or create main repo session when panels are needed
  useEffect(() => {
    const requestGeneration = ++sessionRequestGeneration.current;
    const isLatestRequest = () => requestGeneration === sessionRequestGeneration.current;

    // Create main repo session when component mounts to support panels
    const getMainRepoSession = async () => {
      setSessionLoadingState({ projectId, isLoading: true });
      try {
        const response = await API.sessions.getOrCreateMainRepoSession(projectId);
        if (!isLatestRequest()) return;
        if (response.success && response.data) {
          setMainRepoSessionId(response.data.id);
          setMainRepoSession(response.data);
          
          // Subscribe to session updates
          const sessions = useSessionStore.getState().sessions;
          const mainSession = sessions.find(s => s.id === response.data.id);
          if (mainSession) {
            setMainRepoSession(mainSession);
          }
          
          // Set as active session
          if (!isLatestRequest()) return;
          await useSessionStore.getState().setActiveSession(response.data.id);
          if (!isLatestRequest()) return;
        }
      } catch (error) {
        if (isLatestRequest()) console.error('Failed to get main repo session:', error);
      } finally {
        if (isLatestRequest()) setSessionLoadingState({ projectId, isLoading: false });
      }
    };

    void getMainRepoSession();
    return () => {
      if (isLatestRequest()) sessionRequestGeneration.current += 1;
    };
  }, [projectId]);
  
  // Subscribe to session updates - optimized to check for actual changes
  useEffect(() => {
    if (!mainRepoSessionId) return;

    const selectMainSession = (state: ReturnType<typeof useSessionStore.getState>) => (
      state.activeMainRepoSession?.id === mainRepoSessionId
        ? state.activeMainRepoSession
        : state.sessions.find(s => s.id === mainRepoSessionId)
    );
    let previousSession = selectMainSession(useSessionStore.getState());
    const unsubscribe = useSessionStore.subscribe((state) => {
      const session = selectMainSession(state);
      // Only update if session actually changed
      if (session && session !== previousSession) {
        previousSession = session;
        setMainRepoSession(session);
      }
    });
    
    return unsubscribe;
  }, [mainRepoSessionId]);

  const mainRepoGit = useMainRepoGitActions(mainRepoSessionId, mainRepoSession);

  // Listen for panel updates from the backend
  useEffect(() => {
    if (!mainRepoSessionId) return;

    // Handle panel creation events (for auto-created panels like logs)
    const handlePanelCreated = (panel: ToolPanel) => {
      // Only add if it's for the current session
      if (panel.sessionId === mainRepoSessionId) {
        // The store's addPanel now checks for duplicates, so we can safely call it
        addPanel(panel);
      }
    };

    const handlePanelUpdated = (panel: ToolPanel) => {
      if (panel.sessionId === mainRepoSessionId) updatePanelState(panel);
    };

    // The host or an agent brought a tab forward, as `runpane panels open` does.
    const handleActivationRequested = (request: PanelActivationRequest) => {
      if (request.sessionId === mainRepoSessionId) usePanelStore.getState().requestActivation(request);
    };

    // Listen for panel events
    const unsubscribeCreated = window.electronAPI?.events?.onPanelCreated?.(handlePanelCreated);
    const unsubscribeUpdated = window.electronAPI?.events?.onPanelUpdated?.(handlePanelUpdated);
    const unsubscribeActivation = window.electronAPI?.events?.onPanelActivationRequested?.(handleActivationRequested);

    // Cleanup
    return () => {
      unsubscribeCreated?.();
      unsubscribeUpdated?.();
      unsubscribeActivation?.();
    };
  }, [mainRepoSessionId, addPanel, updatePanelState, setActivePanelInStore]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-bg-primary">
      {/* SINGLE SessionProvider wraps everything */}
      {activeMainRepoSession && (
        <SessionProvider
          session={detailSession}
          projectName={projectName}
          gitBranchActions={mainRepoGit.actions}
          isMerging={mainRepoGit.actionsBusy}
          gitCommands={mainRepoGit.gitCommands}
          onOpenIDEWithCommand={mainRepoGit.handleOpenIDE}
          onOpenUrlInBrowser={handleOpenUrlInBrowser}
          onConfigureIDE={onConfigureIDE}
          onSetTracking={mainRepoGit.handleOpenSetTracking}
          trackingBranch={mainRepoGit.currentUpstream}
          configuredIDECommand={configuredIDECommand}
          isRemoteMode={mainRepoGit.isRemoteMode}
        >
          {/* Tab bar at top */}
          <PanelTabBar
            panels={workingPanels}
            activePanel={currentActivePanel}
            onPanelSelect={handlePanelSelect}
            onPanelClose={handlePanelClose}
            onPanelCreate={handlePanelCreate}
            onShowExplorer={() => { void handleShowExplorer(); }}
            projectEnvironment={projectEnvironment}
            context="project"
            onToggleDetailPanel={() => setDetailVisible(v => !v)}
            detailPanelVisible={detailVisible}
          />

          {/* Content area: center panels + right detail */}
          <div ref={projectContentBox.ref} className="pane-project-content flex-1 flex flex-row min-h-0 min-w-0">
            {/* Center: panel content */}
            <div className="flex-1 relative min-h-0 min-w-0 overflow-hidden">
              {isLoadingSession ? (
                <div
                  role="status"
                  aria-label="Loading main repository session"
                  className="h-full animate-pulse"
                >
                  <div className="flex items-center justify-between px-3 py-1.5 border-b border-border-primary bg-surface-secondary">
                    <div className="h-3 w-28 bg-surface-tertiary rounded" />
                    <div className="flex items-center gap-2">
                      <div className="h-3.5 w-3.5 bg-surface-tertiary rounded" />
                      <div className="h-3.5 w-3.5 bg-surface-tertiary rounded" />
                    </div>
                  </div>
                  <div className="p-4 space-y-3">
                    <div className="h-4 w-40 bg-surface-tertiary rounded" />
                    <div className="h-3 w-full bg-surface-tertiary rounded" />
                    <div className="h-3 w-3/4 bg-surface-tertiary rounded" />
                    <div className="h-3 w-5/6 bg-surface-tertiary rounded" />
                    <div className="h-3 w-2/3 bg-surface-tertiary rounded" />
                  </div>
                </div>
              ) : workingPanels.length > 0 && currentActivePanel ? (
                workingPanels.map(panel => {
                  const isActive = panel.id === currentActivePanel.id;
                  return (
                    <div
                      key={panel.id}
                      className="absolute inset-0"
                      style={{
                        display: isActive ? 'block' : 'none',
                        pointerEvents: isActive ? 'auto' : 'none'
                      }}
                    >
                      <PanelContainer
                        panel={panel}
                        isActive={isActive}
                        isMainRepo={!!mainRepoSession?.isMainRepo}
                      />
                    </div>
                  );
                })
              ) : (
                <div className="flex h-full items-center justify-center">
                  <button
                    type="button"
                    onClick={() => handlePanelCreate('terminal')}
                    className="flex h-7 items-center gap-2 rounded px-3 text-[13px] text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring-subtle"
                  >
                    Open a terminal
                  </button>
                </div>
              )}
            </div>

            {/* Right: detail panel */}
            <DetailPanel
              isVisible={detailVisible}
              onToggle={() => setDetailVisible(v => !v)}
              width={detailResize.renderedPx}
              bodyActive={detailResize.bodyActive}
              resizeSeparator={detailResize.separatorVisible ? {
                label: 'Resize main repository inspector',
                orientation: 'vertical',
                value: detailResize.effectivePx,
                minimum: detailResize.floor,
                maximum: detailResize.cap,
                ...detailResize.separatorHandlers,
              } : undefined}
              mergeError={mainRepoGit.error}
              inspectorTab={inspectorTab}
              onInspectorTabChange={openInspector}
              filesPanel={filesPanel}
              changesPanel={changesPanel}
              changesCount={activeMainRepoSession?.gitStatus?.filesChanged || undefined}
              isMainRepo
            />
          </div>
        </SessionProvider>
      )}

      {/* Loading state when no session yet */}
      {!activeMainRepoSession && isLoadingSession && (
        <div
          role="status"
          aria-label="Loading main repository session"
          className="flex-1 animate-pulse"
        >
          {/* Tab bar skeleton */}
          <div className="flex items-center gap-1 px-2 py-1 border-b border-border-primary bg-surface-secondary">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-7 w-20 bg-surface-tertiary rounded" />
            ))}
          </div>
          {/* Panel content skeleton */}
          <div className="p-4 space-y-3">
            <div className="h-4 w-48 bg-surface-tertiary rounded" />
            <div className="h-3 w-full bg-surface-tertiary rounded" />
            <div className="h-3 w-3/4 bg-surface-tertiary rounded" />
            <div className="h-3 w-5/6 bg-surface-tertiary rounded" />
            <div className="h-3 w-1/2 bg-surface-tertiary rounded" />
          </div>
        </div>
      )}

      {!activeMainRepoSession && !isLoadingSession && (
        <div className="flex-1 flex items-center justify-center text-text-secondary">
          No session selected
        </div>
      )}

      <CommitMessageDialog
        isOpen={mainRepoGit.showCommitDialog}
        onClose={() => mainRepoGit.setShowCommitDialog(false)}
        dialogType="commit"
        gitCommands={mainRepoGit.gitCommands}
        shouldSquash={false}
        setShouldSquash={() => {}}
        onConfirm={mainRepoGit.handleCommit}
        isMerging={mainRepoGit.isRunning}
      />

      <SetTrackingBranchDialog
        isOpen={mainRepoGit.showSetTrackingDialog}
        currentUpstream={mainRepoGit.currentUpstream}
        remoteBranches={mainRepoGit.remoteBranches}
        checkoutLabel="the primary checkout"
        onSelect={mainRepoGit.handleSelectUpstream}
        onClose={() => mainRepoGit.setShowSetTrackingDialog(false)}
      />
    </div>
  );
};
