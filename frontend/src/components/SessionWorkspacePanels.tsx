import { createPortal } from 'react-dom';
import { useTitleBarSlotStore } from '../stores/titleBarSlotStore';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, PanelRight, Terminal } from 'lucide-react';
import type { SessionPanelLayout, ToolPanel } from '../../../shared/types/panels';
import { panelApi } from '../services/panelApi';
import { usePanelStore } from '../stores/panelStore';
import { PanelContainer } from './panels/PanelContainer';
import { PanelTabStrip } from './panels/PanelTabStrip';
import { SplitLayout } from './panels/SplitLayout';
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
/** Panels that live on the Session stage as tabs; terminals and Files dock elsewhere. */
const STAGE_PANEL_TYPES = new Set<ToolPanel['type']>(['editor', 'browser']);

export function SessionWorkspacePanels({ agentPanel, agentPanelIds, overviewContent, changesContent, toolbarActions }: {
  agentPanel: ToolPanel; agentPanelIds: string[];
  overviewContent: ReactNode; changesContent: ReactNode; toolbarActions?: ReactNode;
}) {
  const trailingSlot = useTitleBarSlotStore(state => state.trailingSlot);
  const sessionTabsSlot = useTitleBarSlotStore(state => state.sessionTabsSlot);
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
  const [error, setError] = useState<string | null>(null);
  const creating = useRef(false);
  const terminal = panels.find(panel => panel.type === 'terminal' && !agentPanelIds.includes(panel.id));
  const explorer = panels.find(panel => panel.type === 'explorer');
  const tabs = useMemo(() => [agentPanel, ...panels.filter(panel => STAGE_PANEL_TYPES.has(panel.type))], [agentPanel, panels]);
  const agentPanelId = agentPanel.id;
  const persistTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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
    if (focusedPanelId && store.activePanels[sessionId] !== focusedPanelId) store.setActivePanel(sessionId, focusedPanelId);
    clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => {
      panelApi.setLayout(sessionId, repaired).catch(() => {});
    }, 300);
  }, [sessionId]);
  useEffect(() => () => clearTimeout(persistTimer.current), []);

  useEffect(() => {
    let cancelled = false;
    void panelApi.loadPanelsForSession(sessionId).then(async saved => {
      if (cancelled) return;
      usePanelStore.getState().setPanels(sessionId, saved);
      const stored = await panelApi.getLayout(sessionId).catch(() => null);
      if (cancelled) return;
      const stage = (usePanelStore.getState().panels[sessionId] ?? saved).filter(panel => STAGE_PANEL_TYPES.has(panel.type));
      const base = stored?.version === 1 ? stored : createSingleGroupLayout([agentPanelId], agentPanelId);
      const splitIds = new Set(stage.filter(panel => panel.metadata?.openPlacement === 'split').map(panel => panel.id));
      applyLayout(reconcile(base, [agentPanelId, ...stage.map(panel => panel.id)], splitIds).layout);
      setLoaded(true);
    }).catch(() => {
      if (!cancelled) setError('Could not load Session tools. Reopen the Session to retry.');
    });
    const events = window.electronAPI.events;
    const created = events.onPanelCreated(panel => {
      if (panel.sessionId !== sessionId) return;
      usePanelStore.getState().addPanel(panel);
      const current = usePanelStore.getState().layouts[sessionId];
      if (!current || !STAGE_PANEL_TYPES.has(panel.type)) return;
      const focused = findGroup(current.root, current.focusedGroupId ?? '') ?? primaryGroup(current.root);
      // Agents open pages and files beside the conversation by default.
      const root = panel.metadata?.openPlacement === 'split'
        ? placePanelInSplit(current.root, panel.id)
        : addPanelToGroup(current.root, focused.id, panel.id, { activate: panel.state.isActive });
      if (root !== current.root) applyLayout({ ...current, root });
    });
    const updated = events.onPanelUpdated(panel => {
      if (panel.sessionId === sessionId) usePanelStore.getState().updatePanelState(panel);
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
    };
  }, [sessionId, agentPanelId, applyLayout]);

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
  // A single group keeps its tabs in the title bar. Once split, each group
  // owns a strip and the title bar keeps only the permanent agent tab.
  const isSplit = layout?.root.type === 'split';
  const primary = layout ? primaryGroup(layout.root) : null;
  const primaryTabs = primary
    ? primary.panelIds.map(id => tabs.find(panel => panel.id === id)).filter((panel): panel is ToolPanel => !!panel)
    : [agentPanel];
  const titleTabs = isSplit ? primaryTabs.filter(panel => panel.metadata?.permanent === true) : primaryTabs;
  const tabStrip = (
    <PanelTabStrip panels={titleTabs} activePanelId={primary?.activePanelId ?? agentPanelId} idNamespace={`session-${sessionId}`}
      alwaysShowClose
      onPanelSelect={panel => { if (primary) selectPanel(primary.id, panel); }}
      onPanelClose={handleClose} />
  );
  const titleBarActions = (
    <>
      {toolbarActions}
      {sidebarToggle}
    </>
  );

  return (
    <div ref={containerRef} className="flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden">
      {sessionTabsSlot && createPortal(tabStrip, sessionTabsSlot)}
      {trailingSlot && createPortal(titleBarActions, trailingSlot)}
      {!sessionTabsSlot && <div className="flex min-h-9 items-center border-b border-border-primary">
        <div className="flex min-w-0 flex-1 items-center overflow-hidden px-2">
          {tabStrip}
        </div>
        {!trailingSlot && titleBarActions}
      </div>}
      {error && <p role="alert" className="px-3 py-1 text-xs text-status-error">{error}</p>}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="relative min-h-0 flex-1">
            {layout && <SplitLayout layout={layout} panels={tabs} focusedGroupId={layout.focusedGroupId ?? primaryGroup(layout.root).id}
              isMainRepo={false} onSizesChange={resizeSplit} onPanelSelect={selectPanel} onPanelClose={handleClose}
              onFocusGroup={focusGroup} showAddTool={false} alwaysShowClose />}
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
