import { useEffect, type CSSProperties } from 'react';
import { useOrchestrationSessionStore } from '../stores/orchestrationSessionStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useSessionStore } from '../stores/sessionStore';
import { useTitleBarSlotStore } from '../stores/titleBarSlotStore';
import type { Project } from '../types/project';
import { APP_WINDOW_TITLE, formatPaneTitle, resolvePaneTitle } from '../utils/paneTitle';
import { isMac } from '../utils/platformUtils';
import { COLLAPSED_SIDEBAR_PX, isWindowControlsOverlayEnabled, titleStripContentLeft } from '../utils/titleBarOverlay';

const TITLE_BAR_HEIGHT = 38;
const GUTTER = 8;
const MAC_CONTROLS_LEFT: CSSProperties = { left: 80 + GUTTER };
const OVERLAY_CONTROLS_LEFT: CSSProperties = { left: `calc(env(titlebar-area-x, 0px) + ${GUTTER}px)` };
const MAC_CONTROLS_RIGHT: CSSProperties = { right: GUTTER };
const OVERLAY_CONTROLS_RIGHT: CSSProperties = {
  right: `calc(100% - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100%) + ${GUTTER}px)`,
};
// SAFETY: Electron supports WebkitAppRegion although React's CSSProperties omits it.
const NO_DRAG = { WebkitAppRegion: 'no-drag' } as CSSProperties;

interface WindowTitleBarProps {
  projects: Project[];
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  controlsSlotRef?: (element: HTMLDivElement | null) => void;
}

/** Positions window controls over the sidebar and tabs without consuming a layout row. */
export function WindowTitleBar({ projects, sidebarWidth, sidebarCollapsed, controlsSlotRef }: WindowTitleBarProps) {
  const setTrailingSlot = useTitleBarSlotStore(state => state.setTrailingSlot);
  const setSessionTabsSlot = useTitleBarSlotStore(state => state.setSessionTabsSlot);
  const activeView = useNavigationStore(state => state.activeView);
  const activeSession = useSessionStore(state => {
    if (!state.activeSessionId) return undefined;
    if (state.activeMainRepoSession?.id === state.activeSessionId) return state.activeMainRepoSession;
    return state.sessions.find(session => session.id === state.activeSessionId);
  });
  const orchestrationName = useOrchestrationSessionStore(state => state.sessions.find(session => session.id === state.selectedSessionId)?.name);
  const title = activeView === 'sessions' ? resolvePaneTitle(activeSession, projects)
    : activeView === 'pane-chat' && orchestrationName ? { project: 'Session', pane: orchestrationName } : null;
  const windowTitle = formatPaneTitle(title);

  useEffect(() => {
    document.title = windowTitle;
    return () => { document.title = APP_WINDOW_TITLE; };
  }, [windowTitle]);

  if (!isMac() && !isWindowControlsOverlayEnabled()) return null;

  const sessionTabsLeft = titleStripContentLeft(sidebarCollapsed ? COLLAPSED_SIDEBAR_PX : sidebarWidth, isMac());
  const sessionTabsRight = isMac()
    ? '116px'
    : `calc(100% - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100%) + 116px)`;

  return (
    <div
      className="pane-window-title-bar pointer-events-none absolute inset-x-0 top-0 z-30 select-none"
      style={{ height: TITLE_BAR_HEIGHT, ...NO_DRAG }}
      data-testid="window-title-bar"
    >
      <div
        ref={controlsSlotRef}
        className="pointer-events-auto absolute inset-y-0 flex items-center gap-0.5"
        style={{ ...NO_DRAG, ...(isMac() ? MAC_CONTROLS_LEFT : OVERLAY_CONTROLS_LEFT) }}
        data-testid="window-title-bar-controls"
      />
      <div
        ref={setTrailingSlot}
        className="pointer-events-auto absolute inset-y-0 flex items-center gap-0.5"
        style={{ ...NO_DRAG, ...(isMac() ? MAC_CONTROLS_RIGHT : OVERLAY_CONTROLS_RIGHT) }}
        data-testid="window-title-bar-trailing-controls"
      />
      {activeView === 'pane-chat' && (
        <div
          ref={setSessionTabsSlot}
          className="pointer-events-auto absolute inset-y-0 flex min-w-0 items-center overflow-hidden transition-[left] duration-reveal ease-out-strong"
          style={{ ...NO_DRAG, left: sessionTabsLeft, right: sessionTabsRight }}
          data-testid="window-title-bar-session-tabs"
        />
      )}
    </div>
  );
}
