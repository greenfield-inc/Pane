import { createPortal } from 'react-dom';
import { useTitleBarSlotStore } from '../stores/titleBarSlotStore';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChartNoAxesCombined, ChevronDown, ChevronUp, PanelRight, Terminal } from 'lucide-react';
import type { ToolPanel } from '../../../shared/types/panels';
import { panelApi } from '../services/panelApi';
import { usePanelStore } from '../stores/panelStore';
import { PanelContainer } from './panels/PanelContainer';
import { PanelTabStrip } from './panels/PanelTabStrip';
import { useConfigStore } from '../stores/configStore';
import { useSessionProgress } from '../hooks/useSessionProgress';
import { SessionProgressView } from './SessionProgressView';
import { useOuterPanelResize } from '../hooks/useOuterPanelResize';
import { OuterResizeSeparator } from './ui/OuterResizeSeparator';
import { Tooltip } from './ui/Tooltip';
import { OUTER_PANEL_CONFIGS, type OuterPanelConfig } from '../utils/outerPanelSizing';

const EMPTY_PANELS: ToolPanel[] = [];
const SESSION_INSPECTOR_TABS = ['overview', 'files', 'changes'] as const;
type SessionInspectorTab = typeof SESSION_INSPECTOR_TABS[number];

const PROGRESS_SIZE: OuterPanelConfig = {
  axis: 'width', storageKey: 'pane-session-brief-split-width:v2', legacyKey: 'pane-session-brief-split-width',
  legacyMin: 240, legacyMax: 1000, legacyDefault: 480,
  defaultPx: width => width / 2,
  bounds: width => ({ floor: Math.min(240, Math.max(0, width - 240)), cap: Math.max(0, width - 240) }),
};

export function SessionWorkspacePanels({ agentPanel, agentPanelIds, orchestrationSessionId, overviewContent, changesContent, toolbarActions }: {
  agentPanel: ToolPanel; agentPanelIds: string[]; orchestrationSessionId: string;
  overviewContent: ReactNode; changesContent: ReactNode; toolbarActions?: ReactNode;
}) {
  const trailingSlot = useTitleBarSlotStore(state => state.trailingSlot);
  const sessionTabsSlot = useTitleBarSlotStore(state => state.sessionTabsSlot);
  const sessionId = agentPanel.sessionId;
  const panels = usePanelStore(state => state.panels[sessionId] ?? EMPTY_PANELS);
  const activePanelId = usePanelStore(state => state.activePanels[sessionId]);
  const [showTerminal, setShowTerminal] = useState(false);
  const [progressVisible, setProgressVisible] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<SessionInspectorTab>('overview');
  const progressEnabled = useConfigStore(state => state.config?.experimentalSessionProgress === true);
  const progress = useSessionProgress(orchestrationSessionId, progressEnabled);
  const autoOpened = useRef(false);
  useEffect(() => {
    if (!progressEnabled) setProgressVisible(false);
  }, [progressEnabled]);
  const showSidebar = sidebarVisible;
  const showProgress = progressEnabled && progressVisible;
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(960);
  const filesResize = useOuterPanelResize({ config: OUTER_PANEL_CONFIGS.worktreeInspector, containerPx: width, enabled: showSidebar });
  const mainWidth = Math.max(0, width - (showSidebar ? filesResize.renderedPx : 0));
  const resize = useOuterPanelResize({ config: PROGRESS_SIZE, containerPx: mainWidth, enabled: showProgress });
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!progressEnabled) {
      autoOpened.current = false;
    }
    if (progress.document && !autoOpened.current) {
      autoOpened.current = true;
      setProgressVisible(true);
    }
  }, [progress.document, progressEnabled]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const creating = useRef(false);
  const terminal = panels.find(panel => panel.type === 'terminal' && !agentPanelIds.includes(panel.id));
  const explorer = panels.find(panel => panel.type === 'explorer');
  const tabs = [agentPanel, ...panels.filter(panel => panel.type === 'editor')];
  const active = tabs.find(panel => panel.id === activePanelId) ?? agentPanel;

  useEffect(() => {
    let cancelled = false;
    void panelApi.loadPanelsForSession(sessionId).then(saved => {
      if (cancelled) return;
      usePanelStore.getState().setPanels(sessionId, saved);
      setLoaded(true);
    }).catch(() => {
      if (!cancelled) setError('Could not load Session tools. Reopen the Session to retry.');
    });
    const events = window.electronAPI.events;
    const created = events.onPanelCreated(panel => {
      if (panel.sessionId === sessionId) usePanelStore.getState().addPanel(panel);
    });
    const updated = events.onPanelUpdated(panel => {
      if (panel.sessionId === sessionId) usePanelStore.getState().updatePanelState(panel);
    });
    const deleted = events.onPanelDeleted(event => {
      if (event.sessionId === sessionId) usePanelStore.getState().removePanel(sessionId, event.panelId);
    });
    return () => {
      cancelled = true;
      created();
      updated();
      deleted();
    };
  }, [sessionId]);

  async function toggleTool(type: 'terminal' | 'explorer') {
    if (!loaded || creating.current) return;
    creating.current = true;
    setError(null);
    try {
      if (!(type === 'terminal' ? terminal : explorer)) {
        const panel = await panelApi.createPanel({ sessionId, type, title: type === 'terminal' ? 'Terminal' : 'Files' });
        usePanelStore.getState().addPanel(panel);
        usePanelStore.getState().setActivePanel(sessionId, active.id);
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

  async function closePanel(panel: ToolPanel) {
    if (panel.id === agentPanel.id) return;
    try {
      await panelApi.deletePanel(panel.id);
      usePanelStore.getState().removePanel(sessionId, panel.id);
    } catch {
      setError('Could not close file. Please try again.');
    }
  }

  const sidebarToggle = (
      <button type="button" className="inline-flex h-8 w-8 items-center justify-center rounded text-text-secondary hover:bg-surface-hover" disabled={!loaded}
        aria-label={sidebarVisible ? 'Hide details' : 'Show details'}
        title={sidebarVisible ? 'Hide details' : 'Show details'}
        aria-expanded={sidebarVisible}
        onClick={() => setSidebarVisible(value => !value)}><PanelRight className="h-4 w-4" aria-hidden="true" /></button>
  );
  const tabStrip = (
    <PanelTabStrip panels={tabs} activePanelId={active.id} idNamespace={`session-${sessionId}`}
      onPanelSelect={panel => usePanelStore.getState().setActivePanel(sessionId, panel.id)}
      onPanelClose={panel => { void closePanel(panel); }} />
  );
  const titleBarActions = (
    <>
      {toolbarActions}
      {progressEnabled && <Tooltip content={showProgress ? 'Hide progress brief' : 'Show progress brief'} side="bottom">
        <button type="button" aria-label={showProgress ? 'Hide progress brief' : 'Show progress brief'}
          aria-expanded={showProgress} onClick={() => setProgressVisible(value => !value)}
          className="inline-flex h-8 w-8 items-center justify-center rounded text-text-secondary hover:bg-surface-hover hover:text-text-primary">
          <ChartNoAxesCombined className="h-4 w-4" aria-hidden="true" />
        </button>
      </Tooltip>}
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
            {tabs.map(panel => (
              <div key={panel.id} className="absolute inset-0" style={{ display: active.id === panel.id ? 'block' : 'none' }}>
                <PanelContainer panel={panel} isActive={active.id === panel.id} autoFocus={active.id === panel.id} />
              </div>
            ))}
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
        {showProgress && <aside aria-label="Session progress view"
          className="relative flex min-w-0 flex-shrink-0 flex-col border-l border-border-primary" style={{ width: resize.renderedPx }}>
          <OuterResizeSeparator label="Resize progress brief" orientation="vertical" value={resize.effectivePx}
            minimum={resize.floor} maximum={resize.cap} {...resize.separatorHandlers} />
          {progress.document ? <SessionProgressView html={progress.document.html} error={progress.error} />
            : <p className="p-3 text-sm text-text-secondary" role={progress.error ? 'alert' : undefined}>{progress.error || 'Progress will appear when the agent creates progress.html during your task.'}</p>}
        </aside>}
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
