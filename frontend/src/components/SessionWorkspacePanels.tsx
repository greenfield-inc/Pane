import { createPortal } from 'react-dom';
import { useTitleBarSlotStore } from '../stores/titleBarSlotStore';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, PanelRight, Terminal } from 'lucide-react';
import type { SessionPanelLayout, TerminalPanelState, ToolPanel } from '../../../shared/types/panels';
import { panelApi } from '../services/panelApi';
import { isArchivedOrchestrationSession, useOrchestrationSessionStore } from '../stores/orchestrationSessionStore';
import { useConfigStore } from '../stores/configStore';
import { readPaneLayout, rememberPaneLayout } from '../utils/paneLayoutMemory';
import { getActiveRemoteHostId } from '../../../shared/types/remoteDaemon';
import { usePanelStore } from '../stores/panelStore';
import { PanelContainer } from './panels/PanelContainer';
import { PanelTabStrip } from './panels/PanelTabStrip';
import { SplitLayout } from './panels/SplitLayout';
import { SessionAddToolMenu, type SessionToolSpec } from './SessionAddToolMenu';
import { SelectionLoading } from './ui/SelectionLoading';
import { useOuterPanelResize } from '../hooks/useOuterPanelResize';
import { OuterResizeSeparator } from './ui/OuterResizeSeparator';
import { OUTER_PANEL_CONFIGS } from '../utils/outerPanelSizing';
import {
  activatePanelInLayout,
  addPanelToGroup,
  createSingleGroupLayout,
  findGroup,
  placePanelInSplit,
  primaryGroup,
  reconcile,
  removePanelFromLayout,
  updateSizes,
} from '../utils/panelLayout';

const EMPTY_PANELS: ToolPanel[] = [];
const SESSION_INSPECTOR_TABS = ['overview', 'files', 'changes'] as const;
type SessionInspectorTab = typeof SESSION_INSPECTOR_TABS[number];
/** Panels that always live on the Session stage as tabs; Files docks in the inspector. */
const STAGE_PANEL_TYPES = new Set<ToolPanel['type']>(['editor', 'browser', 'notes']);

/** A terminal started with a command (an agent or a custom command) is always a tab. */
function launchesCommand(panel: ToolPanel): boolean {
  // SAFETY: The terminal discriminator determines the custom-state shape.
  const state = panel.state.customState as TerminalPanelState | undefined;
  return !!state?.initialCommand?.trim() || !!state?.isCliPanel || !!state?.agentType;
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
  if (panel.type !== 'terminal' || agentPanelIds.has(panel.id)) return false;
  return inLayout.has(panel.id) || launchesCommand(panel);
}

export function SessionWorkspacePanels({
  agentPanel,
  agentPanelIds,
  overviewContent,
  changesContent,
  toolbarActions,
  stageNotice,
  chromeInline = false,
  focusWithin = true,
}: {
  agentPanel: ToolPanel; agentPanelIds: string[];
  overviewContent: ReactNode; changesContent: ReactNode; toolbarActions?: ReactNode;
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
}) {
  const titleBarSlot = useTitleBarSlotStore(state => state.trailingSlot);
  const trailingSlot = chromeInline ? null : titleBarSlot;
  const sessionId = agentPanel.sessionId;
  const panels = usePanelStore(state => state.panels[sessionId] ?? EMPTY_PANELS);
  const layout = usePanelStore(state => state.layouts[sessionId]);
  const [showTerminal, setShowTerminal] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<SessionInspectorTab>('overview');
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
  const tabs = useMemo(
    () => [currentAgentPanel, ...panels.filter(panel => isStagePanel(panel, agentPanelIdSet, inLayout))],
    [currentAgentPanel, panels, agentPanelIdSet, inLayout],
  );
  const agentPanelId = agentPanel.id;
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
    const repaired: SessionPanelLayout = { ...next, focusedGroupId, zoomedGroupId: null };
    const store = usePanelStore.getState();
    store.setLayout(sessionId, repaired);
    store.setFocusedGroup(sessionId, focusedGroupId);
    const focusedPanelId = findGroup(repaired.root, focusedGroupId)?.activePanelId;
    if (focusedPanelId && store.activePanels[sessionId] !== focusedPanelId) {
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
      const base = stored?.version === 1 ? stored : createSingleGroupLayout([agentPanelId], agentPanelId);
      const storedIds = layoutPanelIds(base);
      const stage = (usePanelStore.getState().panels[sessionId] ?? saved)
        .filter(panel => isStagePanel(panel, agentPanelIdsRef.current, storedIds));
      // This desktop's own memory takes new tabs inactive into its own groups;
      // the shared split placement only shapes the host's seed layout.
      const splitIds = new Set<string>();
      if (!remembered) {
        for (const panel of stage) if (panel.metadata?.openPlacement === 'split') splitIds.add(panel.id);
      }
      applyLayout(reconcile(base, [agentPanelId, ...stage.map(panel => panel.id)], splitIds).layout);
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
      const root = panel.metadata?.openPlacement === 'split'
        ? placePanelInSplit(current.root, panel.id, false)
        : addPanelToGroup(current.root, focused.id, panel.id, { activate: false });
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
      applyLayout(root ? { ...current, root } : createSingleGroupLayout([agentPanelId], agentPanelId));
    });
    return () => {
      cancelled = true;
      created();
      updated();
      deleted();
      activation();
    };
  }, [sessionId, agentPanelId, applyLayout, retry]);

  const activationRequest = usePanelStore(state => state.activationRequests[sessionId]);
  useEffect(() => {
    if (!activationRequest || !loaded) return;
    const store = usePanelStore.getState();
    store.clearActivationRequest(sessionId);
    const current = store.layouts[sessionId];
    const panel = store.panels[sessionId]?.find(saved => saved.id === activationRequest.panelId);
    if (!current || !panel) return;
    if (panel.id !== agentPanelId && !isStagePanel(panel, agentPanelIdsRef.current, layoutPanelIds(current))) return;
    const focused = findGroup(current.root, current.focusedGroupId ?? '') ?? primaryGroup(current.root);
    const root = activationRequest.placement === 'split'
      ? placePanelInSplit(current.root, panel.id)
      : addPanelToGroup(current.root, focused.id, panel.id);
    applyLayout(activatePanelInLayout({ ...current, root }, panel.id));
  }, [activationRequest, loaded, sessionId, agentPanelId, applyLayout]);

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

  const selectSidebarTab = (tab: SessionInspectorTab) => {
    if (tab === 'files') void toggleTool('explorer');
    else setSidebarTab(tab);
  };

  const closePanel = useCallback(async (panel: ToolPanel) => {
    if (panel.id === agentPanelId) return;
    try {
      await panelApi.deletePanel(panel.id);
      usePanelStore.getState().removePanel(sessionId, panel.id);
      const current = usePanelStore.getState().layouts[sessionId];
      const root = current && removePanelFromLayout(current.root, panel.id);
      if (current) applyLayout(root ? { ...current, root } : createSingleGroupLayout([agentPanelId], agentPanelId));
    } catch {
      setError('Could not close tab. Please try again.');
    }
  }, [sessionId, agentPanelId, applyLayout]);

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
        alwaysShowClose
        onPanelSelect={panel => { if (primary) selectPanel(primary.id, panel); }}
        onPanelClose={handleClose} />
    </div>
  );
  const titleBarActions = (
    <>
      {toolbarActions}
      {sidebarToggle}
    </>
  );

  if (!loaded) {
    return <div ref={containerRef} className="flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden">
      {!error ? <SelectionLoading name="Session tools" /> : <div className="p-6 text-text-secondary"><p role="alert">{error}</p>
        <button type="button" className="mt-3 rounded bg-surface-secondary px-3 py-2 text-text-primary" onClick={() => { setError(null); setRetry(value => value + 1); }}>Retry</button>
      </div>}
    </div>;
  }

  return (
    <div ref={containerRef} className="flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden">
      {trailingSlot && createPortal(titleBarActions, trailingSlot)}
      {(!isSplit || !trailingSlot) && <div className="flex min-h-9 items-center border-b border-border-primary bg-bg-chrome">
        <div className="flex min-w-0 flex-1 items-center overflow-hidden px-2">
          {!isSplit && tabStrip}
          {!isSplit && <SessionAddToolMenu disabled={!loaded} onAdd={tool => { void addTool(tool); }} />}
        </div>
        {!trailingSlot && titleBarActions}
      </div>}
      {error && <p role="alert" className="px-3 py-1 text-xs text-status-error">{error}</p>}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="relative min-h-0 flex-1">
            {stageNotice}
            {layout && <SplitLayout layout={layout} panels={tabs} focusedGroupId={focusWithin ? layout.focusedGroupId ?? primaryGroup(layout.root).id : ''}
              isMainRepo={false} onSizesChange={resizeSplit} onPanelSelect={selectPanel} onPanelClose={handleClose}
              onFocusGroup={focusGroup} alwaysShowClose keepPermanentTabsInGroups
              renderAddTool={renderGroupAddTool} />}
          </div>
          <div className="flex flex-shrink-0 flex-col border-t border-border-primary" style={{ height: showTerminal ? '35%' : 32 }}>
            <button type="button" disabled={!loaded} aria-label={showTerminal ? 'Collapse terminal' : 'Expand terminal'}
              aria-expanded={showTerminal} onClick={() => { void toggleTool('terminal'); }}
              className="flex h-8 flex-shrink-0 items-center gap-2 px-3 text-xs text-text-secondary hover:bg-surface-hover">
              {showTerminal ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
              <Terminal className="h-3.5 w-3.5" /> Terminal
            </button>
            {terminal && <div className="relative min-h-0 flex-1" style={{ display: showTerminal ? 'block' : 'none' }}>
              <PanelContainer panel={terminal} isActive={showTerminal} autoFocus={false} />
            </div>}
          </div>
        </div>
        {showSidebar && <aside aria-label={sidebarTab === 'overview' ? 'Session overview' : sidebarTab === 'files' ? 'Session files' : 'Session changes'}
          className="relative flex min-w-0 flex-shrink-0 flex-col border-l border-border-primary" style={{ width: filesResize.renderedPx }}>
          <OuterResizeSeparator label="Resize Session sidebar" orientation="vertical" value={filesResize.effectivePx}
            minimum={filesResize.floor} maximum={filesResize.cap} {...filesResize.separatorHandlers} />
          <div role="tablist" aria-label="Session inspector" className="flex h-8 flex-shrink-0 items-stretch border-b border-border-primary bg-surface-secondary px-1">
            {SESSION_INSPECTOR_TABS.map(tab => (
              <button key={tab} type="button" role="tab" aria-selected={sidebarTab === tab}
                onClick={() => selectSidebarTab(tab)}
                onKeyDown={event => {
                  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
                  event.preventDefault();
                  const index = SESSION_INSPECTOR_TABS.indexOf(tab);
                  const offset = event.key === 'ArrowRight' ? 1 : SESSION_INSPECTOR_TABS.length - 1;
                  selectSidebarTab(SESSION_INSPECTOR_TABS[(index + offset) % SESSION_INSPECTOR_TABS.length]);
                }}
                className={`flex flex-1 items-center justify-center rounded-t-md border border-transparent px-2 text-[12px] font-medium focus:outline-none focus:ring-0 ${sidebarTab === tab ? 'border-border-primary border-b-surface-primary bg-surface-primary text-text-primary -mb-px' : 'text-text-tertiary hover:text-text-primary hover:bg-surface-hover'}`}>
                {tab === 'overview' ? 'Overview' : tab === 'files' ? 'Files' : 'Changes'}
              </button>
            ))}
          </div>
          <div className="relative min-h-0 flex-1 overflow-y-auto">
            {sidebarTab === 'overview' && overviewContent}
            {sidebarTab === 'files' && explorer && <PanelContainer panel={explorer} isActive />}
            {sidebarTab === 'changes' && changesContent}
          </div>
        </aside>}
      </div>
    </div>
  );
}
