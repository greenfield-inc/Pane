import React, { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { WebglAddon } from '@xterm/addon-webgl';
import type { WebLinksAddon } from '@xterm/addon-web-links';
import type { SerializeAddon } from '@xterm/addon-serialize';
import type { Unicode11Addon } from '@xterm/addon-unicode11';
import type { ImageAddon, IImageAddonOptions } from '@xterm/addon-image';
import { useSession } from '../../contexts/SessionContext';
import { useTheme } from '../../contexts/ThemeContext';
import { TerminalPanelProps } from '../../types/panelComponents';
import { isHotkeyEnabledForEvent, useHotkeyStore } from '../../stores/hotkeyStore';
import { renderLog, devLog } from '../../utils/console';
import { getTerminalTheme } from '../../utils/terminalTheme';
import {
  isFineSurfaceScrollKey,
  isPageSurfaceScrollKey,
  resolveTerminalKeyHandling,
  shouldOpenTerminalSearch,
  terminalClaimsFineSurfaceScroll,
} from '../../utils/terminalKeyHandling';
import { isMac } from '../../utils/platformUtils';
import { copyTerminalText, isTerminalCopyShortcut } from '../../utils/terminalClipboard';
import { FileEdit, FolderOpen } from 'lucide-react';
import { useTerminalLinks } from '../terminal/hooks/useTerminalLinks';
import { TerminalLinkTooltip } from '../terminal/TerminalLinkTooltip';
import { TerminalPopover, PopoverButton } from '../terminal/TerminalPopover';
import { SelectionPopover } from '../terminal/SelectionPopover';
import { useTerminalSearch } from '../../hooks/useTerminalSearch';
import { useScrollSurface } from '../../hooks/useScrollSurface';
import { TerminalSearchOverlay } from '../terminal/TerminalSearchOverlay';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import { TERMINAL_IMAGE_OPTIONS } from '../../../../shared/constants/terminalGraphics';
import { selectTerminalRestoreContent } from '../../utils/terminalRestore';
import { TerminalInterceptor } from '../../services/terminalInterceptor/TerminalInterceptor';
import { createAtTerminalHandler } from '../../services/terminalInterceptor/handlers/atTerminalHandler';
import { InterceptorDropdown } from '../terminal/InterceptorDropdown';
import { InterceptorToast } from '../terminal/InterceptorToast';
import { usePanelStore } from '../../stores/panelStore';
import { areKeyboardShortcutsEnabled, useConfigStore } from '../../stores/configStore';
import type { InterceptorState, TerminalSuggestion } from '../../services/terminalInterceptor/types';
import { markPaneTerminalShown, markPanelOutput, startSendPrompt } from '../../utils/journeyTimings';
import '@xterm/xterm/css/xterm.css';

interface DropdownPosition {
  x: number;
  y: number;
}

// Hold the loading overlay at least this long past ready so the terminal
// underneath finishes painting before it is revealed.
const TERMINAL_OVERLAY_LINGER_MS = 150;

const SKELETON_TRANSCRIPT_WIDTHS = ['w-2/3', 'w-1/2', 'w-5/6', 'w-1/3', 'w-3/4', 'w-2/5'];

// Opaque stand-in shaped like a CLI agent session: greeting banner, transcript
// lines, and a prompt box, swept by a single shimmer so it reads as one
// cohesive loading surface. Shown while initializing, refreshing, and CLI startup.
const TerminalLoadingSkeleton: React.FC = () => (
  <div className="relative w-full h-full overflow-hidden px-4 py-4 font-mono select-none" role="status" aria-label="Loading terminal">
    <div className="flex h-full flex-col gap-4">
      <div className="rounded-md border border-border-primary p-3 space-y-2 max-w-md">
        <div className="h-3.5 w-40 rounded bg-surface-tertiary" />
        <div className="h-3 w-56 rounded bg-surface-tertiary" />
        <div className="h-3 w-32 rounded bg-surface-tertiary" />
      </div>
      <div className="space-y-2.5 max-w-2xl">
        {SKELETON_TRANSCRIPT_WIDTHS.map((w, i) => (
          <div key={i} className={`h-3 rounded bg-surface-tertiary ${w}`} />
        ))}
      </div>
      <div className="flex-1" />
      <div className="space-y-2">
        <div className="rounded-md border border-border-primary px-3 py-2.5">
          <div className="h-3 w-24 rounded bg-surface-tertiary" />
        </div>
        <div className="flex items-center gap-3">
          <div className="h-2.5 w-20 rounded bg-surface-tertiary" />
          <div className="h-2.5 w-28 rounded bg-surface-tertiary" />
        </div>
      </div>
    </div>
    <div className="pointer-events-none absolute inset-0 animate-shimmer bg-gradient-to-r from-transparent via-[color-mix(in_srgb,var(--color-text-primary)_4%,transparent)] to-transparent" />
  </div>
);

// Type for terminal state restoration
interface TerminalRestoreState {
  scrollbackBuffer: string | string[];
  alternateScreenBuffer?: string;
  isAlternateScreen?: boolean;
  serializedBuffer?: string;
  cursorX?: number;
  cursorY?: number;
}

const DEFAULT_TERMINAL_FONT_FAMILY = 'Geist Mono';
const DEFAULT_TERMINAL_FONT_SIZE = 14;
const WEBGL_APP_BLUR_DETACH_DELAY_MS = 10_000;
const REFOCUS_DELAYED_REFRESH_MS = 300;
const TERMINAL_ACTIVATION_MASK_AFTER_PAINT_MS = 200;
const TERMINAL_VISIBILITY_REFRESH_MS = 60_000;
const SNAPSHOT_MIN_INTERVAL_MS = 10_000;
const MIN_VIABLE_RECT_PX = 100; // below this the container is hidden or mid-layout (Allotment minSize is 120)
const MIN_PTY_COLS = 20;        // mirrors main-process floor
const MIN_PTY_ROWS = 5;
const NEAR_BOTTOM_THRESHOLD_ROWS = 3;

// Sequence-size limits stay at the addon defaults (32 MB), which a 4K kitty frame
// fits inside once zlib-compressed and base64-encoded.
const TERMINAL_IMAGE_ADDON_OPTIONS: IImageAddonOptions = TERMINAL_IMAGE_OPTIONS;
const terminalPasteImageResultSchema = boundary.object({
  filePath: boundary.string,
  imageNumber: boundary.number,
});
const terminalPasteFileResultSchema = boundary.object({ filePath: boundary.string });

// xterm halves the configured ratio for dim (SGR 2) cells, so 9 is what gets dim
// CLI output (Claude Code / Codex) to 4.5:1 AA. Off-state stays a modest safety
// floor so the deliberate muted grays in the dark themes survive.
const HIGH_CONTRAST_MIN_RATIO = 9;   // dim cells get ratio/2 = 4.5 (AA)
const LIGHT_MIN_RATIO = 4.5;
const DARK_MIN_RATIO = 3;

// Takes highContrast as an argument rather than reading the `high-contrast`
// class: that class is stamped by ThemeProvider's effect, and React flushes
// passive effects child-first, so this component's effect would observe the
// previous value and leave the terminal one toggle behind.
const getMinimumContrastRatio = (highContrast: boolean): number => {
  if (highContrast) return HIGH_CONTRAST_MIN_RATIO;
  return document.documentElement.classList.contains('light') ? LIGHT_MIN_RATIO : DARK_MIN_RATIO;
};
const TERMINAL_VISIBILITY_VIEWER_ID = getTerminalVisibilityViewerId();

function getTerminalVisibilityViewerId(): string {
  const storageKey = 'pane-terminal-visibility-viewer-id';
  try {
    const existing = window.sessionStorage.getItem(storageKey);
    if (existing) return existing;

    const next = globalThis.crypto?.randomUUID?.()
      ?? `viewer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    window.sessionStorage.setItem(storageKey, next);
    return next;
  } catch {
    return `viewer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

function buildTerminalFontFamily(userFont: string): string {
  return `"${userFont}", "Symbols Nerd Font Mono", monospace`;
}

function isClipboardImagePlaceholderText(text: string): boolean {
  return text.trim() === '[Image]';
}

function waitForNextPaint(): Promise<void> {
  return new Promise(resolve => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

/**
 * Terminal panel lifecycle — the invariants below keep hidden terminals cheap
 * and correct; break one and you get mangled buffers or replay storms.
 *
 * MOUNT (possibly hidden): keep-alive terminal tabs mount even when inactive
 * (PanelGroupView renders them behind display:none). The PTY spawns at the
 * backend default (80×30) when the container has no measurable size, and the
 * mount-time fit() is SKIPPED for containers below MIN_VIABLE_RECT_PX —
 * FitAddon has no cols floor, so fitting a 0×0 container would shrink the
 * grid to a few columns and background PTY output would parse into a
 * garbage-width buffer that xterm reflow cannot repair. A skipped mount fit
 * arms `needsFullActivationRefreshRef` so the first activation rebuilds the
 * buffer at the settled width. The same width guard applies to every other
 * grid-resizing path (resizePtyToFit, post-restore fit, font-change fit).
 *
 * HIDDEN (performance mode): the panel keeps reporting visible to main
 * (`effectiveVisible` is hard-coded true), so PTY output keeps streaming and
 * the xterm buffer stays live while display:none. Battery saver instead
 * reports hidden — main stops renderer delivery — so its buffer genuinely
 * goes stale while inactive.
 *
 * ACTIVATION (tab shown and window focused — `activationVisible`): initial
 * construction, remounts/session switches, battery saver, and manual Refresh
 * run the full masked reset+replay from
 * `terminal:getState` (`handleRefreshTerminal`). A narrowly eligible same-
 * session hot activation may instead preserve the continuously updated mounted
 * xterm and perform masked fit/reconcile/refresh. This is intentionally gated:
 * two shipped attempts to broadly lighten activation — a fit+repaint activation
 * (v2.4.11) and keep-alive WebGL contexts with an atlas clear (v2.4.14) —
 * produced ghosted rows and garbage-glyph atlas corruption (xterm terminals
 * with the same font/theme SHARE a texture atlas; clearing it from one terminal
 * poisons the others). Performance mode keeps both WebGL and the continuously
 * fed xterm buffer valid through a window blur of any duration, so refocus takes
 * the light silent `repaintTerminal` path. A delayed backstop re-runs the chosen
 * depth once (REFOCUS_DELAYED_REFRESH_MS).
 *
 * WEBGL: one context per VISIBLE terminal. Detached immediately on panel
 * hide. Performance mode keeps it attached through app blur; battery saver
 * detaches it after WEBGL_APP_BLUR_DETACH_DELAY_MS and takes its existing full
 * recovery because output was gated. Re-attach paints via a refresh deferred
 * past the next frame — same-task refreshes can hit an uncomposited canvas.
 * Context loss keeps its existing DOM-renderer fallback. Never call
 * `clearTextureAtlas()` here: the atlas is shared across terminals.
 *
 * PERSISTENCE: main owns the raw scrollback log plus a headless emulator that
 * renders every PTY byte; the renderer serializes a formatting-preserving
 * snapshot on hide (throttled to SNAPSHOT_MIN_INTERVAL_MS) and on unmount,
 * used only for app-restart restore. Live normal-buffer restores replay main's
 * rendered emulator serialization (duplicate-free by construction); the raw
 * append log remains for snapshot/scrollback readers.
 *
 * UNMOUNT (session switch / panel close): serialize a final snapshot, then
 * dispose WebGL, addons, and the xterm instance. Remounts restore from
 * `terminal:getState` (capped payload) and replay once into a fresh xterm.
 * This differs intentionally from terminal clients that retain every renderer
 * and its DOM node for every session: Pane bounds renderer memory, listeners,
 * WebGL resources, and duplicate output parsing to the mounted top-level Pane
 * session. Tool tabs inside that session are still kept mounted as described
 * above. The main-process PTY and headless emulator remain authoritative, so
 * background agents keep running and local-control screen reads remain correct
 * without a renderer per session. The tradeoff is that remounting exposes
 * foreground-TUI redraw assumptions hidden by retained-DOM designs. Restoring
 * cells recreates terminal state but cannot make the application recompute its
 * layout, which is why the alternate-screen activation path finishes with a
 * forced resize: main toggles the PTY rows once (renderer grid untouched) so
 * the app gets a real SIGWINCH and repaints. The normal-buffer path deliberately does
 * NOT force one: the emulator serialization is already the exact current
 * screen, and forced width transitions made normal-buffer TUIs (Claude Code)
 * re-render their transcript tail — duplicating scrollback on every
 * activation once content overflowed the viewport.
 */
const TerminalPanel: React.FC<TerminalPanelProps> = React.memo(({ panel, isActive, autoFocus = true }) => {
  renderLog('[TerminalPanel] Component rendering, panel:', panel.id, 'isActive:', isActive);
  
  // All hooks must be called at the top level, before any conditional returns
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  // Async initialization must publish the instance reactively so terminal hooks subscribe immediately.
  const [terminalInstance, setTerminalInstance] = useState<Terminal | null>(null);
  const [terminalFontObservation, setTerminalFontObservation] = useState<string>();
  const fitAddonRef = useRef<FitAddon | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const webLinksAddonRef = useRef<WebLinksAddon | null>(null);
  const serializeAddonRef = useRef<SerializeAddon | null>(null);
  const unicode11AddonRef = useRef<Unicode11Addon | null>(null);
  const imageAddonRef = useRef<ImageAddon | null>(null);
  const isActiveRef = useRef(isActive);
  const isNearBottomRef = useRef(true); // Track if user is scrolled near the bottom
  const [showScrollDown, setShowScrollDown] = useState(false); // Show jump-to-bottom pill
  const tuiActiveRef = useRef(false);
  const scrollLineRemainderRef = useRef(0);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [interceptorState, setInterceptorState] = useState<InterceptorState | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [windowFocused, setWindowFocused] = useState(true);
  const interceptorRef = useRef<TerminalInterceptor | null>(null);
  const skipNextInterceptRef = useRef(false); // set by AltGr @ detection
  const terminalPowerMode = useConfigStore((state) => state.config?.terminalPowerMode ?? 'performance');
  const keyboardShortcutsEnabled = useConfigStore((state) => areKeyboardShortcutsEnabled(state.config));
  const keyboardShortcutsEnabledRef = useRef(keyboardShortcutsEnabled);
  // Opt-in per application: a program has to ask for it with CSI > flags u, so
  // this only changes what reaches programs that requested enhanced reporting.
  const kittyKeyboardEnabled = useConfigStore((state) => state.config?.kittyKeyboardEnabled !== false);
  const kittyKeyboardEnabledRef = useRef(kittyKeyboardEnabled);
  const useBatterySaverTerminalVisibility = terminalPowerMode === 'batterySaver';
  const panelVisible = isActive;
  const effectiveVisible = useBatterySaverTerminalVisibility ? panelVisible && windowFocused : true;
  // Drives the shared activation refresh: fires on tab activation and window
  // refocus in both power modes (effectiveVisible is hard-coded true in
  // performance mode, so it cannot serve this role).
  const activationVisible = panelVisible && windowFocused;
  // True when the next activation needs the full reset+replay path: initial
  // mount/remount, an ineligible panel hide/show, or battery saver gating PTY
  // output while inactive. Performance-mode app blur never arms this flag:
  // both the renderer and buffer remain valid and refocus silently repaints.
  // This full refresh on activation is LOAD-BEARING for paint correctness: two
  // attempts to replace it with a light repaint (v2.4.11) and with keep-alive
  // WebGL contexts (v2.4.14) shipped ghosted rows and texture-atlas corruption.
  // Do not remove it from the retained triggers without an offline repro of
  // the renderer-swap artifacts.
  const needsFullActivationRefreshRef = useRef(true);
  // Fast activation is only safe after this exact mounted xterm has completed a
  // full refresh and has remained on the ungated performance-mode output path.
  // A fresh mount starts false so it cannot skip its initial reset/replay.
  const hotActivationEligibleRef = useRef(false);
  const hotActivationPendingRef = useRef(false);
  const [webglAllowed, setWebglAllowed] = useState(panelVisible);
  const blurDetachTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Read CLI state from persisted panel state (handles remount case)
  const terminalState = decodeOptionalBoundary(panel.state?.customState, boundary.object({
    isCliPanel: boundary.optional(boundary.boolean),
    isCliReady: boundary.optional(boundary.boolean),
  }));
  const isCliPanel = !!terminalState?.isCliPanel;
  const [isCliReady, setIsCliReady] = useState(!!terminalState?.isCliReady);
  const isRemoteMode = useConfigStore((state) => state.config?.remoteDaemon?.client.mode === 'remote');
  const isCliPanelRef = useRef(isCliPanel);

  // ptyId for the current PTY behind this panel, delivered via
  // `terminal:ptyReady` when spawned through the ptyHost UtilityProcess.
  // Null under the legacy `pty.spawn` path. Re-fires with a new value on
  // auto-reattach after a supervisor restart. A ref so the ack-flush closure
  // (captured inside the init effect) reads the current value.
  const currentPtyIdRef = useRef<string | null>(null);

  // Sync isCliReady from panel prop when it changes (e.g. backend persisted isCliReady
  // before this component subscribed to the IPC event, or panel state was updated externally)
  useEffect(() => {
    isCliPanelRef.current = isCliPanel;
  }, [isCliPanel]);

  useEffect(() => {
    keyboardShortcutsEnabledRef.current = keyboardShortcutsEnabled;
  }, [keyboardShortcutsEnabled]);

  // vtExtensions is not a constructor-only option and useKitty reads it per key
  // event, so the toggle takes effect on the live terminal with no restart.
  useEffect(() => {
    kittyKeyboardEnabledRef.current = kittyKeyboardEnabled;
    const terminal = xtermRef.current;
    if (!terminal) return;
    terminal.options.vtExtensions = { ...terminal.options.vtExtensions, kittyKeyboard: kittyKeyboardEnabled };
  }, [kittyKeyboardEnabled]);

  const terminalScrollSurfaceRef = useScrollSurface<HTMLDivElement>({
    id: `terminal:${panel.id}`,
    sessionId: panel.sessionId,
    enabled: isActive,
    priority: autoFocus ? 100 : 20,
    scrollByLines: (lines) => {
      const terminal = xtermRef.current;
      if (!terminal) return;
      if (
        scrollLineRemainderRef.current !== 0
        && Math.sign(scrollLineRemainderRef.current) !== Math.sign(lines)
      ) {
        scrollLineRemainderRef.current = 0;
      }
      const total = scrollLineRemainderRef.current + lines;
      const wholeLines = total > 0 ? Math.floor(total) : Math.ceil(total);
      scrollLineRemainderRef.current = total - wholeLines;
      if (wholeLines !== 0) terminal.scrollLines(wholeLines);
    },
    scrollPage: direction => xtermRef.current?.scrollPages(direction),
    focus: () => xtermRef.current?.focus(),
  });

  useEffect(() => {
    if (terminalState?.isCliReady && !isCliReady) {
      setIsCliReady(true);
    }
  }, [terminalState?.isCliReady, isCliReady]);

  // Loading-skeleton visibility: show immediately when any loading state is
  // active, hide only after a short linger so the terminal underneath has
  // finished painting before the mask lifts.
  const overlayActive = !isInitialized || isRefreshing || (isCliPanel && !isCliReady);
  const [overlayVisible, setOverlayVisible] = useState(true);
  useEffect(() => {
    if (overlayActive) {
      setOverlayVisible(true);
      return;
    }
    const lingerTimer = setTimeout(() => {
      setOverlayVisible(false);
      markPaneTerminalShown(panel.sessionId);
    }, TERMINAL_OVERLAY_LINGER_MS);
    return () => clearTimeout(lingerTimer);
  }, [overlayActive, panel.sessionId]);

  // Listen for cliReady event (only for CLI panels that aren't already ready)
  useEffect(() => {
    if (!isCliPanel || isCliReady) return;
    const cleanup = window.electronAPI.events.onTerminalCliReady((data) => {
      if (data.panelId === panel.id) {
        setIsCliReady(true);
      }
    });
    return cleanup;
  }, [panel.id, isCliPanel, isCliReady]);

  // Listen for the ptyHost ptyId assignment. The main process fires this
  // once per spawn when the `usePtyHost` setting is on; fires again on auto-reattach
  // after a supervisor restart with a new ptyId.
  useEffect(() => {
    const cleanup = window.electronAPI.events.onTerminalPtyReady((data) => {
      if (data.panelId === panel.id) {
        currentPtyIdRef.current = data.ptyId;
      }
    });
    return cleanup;
  }, [panel.id]);

  // Get session data from context using the safe hook
  const sessionContext = useSession();
  const sessionId = sessionContext?.sessionId;
  const workingDirectory = sessionContext?.workingDirectory;
  const { theme, highContrast } = useTheme();
  
  if (sessionContext) {
    devLog.debug('[TerminalPanel] Session context:', sessionContext);
  } else {
    devLog.error('[TerminalPanel] No session context available');
  }

  // Keep isActiveRef in sync with isActive prop
  useEffect(() => {
    isActiveRef.current = panelVisible;
  }, [panelVisible]);

  useEffect(() => {
    let disposed = false;
    window.electronAPI.window?.isFocused?.()
      .then((focused) => {
        if (!disposed) setWindowFocused(focused);
      })
      .catch(() => {
        // Default to focused if the focus query is unavailable.
      });

    const cleanup = window.electronAPI.events.onWindowFocusChanged((focused) => {
      setWindowFocused(focused);
    });

    return () => {
      disposed = true;
      cleanup();
    };
  }, []);

  const forwardToMainLog = useCallback((level: 'info' | 'warn', message: string) => {
    try {
      window.electronAPI.invoke('console:log', {
        level,
        args: [message],
        timestamp: new Date().toISOString(),
        source: 'renderer',
        toMainLog: true,
      });
    } catch {
      // IPC failure shouldn't break terminal lifecycle work.
    }
  }, []);

  const loadWebglRenderer = useCallback(async (terminal: Terminal, isDisposed: () => boolean, reason = 'visible') => {
    if (webglAddonRef.current) return;
    try {
      const { WebglAddon: WebglAddonImpl } = await import('@xterm/addon-webgl');
      if (isDisposed() || webglAddonRef.current) return;
      const addon = new WebglAddonImpl();
      addon.onContextLoss(() => {
        console.warn('[TerminalPanel] WebGL context lost for panel', panel.id, ', falling back to DOM renderer');
        forwardToMainLog('warn', `[TerminalPanel] WebGL context lost for panel ${panel.id}, falling back to DOM renderer`);
        try { addon.dispose(); } catch { /* already disposed */ }
        webglAddonRef.current = null;
        // Defense-in-depth: force a redraw on the restored DOM renderer.
        const fallbackTerminal = xtermRef.current;
        if (fallbackTerminal && fallbackTerminal.rows > 0) {
          fallbackTerminal.refresh(0, fallbackTerminal.rows - 1);
        }
      });
      terminal.loadAddon(addon);
      webglAddonRef.current = addon;
      // xterm's activate() only swaps the renderer via setRenderer with no full
      // row refresh, so force a redraw on the freshly attached WebGL renderer —
      // deferred past the next paint: refreshing in the same task can hit an
      // uncomposited canvas on blur→refocus reattach.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (webglAddonRef.current !== addon) return;
        if (terminal.rows > 0) terminal.refresh(0, terminal.rows - 1);
      }));
      devLog.debug('[TerminalPanel] WebGL renderer loaded for panel', panel.id);
      forwardToMainLog('info', `[TerminalPanel] WebGL renderer loaded for panel ${panel.id} reason=${reason}`);
    } catch (e) {
      console.warn('[TerminalPanel] WebGL renderer failed for panel', panel.id, ', using DOM renderer:', e);
      forwardToMainLog('warn', `[TerminalPanel] WebGL renderer failed for panel ${panel.id}, using DOM renderer: ${e instanceof Error ? e.message : String(e)}`);
      webglAddonRef.current = null;
    }
  }, [forwardToMainLog, panel.id]);

  const disposeWebglRenderer = useCallback((reason = 'hidden') => {
    if (!webglAddonRef.current) return;
    try { webglAddonRef.current.dispose(); } catch { /* ignore */ }
    webglAddonRef.current = null;
    forwardToMainLog('info', `[TerminalPanel] WebGL renderer detached for panel ${panel.id} reason=${reason}`);
  }, [forwardToMainLog, panel.id]);

  // Replaces the old 30 s snapshot interval: fire once on active-to-inactive
  // transitions (tab switches / panel hides), throttled so rapid tab flips
  // don't do a full buffer walk + IPC each time. The dispose-time snapshot in
  // the terminal init effect stays as a backstop for full unmount.
  const wasActiveRef = useRef(panelVisible);
  const lastSnapshotAtRef = useRef(0);
  useEffect(() => {
    const wasActive = wasActiveRef.current;
    wasActiveRef.current = panelVisible;
    if (wasActive && !panelVisible && serializeAddonRef.current) {
      if (Date.now() - lastSnapshotAtRef.current < SNAPSHOT_MIN_INTERVAL_MS) return;
      try {
        const serialized = serializeAddonRef.current.serialize();
        window.electronAPI.invoke('terminal:saveSnapshot', panel.id, serialized);
        lastSnapshotAtRef.current = Date.now();
      } catch {
        // xterm buffer in a bad state — not worth surfacing
      }
    }
  }, [panelVisible, panel.id]);

  // Tell main when this panel's visibility changes so PTY output cadence
  // can drop to 250 ms while hidden and snap back to 32 ms when shown.
  // Gate on isInitialized so panels that mount inactive (hidden background
  // sessions) actually deliver the signal — main's no-op-on-missing guard
  // would drop it otherwise. isInitialized in deps ensures re-fire with the
  // current isActive the moment the PTY exists.
  useEffect(() => {
    if (!isInitialized) return;
    window.electronAPI.invoke('terminal:setVisibility', panel.id, effectiveVisible, TERMINAL_VISIBILITY_VIEWER_ID);

    if (!effectiveVisible) {
      hotActivationEligibleRef.current = false;
      hotActivationPendingRef.current = false;
      return;
    }
    const refreshTimer = setInterval(() => {
      window.electronAPI.invoke('terminal:setVisibility', panel.id, true, TERMINAL_VISIBILITY_VIEWER_ID);
    }, TERMINAL_VISIBILITY_REFRESH_MS);

    return () => clearInterval(refreshTimer);
  }, [effectiveVisible, panel.id, isInitialized]);

  // WebGL policy: panel hides detach immediately. App blur keeps WebGL attached
  // in performance mode; battery saver detaches after the delay because its
  // gated output already requires full recovery on refocus.
  useEffect(() => {
    if (blurDetachTimerRef.current) {
      clearTimeout(blurDetachTimerRef.current);
      blurDetachTimerRef.current = null;
    }

    if (!panelVisible) {
      // Capture eligibility before detaching WebGL. The xterm remains mounted and
      // performance mode continues delivering output while this panel is hidden.
      hotActivationPendingRef.current = hotActivationEligibleRef.current && !useBatterySaverTerminalVisibility;
      if (!hotActivationPendingRef.current) {
        needsFullActivationRefreshRef.current = true;
      }
      setWebglAllowed(false);
      disposeWebglRenderer('panel-hidden');
      return;
    }

    if (windowFocused) {
      setWebglAllowed(true);
      return;
    }

    setWebglAllowed(true);
    if (!useBatterySaverTerminalVisibility) return;

    // Battery saver retains the delayed resource-saving detach. Its visibility
    // gate and activation effect already arm full recovery, so do not mutate the
    // full/hot activation refs here.
    blurDetachTimerRef.current = setTimeout(() => {
      blurDetachTimerRef.current = null;
      setWebglAllowed(false);
      disposeWebglRenderer('app-blur-timeout');
    }, WEBGL_APP_BLUR_DETACH_DELAY_MS);

    return () => {
      if (blurDetachTimerRef.current) {
        clearTimeout(blurDetachTimerRef.current);
        blurDetachTimerRef.current = null;
      }
    };
  }, [panelVisible, windowFocused, useBatterySaverTerminalVisibility, disposeWebglRenderer]);

  useEffect(() => {
    if (!isInitialized || !xtermRef.current) return;
    if (!webglAllowed || !panelVisible) {
      disposeWebglRenderer(panelVisible ? 'webgl-not-allowed' : 'panel-hidden');
      return;
    }

    let disposed = false;
    // short-app-blur means the renderer attached while the window was blurred
    // (for example, mount or context-loss recovery), not that blur is time-limited.
    void loadWebglRenderer(xtermRef.current, () => disposed, windowFocused ? 'visible' : 'short-app-blur');
    return () => {
      disposed = true;
    };
  }, [webglAllowed, panelVisible, windowFocused, isInitialized, disposeWebglRenderer, loadWebglRenderer]);

  const handleClipboardError = useCallback(() => {
    console.error('[TerminalPanel] Failed to copy selection to clipboard');
    setToastMessage('Failed to copy terminal text');
  }, []);

  // Terminal link handling hook
  const {
    onMouseMove,
    tooltip,
    filePopover,
    selectionPopover,
    handleOpenInEditor,
    handleOpenInBrowser,
    handleShowInExplorer,
    closeFilePopover,
    closeSelectionPopover,
  } = useTerminalLinks(terminalInstance, {
    workingDirectory: workingDirectory || '',
    sessionId: sessionId || panel.sessionId,
  });

  // Terminal search hook
  const {
    isSearchOpen,
    searchQuery,
    searchStatus,
    searchInputRef,
    openSearch,
    closeSearch,
    onQueryChange,
    onStep,
  } = useTerminalSearch(xtermRef);

  const resizePtyToFit = useCallback(async (force = false): Promise<void> => {
    if (!fitAddonRef.current || !terminalRef.current) return;
    // Guard before fit(): the renderer grid is the damage point, not just the IPC.
    // Width only: wrap junk is a cols problem, and a stacked pane at Allotment's
    // 120px minSize minus tab-bar chrome leaves a legitimately <100px-tall container.
    const rect = terminalRef.current.getBoundingClientRect();
    if (rect.width < MIN_VIABLE_RECT_PX) return;
    const terminal = xtermRef.current;
    const prevCols = terminal?.cols;
    const prevRows = terminal?.rows;
    fitAddonRef.current.fit();
    const dimensions = fitAddonRef.current.proposeDimensions();
    if (
      !dimensions ||
      !Number.isInteger(dimensions.cols) || !Number.isInteger(dimensions.rows) ||
      dimensions.cols < MIN_PTY_COLS || dimensions.rows < MIN_PTY_ROWS
    ) {
      return;
    }

    // A dims change invalidates the renderer's cached rows; repaint the whole
    // grid so WebGL never shows cells from the previous geometry.
    if (terminal && (terminal.cols !== prevCols || terminal.rows !== prevRows) && terminal.rows > 0) {
      terminal.refresh(0, terminal.rows - 1);
    }

    // The renderer grid always stays at the fitted size. A forced redraw is a
    // main-side concern: main toggles the PTY through a one-row transition so
    // the foreground app receives a real SIGWINCH, and its intermediate frame
    // is overwritten by the final repaint. Doing the round trip here as well
    // used to stack up to four SIGWINCHes per activation.
    await window.electronAPI.invoke(
      'terminal:resize',
      panel.id,
      dimensions.cols,
      dimensions.rows,
      { force },
    );
  }, [panel.id]);

  // The terminal instance lives for the lifetime of a panel. Event handlers installed
  // during initialization read changing session/config values through this ref so those
  // changes do not tear down and recreate xterm or its PTY connection.
  const terminalRuntimeRef = useRef({
    handleClipboardError,
    highContrast,
    isRemoteMode,
    panelSessionId: panel.sessionId,
    resizePtyToFit,
    sessionId,
    workingDirectory,
  });
  useEffect(() => {
    terminalRuntimeRef.current = {
      handleClipboardError,
      highContrast,
      isRemoteMode,
      panelSessionId: panel.sessionId,
      resizePtyToFit,
      sessionId,
      workingDirectory,
    };
  }, [handleClipboardError, highContrast, isRemoteMode, panel.sessionId, resizePtyToFit, sessionId, workingDirectory]);

  // Full-depth refresh: normal buffers reset+replay main's rendered emulator
  // serialization at the settled width; alternate buffers preserve their live
  // model and end with a forced PTY resize so the fullscreen app redraws. The
  // normal-buffer path must NOT force a PTY resize: the serialized snapshot is
  // already the exact current screen, and a forced width transition makes
  // normal-buffer TUIs (Claude Code) re-render their transcript tail — when
  // that content overflows the viewport the re-render scrolls, appending a
  // duplicate copy to scrollback on every activation. Runs on initial
  // construction, remount/session switch, battery-saver activation, and manual
  // Refresh. Eligible same-session hot
  // activations use reconcileMountedTerminal instead and never enter this
  // function.
  const handleRefreshTerminal = useCallback(async () => {
    const terminal = xtermRef.current;
    if (!terminal) return;
    // Entry guard: never reset+replay into a tiny/unsettled container (width only,
    // matching resizePtyToFit: height-constrained panes are legitimate layouts)
    const rect = terminalRef.current?.getBoundingClientRect();
    if (!rect || rect.width < MIN_VIABLE_RECT_PX) return;
    try {
      const scrollSnapshot = (() => {
        const buffer = terminal.buffer.active;
        const distanceFromBottom = Math.max(0, buffer.baseY - buffer.viewportY);
        return {
          distanceFromBottom,
          wasNearBottom: isNearBottomRef.current || distanceFromBottom <= NEAR_BOTTOM_THRESHOLD_ROWS,
        };
      })();
      const restoreScrollPosition = () => {
        if (scrollSnapshot.wasNearBottom) {
          terminal.scrollToBottom();
          isNearBottomRef.current = true;
          setShowScrollDown(false);
          return;
        }

        const targetLine = Math.max(0, terminal.buffer.active.baseY - scrollSnapshot.distanceFromBottom);
        terminal.scrollToLine(targetLine);
        isNearBottomRef.current = false;
        setShowScrollDown(true);
      };

      // Fit BEFORE requesting state so the emulator serializes at the settled
      // width — resizing after getState would replay a stale-width snapshot,
      // and the normal-buffer path has no forced app redraw left to repair it.
      await resizePtyToFit();
      const state = await window.electronAPI.invoke('terminal:getState', panel.id);
      if (state?.isAlternateScreen) {
        // Renderer refresh alone cannot repair an application frame that was
        // restored before the visible grid settled. Ask main for a forced resize
        // (single PTY row nudge) so the foreground app receives a real resize
        // notification and repaints at the settled grid.
        await resizePtyToFit(true);
        if (terminal.rows > 0) {
          terminal.refresh(0, terminal.rows - 1);
        }
        restoreScrollPosition();
        return;
      }

      terminal.reset();
      const finishRefresh = async () => {
        restoreScrollPosition();
        // The old post-replay fit() invalidated WebGL via a dims change; after reordering
        // that fit is a same-size no-op, so an explicit refresh is needed for WebGL redraw
        if (terminal.rows > 0) terminal.refresh(0, terminal.rows - 1);
      };

      if (state?.scrollbackBuffer) {
        const content = Array.isArray(state.scrollbackBuffer)
          ? state.scrollbackBuffer.join('\n')
          : state.scrollbackBuffer;
        if (content) {
          await new Promise<void>((resolve, reject) => {
            terminal.write(content, () => {
              void finishRefresh().then(resolve, reject);
            });
          });
          return;
        }
      }
      await finishRefresh();
    } catch (e) {
      console.warn('[TerminalPanel] Failed to refresh terminal:', e);
    }
  }, [panel.id, resizePtyToFit]);

  const handleManualRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await handleRefreshTerminal();
      await waitForNextPaint();
      await new Promise(resolve => setTimeout(resolve, TERMINAL_ACTIVATION_MASK_AFTER_PAINT_MS));
    } finally {
      setIsRefreshing(false);
    }
  }, [handleRefreshTerminal]);

  // Light repaint for pure-refocus activations (buffer is live, only pixels are
  // stale). Pattern: the theme effect's guarded refresh minus its unconditional
  // scrollToBottom. Snapshot/restore scroll around the fit, mirroring
  // handleRefreshTerminal's alt-screen path: fit() is a no-op when dims are
  // unchanged, but a refocus coinciding with a window resize reflows the buffer
  // and would otherwise shift a scrolled-up shell.
  const reconcileMountedTerminal = useCallback(async (): Promise<void> => {
    const terminal = xtermRef.current;
    if (!terminal) return;
    const buffer = terminal.buffer.active;
    const distanceFromBottom = Math.max(0, buffer.baseY - buffer.viewportY);
    const wasNearBottom = isNearBottomRef.current || distanceFromBottom <= NEAR_BOTTOM_THRESHOLD_ROWS;

    await resizePtyToFit();
    if (terminal.rows > 0) terminal.refresh(0, terminal.rows - 1);

    if (wasNearBottom) {
      terminal.scrollToBottom();
      isNearBottomRef.current = true;
      setShowScrollDown(false);
    } else {
      terminal.scrollToLine(Math.max(0, terminal.buffer.active.baseY - distanceFromBottom));
      isNearBottomRef.current = false;
      setShowScrollDown(true);
    }
  }, [resizePtyToFit]);

  const repaintTerminal = useCallback(() => {
    void reconcileMountedTerminal();
  }, [reconcileMountedTerminal]);

  // Open search on Ctrl/Cmd+F from the container div
  const handleTerminalKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (shouldOpenTerminalSearch(e, keyboardShortcutsEnabled)) {
      e.preventDefault();
      openSearch();
    }
  }, [keyboardShortcutsEnabled, openSearch]);

  const getDropdownPosition = useCallback((): DropdownPosition => {
    const container = terminalRef.current;
    const terminal = xtermRef.current;
    if (!container) return { x: 0, y: 0 };
    const rect = container.getBoundingClientRect();

    // Position near the cursor row. The dropdown's viewport clamping will
    // flip it above the cursor line if there isn't enough room below.
    if (terminal) {
      const cursorY = terminal.buffer.active.cursorY;
      const totalRows = terminal.rows;
      // Approximate row height from container height
      const rowHeight = rect.height / totalRows;
      return {
        x: rect.left + 16,
        y: rect.top + cursorY * rowHeight,
      };
    }

    // Fallback: bottom of terminal
    return {
      x: rect.left + 16,
      y: rect.bottom - 40,
    };
  }, []);

  // Initialize terminal only once when component first mounts
  // Keep it alive even when switching sessions
  // The initializer guards every post-await state update with `disposed`; its returned
  // resource cleanup is awaited by the synchronous effect teardown. React Doctor's
  // nested-function scan cannot follow that deferred cleanup contract.
  // react-doctor-disable-next-line react-doctor/effect-needs-cleanup, react-doctor/no-set-state-after-await-in-effect
  useEffect(() => {
    devLog.debug('[TerminalPanel] Initialization useEffect running, terminalRef:', terminalRef.current);

    if (!terminalRef.current) {
      devLog.debug('[TerminalPanel] Missing terminal ref, skipping initialization');
      return;
    }

    let terminal: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let toastClearTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleToastClear = (delayMs: number) => {
      if (toastClearTimer) clearTimeout(toastClearTimer);
      toastClearTimer = setTimeout(() => {
        toastClearTimer = null;
        if (!disposed) setToastMessage(null);
      }, delayMs);
    };

    const initializeTerminal = async () => {
      try {
        devLog.debug('[TerminalPanel] Starting initialization for panel:', panel.id);

        // Check if already initialized on backend
        const initialized = await window.electronAPI.invoke('panels:checkInitialized', panel.id);
        devLog.debug('[TerminalPanel] Panel already initialized?', initialized);

        // Store terminal state for THIS panel only (not in global variable)
        let terminalStateForThisPanel: TerminalRestoreState | null = null;

        if (!initialized) {
          // Initialize backend PTY process
          devLog.debug('[TerminalPanel] Initializing backend PTY process...');
          // Use workingDirectory and sessionId if available, but don't require them
          // Use actual container dimensions for PTY spawn (falls back to 80x30 on backend)
          const containerRect = terminalRef.current?.getBoundingClientRect();
          const estimatedCols = containerRect ? Math.floor(containerRect.width / 8) : undefined; // rough char width estimate
          const estimatedRows = containerRect ? Math.floor(containerRect.height / 17) : undefined; // rough char height estimate
          await window.electronAPI.invoke('panels:initialize', panel.id, {
            cwd: terminalRuntimeRef.current.workingDirectory || process.cwd(),
            sessionId: terminalRuntimeRef.current.sessionId || terminalRuntimeRef.current.panelSessionId,
            cols: estimatedCols && estimatedCols >= 20 ? estimatedCols : undefined,
            rows: estimatedRows && estimatedRows >= 5 ? estimatedRows : undefined,
          });
          devLog.debug('[TerminalPanel] Backend PTY process initialized');
        } else {
          // Terminal is already initialized, get its state to restore scrollback
          devLog.debug('[TerminalPanel] Restoring terminal state from backend...');
          const terminalState = await window.electronAPI.invoke('terminal:getState', panel.id);
          if (terminalState && selectTerminalRestoreContent(terminalState)) {
            // We'll restore this to the terminal after it's created
            devLog.debug('[TerminalPanel] Found terminal restore state');
            // Store for restoration after terminal is created - LOCAL to this initialization
            terminalStateForThisPanel = terminalState;
          }
        }

        // FIX: Check if component was unmounted during async operation
        if (disposed) return;

        // Read terminal font config
        let terminalFontFamily = DEFAULT_TERMINAL_FONT_FAMILY;
        let terminalFontSize = DEFAULT_TERMINAL_FONT_SIZE;
        try {
          const configResult = await window.electronAPI.config.get();
          if (configResult?.data) {
            terminalFontFamily = configResult.data.terminalFontFamily || DEFAULT_TERMINAL_FONT_FAMILY;
            terminalFontSize = configResult.data.terminalFontSize || DEFAULT_TERMINAL_FONT_SIZE;
          }
        } catch {
          // Config read failed — use defaults
        }

        // FIX: Check if component was unmounted during async config read
        if (disposed) return;

        // Create XTerm instance
        devLog.debug('[TerminalPanel] Creating XTerm instance...');
        const initialFontFamily = buildTerminalFontFamily(terminalFontFamily);
        terminal = new Terminal({
          fontSize: terminalFontSize,
          fontFamily: initialFontFamily,
          theme: getTerminalTheme(),
          scrollback: 2500,
          cursorBlink: false,
          cursorStyle: 'block',
          cursorWidth: 1,
          cursorInactiveStyle: 'outline',
          allowTransparency: false,
          // Unlocks terminal.unicode, which the Unicode11Addon below needs.
          // Without it that addon throws on load and the terminal silently
          // falls back to Unicode 6 cell widths.
          allowProposedApi: true,
          // Honor ConPTY's CSI ? 9001 h request. In particular, Windows programs
          // launched through WSL need key records, not literal VT characters.
          vtExtensions: {
            kittyKeyboard: kittyKeyboardEnabledRef.current,
            win32InputMode: true,
          },
          scrollOnUserInput: true,
          scrollSensitivity: 1,
          altClickMovesCursor: true,
          drawBoldTextInBrightColors: true,
          rescaleOverlappingGlyphs: true,
          minimumContrastRatio: getMinimumContrastRatio(terminalRuntimeRef.current.highContrast),
          macOptionIsMeta: false,
          linkHandler: {
            activate: (_event, uri) => {
              void window.electronAPI.openExternal(uri).catch((error) => {
                console.error('[TerminalPanel] Failed to open terminal link:', error);
              });
            },
          },
        });
        setTerminalFontObservation(initialFontFamily);
        devLog.debug('[TerminalPanel] XTerm instance created:', !!terminal);

        fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        devLog.debug('[TerminalPanel] FitAddon loaded');

        // Intercept app-level shortcuts before xterm consumes them
        terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
          if (isTerminalCopyShortcut(e, isMac())) {
            if (e.type === 'keydown' && terminal?.hasSelection()) {
              void copyTerminalText(terminal.getSelection()).catch(() => {
                terminalRuntimeRef.current.handleClipboardError();
              });
            }
            return false;
          }

          if (!keyboardShortcutsEnabledRef.current) return !isHotkeyEnabledForEvent(e);

          const ctrlOrMeta = e.ctrlKey || e.metaKey;

          // Pane owns focused-surface scrolling before xterm encodes the key.
          // Managed CLI panels (Claude, Codex, Cursor, etc.) reserve the exact
          // Shift+Arrow chords for Pane; ordinary alternate-screen TUIs keep them.
          if (isFineSurfaceScrollKey(e) || isPageSurfaceScrollKey(e)) {
            if (terminalClaimsFineSurfaceScroll(e, {
              isCliPanel: isCliPanelRef.current,
              isTuiActive: tuiActiveRef.current,
            })) {
              // The application hotkey registry listens on window, so accepting
              // the key in xterm is not sufficient to keep it terminal-owned.
              e.stopPropagation();
              return true;
            }
            return !isHotkeyEnabledForEvent(e);
          }

          // Ctrl/Cmd+K: clear xterm scrollback without writing ^K to the PTY.
          if (ctrlOrMeta && e.key.toLowerCase() === 'k') {
            if (e.type === 'keydown') {
              xtermRef.current?.clear();
              window.electronAPI
                .invoke('terminal:clearScrollback', panel.id)
                .catch((error) => {
                  console.warn('[TerminalPanel] Failed to persist scrollback clear:', error);
                });
            }
            return false;
          }

          const terminalKeyDecision = resolveTerminalKeyHandling(e, {
            isTuiActive: tuiActiveRef.current,
            isCliPanel: isCliPanelRef.current,
            isMac: isMac(),
            keyboardShortcutsEnabled: keyboardShortcutsEnabledRef.current,
          });

          // Shift+Enter sends the same ESC+CR sequence as Alt+Enter for CLI
          // composers. In fullscreen agent TUIs this must run before generic
          // passthrough, while ordinary TUIs still receive Shift+Enter directly.
          if (terminalKeyDecision.action === 'send-input') {
            if (e.type === 'keydown') {
              window.electronAPI.invoke('terminal:input', panel.id, terminalKeyDecision.input);
            }
            return false;
          }
          if (terminalKeyDecision.action === 'block') return false;
          if (terminalKeyDecision.action === 'release-to-app') {
            return !isHotkeyEnabledForEvent(e);
          }
          if (terminalKeyDecision.action === 'pass-through') return true;

          // Ctrl/Cmd+1-9: switch sessions
          if (ctrlOrMeta && e.key >= '1' && e.key <= '9') return false;
          // Ctrl+Alt+1-9: switch panel tabs
          if (ctrlOrMeta && e.altKey && e.key >= '1' && e.key <= '9') return false;
          // Ctrl/Cmd+Alt+letter: terminal shortcuts — only release if a matching hotkey is registered
          // Use e.code instead of e.key because macOS Option key modifies e.key to special chars
          // (e.g. Option+A produces e.key='å' but e.code='KeyA')
          // Skip AltGr — on Windows/Linux international layouts AltGr sets both ctrlKey+altKey
          // but is used for character input (e.g. AltGr+Q = '@' on German keyboards)
          if (ctrlOrMeta && e.altKey && !e.getModifierState('AltGraph') && /^Key[A-Z]$/.test(e.code)) {
            const pressed = `mod+alt+${e.code.slice(3).toLowerCase()}`;
            const hotkeys = useHotkeyStore.getState().hotkeys;
            for (const def of hotkeys.values()) {
              if (def.keys === pressed) return false;
            }
          }
          // Ctrl/Cmd+Alt+/: open shortcut settings
          // Check e.code too: macOS Option modifies e.key (e.g. '/' becomes '÷')
          if (ctrlOrMeta && e.altKey && (e.key === '/' || (!e.getModifierState('AltGraph') && e.code === 'Slash'))) return false;
          // Ctrl/Cmd+W or Ctrl/Cmd+Q: close active tab
          if (ctrlOrMeta && (e.key.toLowerCase() === 'w' || e.key.toLowerCase() === 'q')) return false;
          // Ctrl/Cmd+T: open Add Tool dropdown
          if (ctrlOrMeta && e.key.toLowerCase() === 't') return false;
          // Ctrl/Cmd+P: prompt history; Ctrl/Cmd+Shift+P: command palette
          if (ctrlOrMeta && e.key.toLowerCase() === 'p') return false;
          // Ctrl/Cmd+N: new workspace
          if (ctrlOrMeta && e.key.toLowerCase() === 'n') return false;
          // Ctrl/Cmd+Shift+D: toggle diff
          if (ctrlOrMeta && e.shiftKey && e.key.toLowerCase() === 'd') return false;
          // Ctrl/Cmd+Shift+R: toggle run
          if (ctrlOrMeta && e.shiftKey && e.key.toLowerCase() === 'r') return false;
          // Git shortcuts - release to DOM for hotkeyStore
          if (ctrlOrMeta && e.shiftKey && e.key.toLowerCase() === 'm') return false;
          if (ctrlOrMeta && e.shiftKey && e.key.toLowerCase() === 'u') return false;
          if (ctrlOrMeta && e.shiftKey && e.key.toLowerCase() === 'l') return false;
          // Ctrl/Cmd+Shift+N: new project
          if (ctrlOrMeta && e.shiftKey && e.key.toLowerCase() === 'n') return false;

          // Session cycling - Tab
          if (ctrlOrMeta && e.key === 'Tab') return false;
          // Session cycling - Ctrl+Up/Down arrows
          if (ctrlOrMeta && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return false;
          // Tab cycling - Ctrl+A/D
          if (ctrlOrMeta && (e.key.toLowerCase() === 'a' || e.key.toLowerCase() === 'd')) return false;
          // Ctrl/Cmd+B: toggle sidebar
          if (ctrlOrMeta && e.key.toLowerCase() === 'b') return false;
          // Ctrl/Cmd+Shift+digit: panel tab switching (use e.code for layout independence)
          if (ctrlOrMeta && e.shiftKey && /^Digit[1-9]$/.test(e.code)) return false;
          // Ctrl/Cmd+Alt+digit: add tool shortcuts (skip AltGr — used for @/€ etc. on EU layouts)
          if (ctrlOrMeta && e.altKey && !e.getModifierState('AltGraph') && /^Digit[1-9]$/.test(e.code)) return false;
          // Ctrl/Cmd+`: toggle bottom terminal
          if (ctrlOrMeta && e.key === '`') return false;
          // Ctrl/Cmd+,: open settings
          if (ctrlOrMeta && e.key === ',') return false;
          // Ctrl/Cmd+Shift+E: focus sidebar
          if (ctrlOrMeta && e.shiftKey && e.key.toLowerCase() === 'e') return false;

          // Split tab groups: Mod+\ and Mod+Shift+\ (Ctrl+\ is SIGQUIT - must release!)
          // ISO/international keyboards report the key as IntlBackslash.
          // On macOS the app hotkey is Cmd+\, so only release metaKey there
          // and let Ctrl+\ keep delivering SIGQUIT to the PTY.
          if ((isMac() ? e.metaKey : e.ctrlKey) && (e.code === 'Backslash' || e.code === 'IntlBackslash')) return false;
          // Zoom toggle: Mod+Shift+Z
          if (ctrlOrMeta && e.shiftKey && e.key.toLowerCase() === 'z') return false;
          // Directional group focus: Mod+Alt+Arrows (all four directions)
          if (ctrlOrMeta && e.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return false;

          // Detect AltGr+key producing '@' (e.g. German AltGr+Q) — set flag so the
          // interceptor skips activation for this keystroke. AltGr sets both ctrlKey+altKey
          // on Windows/Linux, or e.getModifierState('AltGraph') on some platforms.
          if (e.key === '@' && (e.getModifierState('AltGraph') || (e.ctrlKey && e.altKey))) {
            skipNextInterceptRef.current = true;
          }

          // Right Alt: let OS/browser handle (e.g. voice transcription, IME)
          // Use e.code for physical key (e.key may report 'AltGraph' on some layouts)
          if (e.code === 'AltRight') return false;

          // Ctrl/Cmd+F: terminal search
          if (ctrlOrMeta && e.key.toLowerCase() === 'f') return false;

          // Ctrl/Cmd+V: stop xterm from sending raw \x16 to PTY
          // Returning false lets the browser trigger a native paste event instead,
          // which is handled by our paste event listener on the terminal container
          if (ctrlOrMeta && e.key.toLowerCase() === 'v') return false;

          return true; // Let terminal handle everything else
        });

        // FIX: Additional check before DOM manipulation
        if (terminalRef.current && !disposed) {
          devLog.debug('[TerminalPanel] Opening terminal in DOM element:', terminalRef.current);
          terminal.open(terminalRef.current);
          devLog.debug('[TerminalPanel] Terminal opened in DOM');

          // Wait for fonts to load before fitting so xterm measures correct cell dimensions
          await Promise.all([
            document.fonts.load(`${terminalFontSize}px "${terminalFontFamily}"`).catch(() => {}),
            document.fonts.load(`${terminalFontSize}px "Symbols Nerd Font Mono"`).catch(() => {}),
          ]);
          // Never fit against a hidden/mid-layout container (display:none keep-alive
          // tabs measure 0×0): FitAddon resizes the grid with no floor, and background
          // PTY output then parses into a garbage-width buffer that reflow can't fix.
          // Keeping xterm's default grid matches the PTY's default cols; the one-time
          // full activation refresh rebuilds anything that still parsed mismatched.
          if ((terminalRef.current?.getBoundingClientRect().width ?? 0) >= MIN_VIABLE_RECT_PX) {
            fitAddon.fit();
            devLog.debug('[TerminalPanel] FitAddon fitted');
          } else {
            needsFullActivationRefreshRef.current = true;
            devLog.debug('[TerminalPanel] Skipped mount fit (hidden container); armed full activation refresh');
          }
          terminal.options.theme = getTerminalTheme();

          // Load WebLinksAddon for clickable URLs
          try {
            const { WebLinksAddon: WebLinksAddonImpl } = await import('@xterm/addon-web-links');
            if (!disposed) {
              const isMac = navigator.platform.toUpperCase().includes('MAC');
              const webLinksAddon = new WebLinksAddonImpl((event, uri) => {
                // Only open link if Ctrl (Windows/Linux) or Cmd (Mac) is held
                if (isMac ? event.metaKey : event.ctrlKey) {
                  window.electronAPI.openExternal(uri);
                }
              });
              terminal.loadAddon(webLinksAddon);
              webLinksAddonRef.current = webLinksAddon;
              devLog.debug('[TerminalPanel] WebLinksAddon loaded for panel', panel.id);
            }
          } catch (e) {
            console.warn('[TerminalPanel] WebLinksAddon failed to load for panel', panel.id, ':', e);
            webLinksAddonRef.current = null;
          }

          // Load SerializeAddon for terminal snapshot persistence
          try {
            const { SerializeAddon: SerializeAddonImpl } = await import('@xterm/addon-serialize');
            if (!disposed) {
              const serializeAddon = new SerializeAddonImpl();
              terminal.loadAddon(serializeAddon);
              serializeAddonRef.current = serializeAddon;
              devLog.debug('[TerminalPanel] SerializeAddon loaded for panel', panel.id);
            }
          } catch (e) {
            console.warn('[TerminalPanel] SerializeAddon failed to load for panel', panel.id, ':', e);
            serializeAddonRef.current = null;
          }

          // Load Unicode11Addon for better emoji/unicode width calculation
          try {
            const { Unicode11Addon: Unicode11AddonImpl } = await import('@xterm/addon-unicode11');
            if (!disposed) {
              const unicode11Addon = new Unicode11AddonImpl();
              terminal.loadAddon(unicode11Addon);
              terminal.unicode.activeVersion = '11';
              unicode11AddonRef.current = unicode11Addon;
              devLog.debug('[TerminalPanel] Unicode11Addon loaded for panel', panel.id);
            }
          } catch (e) {
            console.warn('[TerminalPanel] Unicode11Addon failed to load for panel', panel.id, ':', e);
            unicode11AddonRef.current = null;
          }

          // Load ImageAddon so image-emitting tools render inline instead of
          // printing nothing. Protocols and limits live in TERMINAL_IMAGE_OPTIONS.
          try {
            const { ImageAddon: ImageAddonImpl } = await import('@xterm/addon-image');
            if (!disposed) {
              const imageAddon = new ImageAddonImpl(TERMINAL_IMAGE_ADDON_OPTIONS);
              terminal.loadAddon(imageAddon);
              imageAddonRef.current = imageAddon;
              devLog.debug('[TerminalPanel] ImageAddon loaded for panel', panel.id);
            }
          } catch (e) {
            console.warn('[TerminalPanel] ImageAddon failed to load for panel', panel.id, ':', e);
            imageAddonRef.current = null;
          }

          if (disposed) {
            terminal.dispose();
            fitAddon.dispose();
            return;
          }
          xtermRef.current = terminal;
          setTerminalInstance(terminal);
          fitAddonRef.current = fitAddon;

          // Track scroll position with direction-based sticky behaviour.
          // Also snap to true bottom when the user scrolls close enough — xterm's mouse
          // wheel sometimes stops 1-2 lines short of baseY, leaving the prompt just
          // out of view. Snapping within a small threshold fixes the "can't reach input" feel.
          const terminalInstance = terminal;
          const SNAP_THRESHOLD = NEAR_BOTTOM_THRESHOLD_ROWS; // lines — for the "can't reach input" snap fix
          let prevDistFromBottom = 0;
          const scrollDisposable = terminalInstance.onScroll(() => {
            const buf = terminalInstance.buffer.active;
            const dist = buf.baseY - buf.viewportY;

            if (dist === 0) {
              // User is at the very bottom — enable sticky
              isNearBottomRef.current = true;
              setShowScrollDown(false);
            } else if (dist > prevDistFromBottom) {
              // User scrolled UP — they want to read history, disable sticky
              isNearBottomRef.current = false;
              setShowScrollDown(true);
            }
            // If scrolling down but not at bottom yet, leave sticky as-is
            // Note: programmatic writes may shift baseY and fire onScroll with changed dist.
            // The direction heuristic is not perfect for those events, but is correct
            // for the primary case (user mouse-wheel / trackpad scrolls).

            prevDistFromBottom = dist;

            // Snap: if user scrolled to within a few lines of bottom, go all the way
            // (fixes mouse wheel stopping 1-2 lines short of actual bottom)
            // Only snap if sticky is already engaged — don't re-engage for a user
            // who scrolled up and is scrolling back down manually.
            if (isNearBottomRef.current && dist > 0 && dist <= SNAP_THRESHOLD) {
              terminalInstance.scrollToBottom();
            }
          });

          // Ack batching for flow control
          const ACK_BATCH_SIZE = 5_000; // 5KB - aligned with main LOW_WATERMARK per VS Code FlowControlConstants
          const ACK_BATCH_INTERVAL = 100; // ms
          let pendingAckBytes = 0;
          let ackFlushTimer: ReturnType<typeof setTimeout> | null = null;

          const flushAck = () => {
            if (ackFlushTimer) {
              clearTimeout(ackFlushTimer);
              ackFlushTimer = null;
            }
            if (pendingAckBytes > 0) {
              const bytes = pendingAckBytes;
              pendingAckBytes = 0;
              // Under the ptyHost flag, ack over the per-window MessagePort so it
              // bypasses the main IPC invoke queue. Flag-off keeps the legacy
              // IPC path. `currentPtyIdRef` is a ref because the ptyId can change
              // across auto-reattach after a supervisor restart.
              const activePtyId = currentPtyIdRef.current;
              if (activePtyId) {
                window.electronAPI.ptyHost.ack(activePtyId, bytes);
              } else {
                window.electronAPI.invoke('terminal:ack', panel.id, bytes);
              }
            }
          };

          // Snapshot persistence: see the active-to-inactive effect below and
          // the dispose-time snapshot in this effect's cleanup. The previous
          // 30 s interval was removed to stop hidden panels from doing a full
          // buffer walk + IPC payload once per half-minute for no visible gain.

          // Restore the active buffer for this panel. Full-screen TUIs render in
          // xterm's alternate buffer, so normal shell scrollback is not a valid
          // representation while alternate-screen mode is active.
          if (terminalStateForThisPanel) {
            const restore = selectTerminalRestoreContent(terminalStateForThisPanel);
            if (restore) {
              devLog.debug('[TerminalPanel] Restoring', restore.content.length, 'chars from', restore.source);
              terminal.write(restore.content);
            }
            // Force WebGL renderer to redraw after buffer content changes.
            // Without this, macOS WebGL canvas shows stale/stuttered content until
            // a resize event (minimize/fullscreen) forces invalidation.
            // Same hidden-container guard as the mount fit: WebGL isn't attached
            // while hidden, and a 0-width fit would mangle the grid.
            if ((terminalRef.current?.getBoundingClientRect().width ?? 0) >= MIN_VIABLE_RECT_PX) {
              fitAddon.fit();
            }
          }

          // Handle paste events (Ctrl+V, voice transcription, external text injection)
          // Attached on the container in CAPTURE phase so we fire BEFORE xterm's textarea
          // handler. This is required for correct image paste in packaged builds: when
          // pasting a screenshot on Windows the clipboard contains both the image bitmap
          // AND a text/plain representation (e.g. "[Image]"). If xterm's handler fires
          // first it pastes that text before we can intercept, and our old `!text` fallback
          // condition was then false — so the Electron clipboard IPC was never called and
          // no image path was pasted.
          //
          // Strategy:
          //   1. Check browser clipboardData.items for an image (fast path, works on
          //      native Windows/macOS when Chromium exposes the bitmap).
          //   2. If not found, always try terminal:clipboard-paste-image (Electron's native
          //      clipboard API, works for WSL screenshots and any case where Chromium
          //      doesn't expose the image in items).  We capture the text from clipboardData
          //      first so we can forward it manually if the Electron check finds no image.
          //   3. If Electron clipboard has no image either, call terminal.paste(text) to
          //      forward the text content — this replaces the xterm handler we blocked.
          // Paste handler: we always paste the raw file path (no "[Image] " prefix).
          // Claude Code CLI's paste parser auto-detects bare image file paths and
          // attaches them as [Image #N] in the next API message on every platform.
          // The "[Image] " prefix we used to add actually broke the parser's
          // path-detection — on Windows+WSL it caused Claude to cache the file but
          // never attach it to the API call (see commit 7b76ee5).
          const pasteText = (text: string) => {
            if (!terminal) return;
            const shouldProtectMultilinePaste = isCliPanelRef.current && !tuiActiveRef.current && /[\r\n]/.test(text);
            if (shouldProtectMultilinePaste) {
              window.electronAPI.invoke(
                'terminal:input',
                panel.id,
                text.replace(/\r\n|\r|\n/g, '\x1b\r'),
              );
              return;
            }

            terminal.paste(text);
          };

          const handlePaste = (e: ClipboardEvent) => {
            // Step 1: Check for images in browser clipboard (works on native Windows/macOS)
            const items = e.clipboardData?.items;
            const textVal = e.clipboardData?.getData('text') ?? '';
            if (items) {
              for (let i = 0; i < items.length; i++) {
                if (items[i].type.startsWith('image/')) {
                  e.stopPropagation();
                  e.preventDefault();
                  const file = items[i].getAsFile();
                  if (!file) return;

                  if (file.size > 50 * 1024 * 1024) {
                    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
                    if (terminal && !disposed) {
                      terminal.paste(`[Image paste failed] File too large (${sizeMB} MB), max 50 MB\n`);
                    }
                    return;
                  }

                  const reader = new FileReader();
                  reader.onload = async (ev) => {
                    if (disposed || !terminal) return;
                    // SAFETY: readAsDataURL completes with a string result before onload fires.
                    const dataUrl = ev.target?.result as string;
                    if (!dataUrl) return;

                    try {
                      const result = decodeOptionalBoundary(await window.electronAPI.invoke(
                        'terminal:paste-image',
                        panel.id,
                        terminalRuntimeRef.current.sessionId || terminalRuntimeRef.current.panelSessionId,
                        dataUrl,
                        file.type
                      ), terminalPasteImageResultSchema);
                      if (result?.filePath && !disposed && terminal) {
                        terminal.paste(`${result.filePath}\n`);
                      }
                    } catch (err) {
                      console.error('[TerminalPanel] Failed to paste image:', err);
                    }
                  };
                  reader.readAsDataURL(file);
                  return;
                }
              }
            }

            // Step 2: No image in browser clipboard. Capture text now (before any
            // preventDefault clears it), block xterm, then check the Electron clipboard.
            // We always check regardless of whether text is present — the old `!text`
            // guard caused silent failures when Windows put "[Image]" in text/plain
            // alongside the actual bitmap (making text non-empty, skipping the fallback).
            const text = textVal;
            e.stopPropagation();
            e.preventDefault();

            if (terminalRuntimeRef.current.isRemoteMode) {
              if (text && !isClipboardImagePlaceholderText(text) && !disposed && terminal) {
                terminal.paste(text);
              } else {
                setToastMessage('Native image clipboard paste is unavailable in remote mode. Use drag and drop or browser image paste instead.');
                scheduleToastClear(2500);
              }
              return;
            }

            (async () => {
              if (disposed || !terminal) return;
              try {
                const result = decodeOptionalBoundary(await window.electronAPI.invoke(
                  'terminal:clipboard-paste-image',
                  terminalRuntimeRef.current.sessionId || terminalRuntimeRef.current.panelSessionId
                ), terminalPasteImageResultSchema);
                if (result?.filePath && !disposed && terminal) {
                  terminal.paste(`${result.filePath}\n`);
                  return;
                }
              } catch (err) {
                console.error('[TerminalPanel] Clipboard fallback failed:', err);
              }

              // No image found — forward the text content xterm would have pasted.
              if (text && !disposed && terminal) {
                pasteText(text);
              }
            })();
          };
          // Attach on the container in CAPTURE phase — fires before xterm's textarea
          // listener so we control whether an image or text is pasted.
          terminalRef.current.addEventListener('paste', handlePaste, { capture: true });

          // Handle drag-and-drop of files onto the terminal.
          //
          // Quirk: the old code only preventDefault'd when dataTransfer.types
          // contained exactly 'Files'. Chromium restricts access to types during
          // dragover on some platforms/versions, so that check could silently fail
          // mid-drag and the subsequent drop event would never reach us. We always
          // preventDefault on dragover now — harmless if the drop isn't a file,
          // and critical for letting the drop event fire when it is.
          const handleDragOver = (e: DragEvent) => {
            if (!e.dataTransfer) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          };
          const handleDrop = (e: DragEvent) => {
            e.preventDefault();
            if (!e.dataTransfer?.files.length || disposed || !terminal) return;

            // Save all dropped files to disk and paste the resolved path
            const files = Array.from(e.dataTransfer.files);
            (async () => {
              for (const file of files) {
                if (file.size > 50 * 1024 * 1024) {
                  const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
                  if (!disposed && terminal) {
                    terminal.paste(`[Drop failed] File too large (${sizeMB} MB), max 50 MB\n`);
                  }
                  continue;
                }
                const dataUrl = await new Promise<string | null>((resolve) => {
                  const reader = new FileReader();
                  reader.onload = (ev) => {
                    // SAFETY: readAsDataURL completes with a string result before onload fires.
                    resolve(ev.target?.result as string ?? null);
                  };
                  reader.onerror = () => resolve(null);
                  reader.readAsDataURL(file);
                });
                if (!dataUrl || disposed || !terminal) continue;
                try {
                  const isImage = file.type.startsWith('image/');
                  let resolvedPath: string | null = null;

                  if (isImage) {
                    const result = decodeOptionalBoundary(await window.electronAPI.invoke(
                      'terminal:paste-image',
                      panel.id,
                      terminalRuntimeRef.current.sessionId || terminalRuntimeRef.current.panelSessionId,
                      dataUrl,
                      file.type
                    ), terminalPasteImageResultSchema);
                    resolvedPath = result?.filePath ?? null;
                  } else {
                    const result = decodeOptionalBoundary(await window.electronAPI.invoke(
                      'terminal:paste-file',
                      terminalRuntimeRef.current.sessionId || terminalRuntimeRef.current.panelSessionId,
                      dataUrl,
                      file.name
                    ), terminalPasteFileResultSchema);
                    resolvedPath = result?.filePath ?? null;
                  }

                  if (resolvedPath && !disposed && terminal) {
                    // See paste-handler comment above: paste the raw path, Claude's
                    // parser detects image file paths and auto-attaches them.
                    terminal.paste(`${resolvedPath}\n`);
                  }
                } catch (err) {
                  console.error('[TerminalPanel] Failed to drop file:', err);
                  if (!disposed && terminal) {
                    // Strip Electron's IPC wrapper so the user sees the backend reason
                    const raw = err instanceof Error ? err.message : String(err);
                    const reason = raw.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
                    terminal.paste(`[Drop failed] ${reason || 'Unknown error'}\n`);
                  }
                }
              }
            })();
          };
          terminalRef.current.addEventListener('dragover', handleDragOver);
          terminalRef.current.addEventListener('drop', handleDrop);

          // Let the WebGL renderer finish painting before removing the loader overlay.
          // Without this, the loader disappears and the user briefly sees stale/blank
          // content before the fit() render completes (visible as a stutter on macOS).
          await waitForNextPaint();
          if (disposed) return;
          hotActivationEligibleRef.current = false;
          hotActivationPendingRef.current = false;
          setIsInitialized(true);
          devLog.debug('[TerminalPanel] Terminal initialization complete, isInitialized set to true');

          // Core write-and-ack: consume a raw output chunk for this panel.
          const writeAndAck = (output: string) => {
            if (!terminal || disposed) return;
            const outputLength = output.length;
            terminal.write(output, () => {
              if (disposed) return;
              markPanelOutput(panel.id);
              // Ack AFTER xterm has rendered the data — proper backpressure
              pendingAckBytes += outputLength;
              if (pendingAckBytes >= ACK_BATCH_SIZE) {
                flushAck();
              } else if (!ackFlushTimer) {
                ackFlushTimer = setTimeout(flushAck, ACK_BATCH_INTERVAL);
              }
              // Read scroll position LIVE after render, not before write —
              // avoids stale shouldSnap=true yanking user back to bottom
              if (isNearBottomRef.current && terminal) {
                terminal.scrollToBottom();
              }
            });
          };

          // `terminal:output` is the single byte source for every panel,
          // ptyHost or not.
          const outputHandler = (data: import('../../../../shared/types/panels').TerminalOutputEvent) => {
            if ('panelId' in data && data.panelId === panel.id) {
              writeAndAck(data.output);
            }
            // Ignore session terminal output, which has no panelId.
          };
          const unsubscribeOutput = window.electronAPI.events.onTerminalOutput(outputHandler);
          devLog.debug('[TerminalPanel] Subscribed to terminal output events for panel:', panel.id);

          // Detect full-screen TUI apps (vim, htop, etc.) via alternate screen buffer.
          // This is universal — all well-behaved TUI apps enter alternate screen via
          // \x1b[?1049h and leave via \x1b[?1049l. No hardcoded app list needed.
          const unsubscribeAltScreen = window.electronAPI.events.onTerminalAlternateScreen((data: { panelId: string; active: boolean }) => {
            if (data.panelId === panel.id) {
              tuiActiveRef.current = data.active;
            }
          });

          // Initialize TUI mode for already-running programs (e.g. vim was
          // left open and the panel remounted).
          window.electronAPI.invoke('terminal:getAltScreenState', panel.id)
            .then((info: { isAlternateScreen: boolean } | null) => {
              if (disposed || !info) return;
              tuiActiveRef.current = info.isAlternateScreen;
            })
            .catch(() => { /* terminal may not exist yet — ignore */ });

          // Handle terminal process exit
          const unsubscribeExited = window.electronAPI.events.onTerminalExited((data: { sessionId: string; panelId: string; exitCode: number; signal: number | null }) => {
            if (data.panelId === panel.id) {
              // Reset TUI passthrough so Pane shortcuts work again on the dead terminal
              tuiActiveRef.current = false;
              if (terminal && !disposed) {
                // Detect crash signals: SIGABRT(6), SIGBUS(7), SIGSEGV(11)
                const crashSignals = new Map([[6, 'SIGABRT'], [7, 'SIGBUS'], [11, 'SIGSEGV']]);
                const crashSignalName = data.signal ? crashSignals.get(data.signal) : null;

                if (crashSignalName) {
                  terminal.write(`\r\n\x1b[91m[Process crashed: ${crashSignalName}]\x1b[0m\r\n`);
                  terminal.write(`\x1b[33m  Your system may be under memory pressure — check RAM usage.\x1b[0m\r\n`);
                } else {
                  terminal.write(`\r\n\x1b[90m[Process exited with code ${data.exitCode}]\x1b[0m\r\n`);
                }
              }
            }
          });

          // Subscribe to live terminal font updates from Settings
          const unsubscribeFontUpdate = window.electronAPI.events.onTerminalFontUpdated((data: { terminalFontFamily: string; terminalFontSize: number }) => {
            if (!terminal || disposed) return;
            const userFont = data.terminalFontFamily || DEFAULT_TERMINAL_FONT_FAMILY;
            const newFontFamily = buildTerminalFontFamily(userFont);
            const newFontSize = data.terminalFontSize || DEFAULT_TERMINAL_FONT_SIZE;
            if (terminal.options.fontFamily !== newFontFamily || terminal.options.fontSize !== newFontSize) {
              // Wait for the new font to load before applying, so xterm measures correct cell dimensions
              Promise.all([
                document.fonts.load(`${newFontSize}px "${userFont}"`).catch(() => {}),
                document.fonts.load(`${newFontSize}px "Symbols Nerd Font Mono"`).catch(() => {}),
              ]).then(() => {
                if (!terminal || disposed) return;
                terminal.options.fontFamily = newFontFamily;
                setTerminalFontObservation(newFontFamily);
                terminal.options.fontSize = newFontSize;
                // Hidden-container guard (see mount fit): defer to the activation fit
                if (fitAddon && (terminalRef.current?.getBoundingClientRect().width ?? 0) >= MIN_VIABLE_RECT_PX) {
                  fitAddon.fit();
                }
              });
            }
          });

          // Create interceptor for @ mentions and future trigger handlers
          const interceptor = new TerminalInterceptor({
            onStateChange: (state) => setInterceptorState(state.active ? state : null),
            onFlush: (data) => window.electronAPI.invoke('terminal:input', panel.id, data),
          });
          interceptorRef.current = interceptor;

          // Register @ handler for terminal scrollback copy
          const effectiveSessionId = terminalRuntimeRef.current.sessionId || terminalRuntimeRef.current.panelSessionId;

          const getTerminals = async (): Promise<TerminalSuggestion[]> => {
            const allPanels = usePanelStore.getState().getSessionPanels(effectiveSessionId);
            const terminalPanels = allPanels.filter(p => p.type === 'terminal' && p.id !== panel.id);
            const suggestions = await Promise.all(terminalPanels.map(async (p) => {
              const resp = await window.electronAPI.invoke('terminal:getScrollbackClean', p.id, 20);
              let preview: string[] = ['(no output)'];
              if (resp?.success && resp.data?.content) {
                // Clean preview: filter blank lines, trim whitespace, take last 3
                preview = resp.data.content
                  .split('\n')
                  .map((l: string) => l.trim())
                  .filter((l: string) => l.length > 0)
                  .slice(-3);
                if (preview.length === 0) preview = ['(no output)'];
              }
              return { panelId: p.id, title: p.title, preview };
            }));
            return suggestions;
          };

          const handleCopy = async (targetPanelId: string, lines: number, mode: 'raw' | 'embed') => {
            try {
              if (mode === 'embed') {
                // Embed mode: save to file, insert path reference
                const response = await window.electronAPI.invoke(
                  'terminal:save-scrollback',
                  targetPanelId,
                  effectiveSessionId,
                  lines,
                );
                if (response?.success && response.data && terminal && !disposed) {
                  terminal.paste(response.data.filePath);
                  setToastMessage(`Embedded ${response.data.lineCount} lines from ${response.data.panelTitle}`);
                } else {
                  setToastMessage('Failed — no scrollback available');
                }
              } else {
                // Raw mode: paste clean text directly into terminal
                const response = await window.electronAPI.invoke(
                  'terminal:getScrollbackClean',
                  targetPanelId,
                  lines,
                );
                if (response?.success && response.data && terminal && !disposed) {
                  terminal.paste(response.data.content);
                  setToastMessage(`Pasted ${response.data.lineCount} lines from ${response.data.panelTitle}`);
                } else {
                  setToastMessage('Failed — no scrollback available');
                }
              }
            } catch {
              setToastMessage('Failed to paste scrollback');
            }
            scheduleToastClear(2000);
          };

          interceptor.registerHandler('@', createAtTerminalHandler({
            sessionId: effectiveSessionId,
            currentPanelId: panel.id,
            getTerminals,
            hasOtherTerminals: () => {
              const allPanels = usePanelStore.getState().getSessionPanels(effectiveSessionId);
              return allPanels.filter(p => p.type === 'terminal' && p.id !== panel.id).length > 0;
            },
            onCopy: handleCopy,
            onStateChange: () => interceptor.notifyStateChange(),
            onForceCancel: () => interceptor.forceCancel(),
            getPreference: async (key: string) => {
              const resp = await window.electronAPI.invoke('preferences:get', key);
              return resp?.success
                ? decodeOptionalBoundary(resp.data, boundary.nullable(boundary.string)) ?? null
                : null;
            },
            setPreference: (key: string, value: string) => {
              window.electronAPI.invoke('preferences:set', key, value);
            },
          }));

          // Handle terminal input — route through interceptor first
          const inputDisposable = terminal.onData((data) => {
            if (data === '\r' && isCliPanelRef.current) startSendPrompt(panel.id);
            // Skip interception for AltGr-produced @ (e.g. German keyboard)
            if (skipNextInterceptRef.current) {
              skipNextInterceptRef.current = false;
              window.electronAPI.invoke('terminal:input', panel.id, data);
              return;
            }
            const result = interceptor.handleInput(data);
            if (!result.consumed) {
              window.electronAPI.invoke('terminal:input', panel.id, data);
            }
          });

          // Handle resize — delegates to the guarded resizePtyToFit (single resize path)
          // Debounce so fit() only fires after transitions settle (300ms sidebar animations)
          let resizeTimer: ReturnType<typeof setTimeout> | null = null;
          const debouncedResize = () => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
              if (!disposed) void terminalRuntimeRef.current.resizePtyToFit();
            }, 150);
          };

          resizeObserver = new ResizeObserver(() => {
            if (isActiveRef.current) {  // Only resize when panel is active
              debouncedResize();
            }
          });

          resizeObserver.observe(terminalRef.current);

          // FIX: Return comprehensive cleanup function
          const terminalElement = terminalRef.current;
          return () => {
            disposed = true;
            interceptor.dispose();
            interceptorRef.current = null;
            flushAck();
            if (ackFlushTimer) clearTimeout(ackFlushTimer);
            resizeObserver?.disconnect();
            resizeObserver = null;
            if (resizeTimer) clearTimeout(resizeTimer);
            unsubscribeOutput();
            unsubscribeAltScreen();
            unsubscribeExited();
            unsubscribeFontUpdate();
            inputDisposable.dispose();
            scrollDisposable.dispose();
            terminalElement?.removeEventListener('paste', handlePaste, { capture: true });
            terminalElement?.removeEventListener('dragover', handleDragOver);
            terminalElement?.removeEventListener('drop', handleDrop);
          };
        }
      } catch (error) {
        console.error('Failed to initialize terminal:', error);
        if (!disposed) {
          setInitError(error instanceof Error ? error.message : 'Unknown error');
        }
      }
    };

    const cleanupPromise = initializeTerminal();

    // Only dispose when component is actually unmounting (panel deleted)
    // Not when just switching tabs
    return () => {
      disposed = true;
      if (toastClearTimer) clearTimeout(toastClearTimer);
      resizeObserver?.disconnect();
      resizeObserver = null;
      hotActivationEligibleRef.current = false;
      hotActivationPendingRef.current = false;

      // Synchronously push hidden cadence so backgrounded-session unmount
      // and unmount-during-init both reliably reach main. The inner cleanup
      // below is deferred via cleanupPromise.then(...) and may never run if
      // unmount happens before init resolves.
      window.electronAPI.invoke('terminal:setVisibility', panel.id, false, TERMINAL_VISIBILITY_VIEWER_ID);

      // Clean up async initialization
      cleanupPromise.then(cleanupFn => cleanupFn?.());

      // Dispose WebGL addon
      if (webglAddonRef.current) {
        try { webglAddonRef.current.dispose(); } catch { /* ignore */ }
        webglAddonRef.current = null;
      }

      // Dispose WebLinks addon
      if (webLinksAddonRef.current) {
        try { webLinksAddonRef.current.dispose(); } catch { /* ignore */ }
        webLinksAddonRef.current = null;
      }

      // Save serialized terminal snapshot before disposing
      if (serializeAddonRef.current && xtermRef.current) {
        try {
          const serialized = serializeAddonRef.current.serialize();
          window.electronAPI.invoke('terminal:saveSnapshot', panel.id, serialized);
        } catch (e) {
          console.warn('[TerminalPanel] Failed to save serialized snapshot:', e);
        }
      }

      // Dispose SerializeAddon
      if (serializeAddonRef.current) {
        try { serializeAddonRef.current.dispose(); } catch { /* ignore */ }
        serializeAddonRef.current = null;
      }

      // Dispose ImageAddon
      if (imageAddonRef.current) {
        try { imageAddonRef.current.dispose(); } catch { /* ignore */ }
        imageAddonRef.current = null;
      }

      // Dispose Unicode11Addon
      if (unicode11AddonRef.current) {
        try { unicode11AddonRef.current.dispose(); } catch { /* ignore */ }
        unicode11AddonRef.current = null;
      }

      // Dispose XTerm instance only on final unmount
      if (xtermRef.current) {
        const terminalToDispose = xtermRef.current;
        try {
          devLog.debug('[TerminalPanel] Disposing terminal for panel:', panel.id);
          terminalToDispose.dispose();
        } catch (e) {
          console.warn('Error disposing terminal:', e);
        }
        xtermRef.current = null;
        setTerminalInstance((current) => current === terminalToDispose ? null : current);
      }
      
      if (fitAddonRef.current) {
        try {
          fitAddonRef.current.dispose();
        } catch (e) {
          console.warn('Error disposing fit addon:', e);
        }
        fitAddonRef.current = null;
      }
      
      setIsInitialized(false);
    };
  }, [panel.id]); // Only depend on panel.id to prevent re-initialization on session switch

  // Shared activation refresh for both power modes: fires on tab activation and
  // window refocus (activationVisible = panelVisible && windowFocused). Initial,
  // remounted, output-gated, and recovery activations stay on full reset+replay.
  // A same-session activation can use masked fit/reconcile/refresh only when this
  // exact mounted xterm previously completed the full path and output remained
  // ungated. Performance-mode refocus of any duration stays a silent repaint.
  // Declared after WebGL policy effects so the delayed backstop covers attach races.
  useLayoutEffect(() => {
    if (!isInitialized || !fitAddonRef.current || !xtermRef.current) return;
    if (!activationVisible) {
      // Battery saver gates output, so refocus must rebuild from main. Panel
      // hides may retain a hot-path candidate captured by the WebGL policy effect
      // when this exact xterm stayed live.
      if (useBatterySaverTerminalVisibility) {
        needsFullActivationRefreshRef.current = true;
        hotActivationEligibleRef.current = false;
        hotActivationPendingRef.current = false;
      }
      return;
    }

    // A hot activation is narrowly limited to panel hide/show in performance
    // mode after this mounted xterm previously completed a full refresh. Initial
    // construction, remounts, output gating, and recovery paths remain full.
    const hotActivation = !useBatterySaverTerminalVisibility
      && hotActivationPendingRef.current
      && hotActivationEligibleRef.current;
    hotActivationPendingRef.current = false;
    const fullRefresh = !hotActivation && (useBatterySaverTerminalVisibility || needsFullActivationRefreshRef.current);

    // Both full and hot panel activations stay behind the existing opaque mask.
    if (fullRefresh || hotActivation) setIsRefreshing(true);

    let lastWidth = 0;
    let retries = 0;
    const MAX_RETRIES = 10;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let delayedRefreshTimer: ReturnType<typeof setTimeout> | null = null;
    let hideOverlayTimer: ReturnType<typeof setTimeout> | null = null;

    const fitAndRefresh = () => {
      if (cancelled || !fitAddonRef.current || !xtermRef.current || !terminalRef.current) return;

      const containerWidth = terminalRef.current.clientWidth;
      // If width is still changing or below viable threshold, the reflow isn't done — retry
      if ((containerWidth < MIN_VIABLE_RECT_PX || containerWidth !== lastWidth) && retries < MAX_RETRIES) {
        lastWidth = containerWidth;
        retries++;
        retryTimer = setTimeout(fitAndRefresh, 50);
        return;
      }

      // Never settled at a viable size — bail; the ResizeObserver finishes the job
      // once layout settles. Leave the ref armed so the next activation retries full.
      if (containerWidth < MIN_VIABLE_RECT_PX) {
        forwardToMainLog('warn', `[TerminalPanel] Activation refresh bailed for panel ${panel.id}: container ${containerWidth}px`);
        setIsRefreshing(false);
        if (autoFocus && fullRefresh) xtermRef.current?.focus();
        return;
      }

      void document.fonts.ready.then(async () => {
        if (cancelled || !fitAddonRef.current || !xtermRef.current) return;

        const depth = fullRefresh ? 'full' : hotActivation ? 'hot' : 'light';
        forwardToMainLog('info', `[TerminalPanel] Activation depth for panel ${panel.id}: ${depth}`);

        if (fullRefresh) {
          // Consume the flag only when the full refresh actually executes, so a
          // bail or an activate-then-blur cancellation leaves it armed.
          needsFullActivationRefreshRef.current = false;
          await handleRefreshTerminal();
          hotActivationEligibleRef.current = !useBatterySaverTerminalVisibility;
        } else if (hotActivation) {
          await reconcileMountedTerminal();
        } else {
          repaintTerminal();
        }
        await waitForNextPaint();
        if (cancelled) return;
        // Masked activations report from the overlay linger timer when the mask lifts.
        if (!fullRefresh && !hotActivation) markPaneTerminalShown(panel.sessionId);

        if (autoFocus && (fullRefresh || hotActivation)) {
          xtermRef.current?.focus();
        }

        delayedRefreshTimer = setTimeout(() => {
          void (async () => {
            if (cancelled || !fitAddonRef.current || !xtermRef.current || !terminalRef.current) return;
            forwardToMainLog('info', `[TerminalPanel] Delayed activation refresh for panel ${panel.id}`);
            if (fullRefresh) await handleRefreshTerminal();
            else if (hotActivation) await reconcileMountedTerminal();
            else repaintTerminal();
            if (!hotActivation) return;
            await waitForNextPaint();
            if (cancelled) return;
            hideOverlayTimer = setTimeout(() => {
              if (!cancelled) setIsRefreshing(false);
            }, TERMINAL_ACTIVATION_MASK_AFTER_PAINT_MS);
          })();
        }, REFOCUS_DELAYED_REFRESH_MS);

        if (fullRefresh) {
          // Full refresh keeps the historical mask timing. Hot activation keeps
          // the mask through its delayed fit/reconcile/refresh backstop above.
          hideOverlayTimer = setTimeout(() => {
            if (!cancelled) setIsRefreshing(false);
          }, TERMINAL_ACTIVATION_MASK_AFTER_PAINT_MS);
        }
      });
    };

    const animationFrame = requestAnimationFrame(fitAndRefresh);

    return () => {
      cancelled = true;
      cancelAnimationFrame(animationFrame);
      if (retryTimer) clearTimeout(retryTimer);
      if (delayedRefreshTimer) clearTimeout(delayedRefreshTimer);
      if (hideOverlayTimer) clearTimeout(hideOverlayTimer);
      setIsRefreshing(false);
    };
  }, [activationVisible, panelVisible, useBatterySaverTerminalVisibility, panel.id, panel.sessionId, isInitialized, autoFocus, handleRefreshTerminal, reconcileMountedTerminal, repaintTerminal, forwardToMainLog]);

  useEffect(() => {
    const terminal = xtermRef.current;
    if (!terminal) return;
    const buffer = terminal.buffer.active;
    const distanceFromBottom = Math.max(0, buffer.baseY - buffer.viewportY);
    const wasNearBottom = isNearBottomRef.current || distanceFromBottom <= NEAR_BOTTOM_THRESHOLD_ROWS;
    const newTheme = getTerminalTheme();
    terminal.options.theme = newTheme;
    terminal.options.minimumContrastRatio = getMinimumContrastRatio(highContrast);
    const rows = terminal.rows;
    if (rows > 0) {
      terminal.refresh(0, rows - 1);
      if (wasNearBottom) {
        terminal.scrollToBottom();
        isNearBottomRef.current = true;
        setShowScrollDown(false);
      } else {
        terminal.scrollToLine(Math.max(0, terminal.buffer.active.baseY - distanceFromBottom));
        isNearBottomRef.current = false;
        setShowScrollDown(true);
      }
    }
  }, [theme, highContrast]);


  // Handle missing session context (show after all hooks have been called)
  if (!sessionContext) {
    return (
      <div className="flex items-center justify-center h-full text-red-500">
        Pane context not available
      </div>
    );
  }

  if (initError) {
    return (
      <div className="flex items-center justify-center h-full text-red-500">
        Terminal initialization failed: {initError}
      </div>
    );
  }

  // Always render the terminal div to keep XTerm instance alive
  return (
    <div
      ref={terminalScrollSurfaceRef}
      data-terminal-panel-id={panel.id}
      className="h-full w-full relative group/terminal"
      onMouseMove={onMouseMove}
      onKeyDown={handleTerminalKeyDown}
    >
      {/* ph-no-capture keeps xterm out of session recordings: its WebGL canvas
          never replays, and replaying scrollback rewrites the scrollbar
          slider's style thousands of times, which the recorder would serialize. */}
      <div ref={terminalRef} className="ph-no-capture h-full w-full" data-terminal-font={terminalFontObservation} data-window-focused={windowFocused ? "true" : "false"} />

      {/* Terminal search overlay */}
      <TerminalSearchOverlay
        isOpen={isSearchOpen}
        searchQuery={searchQuery}
        searchStatus={searchStatus}
        searchInputRef={searchInputRef}
        onQueryChange={onQueryChange}
        onStep={onStep}
        onClose={closeSearch}
      />

      {/* Terminal scroll buttons — compact, revealed on hover */}
      {isInitialized && (
        <div className="absolute top-2 right-5 z-30 flex items-center gap-0.5 opacity-0 pointer-events-none group-hover/terminal:opacity-100 group-hover/terminal:pointer-events-auto transition-opacity">
          <button
            onClick={() => { void handleManualRefresh(); }}
            className="p-0.5 rounded bg-surface-secondary/60 hover:bg-surface-tertiary/80 text-text-tertiary hover:text-text-secondary transition-colors"
            title="Refresh terminal"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1.5 2v3h3" />
              <path d="M10.5 10v-3h-3" />
              <path d="M9.25 4.5A3.75 3.75 0 0 0 3 3.15L1.5 5" />
              <path d="M2.75 7.5A3.75 3.75 0 0 0 9 8.85L10.5 7" />
            </svg>
          </button>
          <button
            onClick={() => xtermRef.current?.scrollToTop()}
            className="p-0.5 rounded bg-surface-secondary/60 hover:bg-surface-tertiary/80 text-text-tertiary hover:text-text-secondary transition-colors"
            title="Scroll to top"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7L6 4L9 7" />
            </svg>
          </button>
          <button
            onClick={() => {
              xtermRef.current?.scrollToBottom();
              isNearBottomRef.current = true;
            }}
            className="p-0.5 rounded bg-surface-secondary/60 hover:bg-surface-tertiary/80 text-text-tertiary hover:text-text-secondary transition-colors"
            title="Scroll to bottom"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 5L6 8L9 5" />
            </svg>
          </button>
        </div>
      )}

      {/* Jump-to-bottom pill — appears when scrolled up */}
      {showScrollDown && isInitialized && (
        <button
          onClick={() => {
            xtermRef.current?.scrollToBottom();
            isNearBottomRef.current = true;
            setShowScrollDown(false);
          }}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 z-30 flex items-center justify-center w-7 h-7 rounded-full bg-[color-mix(in_srgb,var(--color-text-primary)_6%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-text-primary)_8%,transparent)] text-text-tertiary hover:text-text-secondary transition-colors duration-150"
          title="Jump to bottom"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 6L7 9L10 6" />
          </svg>
        </button>
      )}

      {overlayVisible && (
        <div className="absolute inset-0 bg-surface-primary z-10" data-testid="terminal-activation-mask">
          <TerminalLoadingSkeleton />
        </div>
      )}

      {/* Terminal link overlays */}
      <TerminalLinkTooltip
        visible={tooltip.visible}
        x={tooltip.x}
        y={tooltip.y}
        linkText={tooltip.text}
        hint={tooltip.hint}
      />

      <TerminalPopover
        visible={filePopover.visible}
        x={filePopover.x}
        y={filePopover.y}
        onClose={closeFilePopover}
      >
        <PopoverButton onClick={handleOpenInEditor}>
          <span className="flex items-center gap-2">
            <FileEdit className="w-4 h-4" />
            Open in Editor
          </span>
        </PopoverButton>
        <PopoverButton
          onClick={handleShowInExplorer}
          disabled={isRemoteMode}
          title={isRemoteMode ? 'Only available in local mode' : undefined}
        >
          <span className="flex items-center gap-2">
            <FolderOpen className="w-4 h-4" />
            Show in Explorer{isRemoteMode ? ' (local only)' : ''}
          </span>
        </PopoverButton>
      </TerminalPopover>

      <SelectionPopover
        visible={selectionPopover.visible}
        x={selectionPopover.x}
        y={selectionPopover.y}
        text={selectionPopover.text}
        workingDirectory={workingDirectory}
        sessionId={panel.sessionId}
        isRemoteMode={isRemoteMode}
        onOpenInBrowser={handleOpenInBrowser}
        onClose={closeSelectionPopover}
      />

      {/* Terminal interceptor overlays */}
      {interceptorState && (
        <InterceptorDropdown
          visible={interceptorState.active}
          terminals={interceptorState.handlerState?.terminals ?? []}
          selectedIndex={interceptorState.handlerState?.selectedIndex ?? 0}
          lineCountPresetIndex={interceptorState.handlerState?.lineCountPresetIndex ?? 0}
          pasteMode={interceptorState.handlerState?.pasteMode ?? 'raw'}
          filterText={interceptorState.buffer}
          position={getDropdownPosition()}
        />
      )}
      {toastMessage && (
        <InterceptorToast
          visible={!!toastMessage}
          message={toastMessage}
          onHide={() => setToastMessage(null)}
        />
      )}
    </div>
  );
});

TerminalPanel.displayName = 'TerminalPanel';

export default TerminalPanel;
