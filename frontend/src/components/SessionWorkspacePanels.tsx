import { createPortal } from 'react-dom';
import { useTitleBarSlotStore } from '../stores/titleBarSlotStore';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, ListTodo, PanelRight, Terminal } from 'lucide-react';
import type { PanelLayoutNode, SessionPanelLayout, TerminalPanelState, ToolPanel } from '../../../shared/types/panels';
import { panelApi } from '../services/panelApi';
import { isArchivedOrchestrationSession, useOrchestrationSessionStore } from '../stores/orchestrationSessionStore';
import { isTodosEnabled, useConfigStore } from '../stores/configStore';
import { readPaneLayout, rememberPaneLayout } from '../utils/paneLayoutMemory';
import { getActiveRemoteHostId } from '../../../shared/types/remoteDaemon';
import { usePanelStore } from '../stores/panelStore';
import { PanelContainer } from './panels/PanelContainer';
import { PanelTabStrip } from './panels/PanelTabStrip';
import { SplitLayout } from './panels/SplitLayout';
import type { PanelTabPresentationResolver } from '../types/panelComponents';
import { SessionAddToolMenu, type SessionToolSpec } from './SessionAddToolMenu';
import { SessionStageSkeleton, SessionWorkspaceSkeleton } from './SessionWorkspaceSkeleton';
import { useOuterPanelResize } from '../hooks/useOuterPanelResize';
import { OuterResizeSeparator } from './ui/OuterResizeSeparator';
import { OUTER_PANEL_CONFIGS } from '../utils/outerPanelSizing';
import { cycleIndex } from '../utils/arrayUtils';
import { RestoreRegionButton } from './RestoreRegionButton';
import { useRegionActions } from '../hooks/useRegionNavigation';
import {
  approvalColumnTabCount,
  focusedApprovalColumn,
  leaveApprovalColumn,
  showApprovalColumnTab,
  useFocusRegionStore,
} from '../services/regionFocus';
import { SplitApprovalOverlay } from './approvals/SplitApprovalOverlay';
import { escapeApprovalColumn, useLeaveOnClose } from './approvals/useSplitOverlay';
import { useProjectViewActionsStore, type ProjectViewActions } from '../stores/projectViewActionsStore';
import { announceTerminalReflow } from '../utils/terminalReflow';
import {
  activatePanelInLayout,
  addPanelToGroup,
  createSingleGroupLayout,
  findGroup,
  findGroupContainingPanel,
  movePanel,
  primaryGroup,
  applyPanelReplacements,
  placeCreatedPanel,
  placeLeadingSideTab,
  placeTabAfter,
  sessionOverviewTabId,
  sessionTodosTabId,
  reconcile,
  removePanelFromLayout,
  showPanelInSplit,
  splitGroup,
  subsetInsertIndex,
  updateSizes,
  type DropZone,
} from '../utils/panelLayout';

const EMPTY_PANELS: ToolPanel[] = [];
const SESSION_INSPECTOR_TABS = ['files', 'changes', 'todos'] as const;
const SESSION_INSPECTOR_LABELS = { files: 'Files', changes: 'Changes', todos: 'To-dos' } as const satisfies Record<SessionInspectorTab, string>;
type SessionInspectorTab = typeof SESSION_INSPECTOR_TABS[number];

/** The Overview tab as the tab strip sees it: a permanent tab named Overview. */
function sessionOverviewTab(sessionId: string): ToolPanel {
  return {
    id: sessionOverviewTabId(sessionId),
    sessionId,
    type: 'dashboard',
    title: 'Overview',
    state: { isActive: false },
    metadata: { createdAt: '', lastActiveAt: '', position: 0, permanent: true },
  };
}

/** The To-dos tab (T-23), the same way: a permanent tab named To-dos, its list drawn by the Session. */
function sessionTodosTab(sessionId: string): ToolPanel {
  return {
    id: sessionTodosTabId(sessionId),
    sessionId,
    type: 'dashboard',
    title: 'To-dos',
    state: { isActive: false },
    metadata: { createdAt: '', lastActiveAt: '', position: 1, permanent: true },
  };
}

/**
 * A layout with the Overview and To-dos tabs in it: Overview first in the right split, opening one
 * beside the conversation when there is none, and To-dos right after it. Wherever the person moved
 * either, it stays. With To-dos off (`todosId` null, T-39) there is no To-dos tab.
 */
function withSessionTabs(layout: SessionPanelLayout, overviewId: string, todosId: string | null, chatId: string): SessionPanelLayout {
  const withOverview = placeLeadingSideTab(layout.root, overviewId, chatId);
  const root = todosId ? placeTabAfter(withOverview, todosId, overviewId) : withOverview;
  return root === layout.root ? layout : { ...layout, root };
}

const TODOS_TAB_ICON = <ListTodo className="h-4 w-4 flex-shrink-0" aria-hidden="true" />;
/** Panels that always live on the Session stage as tabs; Files docks in the inspector. */
const STAGE_PANEL_TYPES = new Set<ToolPanel['type']>(['editor', 'browser', 'notes', 'device']);

/** A terminal started with a command (an agent or a custom command) is always a tab. */
function launchesCommand(panel: ToolPanel): boolean {
  // SAFETY: The terminal discriminator determines the custom-state shape.
  const state = panel.state.customState as TerminalPanelState | undefined;
  return !!state?.initialCommand?.trim() || !!state?.isCliPanel || !!state?.agentType;
}

/** Every group in a layout subtree, in order. */
function groupsIn(node: PanelLayoutNode): Array<Extract<PanelLayoutNode, { type: 'group' }>> {
  return node.type === 'group' ? [node] : node.children.flatMap(groupsIn);
}

/** The Session's right split view: the last child of a side-by-side root, if there is one (D-261). */
function rightSplit(layout: SessionPanelLayout | null | undefined): PanelLayoutNode | undefined {
  return layout?.root.type === 'split' && layout.root.direction === 'row' ? layout.root.children.at(-1) : undefined;
}

/**
 * The approval column for a Session's stage (D-261): it lays over the right split view, or opens
 * a split of its own when there is none. ✕ shows the split again, or collapses the one it opened.
 */
export interface StageApproval {
  open: boolean;
  /** `focused`: keyboard focus is in the column, so its active tab carries the accent (D-335). */
  render: (closeLabel: string, onClose: () => void, focused: boolean) => ReactNode;
  onClose: () => void;
}

function layoutPanelIds(layout: SessionPanelLayout | null | undefined): Set<string> {
  const ids = new Set<string>();
  const walk = (node: SessionPanelLayout['root']) => {
    if (node.type === 'group') node.panelIds.forEach(id => ids.add(id));
    else node.children.forEach(walk);
  };
  if (layout) walk(layout.root);
  return ids;
}

/**
 * Whether a Session panel is a tab on the stage. Terminals opened from the "+"
 * menu are tabs (they sit in the layout, or launch a command); the one plain
 * shell outside the layout is the bottom terminal dock.
 */
function isStagePanel(panel: ToolPanel, agentPanelIds: ReadonlySet<string>, inLayout: ReadonlySet<string>): boolean {
  if (STAGE_PANEL_TYPES.has(panel.type)) return true;
  // A chat taking over a terminal tab (Switch to chat) holds its slot until it becomes the agent tab.
  const replaced = panel.metadata?.replacesPanelId;
  if (replaced && !agentPanelIds.has(panel.id) && (inLayout.has(panel.id) || inLayout.has(replaced))) return true;
  if (panel.type !== 'terminal' || agentPanelIds.has(panel.id)) return false;
  return inLayout.has(panel.id) || launchesCommand(panel);
}

export function SessionWorkspacePanels({
  agentPanel,
  agentPanelIds,
  overviewContent,
  todosContent,
  todosWaiting = 0,
  changesContent,
  sidebarTodosContent,
  toolbarActions,
  stageNotice,
  chromeInline = false,
  focusWithin = true,
  approval,
  hidden = false,
  tileMaximized = false,
  onToggleTileMaximize,
}: {
  agentPanel: ToolPanel; agentPanelIds: string[];
  overviewContent: ReactNode; changesContent: ReactNode; toolbarActions?: ReactNode;
  /**
   * The sidebar's To-dos (T-37): the to-dos the Session requested. Given the opener that shows the
   * split's To-dos tab, which the Session calls after pointing that tab at the to-do.
   */
  sidebarTodosContent?: (showTodosTab: () => void) => ReactNode;
  /** The To-dos tab's list (T-23), drawn by the Session like the Overview. */
  todosContent: ReactNode;
  /** The Session's to-dos' approvals waiting on you: the To-dos tab's amber count. */
  todosWaiting?: number;
  /** Absolutely positioned over the top of the stage, so showing it never resizes a terminal. */
  stageNotice?: ReactNode;
  /**
   * Keep this Session's toolbar in its own tile instead of the window title
   * bar. The title bar has one trailing slot, so tiled Sessions would otherwise
   * all portal their controls into the same strip.
   */
  chromeInline?: boolean;
  /**
   * Whether this Session owns window focus. A tile that does not must not
   * autofocus its panels, or the last tile to mount would steal the caret.
   */
  focusWithin?: boolean;
  /** An approval open on this Session (P4). */
  approval?: StageApproval;
  /** Another tile is maximized over this one: everything stays mounted, terminals deactivate. */
  hidden?: boolean;
  /** This Session's tile is maximized over the other tiles (P4). */
  tileMaximized?: boolean;
  /** Maximize this Session's tile, or restore; absent while it is the only tile. */
  onToggleTileMaximize?: () => void;
}) {
  const titleBarSlot = useTitleBarSlotStore(state => state.trailingSlot);
  const trailingSlot = chromeInline ? null : titleBarSlot;
  const sessionId = agentPanel.sessionId;
  const panels = usePanelStore(state => state.panels[sessionId] ?? EMPTY_PANELS);
  const layout = usePanelStore(state => state.layouts[sessionId]);
  const [showTerminal, setShowTerminal] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<SessionInspectorTab>('changes');
  const showSidebar = sidebarVisible;
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(960);
  const filesResize = useOuterPanelResize({ config: OUTER_PANEL_CONFIGS.worktreeInspector, containerPx: width, enabled: showSidebar });
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  const [loaded, setLoaded] = useState(false);
  // The split layout measures itself before its panels paint: for those first
  // frames the stage keeps the skeleton the terminal's own mask then takes over.
  const [stageUnderlay, setStageUnderlay] = useState(true);
  useEffect(() => {
    if (!loaded) { setStageUnderlay(true); return; }
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => setStageUnderlay(false)); });
    return () => cancelAnimationFrame(frame);
  }, [loaded]);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const creating = useRef(false);
  const inLayout = useMemo(() => layoutPanelIds(layout), [layout]);
  const agentPanelIdSet = useMemo(() => new Set(agentPanelIds), [agentPanelIds]);
  const terminal = panels.find(panel => panel.type === 'terminal' && !agentPanelIdSet.has(panel.id) && !isStagePanel(panel, agentPanelIdSet, inLayout));
  const explorer = panels.find(panel => panel.type === 'explorer');
  // Readiness may arrive while the initial layout is loading, before the
  // terminal subscribes. Use the live record after this visit's load finishes;
  // until then the store may still contain a previous visit or host's record.
  const currentAgentPanel = (loaded && panels.find(panel => panel.id === agentPanel.id)) || agentPanel;
  const overviewTab = useMemo(() => sessionOverviewTab(sessionId), [sessionId]);
  const overviewId = overviewTab.id;
  const todosTab = useMemo(() => sessionTodosTab(sessionId), [sessionId]);
  // To-dos off (T-39): no To-dos tab; turning it on puts it back after the Overview. Until the
  // settings load it counts as on, so a saved layout never loses the tab's place to a first frame.
  const todosOn = useConfigStore(state => state.config === null || isTodosEnabled(state.config));
  // T-39: the sidebar's To-dos tab (T-37) and its count wait for the switch itself, so it never flashes in before settings load.
  const sidebarTodosOn = useConfigStore(state => isTodosEnabled(state.config));
  const inspectorTabs: readonly SessionInspectorTab[] = sidebarTodosOn ? SESSION_INSPECTOR_TABS : SESSION_INSPECTOR_TABS.filter(tab => tab !== 'todos');
  const shownSidebarTab: SessionInspectorTab = sidebarTab === 'todos' && !sidebarTodosOn ? 'changes' : sidebarTab;
  const todosId = todosOn ? todosTab.id : null;
  const tabs = useMemo(
    () => [currentAgentPanel, overviewTab, ...(todosOn ? [todosTab] : []), ...panels.filter(panel => isStagePanel(panel, agentPanelIdSet, inLayout))],
    [currentAgentPanel, overviewTab, todosOn, todosTab, panels, agentPanelIdSet, inLayout],
  );
  const tabPresentation = useCallback<PanelTabPresentationResolver>((panel) => {
    if (panel.id !== todosId) return undefined;
    return {
      icon: TODOS_TAB_ICON,
      badge: todosWaiting > 0 ? { count: todosWaiting, label: `${todosWaiting} waiting on you` } : undefined,
    };
  }, [todosId, todosWaiting]);
  const agentPanelId = agentPanel.id;
  // With no tab left but the conversation, the layout still holds the Overview and To-dos beside it.
  const freshLayout = useCallback(
    () => withSessionTabs(createSingleGroupLayout([agentPanelId], agentPanelId), overviewId, todosId, agentPanelId),
    [agentPanelId, overviewId, todosId],
  );
  // The panel events below outlive the render that subscribed them, so they read
  // the agent ids through a ref that the commit keeps current.
  const agentPanelIdsRef = useRef(agentPanelIdSet);
  useEffect(() => {
    agentPanelIdsRef.current = agentPanelIdSet;
  }, [agentPanelIdSet]);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingLayout = useRef<{ sessionId: string; layout: SessionPanelLayout; hostId: string | null | undefined } | null>(null);
  // Writes a debounced layout now. Leaving the Session flushes it, so the last
  // tab or split shown is never lost; an archived Session stays forgotten.
  const flushLayout = useCallback(() => {
    clearTimeout(persistTimer.current);
    const pending = pendingLayout.current;
    pendingLayout.current = null;
    if (!pending) return;
    const record = useOrchestrationSessionStore.getState().sessions.find(session => session.internalSessionId === pending.sessionId);
    if (record && isArchivedOrchestrationSession(record)) return;
    // The host keeps it as the last-used layout; this desktop keeps its own.
    panelApi.setLayout(pending.sessionId, pending.layout).catch(() => {});
    rememberPaneLayout(pending.hostId, pending.sessionId, pending.layout);
  }, []);
  const hostId = useConfigStore(state => state.config ? getActiveRemoteHostId(state.config.remoteDaemon) : undefined);
  // The host this Session's layout was loaded from, so writes land in its memory.
  const hostIdRef = useRef(hostId);
  useEffect(() => {
    hostIdRef.current = hostId;
  }, [hostId]);

  // Every layout change funnels through here: store, focus mirror, and a
  // debounced save so sash drags do not write per frame.
  const applyLayout = useCallback((next: SessionPanelLayout) => {
    const focusedGroupId = next.focusedGroupId && findGroup(next.root, next.focusedGroupId)
      ? next.focusedGroupId
      : primaryGroup(next.root).id;
    // Maximize (P4) holds while its group exists, keeps focus, and the groups
    // stay the same; a split, a drop or a close restores, as in a worktree Pane.
    let zoomedGroupId = next.zoomedGroupId && findGroup(next.root, next.zoomedGroupId) ? next.zoomedGroupId : null;
    if (zoomedGroupId) {
      const previous = usePanelStore.getState().layouts[sessionId];
      const groupIds = (layout: SessionPanelLayout['root']): string => {
        const ids: string[] = [];
        const walk = (node: SessionPanelLayout['root']) => {
          if (node.type === 'group') ids.push(node.id);
          else node.children.forEach(walk);
        };
        walk(layout);
        return ids.join('|');
      };
      if (previous && groupIds(previous.root) !== groupIds(next.root)) zoomedGroupId = null;
      if (zoomedGroupId !== focusedGroupId) zoomedGroupId = null;
    }
    const repaired: SessionPanelLayout = { ...next, focusedGroupId, zoomedGroupId };
    const store = usePanelStore.getState();
    store.setLayout(sessionId, repaired);
    store.setFocusedGroup(sessionId, focusedGroupId);
    const focusedPanelId = findGroup(repaired.root, focusedGroupId)?.activePanelId;
    // The Overview and To-dos have no panel record, so the host keeps the last real tab as the active one.
    if (focusedPanelId && focusedPanelId !== sessionOverviewTabId(sessionId) && focusedPanelId !== sessionTodosTabId(sessionId) && store.activePanels[sessionId] !== focusedPanelId) {
      store.setActivePanel(sessionId, focusedPanelId);
      void panelApi.setActivePanel(sessionId, focusedPanelId).catch(() => {});
    }
    clearTimeout(persistTimer.current);
    pendingLayout.current = { sessionId, layout: repaired, hostId: hostIdRef.current };
    persistTimer.current = setTimeout(flushLayout, 300);
  }, [sessionId, flushLayout]);
  useEffect(() => flushLayout, [sessionId, flushLayout]);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setError(null);
    void panelApi.loadPanelsForSession(sessionId).then(async saved => {
      if (cancelled) return;
      usePanelStore.getState().setPanels(sessionId, saved);
      // applyLayout below remembers whatever this desktop shows first.
      const remembered = await readPaneLayout(hostIdRef.current, sessionId);
      const stored = remembered ?? await panelApi.getLayout(sessionId);
      if (cancelled) return;
      const live = usePanelStore.getState().panels[sessionId] ?? saved;
      // The Session moves to its chat a moment before the terminal closes; that terminal's slot is already the chat's.
      const replaced = live.find(panel => panel.id === agentPanelId)?.metadata?.replacesPanelId;
      const base = stored?.version === 1
        ? { ...stored, root: applyPanelReplacements(stored.root, live.filter(panel => panel.id !== replaced)) }
        : createSingleGroupLayout([agentPanelId], agentPanelId);
      // The Overview goes first in the right split, To-dos after it, unless this layout already places them.
      const withOverview = withSessionTabs(base, overviewId, todosId, agentPanelId);
      const storedIds = layoutPanelIds(withOverview);
      const stage = live
        .filter(panel => isStagePanel(panel, agentPanelIdsRef.current, storedIds));
      // Agent pages this desktop has never placed (opened while it showed
      // something else) go beside the conversation, inactive. Tabs already in
      // its remembered layout keep their place.
      const splitIds = new Set<string>();
      for (const panel of stage) if (panel.metadata?.openPlacement === 'split') splitIds.add(panel.id);
      const reconciled = reconcile(withOverview, [agentPanelId, overviewId, ...(todosId ? [todosId] : []), ...stage.map(panel => panel.id)], splitIds).layout;
      // A Session whose agent changed (Switch profile to the other agent, T-63) opens on its new agent's tab,
      // not on whatever took the old agent's place.
      const agentNew = stored?.version === 1 && !layoutPanelIds(base).has(agentPanelId);
      applyLayout(agentNew ? activatePanelInLayout(reconciled, agentPanelId) : reconciled);
      setLoaded(true);
    }).catch(error => {
      if (!cancelled) setError(error instanceof Error ? error.message : 'Could not load Session tools');
    });
    const events = window.electronAPI.events;
    const created = events.onPanelCreated(panel => {
      if (panel.sessionId !== sessionId) return;
      usePanelStore.getState().addPanel(panel);
      const current = usePanelStore.getState().layouts[sessionId];
      // Plain shells are the terminal dock unless the "+" menu placed them.
      if (!current || !isStagePanel(panel, agentPanelIdsRef.current, layoutPanelIds(current))) return;
      const focused = findGroup(current.root, current.focusedGroupId ?? '') ?? primaryGroup(current.root);
      // Agents open pages and files beside the conversation by default.
      // Another client's new tab never moves this one; activation requests do.
      const root = placeCreatedPanel(current.root, focused.id, panel);
      if (root !== current.root) applyLayout({ ...current, root });
    });
    const updated = events.onPanelUpdated(panel => {
      if (panel.sessionId === sessionId) usePanelStore.getState().updatePanelState(panel);
    });
    // Queued until this visit's layout has loaded (the effect below applies it).
    const activation = events.onPanelActivationRequested(request => {
      if (request.sessionId === sessionId) usePanelStore.getState().requestActivation(request);
    });
    const deleted = events.onPanelDeleted(event => {
      if (event.sessionId !== sessionId) return;
      usePanelStore.getState().removePanel(sessionId, event.panelId);
      const current = usePanelStore.getState().layouts[sessionId];
      if (!current) return;
      const root = removePanelFromLayout(current.root, event.panelId);
      applyLayout(root ? { ...current, root } : freshLayout());
    });
    return () => {
      cancelled = true;
      created();
      updated();
      deleted();
      activation();
    };
  }, [sessionId, agentPanelId, overviewId, todosId, freshLayout, applyLayout, retry]);

  const activationRequest = usePanelStore(state => state.activationRequests[sessionId]);
  useEffect(() => {
    if (!activationRequest || !loaded) return;
    const store = usePanelStore.getState();
    store.clearActivationRequest(sessionId);
    const current = store.layouts[sessionId];
    // A Session link asks for the Overview, which has no panel record; nor has To-dos.
    if (current && (activationRequest.panelId === overviewId || activationRequest.panelId === todosId)) {
      applyLayout(activatePanelInLayout(withSessionTabs(current, overviewId, todosId, agentPanelId), activationRequest.panelId));
      return;
    }
    const panel = store.panels[sessionId]?.find(saved => saved.id === activationRequest.panelId);
    if (!current || !panel) return;
    if (panel.id !== agentPanelId && !isStagePanel(panel, agentPanelIdsRef.current, layoutPanelIds(current))) return;
    const focused = findGroup(current.root, current.focusedGroupId ?? '') ?? primaryGroup(current.root);
    // A split request also moves a tab out of the conversation's group.
    const root = activationRequest.placement === 'split'
      ? showPanelInSplit(current.root, panel.id)
      : addPanelToGroup(current.root, focused.id, panel.id);
    applyLayout(activatePanelInLayout({ ...current, root }, panel.id));
  }, [activationRequest, loaded, sessionId, agentPanelId, overviewId, todosId, applyLayout]);

  async function toggleTool(type: 'terminal' | 'explorer') {
    if (!loaded || creating.current) return;
    creating.current = true;
    setError(null);
    try {
      if (!(type === 'terminal' ? terminal : explorer)) {
        const panel = await panelApi.createPanel({ sessionId, type, title: type === 'terminal' ? 'Terminal' : 'Files' });
        usePanelStore.getState().addPanel(panel);
      }
      if (type === 'terminal') setShowTerminal(value => !value);
      else { setSidebarTab('files'); setSidebarVisible(true); }
    } catch {
      setError('Could not open Session tool. Please try again.');
    } finally {
      creating.current = false;
    }
  }

  // Opens a tool from the "+" menu as a tab in `groupId` (default: the focused group).
  const addTool = useCallback(async (tool: SessionToolSpec, groupId?: string) => {
    setError(null);
    try {
      if (tool.type === 'notes') {
        const state = usePanelStore.getState();
        const current = state.layouts[sessionId];
        const existing = state.panels[sessionId]?.find(panel => panel.type === 'notes');
        if (current && existing && layoutPanelIds(current).has(existing.id)) {
          applyLayout(activatePanelInLayout(current, existing.id));
          return;
        }
      }
      let initialState: { customState: Pick<TerminalPanelState, 'initialCommand' | 'customResume'> } | undefined;
      if (tool.initialCommand) {
        const customState: Pick<TerminalPanelState, 'initialCommand' | 'customResume'> = { initialCommand: tool.initialCommand };
        if (tool.customResume !== undefined) customState.customResume = tool.customResume;
        initialState = { customState };
      }
      const panel = await panelApi.createPanel({ sessionId, type: tool.type, title: tool.title, initialState });
      usePanelStore.getState().addPanel(panel);
      const current = usePanelStore.getState().layouts[sessionId];
      if (!current) return;
      const target = (groupId && findGroup(current.root, groupId))
        || (current.focusedGroupId && findGroup(current.root, current.focusedGroupId))
        || primaryGroup(current.root);
      // The panel:created event may have inserted it inactive already.
      applyLayout(activatePanelInLayout({ ...current, root: addPanelToGroup(current.root, target.id, panel.id, { activate: true }) }, panel.id));
    } catch {
      setError('Could not open the tool. Please try again.');
    }
  }, [sessionId, applyLayout]);

  const renderGroupAddTool = useCallback((groupId: string) => (
    <SessionAddToolMenu disabled={!loaded} onAdd={tool => { void addTool(tool, groupId); }} />
  ), [loaded, addTool]);

  // The sidebar's To-dos open in the split's To-dos tab, put back beside the conversation if it was moved away.
  const showTodosTab = useCallback(() => {
    const current = usePanelStore.getState().layouts[sessionId];
    if (current && todosId) applyLayout(activatePanelInLayout(withSessionTabs(current, overviewId, todosId, agentPanelId), todosId));
  }, [sessionId, overviewId, todosId, agentPanelId, applyLayout]);

  const inspectorTabButtons = useRef<Partial<Record<SessionInspectorTab, HTMLButtonElement | null>>>({});
  const selectSidebarTab = (tab: SessionInspectorTab) => {
    if (tab === 'files') void toggleTool('explorer');
    else setSidebarTab(tab);
  };

  const closePanel = useCallback(async (panel: ToolPanel) => {
    if (panel.id === agentPanelId || panel.id === overviewId || panel.id === todosId) return;
    try {
      await panelApi.deletePanel(panel.id);
      usePanelStore.getState().removePanel(sessionId, panel.id);
      const current = usePanelStore.getState().layouts[sessionId];
      const root = current && removePanelFromLayout(current.root, panel.id);
      if (current) applyLayout(root ? { ...current, root } : freshLayout());
    } catch {
      setError('Could not close tab. Please try again.');
    }
  }, [sessionId, agentPanelId, overviewId, todosId, freshLayout, applyLayout]);

  const sidebarToggle = (
      <button type="button" className="inline-flex h-8 w-8 items-center justify-center rounded text-text-secondary hover:bg-surface-hover" disabled={!loaded}
        aria-label={sidebarVisible ? 'Hide details' : 'Show details'}
        title={sidebarVisible ? 'Hide details' : 'Show details'}
        aria-expanded={sidebarVisible}
        onClick={() => setSidebarVisible(value => !value)}><PanelRight className="h-4 w-4" aria-hidden="true" /></button>
  );
  const selectPanel = useCallback((groupId: string, panel: ToolPanel) => {
    const current = usePanelStore.getState().layouts[sessionId];
    if (current) applyLayout({ ...activatePanelInLayout(current, panel.id), focusedGroupId: groupId });
  }, [sessionId, applyLayout]);
  const focusGroup = useCallback((groupId: string) => {
    const current = usePanelStore.getState().layouts[sessionId];
    if (current && current.focusedGroupId !== groupId) applyLayout({ ...current, focusedGroupId: groupId });
  }, [sessionId, applyLayout]);
  const resizeSplit = useCallback((splitNodeId: string, sizes: number[]) => {
    const current = usePanelStore.getState().layouts[sessionId];
    if (current) applyLayout({ ...current, root: updateSizes(current.root, splitNodeId, sizes) });
  }, [sessionId, applyLayout]);
  const handleClose = useCallback((panel: ToolPanel) => { void closePanel(panel); }, [closePanel]);
  // The Overview tab's content portals into a host its group draws, so a new overview from
  // the parent repaints only the Overview, never the split's terminals.
  const [overviewHost, setOverviewHost] = useState<HTMLDivElement | null>(null);
  const [todosHost, setTodosHost] = useState<HTMLDivElement | null>(null);
  const renderPanelContent = useCallback((panel: ToolPanel) => {
    if (panel.id === overviewId) return <div ref={setOverviewHost} className="h-full" />;
    if (panel.id === todosId) return <div ref={setTodosHost} className="h-full" />;
    return undefined;
  }, [overviewId, todosId]);
  // A portal's events bubble through this component, not the group around it, so a click in the Overview (or To-dos) focuses its group here.
  const focusGroupOf = useCallback((panelId: string) => {
    const current = usePanelStore.getState().layouts[sessionId];
    const group = current && findGroupContainingPanel(current.root, panelId);
    if (group) focusGroup(group.id);
  }, [sessionId, focusGroup]);
  const focusOverviewGroup = useCallback(() => focusGroupOf(overviewId), [focusGroupOf, overviewId]);
  const focusTodosGroup = useCallback(() => { if (todosId) focusGroupOf(todosId); }, [focusGroupOf, todosId]);

  // Maximize (P4): the split takes the Session's stage, and a tiled Session's
  // tile takes the window, so a chat fills the whole main area. Restoring
  // undoes both. A single, untiled Session has nothing to grow over.
  const zoomedGroupId = layout?.zoomedGroupId ?? null;
  const maximized = Boolean(zoomedGroupId) || tileMaximized;
  const toggleMaximize = useCallback((groupId?: string) => {
    const current = usePanelStore.getState().layouts[sessionId];
    if (!current) return;
    announceTerminalReflow();
    if (current.zoomedGroupId || tileMaximized) {
      if (current.zoomedGroupId) applyLayout({ ...current, zoomedGroupId: null });
      if (tileMaximized) onToggleTileMaximize?.();
      return;
    }
    const target = groupId ?? current.focusedGroupId ?? primaryGroup(current.root).id;
    if (current.root.type === 'split') applyLayout({ ...current, focusedGroupId: target, zoomedGroupId: target });
    onToggleTileMaximize?.();
  }, [sessionId, applyLayout, tileMaximized, onToggleTileMaximize]);
  const canMaximize = layout?.root.type === 'split' || Boolean(onToggleTileMaximize) || maximized;
  const stageRef = useRef<HTMLDivElement>(null);
  useRegionActions(stageRef, { toggleMaximize: canMaximize ? () => toggleMaximize() : undefined });
  const [asideMaximized, setAsideMaximized] = useState(false);
  const asideRef = useRef<HTMLElement>(null);
  useRegionActions(asideRef, {
    toggleMaximize: () => setAsideMaximized(value => !value),
    minimize: () => { setAsideMaximized(false); setSidebarVisible(false); },
  });
  const terminalRegionRef = useRef<HTMLDivElement>(null);
  useRegionActions(terminalRegionRef, { minimize: () => setShowTerminal(false) });

  // The focused tile answers the window's tab, split, terminal and right-panel
  // keys (SessionView routes them here while a Session is shown, P3).
  const latestTools = useRef({ toggleTool, addTool, tabs });
  useEffect(() => { latestTools.current = { toggleTool, addTool, tabs }; });
  useEffect(() => {
    if (!focusWithin || !loaded) return;
    const owner = Symbol(`session-${sessionId}`);
    const focusedGroup = () => {
      const current = usePanelStore.getState().layouts[sessionId];
      if (!current) return null;
      return { current, group: findGroup(current.root, current.focusedGroupId ?? '') ?? primaryGroup(current.root) };
    };
    const groupTabs = () => {
      const focused = focusedGroup();
      if (!focused) return [];
      const byId = new Map(latestTools.current.tabs.map(panel => [panel.id, panel]));
      return focused.group.panelIds.map(id => byId.get(id)).filter((panel): panel is ToolPanel => Boolean(panel));
    };
    const activePanel = () => {
      const focused = focusedGroup();
      return groupTabs().find(panel => panel.id === focused?.group.activePanelId) ?? null;
    };
    // While the approval column has focus, the tab keys walk its tabs instead of a split's (D-336).
    const column = () => focusedApprovalColumn(containerRef.current);
    const actions: ProjectViewActions = {
      toggleDetail: () => setSidebarVisible(value => !value),
      showInspector: () => { void latestTools.current.toggleTool('explorer'); },
      addTerminal: () => { void latestTools.current.addTool({ type: 'terminal', title: 'Terminal' }); },
      tabCount: () => {
        const approvals = column();
        return approvals ? approvalColumnTabCount(approvals) : groupTabs().length;
      },
      selectTab: (index) => {
        const approvals = column();
        if (approvals) { showApprovalColumnTab(approvals, () => index); return; }
        const focused = focusedGroup();
        const panel = groupTabs()[index];
        if (focused && panel) selectPanel(focused.group.id, panel);
      },
      cycleTab: (direction) => {
        const approvals = column();
        if (approvals) { showApprovalColumnTab(approvals, (current, count) => cycleIndex(current, count, direction)); return; }
        const focused = focusedGroup();
        const panels = groupTabs();
        const index = cycleIndex(panels.findIndex(panel => panel.id === focused?.group.activePanelId), panels.length, direction);
        if (focused && index !== -1) selectPanel(focused.group.id, panels[index]);
      },
      canCloseActiveTab: () => Boolean(activePanel()) && activePanel()?.id !== agentPanelId && activePanel()?.metadata.permanent !== true,
      closeActiveTab: () => { const panel = activePanel(); if (panel) handleClose(panel); },
      canSplit: () => {
        const focused = focusedGroup();
        return Boolean(focused && focused.group.panelIds.length >= 2 && focused.group.activePanelId);
      },
      split: (direction) => {
        const focused = focusedGroup();
        const moving = focused?.group.activePanelId;
        if (!focused || !moving || focused.group.panelIds.length < 2) return;
        const root = splitGroup(focused.current.root, focused.group.id, moving, direction, true);
        applyLayout({ ...focused.current, root, focusedGroupId: findGroupContainingPanel(root, moving)?.id ?? focused.current.focusedGroupId });
      },
      toggleTerminal: () => { void latestTools.current.toggleTool('terminal'); },
    };
    const bridge = useProjectViewActionsStore.getState();
    bridge.setSessionActions(owner, actions);
    return () => useProjectViewActionsStore.getState().setSessionActions(owner, null);
  }, [focusWithin, loaded, sessionId, agentPanelId, selectPanel, handleClose, applyLayout]);

  // Tab drag and drop, the same gesture as a worktree Pane: a group's centre
  // takes the tab, an edge splits, a strip slot inserts. The state is local to
  // this mounted Session, so a tiled neighbour never offers itself as a target.
  const [draggedPanelId, setDraggedPanelId] = useState<string | null>(null);
  const [dropZones, setDropZones] = useState<Map<string, DropZone | null>>(new Map());
  const endTabDrag = useCallback(() => {
    setDraggedPanelId(null);
    setDropZones(new Map());
  }, []);
  const handleDropZoneChange = useCallback((groupId: string, zone: DropZone | null) => {
    setDropZones(prev => {
      const next = new Map(prev);
      if (zone === null) next.delete(groupId);
      else next.set(groupId, zone);
      return next;
    });
  }, []);
  const handleDropTab = useCallback((groupId: string, zone: DropZone) => {
    const current = usePanelStore.getState().layouts[sessionId];
    endTabDrag();
    if (!current || !draggedPanelId) return;
    const source = findGroupContainingPanel(current.root, draggedPanelId);
    // Its own centre, or a group's only tab onto that group, changes nothing.
    if (source?.id === groupId && (zone === 'center' || source.panelIds.length === 1)) return;
    const root = zone === 'center'
      ? movePanel(current.root, draggedPanelId, { groupId, index: findGroup(current.root, groupId)?.panelIds.length ?? 0 })
      : movePanel(current.root, draggedPanelId, { groupId, edge: zone });
    applyLayout({ ...current, root });
  }, [sessionId, draggedPanelId, applyLayout, endTabDrag]);
  const handleStripDrop = useCallback((groupId: string, panelId: string, insertIndex: number) => {
    const current = usePanelStore.getState().layouts[sessionId];
    endTabDrag();
    if (current) applyLayout({ ...current, root: movePanel(current.root, panelId, { groupId, index: insertIndex }) });
  }, [sessionId, applyLayout, endTabDrag]);
  // A single group keeps its tabs in the workspace toolbar, directly under the
  // title bar. Once split, every group owns a strip — the agent tab included —
  // so all tab strips sit on one row and the toolbar row goes away.
  const isSplit = layout?.root.type === 'split';
  const primary = layout ? primaryGroup(layout.root) : null;
  const primaryTabs = primary
    ? primary.panelIds.map(id => tabs.find(panel => panel.id === id)).filter((panel): panel is ToolPanel => !!panel)
    : [currentAgentPanel];
  const tabStrip = (
    <div data-testid="session-workspace-tabs" className="flex min-w-0 items-center">
      <PanelTabStrip panels={primaryTabs} activePanelId={primary?.activePanelId ?? agentPanelId} idNamespace={`session-${sessionId}`}
        alwaysShowClose isFocused={focusWithin} quietFocus
        onPanelSelect={panel => { if (primary) selectPanel(primary.id, panel); }}
        onPanelClose={handleClose}
        onDragStart={setDraggedPanelId} onDragEnd={endTabDrag}
        onStripDrop={(panelId, index) => {
          if (primary) handleStripDrop(primary.id, panelId, subsetInsertIndex(primary.panelIds, primaryTabs.map(panel => panel.id), index));
        }}
        isTabDragging={draggedPanelId !== null} draggedPanelId={draggedPanelId} getPanelTabPresentation={tabPresentation} />
    </div>
  );
  const titleBarActions = (
    <>
      {toolbarActions}
      {sidebarToggle}
    </>
  );

  const approvalOpen = approval?.open ?? false;
  const right = rightSplit(layout);
  // Decided when it opens: over the split there was, or in a split of its own that ✕ collapses.
  const [approvalMode, setApprovalMode] = useState<'over' | 'split' | null>(null);
  // Only once this visit's saved layout has loaded: opened from the sidebar count, the approval can
  // arrive before the Session's split does, and deciding then would open a third column (F-8).
  useLayoutEffect(() => {
    setApprovalMode(mode => (!approvalOpen ? null : !loaded ? mode : mode ?? (right ? 'over' : 'split')));
  }, [approvalOpen, right, loaded]);
  // The person closed the split under it: the column keeps its own.
  const placement = approvalMode === 'over' && !right ? 'split' : approvalMode;
  // The column is a focus stop of its own (data-focus-region="approvals"); while it has focus, its
  // active tab carries the accent and the chat's dims, as a split's would (D-249, D-335).
  const approvalFocused = useFocusRegionStore(state => state.region === 'approvals') && focusWithin;
  // The column going away (✕, Esc on ✕, an answer) with focus in it would leave focus on nothing: it goes to the chat.
  useLeaveOnClose(approvalOpen, focusWithin, leaveApprovalColumn);
  // It covers the right split's groups, found by id on the stage, and follows them as they resize.
  const rightGroupKey = useMemo(() => (right ? groupsIn(right).map(group => group.id).join('|') : ''), [right]);
  const rightGroups = useCallback((stage: HTMLElement) => (rightGroupKey ? rightGroupKey.split('|') : []).flatMap(id => {
    const element = stage.querySelector(`[data-panel-group-id="${CSS.escape(id)}"]`);
    return element ? [element] : [];
  }), [rightGroupKey]);
  // ✕ names what the split shows underneath.
  const underneath = useMemo(() => {
    if (!right) return undefined;
    const groups = groupsIn(right);
    const group = groups.find(candidate => candidate.id === layout?.focusedGroupId) ?? groups[0];
    return tabs.find(panel => panel.id === group?.activePanelId)?.title;
  }, [right, layout?.focusedGroupId, tabs]);

  if (!loaded) {
    return <div ref={containerRef} className="flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden">
      {!error ? <SessionWorkspaceSkeleton name="Session tools" tabTitle={agentPanel.title} agentPanelId={agentPanel.id} chain={sessionId}
        layout={layout} panels={panels} chromeInline={Boolean(chromeInline)} /> : <div className="p-6 text-text-secondary"><p role="alert">{error}</p>
        <button type="button" className="mt-3 rounded bg-surface-secondary px-3 py-2 text-text-primary" onClick={() => { setError(null); setRetry(value => value + 1); }}>Retry</button>
      </div>}
    </div>;
  }

  return (
    <div ref={containerRef} className="flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden">
      {trailingSlot && createPortal(titleBarActions, trailingSlot)}
      {/* Portal events reach this component, not the group's PanelGroupView, so the Overview syncs its own group's focus. */}
      {overviewHost && createPortal(<div data-testid="session-overview" className="h-full" onMouseDownCapture={focusOverviewGroup} onFocusCapture={focusOverviewGroup}>{overviewContent}</div>, overviewHost)}
      {todosHost && createPortal(<div data-testid="session-todos" className="h-full" onMouseDownCapture={focusTodosGroup} onFocusCapture={focusTodosGroup}>{todosContent}</div>, todosHost)}
      {(!isSplit || !trailingSlot) && <div className="flex min-h-9 items-center border-b border-border-primary bg-bg-chrome">
        <div className="flex min-w-0 flex-1 items-center overflow-hidden px-2">
          {!isSplit && tabStrip}
          {!isSplit && <SessionAddToolMenu disabled={!loaded} onAdd={tool => { void addTool(tool); }} />}
        </div>
        {!isSplit && maximized && <RestoreRegionButton className="mr-1" onRestore={() => toggleMaximize()} />}
        {!trailingSlot && titleBarActions}
      </div>}
      {error && <p role="alert" className="px-3 py-1 text-xs text-status-error">{error}</p>}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden" inert={asideMaximized ? true : undefined}>
          <div ref={stageRef} data-focus-region="main" className="relative min-h-0 flex-1">
            {stageUnderlay && (isSplit || primary?.activePanelId === agentPanelId) && <div className="absolute inset-0 flex">
              <SessionStageSkeleton layout={layout} panels={panels} agentPanelId={agentPanelId} chain={sessionId} />
            </div>}
            {stageNotice}
            {approval && (
              <SplitApprovalOverlay open={placement === 'over' && rightGroupKey !== ''} baseRef={stageRef} targets={rightGroups} targetsKey={rightGroupKey}
                underneath={underneath} testId="session-approval-overlay">
                {closeLabel => approval.render(closeLabel, approval.onClose, approvalFocused)}
              </SplitApprovalOverlay>
            )}
            {layout && <SplitLayout layout={layout} panels={tabs} focusedGroupId={focusWithin ? layout.focusedGroupId ?? primaryGroup(layout.root).id : ''}
              hidden={hidden} onToggleMaximize={toggleMaximize}
              isMainRepo={false} onSizesChange={resizeSplit} onPanelSelect={selectPanel} onPanelClose={handleClose}
              onFocusGroup={focusGroup} alwaysShowClose keepPermanentTabsInGroups
              renderAddTool={renderGroupAddTool}
              isTabDragging={draggedPanelId !== null} draggedPanelId={draggedPanelId} dropZones={dropZones}
              onDropZoneChange={handleDropZoneChange} onDropTab={handleDropTab} onDragStart={setDraggedPanelId}
              onDragEnd={endTabDrag} onStripDrop={handleStripDrop}
              renderPanelContent={renderPanelContent} getPanelTabPresentation={tabPresentation} />}
          </div>
          <div ref={terminalRegionRef} data-focus-region="terminal" data-region-open={showTerminal && Boolean(terminal)} className="flex flex-shrink-0 flex-col border-t border-border-primary" style={{ height: showTerminal ? '35%' : 32 }}>
            <button type="button" disabled={!loaded} aria-label={showTerminal ? 'Collapse terminal' : 'Expand terminal'}
              aria-expanded={showTerminal} onClick={() => { void toggleTool('terminal'); }}
              className="flex h-8 flex-shrink-0 items-center gap-2 px-3 text-xs text-text-secondary hover:bg-surface-hover">
              {showTerminal ? <ChevronDown className="h-3.5 w-3.5 text-text-tertiary" /> : <ChevronUp className="h-3.5 w-3.5 text-text-tertiary" />}
              <Terminal className="h-3.5 w-3.5 text-text-tertiary" />
              <span className="text-[11px] font-medium uppercase tracking-wider">Terminal</span>
            </button>
            {terminal && <div className="relative min-h-0 flex-1" style={{ display: showTerminal ? 'block' : 'none' }}>
              <PanelContainer panel={terminal} isActive={showTerminal && !hidden} autoFocus={false} />
            </div>}
          </div>
        </div>
        {approval && placement === 'split' && (
          <div className="flex min-h-0 w-1/2 min-w-[360px] flex-shrink-0 flex-col border-l border-border-primary" data-testid="session-approval-split" data-focus-region="approvals" onKeyDown={event => escapeApprovalColumn(event)}>
            {approval.render('Close split', approval.onClose, approvalFocused)}
          </div>
        )}
        {showSidebar && <aside ref={asideRef} data-focus-region="right-panel" aria-label={`Session ${SESSION_INSPECTOR_LABELS[shownSidebarTab].toLowerCase()}`}
          // Maximized, it covers the stage and terminal, which keep their size underneath (P4).
          className={asideMaximized
            ? 'absolute inset-0 z-20 flex min-w-0 flex-col bg-bg-primary'
            : 'relative flex min-w-0 flex-shrink-0 flex-col border-l border-border-primary'}
          style={asideMaximized ? undefined : { width: filesResize.renderedPx }}>
          {!asideMaximized && <OuterResizeSeparator label="Resize Session sidebar" orientation="vertical" value={filesResize.effectivePx}
            minimum={filesResize.floor} maximum={filesResize.cap} {...filesResize.separatorHandlers} />}
          <div role="tablist" aria-label="Session inspector" className="flex h-8 flex-shrink-0 items-stretch border-b border-border-primary bg-surface-secondary px-1">
            {inspectorTabs.map(tab => (
              <button key={tab} ref={button => { inspectorTabButtons.current[tab] = button; }} type="button" role="tab" aria-selected={shownSidebarTab === tab}
                aria-label={tab === 'todos' && todosWaiting > 0 ? `To-dos, ${todosWaiting} waiting on you` : SESSION_INSPECTOR_LABELS[tab]}
                onClick={() => selectSidebarTab(tab)}
                onKeyDown={event => {
                  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
                  event.preventDefault();
                  const index = inspectorTabs.indexOf(tab);
                  const offset = event.key === 'ArrowRight' ? 1 : inspectorTabs.length - 1;
                  const next = inspectorTabs[(index + offset) % inspectorTabs.length];
                  selectSidebarTab(next);
                  // Focus follows the selection, so the next press moves on from there.
                  inspectorTabButtons.current[next]?.focus();
                }}
                className={`flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-t-md border border-transparent px-2 text-[12px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus ${shownSidebarTab === tab ? 'border-border-primary border-b-surface-primary bg-surface-primary text-text-primary -mb-px' : 'text-text-tertiary hover:text-text-primary hover:bg-surface-hover'}`}>
                <span className="truncate">{SESSION_INSPECTOR_LABELS[tab]}</span>
                {tab === 'todos' && todosWaiting > 0 && (
                  <span aria-hidden="true" className="inline-flex h-4 min-w-4 flex-shrink-0 items-center justify-center rounded-full bg-status-warning px-1 text-[10px] font-semibold tabular-nums text-text-on-status-warning">{todosWaiting}</span>
                )}
              </button>
            ))}
            {asideMaximized && <RestoreRegionButton className="my-0.5 ml-1 h-7" onRestore={() => setAsideMaximized(false)} />}
          </div>
          <div className="relative min-h-0 flex-1 overflow-y-auto">
            {shownSidebarTab === 'files' && explorer && <PanelContainer panel={explorer} isActive />}
            {shownSidebarTab === 'changes' && changesContent}
            {shownSidebarTab === 'todos' && sidebarTodosContent?.(showTodosTab)}
          </div>
        </aside>}
      </div>
    </div>
  );
}
