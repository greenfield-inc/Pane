import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { API } from '../utils/api';
import { useSessionStore } from '../stores/sessionStore';
import type { Session } from '../types/session';
import { PanelTabBar } from './panels/PanelTabBar';
import { PanelContainer } from './panels/PanelContainer';
import { TerminalDock } from './panels/TerminalDock';
import { EmptyPanelStage } from './panels/EmptyPanelStage';
import { getDockTerminalPanel } from '../utils/terminalDock';
import { usePanelStore } from '../stores/panelStore';
import { panelApi } from '../services/panelApi';
import type { ToolPanel, ToolPanelType } from '../../../shared/types/panels';
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
  isTerminalCollapsed: boolean;
  onToggleTerminal: () => void;
}

export const ProjectView: React.FC<ProjectViewProps> = ({ 
  projectId, 
  projectName,
  projectEnvironment,
  configuredIDECommand,
  onConfigureIDE,
  isTerminalCollapsed,
  onToggleTerminal,
}) => {
  const [mainRepoSessionId, setMainRepoSessionId] = useState<string | null>(null);
  const [mainRepoSession, setMainRepoSession] = useState<Session | null>(null);
  const [restoredPanelSessionId, setRestoredPanelSessionId] = useState<string | null>(null);
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
  } = usePanelStore();

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
  const centerColumnBox = useObservedContentBox<HTMLDivElement>();
  const detailResize = useOuterPanelResize({
    config: OUTER_PANEL_CONFIGS.projectInspector,
    containerPx: projectContentBox.width,
    enabled: detailVisible && !immersiveMode,
  });

  // Load panels when main repo session changes (no auto-creation, matches worktree session behavior)
  useEffect(() => {
    setRestoredPanelSessionId(null);
    let cancelled = false;
    if (mainRepoSessionId) {
      panelApi.loadPanelsForSession(mainRepoSessionId).then(async (loadedPanels) => {
        if (cancelled) return;
        setPanels(mainRepoSessionId, loadedPanels);

        // Pick default active: the first working panel (Explorer and Review
        // live in the inspector, not the stage).
        const dock = getDockTerminalPanel(loadedPanels);
        const fallback = loadedPanels.find(p => p.type !== 'diff' && p.type !== 'explorer' && p.id !== dock?.id);

        const activePanel = await panelApi.getActivePanel(mainRepoSessionId);
        if (cancelled) return;
        if (activePanel) {
          setActivePanelInStore(mainRepoSessionId, activePanel.id);
        } else if (fallback) {
          setActivePanelInStore(mainRepoSessionId, fallback.id);
          await panelApi.setActivePanel(mainRepoSessionId, fallback.id);
        }
        if (!cancelled) setRestoredPanelSessionId(mainRepoSessionId);
      });
    }
    return () => { cancelled = true; };
  }, [mainRepoSessionId, setPanels, setActivePanelInStore]);
  
  // Get panels for current main repo session
  const sessionPanels = useMemo(
    () => panels[mainRepoSessionId || ''] || [],
    [panels, mainRepoSessionId]
  );

  const filesPanel = useMemo(() => sessionPanels.find(p => p.type === 'explorer'), [sessionPanels]);
  const changesPanel = useMemo(() => sessionPanels.find(p => p.type === 'diff'), [sessionPanels]);
  const defaultTerminalPanel = useMemo(() => getDockTerminalPanel(sessionPanels), [sessionPanels]);
  const workingPanels = useMemo(
    () => sessionPanels.filter(p => p.type !== 'explorer' && p.type !== 'diff' && p.id !== defaultTerminalPanel?.id),
    [sessionPanels, defaultTerminalPanel]
  );

  const currentActivePanel = useMemo(
    () => workingPanels.find(p => p.id === activePanels[mainRepoSessionId || '']),
    [workingPanels, activePanels, mainRepoSessionId]
  );

  // Keep the stage selection and persisted active panel in agreement when
  // the active panel moves into the inspector or dock, or is deleted.
  const staleActiveHandledRef = useRef<string | null>(null);
  useEffect(() => {
    // A missing selection during loading must not overwrite the saved tab.
    if (!mainRepoSessionId || restoredPanelSessionId !== mainRepoSessionId) return;
    const activeId = activePanels[mainRepoSessionId];
    const stale = activeId ? sessionPanels.find(p => p.id === activeId && (p.type === 'explorer' || p.type === 'diff')) : undefined;
    if (stale) {
      const key = `${mainRepoSessionId}:${stale.id}`;
      if (staleActiveHandledRef.current !== key) {
        staleActiveHandledRef.current = key;
        setInspectorTab(stale.type === 'diff' ? 'changes' : 'files');
      }
    }
    if (workingPanels.some(p => p.id === activeId)) return;
    const next = workingPanels[0];
    if (next) {
      setActivePanelInStore(mainRepoSessionId, next.id);
      void panelApi.setActivePanel(mainRepoSessionId, next.id);
    }
  }, [mainRepoSessionId, restoredPanelSessionId, activePanels, sessionPanels, workingPanels, setActivePanelInStore]);

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

      // Remove from store first for immediate UI update
      removePanel(mainRepoSessionId, panel.id);

      // The dock isn't in workingPanels, and closing it may promote another
      // shell. Choose from the tabs that remain after that promotion.
      const remaining = usePanelStore.getState().panels[mainRepoSessionId] || [];
      const dock = getDockTerminalPanel(remaining);
      const remainingTabs = remaining.filter(p => p.type !== 'explorer' && p.type !== 'diff' && p.id !== dock?.id);
      const panelIndex = workingPanels.findIndex(p => p.id === panel.id);
      const nextPanel = panelIndex === -1
        ? remainingTabs[0]
        : remainingTabs[Math.min(panelIndex, remainingTabs.length - 1)];

      // Set next active panel if available
      if (nextPanel && activePanels[mainRepoSessionId] === panel.id) {
        setActivePanelInStore(mainRepoSessionId, nextPanel.id);
        await panelApi.setActivePanel(mainRepoSessionId, nextPanel.id);
      }

      // Delete on backend
      await panelApi.deletePanel(panel.id);
    },
    [mainRepoSessionId, workingPanels, activePanels, removePanel, setActivePanelInStore]
  );

  const handlePanelCreate = useCallback(
    async (type: ToolPanelType, options?: PanelCreateOptions) => {
      if (!mainRepoSessionId) return;

      // For terminal panels with initialCommand (e.g., Terminal (Claude))
      let initialState = options?.initialState;
      if (type === 'terminal' && options?.initialCommand) {
        initialState = {
          customState: {
            initialCommand: options.initialCommand
          }
        };
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
      if (isTerminalCollapsed && getDockTerminalPanel(usePanelStore.getState().panels[mainRepoSessionId] || [])?.id === newPanel.id) {
        onToggleTerminal();
      }
      return newPanel;
    },
    [mainRepoSessionId, addPanel, setActivePanelInStore, isTerminalCollapsed, onToggleTerminal]
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

    // Listen for panel events
    const unsubscribeCreated = window.electronAPI?.events?.onPanelCreated?.(handlePanelCreated);

    // Cleanup
    return () => {
      unsubscribeCreated?.();
    };
  }, [mainRepoSessionId, addPanel]);

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
            <div ref={centerColumnBox.ref} className="pane-center-column flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
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
                  <EmptyPanelStage projectEnvironment={projectEnvironment} onPanelCreate={handlePanelCreate} />
                )}
              </div>
              {defaultTerminalPanel && (
                <TerminalDock
                  panel={defaultTerminalPanel}
                  availableHeight={centerColumnBox.height}
                  collapsed={isTerminalCollapsed}
                  hidden={immersiveMode}
                  onToggle={onToggleTerminal}
                  onClose={() => { void handlePanelClose(defaultTerminalPanel); }}
                  isMainRepo
                />
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
        commitMessage={mainRepoGit.commitMessage}
        setCommitMessage={mainRepoGit.setCommitMessage}
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
