import { useEffect, useState, type CSSProperties } from 'react';
import { useOrchestrationSessionStore } from '../stores/orchestrationSessionStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useSessionStore } from '../stores/sessionStore';
import { useTitleBarSlotStore } from '../stores/titleBarSlotStore';
import type { Project } from '../types/project';
import { APP_WINDOW_TITLE, formatPaneTitle, resolvePaneStatusPills, resolvePaneTitle } from '../utils/paneTitle';
import { isMac } from '../utils/platformUtils';
import { isWindowControlsOverlayEnabled } from '../utils/titleBarOverlay';
import { Badge } from './ui/Badge';

const GUTTER = 8;
const SIDEBAR_EDGE = 'var(--border-hairline) solid var(--color-border-primary)';
// SAFETY: Electron supports WebkitAppRegion although React's CSSProperties omits it.
// The bottom hairline is an inset shadow rather than a border so it does not
// take a pixel from the 38px row: controls stay centered on whole pixels.
const TITLE_BAR_STYLE = {
  height: 38,
  WebkitAppRegion: 'drag',
  boxShadow: 'inset 0 calc(-1 * var(--border-hairline)) 0 var(--color-border-primary)',
} as CSSProperties;
// Traffic lights sit at x=10 with ~70px of width (see `trafficLightPosition` in
// main/src/index.ts); equal padding on both sides clears them and keeps the
// title centered on the window.
const MAC_INSET_STYLE: CSSProperties = { paddingLeft: 88, paddingRight: 88 };
// Windows and Linux report the page's share of the strip through the Window
// Controls Overlay env() values; the far side is whatever they do not cover.
const OVERLAY_INSET_STYLE: CSSProperties = {
  paddingLeft: `calc(env(titlebar-area-x, 0px) + ${GUTTER}px)`,
  paddingRight: `max(${GUTTER}px, calc(100% - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100%) + ${GUTTER}px))`,
};
const MAC_CONTROLS_LEFT: CSSProperties = { left: 80 + GUTTER };
const OVERLAY_CONTROLS_LEFT: CSSProperties = { left: `calc(env(titlebar-area-x, 0px) + ${GUTTER}px)` };
const MAC_CONTROLS_RIGHT: CSSProperties = { right: GUTTER };
const OVERLAY_CONTROLS_RIGHT: CSSProperties = {
  right: `calc(100% - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100%) + ${GUTTER}px)`,
};
// SAFETY: Electron supports WebkitAppRegion although React's CSSProperties omits it.
const NO_DRAG = { WebkitAppRegion: 'no-drag' } as CSSProperties;
// An rtl line box overflows at its left edge, so the ellipsis lands on the head
// and the end of a long pane name ("… (TM-622)") survives. The inner ltr embed
// keeps the name itself a single left-to-right run — without it, trailing
// punctuation is reordered to the clipped end and lost.
const HEAD_ELLIPSIS_STYLE: CSSProperties = { direction: 'rtl' };
const LTR_RUN_STYLE: CSSProperties = { direction: 'ltr', unicodeBidi: 'embed' };

/**
 * Which of `keys` appeared just now, as opposed to being here all along.
 *
 * The distinction is the whole point of animating these at all. A pill that
 * arrives while you are watching the pane — the PR opened, the branch became
 * mergeable — is a state change, and motion is how a state change stops being a
 * thing you have to notice. A pill that is simply present because you switched
 * to a pane that already had one is not news, and animating it would put motion
 * on pane switching, which is the one thing this must not do.
 *
 * Keyed by `scope` (the pane): when that changes, everything counts as
 * pre-existing.
 */
function useArrivedKeys(scope: string | null, keys: string[]): Set<string> {
  const signature = keys.join('\u0000');
  const [seen, setSeen] = useState({ scope, signature, arrived: new Set<string>() });

  if (seen.scope !== scope || seen.signature !== signature) {
    // Render-phase update: React re-renders immediately with the value below,
    // so the commit that first paints a new pill already carries its class.
    setSeen({
      scope,
      signature,
      arrived: seen.scope === scope
        ? new Set(keys.filter(key => !seen.signature.split('\u0000').includes(key)))
        : new Set(),
    });
  }

  return seen.scope === scope && seen.signature === signature ? seen.arrived : new Set();
}

interface WindowTitleBarProps {
  projects: Project[];
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  controlsSlotRef?: (element: HTMLDivElement | null) => void;
}

/**
 * The window's title bar: its own row above the sidebar and every tab strip,
 * the way VS Code lays out its window. It carries the window drag region, the
 * sidebar controls on the left, global controls (Run, inspector, Session
 * settings) on the right, and the name of the pane or Session you are looking
 * at in the middle. Tabs never share this row, so every tab strip — including
 * each group's strip in a split — starts at the same height below it.
 *
 * It renders wherever the app owns the title bar: macOS via `hiddenInset`, and
 * Windows and Linux via the Window Controls Overlay. A Linux desktop that failed
 * the overlay gate in main keeps its native frame and gets no strip — there it
 * is `document.title`, which this also owns, that carries the pane name. That is
 * true on every platform for the taskbar and task switcher.
 */
export function WindowTitleBar({ projects, sidebarWidth, sidebarCollapsed, controlsSlotRef }: WindowTitleBarProps) {
  const setTrailingSlot = useTitleBarSlotStore(state => state.setTrailingSlot);
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

  // Runs before the platform gate below: naming the window is the part of this
  // that a native-framed Windows or Linux window still uses.
  useEffect(() => {
    document.title = windowTitle;
    return () => { document.title = APP_WINDOW_TITLE; };
  }, [windowTitle]);

  // Status pills describe a pane's branch and PR; a Session has neither.
  const pills = activeView === 'sessions' && title ? resolvePaneStatusPills(activeSession) : [];
  const arrived = useArrivedKeys(activeSession?.id ?? null, pills.map(pill => pill.key));

  if (!isMac() && !isWindowControlsOverlayEnabled()) return null;

  return (
    <div
      className="pane-window-title-bar relative flex flex-shrink-0 items-center justify-center overflow-hidden bg-bg-chrome select-none"
      style={{ ...TITLE_BAR_STYLE, ...(isMac() ? MAC_INSET_STYLE : OVERLAY_INSET_STYLE) }}
      data-testid="window-title-bar"
    >
      {/* Over the sidebar the bar takes the sidebar's own colour and edge and
          drops its bottom hairline, so the sidebar runs to the top of the
          window, as in VS Code. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-0 bg-surface-secondary transition-[width] duration-reveal ease-out-strong"
        style={{ width: sidebarCollapsed ? 48 : sidebarWidth, borderRight: SIDEBAR_EDGE }}
        data-testid="window-title-bar-sidebar-segment"
      />
      <div
        ref={controlsSlotRef}
        className="absolute inset-y-0 flex items-center gap-0.5"
        style={{ ...NO_DRAG, ...(isMac() ? MAC_CONTROLS_LEFT : OVERLAY_CONTROLS_LEFT) }}
        data-testid="window-title-bar-controls"
      />
      <div
        ref={setTrailingSlot}
        className="absolute inset-y-0 flex items-center gap-0.5"
        style={{ ...NO_DRAG, ...(isMac() ? MAC_CONTROLS_RIGHT : OVERLAY_CONTROLS_RIGHT) }}
        data-testid="window-title-bar-trailing-controls"
      />
      {title && (
        <div className="relative flex min-w-0 items-center">
          <div
            className="flex min-w-0 items-center gap-1.5 text-xs"
            data-testid="window-title-bar-label"
            title={windowTitle}
          >
            <span className="truncate text-text-tertiary">{title.project}</span>
            {title.pane && (
              <>
                <span className="flex-shrink-0 text-text-tertiary" aria-hidden="true">·</span>
                <span
                  className="truncate font-medium text-text-secondary"
                  style={HEAD_ELLIPSIS_STYLE}
                >
                  <span style={LTR_RUN_STYLE}>{title.pane}</span>
                </span>
              </>
            )}
          </div>
          {pills.length > 0 && (
            // Anchored past the end of the title rather than laid out after it, so a
            // pill appearing or clearing never nudges the centered name sideways.
            <div
              className="absolute left-full top-1/2 flex -translate-y-1/2 items-center gap-1 pl-2"
              data-testid="window-title-bar-pills"
            >
              {pills.map(pill => (
                <Badge
                  key={pill.key}
                  variant={pill.variant}
                  size="sm"
                  className={`whitespace-nowrap px-1.5 py-0 text-[10px] leading-4${
                    arrived.has(pill.key) ? ' origin-left animate-title-pill-enter' : ''
                  }`}
                  title={pill.tooltip}
                >
                  {pill.label}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
