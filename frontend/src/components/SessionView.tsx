import { useRef, useEffect, useState, memo, useMemo, useCallback } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useSessionHistoryStore } from '../stores/sessionHistoryStore';
import { useHotkey } from '../hooks/useHotkey';
import { useCommittedRef } from '../hooks/useCommittedRef';
import { useHotkeyStore } from '../stores/hotkeyStore';
import { HomePage } from './HomePage';
import { PaneChatView } from './PaneChatView';
import { LiveRegion } from './ui/LiveRegion';
import '@xterm/xterm/css/xterm.css';
import { useSessionView } from '../hooks/useSessionView';
import { DetailPanel } from './DetailPanel';
import { GitErrorDialog } from './session/GitErrorDialog';
import { CommitMessageDialog } from './session/CommitMessageDialog';
import { FolderArchiveDialog } from './session/FolderArchiveDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { ProjectView } from './ProjectView';
import { UsageView } from './usage/UsageView';
import { API } from '../utils/api';
import { markPaneViewShown } from '../utils/journeyTimings';
import { useObservedContentBox } from '../hooks/useObservedContentBox';
import { useOuterPanelResize } from '../hooks/useOuterPanelResize';
import { OUTER_PANEL_CONFIGS } from '../utils/outerPanelSizing';
import { OuterResizeSeparator } from './ui/OuterResizeSeparator';
import { usePanelStore } from '../stores/panelStore';
import { useProjectViewActionsStore } from '../stores/projectViewActionsStore';
import { panelApi } from '../services/panelApi';
import { setPendingViewCommit } from './panels/diff/pendingViewCommit';
import { PanelTabBar } from './panels/PanelTabBar';
import { PanelContainer } from './panels/PanelContainer';
import { TerminalDock } from './panels/TerminalDock';
import { EmptyPanelStage } from './panels/EmptyPanelStage';
import { getDockTerminalPanel } from '../utils/terminalDock';
import { SplitLayout } from './panels/SplitLayout';
import { SessionProvider } from '../contexts/SessionContext';
import { ToolPanel, ToolPanelType, PANEL_CAPABILITIES, SessionPanelLayout, PanelGroupNode } from '../../../shared/types/panels';
import { PanelCreateOptions, type PanelTabPresentationResolver } from '../types/panelComponents';
import {
  createSingleGroupLayout,
  reconcile as reconcileLayout,
  splitGroup,
  movePanel as movePanelInLayout,
  removePanelFromLayout,
  addPanelToGroup,
  findGroup,
  primaryGroup,
  allGroups,
  allPanelIds,
  findGroupInDirection,
  updateSizes,
  findGroupContainingPanel,
  activatePanelInLayout,
  subsetInsertIndex,
  mergeAllGroups,
  type DropZone,
} from '../utils/panelLayout';
import { Download, Upload, GitMerge, GitPullRequestArrow, Terminal, RefreshCw, Archive, ArchiveRestore, GitCommitHorizontal, Undo2 } from 'lucide-react';
import { visibleAgentPresets } from '../utils/agentPresets';
import type { Project } from '../types/project';
import { devLog, renderLog } from '../utils/console';
import { useConfigStore } from '../stores/configStore';
import { cycleIndex } from '../utils/arrayUtils';
import type { InspectorTab } from './InspectorTabs';
import { useErrorStore } from '../stores/errorStore';
import ProjectSettings from './ProjectSettings';

function pickDefaultPanel(panelList: ToolPanel[], hasReviewPr: boolean): ToolPanel | undefined {
  return (hasReviewPr ? panelList.find(p => p.type === 'diff') : undefined)
    || panelList.find(p => p.type === 'explorer')
    || panelList.find(p => p.type !== 'diff')
    || panelList[0];
}

/** Explorer and Review render in the inspector rail, never on the stage. */
function isInspectorPanelType(type: ToolPanel['type']): boolean {
  return type === 'explorer' || type === 'diff';
}

export const SessionView = memo(() => {
  const { activeView, activeProjectId } = useNavigationStore();
  const [projectData, setProjectData] = useState<Project | null>(null);
  const [isProjectLoading, setIsProjectLoading] = useState(false);
  const [sessionProject, setSessionProject] = useState<Project | null>(null);
  const [showSetTrackingDialog, setShowSetTrackingDialog] = useState(false);
  const [remoteBranches, setRemoteBranches] = useState<string[]>([]);
  const [currentUpstream, setCurrentUpstream] = useState<string | null>(null);

  // Config store for custom commands in terminal row pills
  const { config, fetchConfig } = useConfigStore();
  useEffect(() => { if (!config) { fetchConfig(); } }, [config, fetchConfig]);
  const customCommands = useMemo(
    () => (config?.customCommands ?? []).filter(cmd => cmd?.name && cmd?.command),
    [config?.customCommands]
  );
  const isRemoteMode = config?.remoteDaemon?.client.mode === 'remote';

  // Get active session by subscribing directly to store state
  // This ensures the component re-renders when git status or other session properties update
  const activeSession = useSessionStore((state) => {
    if (!state.activeSessionId) return undefined;
    // Check main repo session first
    if (state.activeMainRepoSession && state.activeMainRepoSession.id === state.activeSessionId) {
      return state.activeMainRepoSession;
    }
    // Otherwise look in regular sessions
    return state.sessions.find(session => session.id === state.activeSessionId);
  });
  const activeProjectEnvironment = sessionProject && sessionProject.id === activeSession?.projectId
    ? sessionProject.environment
    : undefined;
  const agentPresets = useMemo(
    () => visibleAgentPresets(activeProjectEnvironment),
    [activeProjectEnvironment],
  );
  const lastAnnouncedSessionStateRef = useRef<string | null>(activeSession?.status ?? null);
  const [sessionStatusAnnouncement, setSessionStatusAnnouncement] = useState('');

  useEffect(() => {
    if (!activeSession || lastAnnouncedSessionStateRef.current === activeSession.status) return;
    lastAnnouncedSessionStateRef.current = activeSession.status;
    setSessionStatusAnnouncement(
      `${activeSession.name || 'Pane'} is ${activeSession.status}${activeSession.statusMessage ? `: ${activeSession.statusMessage}` : ''}`,
    );
  }, [activeSession]);

  // Panel store state and actions
  const {
    panels,
    activePanels,
    setPanels,
    setActivePanel: setActivePanelInStore,
    addPanel,
    removePanel,
    updatePanelState,
    layouts,
    focusedGroupIds,
    setLayout: setLayoutInStore,
    setFocusedGroup: setFocusedGroupInStore,
  } = usePanelStore();
  
  // History store for navigation
  const { addToHistory } = useSessionHistoryStore();

  // --- Layout debounced persist ---
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingLayoutRef = useRef<{ sessionId: string; layout: SessionPanelLayout } | null>(null);

  const flushLayoutPersist = useCallback(() => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    const pending = pendingLayoutRef.current;
    if (pending) {
      pendingLayoutRef.current = null;
      panelApi.setLayout(pending.sessionId, pending.layout).catch(err => {
        console.warn('[SessionView] Failed to persist layout:', err);
      });
    }
  }, []);

  const debouncedPersist = useCallback((sessionId: string, layout: SessionPanelLayout) => {
    pendingLayoutRef.current = { sessionId, layout };
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(flushLayoutPersist, 500);
  }, [flushLayoutPersist]);

  // Flush a pending layout write before the window closes: the debounce would
  // otherwise lose a split made just before quit.
  useEffect(() => {
    window.addEventListener('beforeunload', flushLayoutPersist);
    return () => window.removeEventListener('beforeunload', flushLayoutPersist);
  }, [flushLayoutPersist]);

  // --- Layout application helper ---
  // Self-healing: every mutation funnels through here, so focus and zoom are
  // repaired centrally instead of in each caller. A collapse that removed the
  // focused group falls back to the primary group; a dead zoom target clears.
  const applyLayout = useCallback((sessionId: string, next: SessionPanelLayout) => {
    // Closing the dock can promote a working shell. Remove its old tab before
    // repairing focus/zoom and persisting, for both local and backend deletes.
    const dock = getDockTerminalPanel(usePanelStore.getState().panels[sessionId] || []);
    if (dock && findGroupContainingPanel(next.root, dock.id)) {
      const root = removePanelFromLayout(next.root, dock.id);
      next = root ? { ...next, root } : createSingleGroupLayout([], null);
    }
    let focusedGid = next.focusedGroupId;
    if (!focusedGid || !findGroup(next.root, focusedGid)) {
      focusedGid = primaryGroup(next.root).id;
    }
    let zoomedGid = next.zoomedGroupId && findGroup(next.root, next.zoomedGroupId)
      ? next.zoomedGroupId
      : null;
    if (zoomedGid) {
      // Any structural change (group added/removed) exits zoom, matching
      // VS Code: a split or drop while zoomed would otherwise land panels in
      // a pane that Allotment keeps hidden.
      const prev = usePanelStore.getState().layouts[sessionId];
      if (prev) {
        const prevGroupIds = allGroups(prev.root).map(g => g.id).join('|');
        const nextGroupIds = allGroups(next.root).map(g => g.id).join('|');
        if (prevGroupIds !== nextGroupIds) zoomedGid = null;
      }
      // Zoom follows focus: moving focus off the zoomed group (directional
      // nav can target hidden groups) exits zoom instead of typing blind.
      if (zoomedGid && focusedGid !== zoomedGid) zoomedGid = null;
    }
    const repaired: SessionPanelLayout = { ...next, focusedGroupId: focusedGid, zoomedGroupId: zoomedGid };

    setLayoutInStore(sessionId, repaired);
    setFocusedGroupInStore(sessionId, focusedGid);
    debouncedPersist(sessionId, repaired);

    // Mirror focused panel to activePanels for existing compatibility
    const g = findGroup(repaired.root, focusedGid);
    if (g?.activePanelId) {
      const currentActive = usePanelStore.getState().activePanels[sessionId];
      if (g.activePanelId !== currentActive) {
        setActivePanelInStore(sessionId, g.activePanelId);
        panelApi.setActivePanel(sessionId, g.activePanelId).catch(() => {});
      }
    }
  }, [setLayoutInStore, setFocusedGroupInStore, debouncedPersist, setActivePanelInStore]);

  // Load panels AND layout when session changes
  useEffect(() => {
    if (activeSession?.id) {
      const sid = activeSession.id;
      devLog.debug('[SessionView] Loading panels for session:', sid);

      // Flush any pending layout from the previous session
      flushLayoutPersist();

      // Snapshot the ids present BEFORE the async load: a panel:created event
      // landing during the load adds its panel to the store, and a plain
      // setPanels(loadedPanels) overwrite would erase it again. Panels that
      // appeared mid-flight (in the store now, absent from both the snapshot
      // and the response) are merged back in.
      const preLoadIds = new Set(
        (usePanelStore.getState().panels[sid] || []).map(p => p.id)
      );

      // Always reload panels from database when switching sessions
      panelApi.loadPanelsForSession(sid).then(async loadedPanels => {
        devLog.debug('[SessionView] Loaded panels:', loadedPanels);
        const sessionState = useSessionStore.getState();
        const loadedSession = sessionState.activeMainRepoSession?.id === sid
          ? sessionState.activeMainRepoSession
          : sessionState.sessions.find(session => session.id === sid);
        const hasReviewPr = !!loadedSession?.gitStatus?.prUrl;
        const inFlight = (usePanelStore.getState().panels[sid] || []).filter(
          p => !preLoadIds.has(p.id) && !loadedPanels.some(lp => lp.id === p.id)
        );
        setPanels(sid, inFlight.length > 0 ? [...loadedPanels, ...inFlight] : loadedPanels);

        // Preserve the existing startup preference without blocking Review.
        const fallback = pickDefaultPanel(loadedPanels, hasReviewPr);

        const activePanelResult = await panelApi.getActivePanel(sid);
        const effectiveActivePanel = activePanelResult ?? fallback;
        const fallbackActiveId = effectiveActivePanel?.id ?? null;

        if (effectiveActivePanel) {
          setActivePanelInStore(sid, effectiveActivePanel.id);
          if (activePanelResult?.id !== effectiveActivePanel.id) {
            panelApi.setActivePanel(sid, effectiveActivePanel.id).catch(() => {});
          }
        }

        // --- Layout load + reconcile ---
        // The dock shell is excluded from the layout tree
        // and so are the inspector panels (Explorer / Review), which never
        // sit on the stage — otherwise a close could hand the group to one.
        const pinned = getDockTerminalPanel(loadedPanels);
        const livePanels = loadedPanels.filter(p => p.id !== pinned?.id && !isInspectorPanelType(p.type));

        // Sort for initial layout creation (explorer first, diff second, then position)
        const typeOrder = (type: string) => {
          if (type === 'explorer') return 0;
          if (type === 'diff') return 1;
          return 2;
        };
        const sortedLive = [...livePanels].sort((a, b) => {
          const orderDiff = typeOrder(a.type) - typeOrder(b.type);
          if (orderDiff !== 0) return orderDiff;
          return (a.metadata?.position ?? 0) - (b.metadata?.position ?? 0);
        });

        try {
          const stored = await panelApi.getLayout(sid);
          // Recompute live ids from the store at set time: panel:created
          // events that landed while this load was in flight are in the store
          // but not in the loadedPanels snapshot. Reconciling against the
          // current store adopts them as orphans instead of dropping them.
          const nowPanels = usePanelStore.getState().panels[sid] || [];
          const pinnedNow = getDockTerminalPanel(nowPanels);
          const liveIdsNow: string[] = [];
          for (const p of nowPanels) {
            if (p.id !== pinnedNow?.id && !isInspectorPanelType(p.type)) liveIdsNow.push(p.id);
          }
          // Treat unknown future layout versions as no stored layout rather
          // than reconciling a shape this build doesn't understand.
          const versionOk = stored?.version === 1;
          const base = (versionOk ? stored : null) ?? createSingleGroupLayout(
            sortedLive.map(p => p.id),
            fallbackActiveId,
          );
          const { layout: reconciledLayout } = reconcileLayout(base, liveIdsNow);
          const layout = fallbackActiveId
            ? activatePanelInLayout(reconciledLayout, fallbackActiveId)
            : reconciledLayout;
          setLayoutInStore(sid, layout);
          setFocusedGroupInStore(sid, layout.focusedGroupId ?? primaryGroup(layout.root).id);
        } catch (err) {
          console.warn('[SessionView] Failed to load layout, creating default:', err);
          const layout = createSingleGroupLayout(
            sortedLive.map(p => p.id),
            fallbackActiveId,
          );
          setLayoutInStore(sid, layout);
          setFocusedGroupInStore(sid, layout.focusedGroupId ?? primaryGroup(layout.root).id);
        }
      });
    }

    // Flush layout on cleanup (session switch or unmount)
    return () => {
      flushLayoutPersist();
    };
  }, [activeSession?.id, setPanels, setActivePanelInStore, setLayoutInStore, setFocusedGroupInStore, flushLayoutPersist]);
  
  // Listen for panel updates from the backend
  useEffect(() => {
    if (!activeSession?.id) return;
    const sid = activeSession.id;

    // Handle panel creation events (for logs panel auto-creation)
    const handlePanelCreated = (panel: ToolPanel) => {
      // Only add if it's for the current session
      if (panel.sessionId === sid) {
        const existingPanels = panels[sid] || [];
        const panelExists = existingPanels.some(p => p.id === panel.id);

        if (!panelExists) {
          addPanel(panel);

          // The dock shell never enters
          // the layout tree
          const sessionPanelsList = usePanelStore.getState().panels[sid] || [];
          const pinnedTerminal = getDockTerminalPanel(sessionPanelsList);
          if (pinnedTerminal && panel.id === pinnedTerminal.id) {
            return;
          }
          if (isInspectorPanelType(panel.type)) return;

          // Add the new panel to the layout (into the focused group, falling
          // back to the primary group if focus is stale). addPanelToGroup is
          // idempotent, so racing with handlePanelCreate cannot double-insert.
          const currentLayout = usePanelStore.getState().layouts[sid];
          if (currentLayout) {
            const focusedGid = usePanelStore.getState().focusedGroupIds[sid];
            const group = (focusedGid && findGroup(currentLayout.root, focusedGid))
              || primaryGroup(currentLayout.root);
            const nextRoot = addPanelToGroup(currentLayout.root, group.id, panel.id, {
              activate: panel.state.isActive,
            });
            if (nextRoot !== currentLayout.root) {
              applyLayout(sid, { ...currentLayout, root: nextRoot });
            }
          }
        }
      }
    };

    const handlePanelUpdated = (updatedPanel: ToolPanel) => {
      if (updatedPanel.sessionId === sid) {
        updatePanelState(updatedPanel);
      }
    };

    // Handle panel deletion events (for backend-initiated deletes)
    const handlePanelDeleted = (data: { panelId: string; sessionId: string }) => {
      if (data.sessionId === sid) {
        removePanel(sid, data.panelId);
        // Reconcile layout. A null result means the tree collapsed entirely;
        // keep one empty group so later creates have a landing spot.
        const currentLayout = usePanelStore.getState().layouts[sid];
        if (currentLayout) {
          const updated = removePanelFromLayout(currentLayout.root, data.panelId);
          const next: SessionPanelLayout = updated
            ? { ...currentLayout, root: updated }
            : { ...createSingleGroupLayout([], null), zoomedGroupId: null };
          applyLayout(sid, next);
        }
      }
    };

    // Listen for panel events
    const unsubscribeCreated = window.electronAPI?.events?.onPanelCreated?.(handlePanelCreated);
    const unsubscribeUpdated = window.electronAPI?.events?.onPanelUpdated?.(handlePanelUpdated);
    const unsubscribeDeleted = window.electronAPI?.events?.onPanelDeleted?.(handlePanelDeleted);

    // Cleanup
    return () => {
      unsubscribeCreated?.();
      unsubscribeUpdated?.();
      unsubscribeDeleted?.();
    };
  }, [activeSession?.id, addPanel, updatePanelState, removePanel, panels, applyLayout]);

  // Get panels for current session with memoization
  const sessionPanels = useMemo(
    () => panels[activeSession?.id || ''] || [],
    [panels, activeSession?.id]
  );
  const activeSessionPanelsLoaded = Boolean(activeSession && panels[activeSession.id]);
  useEffect(() => {
    if (activeSession?.id && activeSessionPanelsLoaded) markPaneViewShown(activeSession.id);
  }, [activeSession?.id, activeSessionPanelsLoaded]);

  // The bottom dock owns a plain shell, never an agent or command panel.
  const defaultTerminalPanel = useMemo(
    () => getDockTerminalPanel(sessionPanels),
    [sessionPanels]
  );

  // Explorer and Review live in the right inspector (Files / Changes), not
  // in the tab strip.
  const filesPanel = useMemo(() => sessionPanels.find(p => p.type === 'explorer'), [sessionPanels]);
  const changesPanel = useMemo(() => sessionPanels.find(p => p.type === 'diff'), [sessionPanels]);
  const isInspectorPanel = useCallback(
    (p: ToolPanel) => p.type === 'explorer' || p.type === 'diff',
    [],
  );

  // Working panels for the tab bar: exclude the inspector panels and the
  // default terminal that's pinned to the bottom.
  const tabBarPanels = useMemo(
    () => sessionPanels.filter(p => !isInspectorPanel(p) && p.id !== defaultTerminalPanel?.id),
    [sessionPanels, defaultTerminalPanel, isInspectorPanel]
  );

  // Sort tab bar panels same as PanelTabBar: explorer first, diff second, then by position
  const sortedSessionPanels = useMemo(() => {
    const typeOrder = (type: string) => {
      if (type === 'explorer') return 0;
      if (type === 'diff') return 1;
      return 2;
    };
    return [...tabBarPanels].sort((a, b) => {
      const orderDiff = typeOrder(a.type) - typeOrder(b.type);
      if (orderDiff !== 0) return orderDiff;
      return (a.metadata?.position ?? 0) - (b.metadata?.position ?? 0);
    });
  }, [tabBarPanels]);

  const currentActivePanel = useMemo(
    () => sessionPanels.find(p => p.id === activePanels[activeSession?.id || '']),
    [sessionPanels, activePanels, activeSession?.id]
  );

  // --- Layout-derived memos ---
  const sessionLayout = useMemo(
    () => layouts[activeSession?.id || ''],
    [layouts, activeSession?.id]
  );
  const focusedGroupId = useMemo(
    () => focusedGroupIds[activeSession?.id || ''] ?? '',
    [focusedGroupIds, activeSession?.id]
  );
  const focusedGroup: PanelGroupNode | null = useMemo(
    () => sessionLayout ? findGroup(sessionLayout.root, focusedGroupId) : null,
    [sessionLayout, focusedGroupId]
  );
  /** Panels in the focused group, in layout order. */
  const focusedGroupPanels = useMemo(() => {
    if (!focusedGroup) return sortedSessionPanels;
    const panelMap = new Map(tabBarPanels.map(p => [p.id, p]));
    return focusedGroup.panelIds.map(id => panelMap.get(id)).filter((p): p is ToolPanel => !!p);
  }, [focusedGroup, tabBarPanels, sortedSessionPanels]);
  /** Primary group panels (for PanelTabBar tab strip). */
  const primaryGroupNode = useMemo(
    () => sessionLayout ? primaryGroup(sessionLayout.root) : null,
    [sessionLayout]
  );
  const primaryGroupPanels = useMemo(() => {
    if (!primaryGroupNode) return undefined; // undefined means PanelTabBar uses its own sort
    const panelMap = new Map(tabBarPanels.map(p => [p.id, p]));
    return primaryGroupNode.panelIds.map(id => panelMap.get(id)).filter((p): p is ToolPanel => !!p);
  }, [primaryGroupNode, tabBarPanels]);
  const isSplitLayout = sessionLayout?.root.type === 'split';
  /** What the top bar shows: everything when unsplit; once split, the
      permanent tool tabs hoisted from EVERY group (in reading order), so the
      defaults stay pinned to the top bar no matter which group owns them.
      Clicking one routes to its owning group via handlePanelSelect. */
  const topBarPanels = useMemo(() => {
    if (!primaryGroupPanels) return undefined;
    if (!isSplitLayout || !sessionLayout) return primaryGroupPanels;
    const panelMap = new Map(tabBarPanels.map(p => [p.id, p]));
    return allPanelIds(sessionLayout.root)
      .map(id => panelMap.get(id))
      .filter((p): p is ToolPanel => !!p && p.metadata?.permanent === true);
  }, [primaryGroupPanels, isSplitLayout, sessionLayout, tabBarPanels]);

  const getPanelTabPresentation = useCallback<PanelTabPresentationResolver>((panel) => {
    if (panel.type !== 'diff') return undefined;
    return {
      title: 'Review',
    };
  }, []);

  // --- Drag & drop state ---
  const [draggedPanelId, setDraggedPanelId] = useState<string | null>(null);
  const [dropZones, setDropZones] = useState<Map<string, DropZone | null>>(new Map());
  const isTabDragging = draggedPanelId !== null;

  // When a split or cross-group move takes a group's ACTIVE panel away, the
  // pure layer falls back to the first remaining id, which is usually a
  // permanent tab (Diff). Prefer the first working tab instead: when split,
  // permanent tabs live in the top bar, so a group flipping to the Diff view
  // under a terminal strip reads as wrong. Callers gate on the moved panel
  // having been the group's active so a deliberately-active Diff stays put.
  const preferWorkingActive = useCallback((
    root: SessionPanelLayout['root'],
    sourceGroupId: string | undefined,
  ): SessionPanelLayout['root'] => {
    if (!sourceGroupId || !activeSession) return root;
    const g = findGroup(root, sourceGroupId);
    if (!g || !g.activePanelId) return root;
    const panelMap = new Map(
      (usePanelStore.getState().panels[activeSession.id] || []).map(p => [p.id, p])
    );
    if (panelMap.get(g.activePanelId)?.metadata?.permanent !== true) return root;
    const firstWorking = g.panelIds.find(id => panelMap.get(id)?.metadata?.permanent !== true);
    if (!firstWorking) return root;
    const nextActive: string = firstWorking;
    function fix(node: SessionPanelLayout['root']): SessionPanelLayout['root'] {
      if (node.type === 'group') {
        return node.id === sourceGroupId ? { ...node, activePanelId: nextActive } : node;
      }
      return { ...node, children: node.children.map(fix) };
    }
    return fix(root);
  }, [activeSession]);

  // Track current session/panel in history when they change
  useEffect(() => {
    if (activeSession?.id && currentActivePanel?.id) {
      addToHistory(activeSession.id, currentActivePanel.id);
    }
  }, [activeSession?.id, currentActivePanel?.id, addToHistory]);

  // Debug logging - only in development with verbose enabled
  renderLog('[SessionView] Session panels:', sessionPanels);
  renderLog('[SessionView] Active panel ID:', activePanels[activeSession?.id || '']);
  renderLog('[SessionView] Current active panel:', currentActivePanel);

  // --- Layout-aware panel select ---
  const handleGroupPanelSelect = useCallback(
    (groupId: string, panel: ToolPanel) => {
      if (!activeSession) return;
      const sid = activeSession.id;
      const currentLayout = usePanelStore.getState().layouts[sid];
      if (!currentLayout) return;

      const next = activatePanelInLayout(currentLayout, panel.id);
      applyLayout(sid, next);
      setFocusedGroupInStore(sid, next.focusedGroupId ?? groupId);
      addToHistory(sid, panel.id);
    },
    [activeSession, applyLayout, setFocusedGroupInStore, addToHistory]
  );

  // FIX: Memoize all callbacks to prevent re-renders
  const handlePanelSelect = useCallback(
    async (panel: ToolPanel) => {
      if (!activeSession) return;

      // Add to history when panel is selected
      addToHistory(activeSession.id, panel.id);

      // If layout exists, find which group contains this panel and update it
      const currentLayout = usePanelStore.getState().layouts[activeSession.id];
      if (currentLayout) {
        const group = findGroupContainingPanel(currentLayout.root, panel.id);
        if (group) {
          handleGroupPanelSelect(group.id, panel);
          return;
        }
      }

      setActivePanelInStore(activeSession.id, panel.id);
      await panelApi.setActivePanel(activeSession.id, panel.id);
    },
    [activeSession, setActivePanelInStore, addToHistory, handleGroupPanelSelect]
  );

  // --- Inspector (right rail: Details / Files / Changes) ---
  const [detailVisible, setDetailVisible] = useState(() => {
    const stored = localStorage.getItem('pane-detail-panel-visible');
    return stored !== null ? stored === 'true' : true;
  });
  useEffect(() => {
    localStorage.setItem('pane-detail-panel-visible', String(detailVisible));
  }, [detailVisible]);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>(() => {
    const stored = localStorage.getItem('pane-inspector-tab');
    return stored === 'files' || stored === 'details' ? stored : 'changes';
  });
  useEffect(() => {
    localStorage.setItem('pane-inspector-tab', inspectorTab);
  }, [inspectorTab]);
  const [isDetailCollapsed, setIsDetailCollapsed] = useState(() => {
    const stored = localStorage.getItem('pane-detail-collapsed');
    return stored === null ? false : stored === 'true';
  });
  useEffect(() => {
    localStorage.setItem('pane-detail-collapsed', String(isDetailCollapsed));
  }, [isDetailCollapsed]);
  /** Show the inspector on the given tab, whichever layout is active. */
  const openInspector = useCallback((tab: InspectorTab) => {
    setInspectorTab(tab);
    setDetailVisible(true);
    setIsDetailCollapsed(false);
  }, []);

  const handleCommitClick = useCallback(
    async (commitHash: string) => {
      if (!activeSession || sessionPanels.length === 0) return;
      const diffPanel = sessionPanels.find(p => p.type === 'diff');
      if (!diffPanel) return;
      // Store pending hash before dispatching — if the diff panel is not
      // currently active, CombinedDiffView is unmounted and will read this
      // module-level variable when it mounts after the panel switch.
      setPendingViewCommit(activeSession.id, commitHash);
      openInspector('changes');
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent('diff:view-commit', {
          detail: { sessionId: activeSession.id, commitHash },
        }));
      }, 0);
    },
    [activeSession, sessionPanels, openInspector]
  );

  // Tab cycling: navigates between panels in the focused group using
  // keyboard shortcuts. Supports wrap-around (last → first). Only enabled
  // when there are 2+ panels. Uses focusedGroupPanels (layout order).
  // Main-repo panes render ProjectView, which owns its own tabs and inspector;
  // the hotkeys below act on it through this bridge instead of this view's state.
  const isMainRepoPane = !!activeSession?.isMainRepo;
  const projectActions = useCallback(
    () => (isMainRepoPane ? useProjectViewActionsStore.getState().actions : null),
    [isMainRepoPane],
  );

  const cycleTab = useCallback((direction: 'next' | 'prev') => {
    const bridged = projectActions();
    if (bridged) { bridged.cycleTab(direction); return; }
    if (!activeSession || focusedGroupPanels.length < 2) return;

    const currentIndex = focusedGroupPanels.findIndex(
      p => p.id === currentActivePanel?.id
    );
    const nextIndex = cycleIndex(currentIndex, focusedGroupPanels.length, direction);
    if (nextIndex === -1) return;

    const nextPanel = focusedGroupPanels[nextIndex];
    handlePanelSelect(nextPanel);
  }, [activeSession, focusedGroupPanels, currentActivePanel, handlePanelSelect, projectActions]);

  // Tab cycling hotkeys
  useHotkey({
    id: 'cycle-tab-prev-a',
    label: 'Previous Tab',
    keys: 'mod+a',
    category: 'tabs',
    enabled: () => (projectActions()?.tabCount() ?? focusedGroupPanels.length) > 1,
    action: () => cycleTab('prev'),
    showInPalette: true,
  });

  useHotkey({
    id: 'cycle-tab-next-d',
    label: 'Next Tab',
    keys: 'mod+d',
    category: 'tabs',
    enabled: () => (projectActions()?.tabCount() ?? focusedGroupPanels.length) > 1,
    action: () => cycleTab('next'),
    showInPalette: true,
  });

  // Mod+Shift+1 through Mod+Shift+9 to switch between panel tabs (focused group scoped)
  const panelLabel = (i: number) => {
    const p = focusedGroupPanels[i];
    if (!p) return `Switch to tab ${i + 1}`;
    const name = p.type === 'diff' ? 'Review' : p.title;
    return `Switch to ${name}`;
  };
  useHotkey({ id: 'panel-tab-1', label: panelLabel(0), keys: 'mod+shift+1', category: 'tabs', enabled: () => (projectActions()?.tabCount() ?? 0) > 0 || !!focusedGroupPanels[0], action: () => { const bridged = projectActions(); if (bridged) { bridged.selectTab(0); return; } const p = focusedGroupPanels[0]; if (p) handlePanelSelect(p); } });
  useHotkey({ id: 'panel-tab-2', label: panelLabel(1), keys: 'mod+shift+2', category: 'tabs', enabled: () => (projectActions()?.tabCount() ?? 0) > 1 || !!focusedGroupPanels[1], action: () => { const bridged = projectActions(); if (bridged) { bridged.selectTab(1); return; } const p = focusedGroupPanels[1]; if (p) handlePanelSelect(p); } });
  useHotkey({ id: 'panel-tab-3', label: panelLabel(2), keys: 'mod+shift+3', category: 'tabs', enabled: () => (projectActions()?.tabCount() ?? 0) > 2 || !!focusedGroupPanels[2], action: () => { const bridged = projectActions(); if (bridged) { bridged.selectTab(2); return; } const p = focusedGroupPanels[2]; if (p) handlePanelSelect(p); } });
  useHotkey({ id: 'panel-tab-4', label: panelLabel(3), keys: 'mod+shift+4', category: 'tabs', enabled: () => (projectActions()?.tabCount() ?? 0) > 3 || !!focusedGroupPanels[3], action: () => { const bridged = projectActions(); if (bridged) { bridged.selectTab(3); return; } const p = focusedGroupPanels[3]; if (p) handlePanelSelect(p); } });
  useHotkey({ id: 'panel-tab-5', label: panelLabel(4), keys: 'mod+shift+5', category: 'tabs', enabled: () => (projectActions()?.tabCount() ?? 0) > 4 || !!focusedGroupPanels[4], action: () => { const bridged = projectActions(); if (bridged) { bridged.selectTab(4); return; } const p = focusedGroupPanels[4]; if (p) handlePanelSelect(p); } });
  useHotkey({ id: 'panel-tab-6', label: panelLabel(5), keys: 'mod+shift+6', category: 'tabs', enabled: () => (projectActions()?.tabCount() ?? 0) > 5 || !!focusedGroupPanels[5], action: () => { const bridged = projectActions(); if (bridged) { bridged.selectTab(5); return; } const p = focusedGroupPanels[5]; if (p) handlePanelSelect(p); } });
  useHotkey({ id: 'panel-tab-7', label: panelLabel(6), keys: 'mod+shift+7', category: 'tabs', enabled: () => (projectActions()?.tabCount() ?? 0) > 6 || !!focusedGroupPanels[6], action: () => { const bridged = projectActions(); if (bridged) { bridged.selectTab(6); return; } const p = focusedGroupPanels[6]; if (p) handlePanelSelect(p); } });
  useHotkey({ id: 'panel-tab-8', label: panelLabel(7), keys: 'mod+shift+8', category: 'tabs', enabled: () => (projectActions()?.tabCount() ?? 0) > 7 || !!focusedGroupPanels[7], action: () => { const bridged = projectActions(); if (bridged) { bridged.selectTab(7); return; } const p = focusedGroupPanels[7]; if (p) handlePanelSelect(p); } });
  useHotkey({ id: 'panel-tab-9', label: panelLabel(8), keys: 'mod+shift+9', category: 'tabs', enabled: () => (projectActions()?.tabCount() ?? 0) > 8 || !!focusedGroupPanels[8], action: () => { const bridged = projectActions(); if (bridged) { bridged.selectTab(8); return; } const p = focusedGroupPanels[8]; if (p) handlePanelSelect(p); } });

  // --- Add Tool commands (palette-only, no keybindings) ---
  // Only enabled in session view (not project view) to prevent hidden panel mutations
  // Worktree panes are the 'sessions' view; a main-repo pane is 'project'.
  const isInSessionView = !!activeSession && (activeView === 'sessions' || activeView === 'project');

  useHotkey({
    id: 'add-tool-terminal',
    label: 'Add Terminal',
    keys: 'mod+alt+1',
    category: 'tools',
    enabled: () => isInSessionView,
    action: () => { const bridged = projectActions(); if (bridged) bridged.addTerminal(); else void handlePanelCreate('terminal'); },
  });

  useHotkey({
    id: 'add-tool-explorer',
    label: 'Show Files',
    keys: 'mod+alt+2',
    category: 'tools',
    enabled: () => isInSessionView,
    action: () => { const bridged = projectActions(); if (bridged) bridged.showInspector('files'); else openInspector('files'); },
  });

  // Close active panel tab (skip permanent panels like diff)
  const closeTabEnabled = () => {
    const bridged = projectActions();
    if (bridged) return bridged.canCloseActiveTab();
    if (!currentActivePanel) return false;
    const caps = PANEL_CAPABILITIES[currentActivePanel.type];
    return !caps?.permanent && !currentActivePanel.metadata?.permanent;
  };
  const closeTabAction = () => {
    const bridged = projectActions();
    if (bridged) { bridged.closeActiveTab(); return; }
    if (currentActivePanel) handlePanelClose(currentActivePanel);
  };

  useHotkey({
    id: 'close-active-tab',
    label: 'Close active tab',
    keys: 'mod+w',
    category: 'tabs',
    enabled: closeTabEnabled,
    action: closeTabAction,
  });

  useHotkey({
    id: 'archive-active-session',
    label: 'Archive Pane',
    keys: 'mod+shift+w',
    category: 'session',
    enabled: () => !!activeSession && !activeSession.archived,
    action: () => hook.setShowArchiveConfirm(true),
  });

  // --- Split tab group hotkeys ---
  // Mod+\: split right (move active tab to a new group to the right)
  useHotkey({
    id: 'split-right',
    label: 'Split Right',
    keys: 'mod+\\',
    category: 'tabs',
    enabled: () => {
      if (!activeSession || !focusedGroup) return false;
      return focusedGroup.panelIds.length >= 2 && !!focusedGroup.activePanelId;
    },
    action: () => {
      if (!activeSession || !focusedGroup || !focusedGroup.activePanelId) return;
      const sid = activeSession.id;
      const currentLayout = usePanelStore.getState().layouts[sid];
      if (!currentLayout) return;
      const newRoot = preferWorkingActive(
        splitGroup(currentLayout.root, focusedGroup.id, focusedGroup.activePanelId, 'row', true),
        focusedGroup.id,
      );
      // Find the new group (the one containing the moved panel)
      const newGroup = findGroupContainingPanel(newRoot, focusedGroup.activePanelId);
      const next: SessionPanelLayout = {
        ...currentLayout,
        root: newRoot,
        focusedGroupId: newGroup?.id ?? currentLayout.focusedGroupId,
      };
      applyLayout(sid, next);
      if (newGroup) {
        setFocusedGroupInStore(sid, newGroup.id);
      }
    },
    showInPalette: true,
  });

  // Mod+Shift+\: split down
  useHotkey({
    id: 'split-down',
    label: 'Split Down',
    keys: 'mod+shift+\\',
    category: 'tabs',
    enabled: () => {
      if (!activeSession || !focusedGroup) return false;
      return focusedGroup.panelIds.length >= 2 && !!focusedGroup.activePanelId;
    },
    action: () => {
      if (!activeSession || !focusedGroup || !focusedGroup.activePanelId) return;
      const sid = activeSession.id;
      const currentLayout = usePanelStore.getState().layouts[sid];
      if (!currentLayout) return;
      const newRoot = preferWorkingActive(
        splitGroup(currentLayout.root, focusedGroup.id, focusedGroup.activePanelId, 'column', true),
        focusedGroup.id,
      );
      const newGroup = findGroupContainingPanel(newRoot, focusedGroup.activePanelId);
      const next: SessionPanelLayout = {
        ...currentLayout,
        root: newRoot,
        focusedGroupId: newGroup?.id ?? currentLayout.focusedGroupId,
      };
      applyLayout(sid, next);
      if (newGroup) {
        setFocusedGroupInStore(sid, newGroup.id);
      }
    },
    showInPalette: true,
  });

  // Mod+Alt+Arrows: directional group focus
  useHotkey({
    id: 'focus-group-left',
    label: 'Focus Group Left',
    keys: 'mod+alt+ArrowLeft',
    category: 'tabs',
    enabled: () => !!sessionLayout && allGroups(sessionLayout.root).length > 1,
    action: () => {
      if (!activeSession || !sessionLayout) return;
      const target = findGroupInDirection(sessionLayout.root, focusedGroupId, 'left');
      if (target) handleFocusGroup(target);
    },
    showInPalette: true,
  });
  useHotkey({
    id: 'focus-group-right',
    label: 'Focus Group Right',
    keys: 'mod+alt+ArrowRight',
    category: 'tabs',
    enabled: () => !!sessionLayout && allGroups(sessionLayout.root).length > 1,
    action: () => {
      if (!activeSession || !sessionLayout) return;
      const target = findGroupInDirection(sessionLayout.root, focusedGroupId, 'right');
      if (target) handleFocusGroup(target);
    },
    showInPalette: true,
  });
  useHotkey({
    id: 'focus-group-up',
    label: 'Focus Group Up',
    keys: 'mod+alt+ArrowUp',
    category: 'tabs',
    enabled: () => !!sessionLayout && allGroups(sessionLayout.root).length > 1,
    action: () => {
      if (!activeSession || !sessionLayout) return;
      const target = findGroupInDirection(sessionLayout.root, focusedGroupId, 'up');
      if (target) handleFocusGroup(target);
    },
    showInPalette: true,
  });
  useHotkey({
    id: 'focus-group-down',
    label: 'Focus Group Down',
    keys: 'mod+alt+ArrowDown',
    category: 'tabs',
    enabled: () => !!sessionLayout && allGroups(sessionLayout.root).length > 1,
    action: () => {
      if (!activeSession || !sessionLayout) return;
      const target = findGroupInDirection(sessionLayout.root, focusedGroupId, 'down');
      if (target) handleFocusGroup(target);
    },
    showInPalette: true,
  });

  // Mod+Shift+Z: zoom toggle
  useHotkey({
    id: 'zoom-toggle',
    label: 'Toggle Zoom',
    keys: 'mod+shift+z',
    category: 'tabs',
    enabled: () => !!sessionLayout && allGroups(sessionLayout.root).length > 1,
    action: () => {
      if (!activeSession || !sessionLayout) return;
      const sid = activeSession.id;
      const currentLayout = usePanelStore.getState().layouts[sid];
      if (!currentLayout) return;
      const isZoomed = !!currentLayout.zoomedGroupId;
      const next: SessionPanelLayout = {
        ...currentLayout,
        zoomedGroupId: isZoomed ? null : focusedGroupId,
      };
      applyLayout(sid, next);
    },
    showInPalette: true,
  });

  const handlePanelClose = useCallback(
    async (panel: ToolPanel) => {
      if (!activeSession) return;
      const sid = activeSession.id;

      // Remove from store first for immediate UI update
      removePanel(sid, panel.id);

      // Update layout: remove the panel and pick next active. A null result
      // means the tree collapsed entirely; keep one empty group so later
      // creates have a landing spot (applyLayout repairs focus).
      const currentLayout = usePanelStore.getState().layouts[sid];
      if (currentLayout) {
        // Find which group had this panel to pick a neighbor
        const group = findGroupContainingPanel(currentLayout.root, panel.id);
        const updated = removePanelFromLayout(currentLayout.root, panel.id);
        if (updated) {
          const next: SessionPanelLayout = { ...currentLayout, root: updated };
          // Pick a successor only when the closed panel WAS the group's
          // active tab; closing a background tab keeps the current one
          // (matching VS Code).
          if (group && group.activePanelId === panel.id) {
            const remainingInGroup = group.panelIds.filter(id => id !== panel.id);
            const panelIndex = group.panelIds.indexOf(panel.id);
            const nextInGroup = remainingInGroup[Math.min(panelIndex, remainingInGroup.length - 1)];
            if (nextInGroup) {
              // Update the group's activePanelId
              function fixActive(node: SessionPanelLayout['root']): SessionPanelLayout['root'] {
                if (node.type === 'group' && node.id === group!.id) {
                  return { ...node, activePanelId: nextInGroup };
                }
                if (node.type === 'split') {
                  return { ...node, children: node.children.map(fixActive) };
                }
                return node;
              }
              next.root = fixActive(next.root);
            }
          }
          applyLayout(sid, next);
        } else {
          applyLayout(sid, { ...createSingleGroupLayout([], null), zoomedGroupId: null });
        }
      } else {
        // Fallback: no layout, use old logic
        const panelIndex = sessionPanels.findIndex(p => p.id === panel.id);
        const nextPanel = sessionPanels[panelIndex + 1] || sessionPanels[panelIndex - 1];
        if (nextPanel) {
          setActivePanelInStore(sid, nextPanel.id);
          await panelApi.setActivePanel(sid, nextPanel.id);
        }
      }

      // Delete on backend
      await panelApi.deletePanel(panel.id);
    },
    [activeSession, sessionPanels, removePanel, setActivePanelInStore, applyLayout]
  );

  const handlePanelCreate = useCallback(
    async (type: ToolPanelType, options?: PanelCreateOptions) => {
      if (!activeSession) return;
      const sid = activeSession.id;

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
        sessionId: sid,
        type,
        title: options?.title,
        initialState
      });

      // Immediately add the panel and set it as active
      addPanel(newPanel);
      setActivePanelInStore(sid, newPanel.id);

      const dock = getDockTerminalPanel(usePanelStore.getState().panels[sid] || []);
      if (dock?.id === newPanel.id) {
        setIsTerminalCollapsed(false);
        return newPanel;
      }

      // Add to layout (into the focused group, falling back to the primary
      // group if focus is stale). addPanelToGroup is idempotent, so racing
      // with the panel:created event handler cannot double-insert.
      const currentLayout = usePanelStore.getState().layouts[sid];
      if (currentLayout) {
        const focusedGid = usePanelStore.getState().focusedGroupIds[sid];
        const targetGroup = (focusedGid && findGroup(currentLayout.root, focusedGid))
          || primaryGroup(currentLayout.root);
        const nextRoot = addPanelToGroup(currentLayout.root, targetGroup.id, newPanel.id);
        if (nextRoot !== currentLayout.root) {
          applyLayout(sid, { ...currentLayout, root: nextRoot });
        }
      }
      return newPanel;
    },
    [activeSession, addPanel, setActivePanelInStore, applyLayout]
  );

  const handleOpenUrlInBrowser = useCallback(async (url: string, title: string) => {
    if (!activeSession) return;
    const existingPanel = sessionPanels.find((candidate) => candidate.type === 'browser');
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
        detail: { url, sessionId: activeSession.id },
      }));
      return;
    }

    await handlePanelCreate('browser', {
      title,
      initialState: { customState: { currentUrl: url } },
    });
  }, [activeSession, handlePanelCreate, handlePanelSelect, sessionPanels, updatePanelState]);

  const handleShowExplorer = useCallback(async () => {
    if (!filesPanel) await handlePanelCreate('explorer');
    openInspector('files');
  }, [filesPanel, handlePanelCreate, openInspector]);

  // --- SplitLayout callbacks ---
  const handleSizesChange = useCallback((splitNodeId: string, sizes: number[]) => {
    if (!activeSession) return;
    const sid = activeSession.id;
    const currentLayout = usePanelStore.getState().layouts[sid];
    if (!currentLayout) return;
    // Allotment re-layouts when panes hide/show for zoom; those geometries
    // are transient (the hidden pane reports a collapsed size) and must not
    // be persisted or a restart-while-zoomed restores a sliver.
    if (currentLayout.zoomedGroupId) return;
    const next: SessionPanelLayout = { ...currentLayout, root: updateSizes(currentLayout.root, splitNodeId, sizes) };
    applyLayout(sid, next);
  }, [activeSession, applyLayout]);

  const handleFocusGroup = useCallback((groupId: string) => {
    if (!activeSession) return;
    const sid = activeSession.id;
    // No-op when already focused: this fires on every mousedown inside a
    // group (capture phase), and re-applying focus would schedule a layout
    // persist and an IPC write per click.
    if (usePanelStore.getState().focusedGroupIds[sid] === groupId) return;
    const currentLayout = usePanelStore.getState().layouts[sid];
    if (currentLayout) {
      const group = findGroup(currentLayout.root, groupId);
      if (group?.activePanelId) {
        setActivePanelInStore(sid, group.activePanelId);
        panelApi.setActivePanel(sid, group.activePanelId).catch(() => {});
      }
      // applyLayout syncs focusedGroupIds in the store
      const next: SessionPanelLayout = { ...currentLayout, focusedGroupId: groupId };
      applyLayout(sid, next);
    } else {
      setFocusedGroupInStore(sid, groupId);
    }
  }, [activeSession, setFocusedGroupInStore, setActivePanelInStore, applyLayout]);

  const handleDropZoneChange = useCallback((groupId: string, zone: DropZone | null) => {
    setDropZones(prev => {
      const next = new Map(prev);
      if (zone === null) next.delete(groupId);
      else next.set(groupId, zone);
      return next;
    });
  }, []);

  const handleDropTab = useCallback((groupId: string, zone: DropZone) => {
    if (!activeSession || !draggedPanelId) return;
    const sid = activeSession.id;
    const currentLayout = usePanelStore.getState().layouts[sid];
    if (!currentLayout) return;

    // No-op: dropping onto own group center
    const sourceGroup = findGroupContainingPanel(currentLayout.root, draggedPanelId);
    if (zone === 'center' && sourceGroup?.id === groupId) {
      setDraggedPanelId(null);
      setDropZones(new Map());
      return;
    }
    // No-op: dropping the only tab of a group onto an edge of the same group
    if (sourceGroup?.id === groupId && sourceGroup?.panelIds.length === 1) {
      setDraggedPanelId(null);
      setDropZones(new Map());
      return;
    }

    let newRoot: SessionPanelLayout['root'];
    if (zone === 'center') {
      const targetGroup = findGroup(currentLayout.root, groupId);
      const insertIdx = targetGroup ? targetGroup.panelIds.length : 0;
      newRoot = movePanelInLayout(currentLayout.root, draggedPanelId, { groupId, index: insertIdx });
    } else {
      newRoot = movePanelInLayout(currentLayout.root, draggedPanelId, { groupId, edge: zone });
    }
    if (sourceGroup && sourceGroup.activePanelId === draggedPanelId) {
      newRoot = preferWorkingActive(newRoot, sourceGroup.id);
    }

    const next: SessionPanelLayout = { ...currentLayout, root: newRoot };
    applyLayout(sid, next);
    setDraggedPanelId(null);
    setDropZones(new Map());
  }, [activeSession, draggedPanelId, applyLayout, preferWorkingActive]);

  const handleDragStart = useCallback((panelId: string) => {
    setDraggedPanelId(panelId);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggedPanelId(null);
    setDropZones(new Map());
  }, []);

  const handleStripDrop = useCallback((groupId: string, panelId: string, insertIndex: number) => {
    if (!activeSession) return;
    const sid = activeSession.id;
    const currentLayout = usePanelStore.getState().layouts[sid];
    if (!currentLayout) return;

    const sourceGroup = findGroupContainingPanel(currentLayout.root, panelId);
    let newRoot = movePanelInLayout(currentLayout.root, panelId, { groupId, index: insertIndex });
    if (sourceGroup && sourceGroup.id !== groupId && sourceGroup.activePanelId === panelId) {
      newRoot = preferWorkingActive(newRoot, sourceGroup.id);
    }
    const next: SessionPanelLayout = { ...currentLayout, root: newRoot };
    applyLayout(sid, next);
    setDraggedPanelId(null);
    setDropZones(new Map());
  }, [activeSession, applyLayout, preferWorkingActive]);

  // Top-bar drops are the un-split gesture: merge every group back into the
  // primary group and place the dropped tab at the indicated position. When
  // the pane isn't split, the merge is the identity and this is a plain
  // reorder. The top bar shows only the permanent subset while split, so its
  // drop indexes translate to the group's full panel order first.
  const primaryGroupId = primaryGroupNode?.id;
  const handlePrimaryStripDrop = useCallback((panelId: string, insertIndex: number) => {
    if (!primaryGroupId || !primaryGroupNode || !activeSession) return;
    const sid = activeSession.id;
    const currentLayout = usePanelStore.getState().layouts[sid];
    if (!currentLayout) return;
    const merged = mergeAllGroups(currentLayout.root);
    // The top bar shows the hoisted permanent subset while split; translate
    // its drop index against the merged (post-un-split) panel order.
    const fullIndex = isSplitLayout && topBarPanels
      ? subsetInsertIndex(merged.panelIds, topBarPanels.map(p => p.id), insertIndex)
      : insertIndex;
    const newRoot = movePanelInLayout(merged, panelId, { groupId: merged.id, index: fullIndex });
    applyLayout(sid, {
      ...currentLayout,
      root: newRoot,
      focusedGroupId: merged.id,
      zoomedGroupId: null,
    });
    setDraggedPanelId(null);
    setDropZones(new Map());
  }, [primaryGroupId, primaryGroupNode, activeSession, isSplitLayout, topBarPanels, applyLayout]);

  const emptyStage = useMemo(() => (
    <EmptyPanelStage projectEnvironment={activeProjectEnvironment} onPanelCreate={handlePanelCreate} />
  ), [activeProjectEnvironment, handlePanelCreate]);

  // --- Editor stage element (shared by both layouts) ---
  const editorStageElement = useMemo(() => {
    if (!sessionLayout || !activeSession) return null;
    return (
      <SplitLayout
        layout={sessionLayout}
        panels={tabBarPanels}
        focusedGroupId={focusedGroupId}
        isMainRepo={!!activeSession.isMainRepo}
        onSizesChange={handleSizesChange}
        onPanelSelect={handleGroupPanelSelect}
        onPanelClose={handlePanelClose}
        onFocusGroup={handleFocusGroup}
        isTabDragging={isTabDragging}
        draggedPanelId={draggedPanelId}
        dropZones={dropZones}
        onDropZoneChange={handleDropZoneChange}
        onDropTab={handleDropTab}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onStripDrop={handleStripDrop}
        getPanelTabPresentation={getPanelTabPresentation}
        emptyState={emptyStage}
      />
    );
  }, [
    sessionLayout, activeSession, tabBarPanels, focusedGroupId,
    handleSizesChange, handleGroupPanelSelect, handlePanelClose, handleFocusGroup,
    isTabDragging, draggedPanelId, dropZones, handleDropZoneChange,
    handleDropTab, handleDragStart, handleDragEnd, handleStripDrop, getPanelTabPresentation, emptyStage,
  ]);

  // Dynamic shortcuts for custom commands (mod+shift+5, 6, 7, ...)
  const registerHotkey = useHotkeyStore((s) => s.register);
  const unregisterHotkey = useHotkeyStore((s) => s.unregister);
  const handlePanelCreateRef = useCommittedRef(handlePanelCreate);
  const isInSessionViewRef = useCommittedRef(isInSessionView);

  useEffect(() => {
    const ids: string[] = [];
    for (const preset of agentPresets) {
      ids.push(preset.hotkeyId);
      registerHotkey({
        id: preset.hotkeyId,
        label: `Add ${preset.title}`,
        keys: preset.hotkey,
        category: 'tools',
        enabled: () => isInSessionViewRef.current,
        action: () => handlePanelCreateRef.current('terminal', {
          initialCommand: preset.command,
          title: preset.title,
        }),
      });
    }
    return () => { ids.forEach(id => unregisterHotkey(id)); };
  }, [agentPresets, handlePanelCreateRef, isInSessionViewRef, registerHotkey, unregisterHotkey]);

  useEffect(() => {
    const CUSTOM_CMD_START = 6; // mod+alt+3-5 stay reserved for built-in agents on every platform
    const maxSlots = Math.min(customCommands.length, 10 - CUSTOM_CMD_START);
    const ids: string[] = [];

    for (let i = 0; i < maxSlots; i++) {
      const cmd = customCommands[i];
      const id = `add-tool-custom-${i}`;
      ids.push(id);
      registerHotkey({
        id,
        label: `Add ${cmd.name}`,
        keys: `mod+alt+${CUSTOM_CMD_START + i}`,
        category: 'tools',
        enabled: () => isInSessionViewRef.current,
        action: () => handlePanelCreateRef.current('terminal', {
          initialCommand: cmd.command,
          title: cmd.name,
        }),
      });
    }

    return () => { ids.forEach(id => unregisterHotkey(id)); };
  }, [customCommands, handlePanelCreateRef, isInSessionViewRef, registerHotkey, unregisterHotkey]);

  // Load project data for active session
  useEffect(() => {
    const loadSessionProject = async () => {
      if (activeSession?.projectId) {
        try {
          const response = await API.projects.getAll();
          if (response.success && response.data) {
            const project = response.data.find((p: Project) => p.id === activeSession.projectId);
            if (project) {
              setSessionProject(project);
            }
          }
        } catch (error) {
          console.error('Failed to load session project:', error);
        }
      } else {
        setSessionProject(null);
      }
    };
    loadSessionProject();
  }, [activeSession?.projectId]);

  // Fetch upstream tracking branch for display
  useEffect(() => {
    if (!activeSession?.id || activeSession.isMainRepo) {
      setCurrentUpstream(null);
      return;
    }
    let cancelled = false;
    API.sessions.getUpstream(activeSession.id).then(response => {
      if (cancelled) return;
      setCurrentUpstream(response.success ? response.data : null);
    }).catch(() => {
      if (!cancelled) setCurrentUpstream(null);
    });
    return () => { cancelled = true; };
  }, [activeSession?.id, activeSession?.isMainRepo]);

  // Load project data when activeProjectId changes
  useEffect(() => {
    if (activeView === 'project' && activeProjectId) {
      const loadProjectData = async () => {
        setIsProjectLoading(true);
        try {
          // Get all projects and find the one we need
          const response = await API.projects.getAll();
          if (response.success && response.data) {
            const project = response.data.find((p: Project) => p.id === activeProjectId);
            if (project) {
              setProjectData(project);
            }
          }
        } catch (error) {
          console.error('Failed to load project data:', error);
        } finally {
          setIsProjectLoading(false);
        }
      };
      loadProjectData();
    } else {
      setProjectData(null);
    }
  }, [activeView, activeProjectId]);

  const hook = useSessionView(activeSession);

  // Handler to open set tracking dialog
  const handleOpenSetTracking = async () => {
    if (!activeSession) return;
    const sessionIdAtStart = activeSession.id;
    try {
      const [branchesResponse, upstreamResponse] = await Promise.all([
        API.sessions.getRemoteBranches(activeSession.id),
        API.sessions.getUpstream(activeSession.id)
      ]);
      // Guard against stale responses if session changed during async call
      if (activeSession.id !== sessionIdAtStart) return;
      if (branchesResponse.success && branchesResponse.data) {
        setRemoteBranches(branchesResponse.data);
      }
      if (upstreamResponse.success) {
        setCurrentUpstream(upstreamResponse.data);
      }
      setShowSetTrackingDialog(true);
    } catch (error) {
      console.error('Failed to fetch remote branches:', error);
    }
  };

  const handleSelectUpstream = async (branch: string) => {
    if (!activeSession) return;
    setShowSetTrackingDialog(false);
    const success = await hook.handleSetUpstream(branch);
    if (success) {
      setCurrentUpstream(branch);
    }
  };

  // IDE dropdown handlers
  const [showProjectSettings, setShowProjectSettings] = useState(false);

  const handleOpenIDEWithCommand = useCallback(async (ideKey?: string) => {
    if (!activeSession) return;
    if (isRemoteMode) {
      useErrorStore.getState().showError({
        title: 'Open IDE unavailable',
        error: 'Open in IDE is only available in local mode. Switch this client back to the local runtime to use your desktop IDE.',
      });
      return;
    }
    try {
      const response = await API.sessions.openIDE(activeSession.id, ideKey);
      if (!response.success) {
        useErrorStore.getState().showError({
          title: 'Failed to open IDE',
          error: response.error || 'Unknown error occurred',
        });
      }
    } catch (error) {
      useErrorStore.getState().showError({
        title: 'Failed to open IDE',
        error: error instanceof Error ? error.message : 'Unknown error occurred',
      });
    }
  }, [activeSession, isRemoteMode]);

  // Layout swap state
  const [layoutSwapped, setLayoutSwapped] = useState(() => {
    return localStorage.getItem('pane-layout-swapped') === 'true';
  });
  const swappedLayoutRendered = layoutSwapped && Boolean(defaultTerminalPanel);

  useEffect(() => {
    localStorage.setItem('pane-layout-swapped', String(layoutSwapped));
  }, [layoutSwapped]);

  const toggleLayoutSwap = useCallback(() => {
    setLayoutSwapped(prev => !prev);
  }, []);

  // Focused tool panels reserve the right/detail rail for the main workspace.
  // Explorer and Review now live in the inspector, so no panel reserves the
  // right rail any more; immersive mode stays off.
  const isImmersivePanel = false;
  const setImmersiveMode = useNavigationStore(s => s.setImmersiveMode);
  const immersiveMode = useNavigationStore(s => s.immersiveMode);

  useEffect(() => {
    setImmersiveMode(isImmersivePanel);
    return () => {
      setImmersiveMode(false);
    };
  }, [isImmersivePanel, setImmersiveMode]);

  // A persisted active panel that is now an inspector panel (Explorer /
  // Review from before they moved to the rail) opens the inspector on that
  // tab and hands the stage to the first working panel.
  const staleActiveHandledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeSession || !currentActivePanel || !isInspectorPanel(currentActivePanel)) return;
    const key = `${activeSession.id}:${currentActivePanel.id}`;
    if (staleActiveHandledRef.current === key) return;
    staleActiveHandledRef.current = key;
    // Switch the inspector to the matching tab but respect the user's choice
    // of whether the rail is shown at all.
    setInspectorTab(currentActivePanel.type === 'diff' ? 'changes' : 'files');
    const fallback = tabBarPanels[0];
    if (fallback) void handlePanelSelect(fallback);
  }, [activeSession, currentActivePanel, isInspectorPanel, tabBarPanels, handlePanelSelect]);

  useEffect(() => {
    if (!sessionLayout) return;
    const inspectorIds = new Set<string>();
    for (const p of sessionPanels) {
      if (isInspectorPanel(p)) inspectorIds.add(p.id);
    }
    const working = new Map(tabBarPanels.map(p => [p.id, p]));
    for (const group of allGroups(sessionLayout.root)) {
      if (!group.activePanelId || !inspectorIds.has(group.activePanelId)) continue;
      const nextId = group.panelIds.find(id => working.has(id));
      const next = nextId ? working.get(nextId) : undefined;
      if (next) handleGroupPanelSelect(group.id, next);
    }
  }, [sessionLayout, sessionPanels, tabBarPanels, isInspectorPanel, handleGroupPanelSelect]);

  // Auto-create terminal panel for existing sessions that don't have one
  // Unless the user has explicitly closed it previously
  const hasTriedCreatingTerminal = useRef(false);
  useEffect(() => {
    if (!activeSession?.id || sessionPanels.some(p => p.type === 'terminal') || hasTriedCreatingTerminal.current) return;
    // Only attempt once per session to avoid loops
    hasTriedCreatingTerminal.current = true;

    // Check if user has previously closed terminal panel for this session
    window.electronAPI?.invoke('panels:shouldAutoCreate', activeSession.id, 'terminal').then(shouldCreate => {
      if (!shouldCreate) {
        return;
      }
      panelApi.createPanel({
        sessionId: activeSession.id,
        type: 'terminal',
        title: 'Terminal',
      }).then(panel => {
        addPanel(panel);
      }).catch(err => {
        console.error('[SessionView] Failed to auto-create terminal panel:', err);
      });
    });
  }, [activeSession?.id, sessionPanels, addPanel]);

  // Reset the flag when session changes
  useEffect(() => {
    hasTriedCreatingTerminal.current = false;
  }, [activeSession?.id]);

  const toggleDetailCollapse = useCallback(() => {
    setIsDetailCollapsed(prev => !prev);
  }, []);

  // Layout-aware detail panel toggle that also handles immersive mode override
  const handleToggleDetailPanel = useCallback(() => {
    if (immersiveMode) {
      return;
    }
    if (swappedLayoutRendered) {
      toggleDetailCollapse();
    } else {
      setDetailVisible(v => !v);
    }
  }, [immersiveMode, swappedLayoutRendered, toggleDetailCollapse]);

  // Share the dock preference across project and session views; expand on first use.
  const [isTerminalCollapsed, setIsTerminalCollapsed] = useState(() => {
    const stored = localStorage.getItem('pane-terminal-collapsed');
    return stored === 'true';
  });

  useEffect(() => {
    localStorage.setItem('pane-terminal-collapsed', String(isTerminalCollapsed));
  }, [isTerminalCollapsed]);

  const toggleTerminalCollapse = useCallback(() => {
    setIsTerminalCollapsed(prev => !prev);
  }, []);

  const sessionContentBox = useObservedContentBox<HTMLDivElement>();
  const centerColumnBox = useObservedContentBox<HTMLDivElement>();
  const detailResize = useOuterPanelResize({
    config: OUTER_PANEL_CONFIGS.worktreeInspector,
    containerPx: sessionContentBox.width,
    enabled: !swappedLayoutRendered && detailVisible && !immersiveMode,
  });
  const rightTerminalResize = useOuterPanelResize({
    config: OUTER_PANEL_CONFIGS.rightTerminal,
    containerPx: sessionContentBox.width,
    enabled: swappedLayoutRendered && !immersiveMode,
  });
  const bottomDetailResize = useOuterPanelResize({
    config: OUTER_PANEL_CONFIGS.bottomDetail,
    containerPx: centerColumnBox.height,
    enabled: swappedLayoutRendered && !isDetailCollapsed && !immersiveMode,
  });

  // Ctrl+`: toggle bottom terminal
  useHotkey({
    id: 'toggle-terminal',
    label: 'Toggle Terminal',
    keys: 'mod+`',
    category: 'view',
    enabled: () => isInSessionView,
    action: toggleTerminalCollapse,
  });

  // Ctrl+Shift+B: toggle detail panel (right sidebar)
  useHotkey({
    id: 'toggle-detail-panel',
    label: 'Toggle Detail Panel',
    keys: 'mod+shift+b',
    category: 'view',
    enabled: () => isInSessionView && !immersiveMode,
    action: () => { const bridged = projectActions(); if (bridged) bridged.toggleDetail(); else handleToggleDetailPanel(); },
  });

  // Create branch actions for the panel bar
  const branchActions = (() => {
    if (!activeSession) return [];
    const busyReason = hook.isMerging
      ? 'Git operation already in progress'
      : activeSession.status === 'running' || activeSession.status === 'initializing'
        ? 'Session is currently running'
        : undefined;
    
    return activeSession.isMainRepo ? [
      {
        id: 'pull',
        label: 'Pull from Remote',
        icon: Download,
        onClick: hook.handleGitPull,
        disabled: hook.isMerging || activeSession.status === 'running' || activeSession.status === 'initializing',
        variant: 'default' as const,
        description: hook.gitCommands?.getPullCommand ? `git ${hook.gitCommands.getPullCommand()}` : 'git pull',
        disabledReason: busyReason,
      },
      {
        id: 'push',
        label: 'Push to Remote', 
        icon: Upload,
        onClick: hook.handleGitPush,
        disabled: hook.isMerging || activeSession.status === 'running' || activeSession.status === 'initializing',
        variant: 'success' as const,
        description: hook.gitCommands?.getPushCommand ? `git ${hook.gitCommands.getPushCommand()}` : 'git push',
        disabledReason: busyReason,
      }
    ] : [
      // --- Sync ---
      {
        id: 'fetch',
        label: 'Fetch',
        icon: RefreshCw,
        onClick: hook.handleGitFetch,
        disabled: hook.isMerging || activeSession.status === 'running' || activeSession.status === 'initializing',
        variant: 'default' as const,
        description: `Fetch from remote into ${hook.gitCommands?.currentBranch || 'current branch'} without merging`,
        disabledReason: busyReason,
      },
      // --- Update working tree ---
      {
        id: 'stash',
        label: 'Stash',
        icon: Archive,
        onClick: hook.handleGitStash,
        disabled: hook.isMerging || activeSession.status === 'running' || activeSession.status === 'initializing' || !activeSession.gitStatus?.hasUncommittedChanges,
        variant: 'default' as const,
        description: activeSession.gitStatus?.hasUncommittedChanges
          ? `Stash uncommitted changes on ${hook.gitCommands?.currentBranch || 'current branch'}`
          : 'No changes to stash',
        disabledReason: busyReason ?? (activeSession.gitStatus?.hasUncommittedChanges ? undefined : 'No changes to stash'),
      },
      {
        id: 'stash-pop',
        label: 'Pop',
        icon: ArchiveRestore,
        onClick: hook.handleGitStashPop,
        disabled: hook.isMerging || activeSession.status === 'running' || activeSession.status === 'initializing' || !hook.hasStash,
        variant: 'default' as const,
        description: hook.hasStash ? 'Apply and remove most recent stash' : 'No stash to pop',
        disabledReason: busyReason ?? (hook.hasStash ? undefined : 'No stash to pop'),
      },
      // --- Commit & push ---
      {
        id: 'commit',
        label: 'Commit',
        icon: GitCommitHorizontal,
        shortcut: 'mod+shift+k',
        onClick: () => {
          hook.setDialogType('commit');
          hook.setShowCommitMessageDialog(true);
        },
        disabled: hook.isMerging || activeSession.status === 'running' || activeSession.status === 'initializing' || (!activeSession.gitStatus?.hasUncommittedChanges && !activeSession.gitStatus?.hasUntrackedFiles),
        variant: 'default' as const,
        description: (activeSession.gitStatus?.hasUncommittedChanges || activeSession.gitStatus?.hasUntrackedFiles)
          ? `Stage all changes and commit on ${hook.gitCommands?.currentBranch || 'current branch'}`
          : 'No changes to commit',
        disabledReason: busyReason ?? ((activeSession.gitStatus?.hasUncommittedChanges || activeSession.gitStatus?.hasUntrackedFiles) ? undefined : 'No changes to commit'),
      },
      {
        id: 'undo-commit',
        label: 'Undo Commit',
        icon: Undo2,
        shortcut: 'mod+alt+z',
        onClick: hook.handleGitSoftReset,
        disabled: hook.isMerging || activeSession.status === 'running' || activeSession.status === 'initializing' || !activeSession.gitStatus?.ahead,
        variant: 'default' as const,
        description: activeSession.gitStatus?.ahead
          ? 'Undo last commit, keeping changes staged (git reset --soft HEAD~1)'
          : 'No commits to undo',
        disabledReason: busyReason ?? (activeSession.gitStatus?.ahead ? undefined : 'No commits to undo'),
      },
      {
        id: 'pull',
        label: 'Pull',
        icon: Download,
        shortcut: 'mod+shift+l',
        onClick: hook.handleGitPull,
        disabled: hook.isMerging || activeSession.status === 'running' || activeSession.status === 'initializing',
        variant: 'default' as const,
        description: `Pull latest changes into ${hook.gitCommands?.currentBranch || 'current branch'}`,
        disabledReason: busyReason,
      },
      {
        id: 'push',
        label: 'Push',
        icon: Upload,
        shortcut: 'mod+shift+u',
        onClick: hook.handleGitPush,
        disabled: hook.isMerging || activeSession.status === 'running' || activeSession.status === 'initializing' || !activeSession.gitStatus?.ahead,
        variant: 'default' as const,
        description: activeSession.gitStatus?.ahead
          ? `Push ${activeSession.gitStatus.ahead} commit(s)${hook.gitCommands?.currentBranch ? ` from ${hook.gitCommands.currentBranch}` : ''} to remote`
          : 'No commits to push',
        disabledReason: busyReason ?? (activeSession.gitStatus?.ahead ? undefined : 'No commits to push'),
      },
      // --- Main branch operations (last) ---
      {
        id: 'rebase-from-main',
        label: 'Rebase',
        icon: GitPullRequestArrow,
        shortcut: 'mod+shift+r',
        onClick: hook.handleRebaseMainIntoWorktree,
        disabled: hook.isMerging || activeSession.status === 'running' || activeSession.status === 'initializing' || !hook.hasChangesToRebase,
        variant: 'default' as const,
        description: hook.gitCommands?.getRebaseFromMainCommand ? hook.gitCommands.getRebaseFromMainCommand() : `Pulls latest changes from ${hook.gitCommands?.comparisonBaseBranch || 'main'}`,
        disabledReason: busyReason ?? (hook.hasChangesToRebase ? undefined : 'No changes to rebase from main'),
      },
      {
        id: 'rebase-to-main',
        label: 'Merge',
        icon: GitMerge,
        shortcut: 'mod+shift+m',
        onClick: hook.handleSquashAndRebaseToMain,
        disabled: hook.isMerging || activeSession.status === 'running' || activeSession.status === 'initializing' ||
                  (!activeSession.gitStatus?.totalCommits || activeSession.gitStatus?.totalCommits === 0 || activeSession.gitStatus?.ahead === 0),
        variant: 'success' as const,
        description: (!activeSession.gitStatus?.totalCommits || activeSession.gitStatus?.totalCommits === 0 || activeSession.gitStatus?.ahead === 0) ?
                     'No commits to merge' :
                     (hook.gitCommands?.getSquashAndRebaseToMainCommand ? hook.gitCommands.getSquashAndRebaseToMainCommand() : `Merges all commits to ${hook.gitCommands?.comparisonBaseBranch || 'main'} (with safety checks)`),
        disabledReason: busyReason ?? ((!activeSession.gitStatus?.totalCommits || activeSession.gitStatus?.totalCommits === 0 || activeSession.gitStatus?.ahead === 0) ? 'No commits to merge' : undefined),
      }
    ];
  })();
  
  // Removed unused variables - now handled by panels

  // Token usage, cost and rate limits — reported per host.
  if (activeView === 'usage') {
    return <UsageView />;
  }

  // Show project view if navigation is set to project
  if (activeView === 'project' && activeProjectId) {
    if (isProjectLoading || !projectData) {
      return (
        <div className="flex-1 flex flex-col overflow-hidden bg-surface-secondary p-6">
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-interactive mx-auto mb-4"></div>
              <p className="text-text-secondary">Loading project...</p>
            </div>
          </div>
        </div>
      );
    }

    return (
      <>
        <ProjectView
          projectId={activeProjectId}
          projectName={projectData.name || 'Project'}
          projectEnvironment={projectData.environment}
          configuredIDECommand={projectData.open_ide_command}
          onConfigureIDE={() => setShowProjectSettings(true)}
          isTerminalCollapsed={isTerminalCollapsed}
          onToggleTerminal={toggleTerminalCollapse}
        />
        <ProjectSettings
          project={projectData}
          isOpen={showProjectSettings}
          onClose={() => setShowProjectSettings(false)}
          onUpdate={() => {
            API.projects.getAll().then(response => {
              if (response.success && response.data) {
                const project = response.data.find((candidate: Project) => candidate.id === activeProjectId);
                if (project) setProjectData(project);
              }
            });
          }}
          onDelete={() => setShowProjectSettings(false)}
        />
      </>
    );
  }

  if (activeView === 'pane-chat') {
    return <PaneChatView />;
  }

  if (!activeSession) {
    return <HomePage />;
  }
  
  return (
    <div className="pane-session-shell flex-1 flex flex-col overflow-hidden bg-bg-primary">
      <LiveRegion mode={activeSession.status === 'error' ? 'assertive' : 'polite'}>
        {sessionStatusAnnouncement}
      </LiveRegion>
      {/* SINGLE SessionProvider wraps everything */}
      <SessionProvider session={activeSession} gitBranchActions={branchActions} isMerging={hook.isMerging} gitCommands={hook.gitCommands} onOpenIDEWithCommand={handleOpenIDEWithCommand} onOpenUrlInBrowser={handleOpenUrlInBrowser} onConfigureIDE={() => setShowProjectSettings(true)} onSetTracking={handleOpenSetTracking} trackingBranch={currentUpstream} configuredIDECommand={sessionProject?.open_ide_command} isRemoteMode={isRemoteMode}>

        {/* Tab bar at top */}
        <PanelTabBar
          panels={tabBarPanels}
          activePanel={currentActivePanel}
          onPanelSelect={handlePanelSelect}
          onPanelClose={handlePanelClose}
          onPanelCreate={handlePanelCreate}
          onShowExplorer={() => { void handleShowExplorer(); }}
          projectEnvironment={activeProjectEnvironment}
          onToggleDetailPanel={handleToggleDetailPanel}
          detailPanelVisible={detailVisible}
          detailPanelToggleDisabled={immersiveMode}
          detailPanelToggleDisabledReason="Hidden in Explorer and Diff views"
          primaryGroupPanels={topBarPanels}
          primaryGroupActivePanelId={isSplitLayout ? (currentActivePanel?.id ?? null) : primaryGroupNode?.activePanelId}
          primaryGroupFocused={!primaryGroupNode || primaryGroupNode.id === focusedGroupId}
          tabsInGroups={isSplitLayout}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onStripDrop={primaryGroupNode ? handlePrimaryStripDrop : undefined}
          isTabDragging={isTabDragging}
          draggedPanelId={draggedPanelId}
          getPanelTabPresentation={getPanelTabPresentation}
        />

        {/* Content area: center panels + right detail */}
        <div ref={sessionContentBox.ref} className="pane-session-content flex-1 flex flex-row min-h-0 min-w-0">
          {swappedLayoutRendered && defaultTerminalPanel ? (
            <>
              {/* SWAPPED LAYOUT: Center column with panels on top, horizontal detail panel on bottom */}
              <div ref={centerColumnBox.ref} className="pane-center-column flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
                {/* Top: active panel content */}
                <div className="pane-editor-stage flex-1 relative min-h-0 overflow-hidden bg-bg-editor">
                  {editorStageElement || emptyStage}
                </div>

                {/* Bottom: horizontal detail panel */}
                <DetailPanel
                  isVisible={true}
                  onToggle={toggleDetailCollapse}
                  width={0}
                  height={bottomDetailResize.effectivePx}
                  availableHeight={centerColumnBox.height}
                  bodyActive={bottomDetailResize.bodyActive}
                  resizeSeparator={bottomDetailResize.separatorVisible ? {
                    label: 'Resize detail panel',
                    orientation: 'horizontal',
                    value: bottomDetailResize.effectivePx,
                    minimum: bottomDetailResize.floor,
                    maximum: bottomDetailResize.cap,
                    ...bottomDetailResize.separatorHandlers,
                  } : undefined}
                  mergeError={hook.mergeError}
                  orientation="horizontal"
                  isCollapsed={isDetailCollapsed}
                  onToggleCollapse={toggleDetailCollapse}
                  onSwapLayout={toggleLayoutSwap}
                  onCommitClick={handleCommitClick}
                  inspectorTab={inspectorTab}
                  onInspectorTabChange={openInspector}
                  filesPanel={filesPanel}
                  changesPanel={changesPanel}
                  changesCount={activeSession.gitStatus?.filesChanged || undefined}
                  isMainRepo={!!activeSession.isMainRepo}
                />
              </div>

              {/* Right column: terminal at full height — outer wrapper clips, inner stays fixed width so xterm doesn't reflow */}
              <div
                className={`pane-terminal-rail flex-shrink-0 overflow-visible relative ${rightTerminalResize.renderedPx > 0 ? 'border-l border-border-primary' : ''}`}
                style={{ width: `${rightTerminalResize.renderedPx}px` }}
              >
                {rightTerminalResize.separatorVisible && (
                  <OuterResizeSeparator
                    label="Resize terminal"
                    orientation="vertical"
                    value={rightTerminalResize.effectivePx}
                    minimum={rightTerminalResize.floor}
                    maximum={rightTerminalResize.cap}
                    {...rightTerminalResize.separatorHandlers}
                  />
                )}
                <div className="pane-terminal-rail-clip h-full overflow-hidden">
                  <div
                    className="pane-terminal-rail-shell bg-surface-primary flex flex-col h-full relative overflow-hidden"
                    style={{ width: `${rightTerminalResize.effectivePx}px` }}
                    aria-hidden={!rightTerminalResize.bodyActive}
                    inert={!rightTerminalResize.bodyActive ? true : undefined}
                  >
                    {/* Terminal header */}
                    <div className="pane-terminal-shell-header flex items-center h-8 px-3 bg-surface-primary border-b border-border-primary gap-2">
                      <Terminal className="w-3.5 h-3.5 text-text-tertiary" />
                      <span className="text-[11px] font-medium text-text-secondary uppercase tracking-wider">Terminal</span>
                    </div>

                    {/* Terminal content - full height */}
                    <div className="pane-terminal-shell-body flex-1 relative min-h-0 pb-1">
                      <PanelContainer
                        panel={defaultTerminalPanel}
                        isActive={rightTerminalResize.bodyActive}
                        autoFocus={false}
                        isMainRepo={!!activeSession.isMainRepo}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <>
              {/* DEFAULT LAYOUT: Center column with panels on top, terminal on bottom */}
              <div ref={centerColumnBox.ref} className="pane-center-column flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
                {/* Top: active panel content */}
                <div className="pane-editor-stage flex-1 relative min-h-0 overflow-hidden bg-bg-editor">
                  {editorStageElement || emptyStage}
                </div>

                {defaultTerminalPanel && (
                  <TerminalDock
                    panel={defaultTerminalPanel}
                    availableHeight={centerColumnBox.height}
                    collapsed={isTerminalCollapsed}
                    hidden={immersiveMode}
                    onToggle={toggleTerminalCollapse}
                    onClose={() => { void handlePanelClose(defaultTerminalPanel); }}
                    isMainRepo={!!activeSession.isMainRepo}
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
                  label: 'Resize inspector',
                  orientation: 'vertical',
                  value: detailResize.effectivePx,
                  minimum: detailResize.floor,
                  maximum: detailResize.cap,
                  ...detailResize.separatorHandlers,
                } : undefined}
                mergeError={hook.mergeError}
                onSwapLayout={toggleLayoutSwap}
                onCommitClick={handleCommitClick}
                inspectorTab={inspectorTab}
                onInspectorTabChange={openInspector}
                filesPanel={filesPanel}
                changesPanel={changesPanel}
                changesCount={activeSession.gitStatus?.filesChanged || undefined}
                isMainRepo={!!activeSession.isMainRepo}
              />
            </>
          )}
        </div>

      </SessionProvider>

      <CommitMessageDialog
        isOpen={hook.showCommitMessageDialog}
        onClose={() => hook.setShowCommitMessageDialog(false)}
        dialogType={hook.dialogType}
        gitCommands={hook.gitCommands}
        commitMessage={hook.commitMessage}
        shouldSquash={hook.shouldSquash}
        setShouldSquash={hook.setShouldSquash}
        onConfirm={(message) => {
          if (hook.dialogType === 'commit') {
            hook.handleGitStageAndCommit(message);
            hook.setShowCommitMessageDialog(false);
          } else {
            hook.performSquashWithCommitMessage(message);
          }
        }}
        onMergeAndArchive={hook.performSquashWithCommitMessageAndArchive}
        isMerging={hook.isMerging}
        isMergingAndArchiving={hook.isMergingAndArchiving}
      />

      <GitErrorDialog
        isOpen={hook.showGitErrorDialog}
        onClose={() => hook.setShowGitErrorDialog(false)}
        errorDetails={hook.gitErrorDetails}
        getGitErrorTips={hook.getGitErrorTips}
        onAbortAndUseClaude={hook.handleAbortRebaseAndUseClaude}
      />

      <ConfirmDialog
        isOpen={hook.showArchiveConfirm}
        onClose={() => hook.setShowArchiveConfirm(false)}
        onConfirm={hook.handleConfirmArchive}
        title="Archive Pane"
        message={`Archive pane "${activeSession?.name}"? This will:\n\n• Move the pane to the archived panes list\n• Preserve all pane history and outputs\n${activeSession?.isMainRepo ? '• Close the active Claude Code connection' : activeSession?.worktreeOwnership === 'external' ? '• Leave the externally managed worktree untouched' : `• Remove the git worktree locally (${activeSession?.worktreePath?.split('/').pop() || 'worktree'})`}`}
        confirmText="Archive"
        variant="warning"
        icon={<Archive className="w-6 h-6 text-amber-500 flex-shrink-0" />}
      />

      <FolderArchiveDialog
        isOpen={hook.showFolderArchiveDialog}
        sessionCount={hook.folderSessionCount}
        onArchiveSessionOnly={hook.handleArchiveSessionOnly}
        onArchiveEntireFolder={hook.handleArchiveEntireFolder}
        onCancel={hook.handleCancelFolderArchive}
      />

      {/* Project Settings Dialog (opened from IDE dropdown) */}
      {sessionProject && (
        <ProjectSettings
          project={sessionProject}
          isOpen={showProjectSettings}
          onClose={() => setShowProjectSettings(false)}
          onUpdate={() => {
            // Refresh session project data
            if (activeSession?.projectId) {
              API.projects.getAll().then(response => {
                if (response.success && response.data) {
                  const project = response.data.find((p: Project) => p.id === activeSession.projectId);
                  if (project) setSessionProject(project);
                }
              });
            }
          }}
          onDelete={() => setShowProjectSettings(false)}
        />
      )}

      {/* Set Tracking Dialog */}
      {showSetTrackingDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-bg-primary border border-border-primary rounded-lg shadow-lg p-4 w-80 max-h-96 overflow-hidden flex flex-col">
            <h3 className="text-lg font-medium text-text-primary mb-2">Set Tracking Branch</h3>
            {currentUpstream && (
              <p className="text-sm text-text-secondary mb-3">
                Currently tracking: <span className="text-text-primary font-mono">{currentUpstream}</span>
              </p>
            )}
            <p className="text-sm text-text-secondary mb-3">Select a remote branch to track:</p>
            <div className="flex-1 overflow-y-auto space-y-1 mb-4">
              {remoteBranches.length === 0 ? (
                <p className="text-sm text-text-tertiary italic">No remote branches found</p>
              ) : (
                remoteBranches.map((branch) => (
                  <button
                    key={branch}
                    onClick={() => handleSelectUpstream(branch)}
                    className={`w-full text-left px-3 py-2 rounded text-sm font-mono hover:bg-bg-secondary transition-colors ${
                      branch === currentUpstream ? 'bg-bg-secondary text-accent-primary' : 'text-text-primary'
                    }`}
                  >
                    {branch}
                    {branch === currentUpstream && <span className="ml-2 text-xs">(current)</span>}
                  </button>
                ))
              )}
            </div>
            <button
              onClick={() => setShowSetTrackingDialog(false)}
              className="w-full px-4 py-2 text-sm text-text-secondary hover:text-text-primary border border-border-primary rounded hover:bg-bg-secondary transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

    </div>
  );
});

SessionView.displayName = 'SessionView';
