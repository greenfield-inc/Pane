import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useCommittedRef } from './useCommittedRef';
import { Terminal, type IDisposable } from '@xterm/xterm';
import {
  getTerminalTheme,
  buildTerminalFontFamily,
  getMinimumContrastRatio,
  DEFAULT_TERMINAL_FONT_FAMILY,
} from '../utils/terminalTheme';
import { useConfigStore } from '../stores/configStore';
import { useTheme } from '../contexts/ThemeContext';
import {
  charHeightRatio,
  charWidthRatio,
  fitTerminalViewerGeometry,
  rowHeight,
  type TerminalViewerGeometry,
  MAX_TILE_FONT_SIZE,
  TERMINAL_CHROME_X,
  TERMINAL_CHROME_Y,
  TILE_LINE_HEIGHT,
} from '../utils/terminalFit';
import { loadTerminalCapabilities, terminalCapabilityOptions } from '../utils/terminalCapabilities';
import { registerTerminalQueryHandlers } from '../utils/terminalQueries';
import { subscribeToTerminalOutput } from '../services/terminalOutputBus';
import { MISSION_CONTROL_VIEWER_PREFIX } from '../../../shared/types/missionControl';
import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import { createTerminalOutputAcknowledger } from '../utils/terminalRestore';

/**
 * Read-only xterm for a Mission Control tile.
 *
 * A tile is roughly a fifth of the width the real terminal panel gets, so the
 * whole job is fitting a wide PTY into a small box without lying about it.
 * Four rules, each learned the hard way:
 *
 * 1. **Render exactly the PTY's columns — never fewer, never more.** Agent TUIs
 *    paint with absolute cursor positioning sized to the real PTY. A narrower
 *    viewer wraps every line and each repaint pushes the viewport down, so the
 *    console scrolls forever. A *wider* one is just as wrong in the other
 *    direction: lines that wrapped in the PTY arrive unwrapped, every later
 *    partial redraw lands a row off, and the tile fills with text painted over
 *    text. Matching exactly is the only correct width; what does not fit the
 *    tile is clipped, and `clippedRight` says so.
 * 2. **Height depends on which buffer the agent uses.** On the alternate
 *    screen the frame *is* the PTY's height and its bottom rows carry the
 *    prompt, so the terminal must be that tall and anchored to the bottom. In
 *    the normal buffer output simply scrolls, the tail is what matters, and a
 *    full-height grid would leave the visible bottom rows blank — which is
 *    exactly why Codex tiles rendered empty.
 * 3. **Fit by font size, not by scaling.** `transform: scale()` on a 120-column
 *    terminal in a 400px tile yields a ~4px glyph. Choosing a font size so the
 *    PTY's columns fit — clamped to a readable floor — shows far more and stays
 *    legible.
 * 4. **Exactly one renderer answers the agent's terminal queries.** A tile is
 *    usually a second view of a PTY the real panel answers for — but while
 *    Mission Control is open that panel is unmounted, so a tile that always
 *    stayed quiet would leave nobody to answer. The tile with the keyboard
 *    answers; main drops the reply if a primary terminal exists after all. See
 *    `terminalQueries`.
 *
 * A tile carries the same capabilities as the real panel — Unicode 11 widths,
 * inline images, the user's kitty keyboard setting — because the agent cannot
 * tell the two renderers apart. See `terminalCapabilities`.
 *
 * Also unlike `TerminalPanel`: no `WebglAddon` (instances sharing a font+theme
 * share a texture atlas, and Chromium caps live GL contexts at ~16), no
 * `FitAddon`, `disableStdin` unless the tile has the keyboard, and a
 * `MISSION_CONTROL_VIEWER_PREFIX`-scoped viewer id so the visibility refcount
 * in `terminalPanelManager` stays correct.
 */

const VISIBILITY_REFRESH_MS = 60_000;
/** Tiles show recent context only; a deep buffer would cost memory per tile. */
const TILE_SCROLLBACK = 600;
/**
 * Inset between the wrapper and the terminal in the expanded view, mirroring
 * the container's `inset-x-1` and its 4px bottom offset. It is inside the box
 * `measure` is handed, so the font has to be chosen against what is left.
 */
const EXPANDED_INSET_PX = 4;
/** Fallbacks when a panel has no live PTY to report dimensions. */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const RESIZE_DEBOUNCE_MS = 200;

const VIEWER_ID = getMissionControlViewerId();

const terminalStateSchema = boundary.object({
  serializedBuffer: boundary.optional(boundary.string),
  scrollbackBuffer: boundary.optional(boundary.union(boundary.string, boundary.array(boundary.string))),
});

function getMissionControlViewerId(): string {
  const storageKey = 'pane.missionControl.terminalViewerId';
  const id = `${MISSION_CONTROL_VIEWER_PREFIX}:${window.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
  try {
    const existing = window.sessionStorage.getItem(storageKey);
    if (existing) return existing;
    window.sessionStorage.setItem(storageKey, id);
  } catch {
    // A locked-down storage profile costs viewer-id stability across reloads,
    // not the view: the stale-viewer sweep clears the orphan.
  }
  return id;
}

/**
 * Park the viewport on the last line that actually has content.
 *
 * `scrollToBottom()` lands on the true end of the buffer, which for an agent
 * waiting on a decision is a run of blank rows below its prompt — the tile
 * then looks like it scrolled the important part away. Finding the last
 * non-empty row and putting it at the bottom keeps the question on screen.
 */
function scrollToLastContent(terminal: Terminal): void {
  const buffer = terminal.buffer.active;
  let lastContentLine = -1;

  for (let i = buffer.length - 1; i >= 0; i--) {
    const text = buffer.getLine(i)?.translateToString(true) ?? '';
    if (text.trim().length > 0) {
      lastContentLine = i;
      break;
    }
  }

  if (lastContentLine < 0) {
    terminal.scrollToBottom();
    return;
  }

  // Put that line on the last visible row.
  terminal.scrollToLine(Math.max(0, lastContentLine - terminal.rows + 1));
}

/**
 * Grid rows below the agent's last line of content.
 *
 * An agent's screen is usually taller than what it has drawn: Claude paints its
 * question near the top of the PTY and leaves the rest of the rows empty.
 * Scrolling cannot remove them — they are inside the viewport, not above it —
 * so a tile that simply shows the bottom of the grid shows blank space, and the
 * options the user is supposed to choose between are clipped off the top. The
 * count returned here is how far the terminal must be pushed down (and out of
 * the tile) for its content to end where the tile ends.
 *
 * The cursor row always counts as content: an empty prompt line the user is
 * typing into must never be the thing that gets pushed out of sight.
 */
function trailingBlankRows(terminal: Terminal): number {
  const buffer = terminal.buffer.active;
  const bottom = buffer.viewportY + terminal.rows - 1;
  const cursorRow = buffer.viewportY + buffer.cursorY;

  for (let row = bottom; row > buffer.viewportY; row--) {
    if (row <= cursorRow) return Math.max(0, bottom - cursorRow);
    const text = buffer.getLine(row)?.translateToString(true) ?? '';
    if (text.trim().length > 0) return bottom - row;
  }

  return 0;
}

/**
 * xterm's helper textarea is focusable, and a non-interactive tile hides its
 * whole surface from the accessibility tree. Match the two so a screen reader's
 * focus can never land inside an `aria-hidden` subtree.
 */
function syncHelperTextareaFocusability(container: HTMLElement | null, interactive: boolean): void {
  const helper = container?.querySelector('textarea.xterm-helper-textarea');
  if (helper instanceof HTMLTextAreaElement) helper.tabIndex = interactive ? 0 : -1;
}

/** Rendered height of one row, measured rather than recomputed from the font. */
function measuredRowHeight(container: HTMLElement, terminal: Terminal): number {
  // SAFETY: `.xterm-screen` is an element xterm renders into this container, so the match is an HTMLElement.
  const screen = container.querySelector('.xterm-screen') as HTMLElement | null;
  if (screen && terminal.rows > 0 && screen.clientHeight > 0) {
    return screen.clientHeight / terminal.rows;
  }
  const fontSize = terminal.options.fontSize;
  return fontSize ? rowHeight(fontSize, terminal.options.fontFamily ?? '') : 0;
}

export interface UseMissionControlTerminalOptions {
  panelId: string | null;
  /** Live PTY dimensions — the reference the agent's output was drawn for. */
  cols: number | null;
  rows: number | null;
  /** True when the agent is painting a full-screen TUI. */
  /**
   * Accept keystrokes and forward them to the real PTY. Enabled only for the
   * tile the user has explicitly focused — typing into the wrong agent is not
   * a recoverable mistake.
   */
  interactive?: boolean;
  /**
   * Reproduce the PTY's grid exactly — same columns *and* rows — and shrink the
   * font until the whole thing fits the box.
   *
   * For the expanded focus view, where the point is to see the agent's entire
   * screen at once. A tile that stays preview-sized instead keeps the preview's
   * font and simply clips, which is what makes typing in place look like
   * nothing changed.
   */
  matchPtyExactly?: boolean;
  /**
   * The height the font is chosen against, when it differs from the wrapper's.
   *
   * The expanded view grows its wrapper when even the smallest font cannot get
   * the whole grid into the budget (see `heightShortfall`), and a font refitted
   * to the grown wrapper would grow too, need more height again, and never
   * settle. So the budget is passed in and the fit stays anchored to it.
   */
  fitHeightPx?: number;
  /**
   * Forward Escape to the agent instead of treating it as "I am done typing
   * here". Off by default: leaving a tile is the far more common intent, and an
   * Escape that cannot be taken back is a bad default in a grid of agents.
   */
  sendEscape?: boolean;
  /** Called when Escape is used to leave typing mode. */
  onEscapeExit?: () => void;
}

export function useMissionControlTerminal({
  panelId,
  cols,
  rows,
  interactive = false,
  matchPtyExactly = false,
  fitHeightPx = 0,
  sendEscape = false,
  onEscapeExit,
}: UseMissionControlTerminalOptions) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A tile mirrors a real panel, so it renders in the typeface that panel does.
  const userFont = useConfigStore(state => state.config?.terminalFontFamily) || DEFAULT_TERMINAL_FONT_FAMILY;
  const fontFamily = buildTerminalFontFamily(userFont);
  // The same setting `TerminalPanel` reads. A program that asked for enhanced
  // key reporting must get the same encoding whichever renderer it is typed in.
  const kittyKeyboardEnabled = useConfigStore(state => state.config?.kittyKeyboardEnabled !== false);
  const { highContrast } = useTheme();
  // Read inside the persistent onData handler so toggling interactivity does
  // not tear the terminal down. Committed refs rather than writes during
  // render: render has to stay pure, and the layout effect behind them still
  // lands before the browser can deliver the next keystroke.
  const interactiveRef = useCommittedRef(interactive);
  const sendEscapeRef = useCommittedRef(sendEscape);
  const escapeExitRef = useCommittedRef(onEscapeExit);
  // Read once when the terminal is constructed; changes are applied live below
  // rather than by rebuilding a tile mid-stream.
  const fontFamilyRef = useCommittedRef(fontFamily);
  const highContrastRef = useCommittedRef(highContrast);
  const kittyKeyboardRef = useCommittedRef(kittyKeyboardEnabled);
  // Read inside the terminal's own overflow check, which outlives any single
  // render and must not rebuild the terminal when the budget changes.
  const fitHeightRef = useCommittedRef(fitHeightPx);
  const matchPtyExactlyRef = useCommittedRef(matchPtyExactly);

  /**
   * Pixels the terminal is pushed below the tile so its content ends where the
   * tile does. See `trailingBlankRows`.
   */
  const [bottomOverflow, setBottomOverflow] = useState(0);
  /** True when the PTY is wider than the tile, so text is cut off on the right. */
  const [clippedRight, setClippedRight] = useState(false);
  /**
   * Pixels the expanded tile is short of showing the agent's whole screen.
   *
   * The expanded view promises every row at once, and below the focus floor the
   * font has nothing left to give: a 60-row screen needs about 560px however
   * small the text. Rather than clip the oldest rows behind the wrapper and say
   * nothing, the tile grows by this much and the grid scrolls to it.
   */
  const [heightShortfall, setHeightShortfall] = useState(0);
  /**
   * The live terminal's overflow check, so a resize can re-run it.
   *
   * It normally rides along with output, but once the font has hit its floor a
   * narrowing tile clips further without any geometry change to rebuild on —
   * and an idle agent sends nothing to trigger it. The fade would then stay
   * behind the truth exactly when it is needed most.
   */
  const syncOverflowRef = useRef<() => void>(() => {});

  // Dimensions are sticky: a poll that momentarily reports null (panel between
  // states) must not tear the terminal down and rebuild it at a default size.
  // Reading the ref during render is fine; the write belongs in an effect.
  const lastDimsRef = useRef({ cols: DEFAULT_COLS, rows: DEFAULT_ROWS });
  const hasReportedDims = Boolean(cols && cols > 0 && rows && rows > 0);
  const ptyCols = hasReportedDims ? cols! : lastDimsRef.current.cols;
  const ptyRows = hasReportedDims ? rows! : lastDimsRef.current.rows;
  useLayoutEffect(() => {
    if (hasReportedDims) lastDimsRef.current = { cols: cols!, rows: rows! };
  }, [hasReportedDims, cols, rows]);

  /** Until the wrapper has been measured, any geometry is a guess. */
  const [measured, setMeasured] = useState(false);
  const [geometry, setGeometry] = useState<TerminalViewerGeometry>({
    fontSize: MAX_TILE_FONT_SIZE,
    cols: ptyCols,
    rows: ptyRows,
  });

  const measure = useCallback((width: number, height: number): TerminalViewerGeometry => {
    const ratio = charWidthRatio(fontFamily);
    const heightRatio = charHeightRatio(fontFamily);
    // The box handed in is the wrapper, but the glyphs only get what is left of
    // it once the terminal's own padding — and, expanded, the container's inset
    // — is taken out. Fitting against the whole wrapper puts the trailing
    // column past the tile's clipped edge, which is the hard cut mid-word.
    const inset = matchPtyExactly ? EXPANDED_INSET_PX * 2 : 0;
    const glyphWidth = Math.max(width - inset - TERMINAL_CHROME_X, 1);
    const glyphHeight = Math.max(height - inset - TERMINAL_CHROME_Y, 1);

    // Both preview and expanded terminals preserve the PTY's exact dimensions.
    // A preview fits by width while the expanded view fits both axes and may use
    // its lower font floor; neither is allowed to reflow the agent's screen.
    return fitTerminalViewerGeometry(
      glyphWidth,
      glyphHeight,
      ptyCols,
      ptyRows,
      ratio,
      heightRatio,
      matchPtyExactly,
    );
  }, [ptyCols, ptyRows, matchPtyExactly, fontFamily]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const sync = () => {
      // Height from the budget, not from the wrapper: the wrapper may already
      // have grown to carry a shortfall, and refitting to the grown box would
      // grow the font, grow the grid, and never settle.
      const next = measure(wrapper.clientWidth, fitHeightPx > 0 ? fitHeightPx : wrapper.clientHeight);
      setMeasured(true);
      setGeometry(current => (
        next.fontSize !== current.fontSize || next.cols !== current.cols || next.rows !== current.rows
          ? next
          : current
      ));
      syncOverflowRef.current();
    };
    sync();

    let debounce: number | undefined;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(sync, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(wrapper);

    return () => {
      window.clearTimeout(debounce);
      observer.disconnect();
    };
  }, [measure, fitHeightPx]);

  useEffect(() => {
    const container = containerRef.current;
    // Wait for the measurement. The seed geometry is a guess and never the
    // answer, so building against it costs an xterm, a `terminal:getState`
    // round trip and a full-buffer replay that the next tick throws away.
    if (!panelId || !container || !measured) return;

    // Geometry changes rebuild the terminal, and a rebuild that ignored the
    // current interactivity would hand the user a fresh, mute terminal: the
    // effect below only fires when `interactive` *changes*, which it does not
    // during a rebuild. That is what made a focused tile stop accepting input
    // the moment its tile resized.
    const startsInteractive = interactiveRef.current;

    const terminal = new Terminal({
      // Proposed APIs and the kitty keyboard setting, shared with the real
      // panel: the agent cannot tell its two renderers apart, so neither may
      // their capabilities.
      ...terminalCapabilityOptions(kittyKeyboardRef.current),
      // No `convertEol`: a tile replays and then follows the same byte stream
      // the real panel does, and rewriting bare LFs as CRLF shifts every line a
      // TUI paints without one.
      cursorBlink: startsInteractive,
      disableStdin: !startsInteractive,
      scrollOnUserInput: true,
      // Sized correctly up front — never resized once content exists.
      cols: geometry.cols,
      rows: geometry.rows,
      fontSize: geometry.fontSize,
      lineHeight: TILE_LINE_HEIGHT,
      fontFamily: fontFamilyRef.current,
      scrollback: TILE_SCROLLBACK,
      // Agent TUIs paint their own backgrounds assuming a dark terminal. In a
      // light theme that lands as dark-on-dark; this floor keeps it legible.
      minimumContrastRatio: getMinimumContrastRatio(highContrastRef.current),
      // The app's real terminal palette. A transparent background leaves cells
      // the TUI never paints showing the tile's surface colour instead of the
      // terminal's, which reads as a broken, patchy background.
      theme: getTerminalTheme(),
    });

    terminal.open(container);
    terminalRef.current = terminal;
    // A non-interactive tile marks its surface `aria-hidden`, and xterm mounts a
    // focusable helper textarea inside it. Taking that textarea out of the tab
    // order keeps focus from landing inside a hidden subtree.
    syncHelperTextareaFocusability(container, startsInteractive);
    if (startsInteractive) terminal.focus();

    // Escape leaves typing mode by default; the agent only receives it when the
    // user has explicitly asked for that. Handled here rather than on `onData`
    // so xterm never writes the sequence in the first place.
    terminal.attachCustomKeyEventHandler(event => {
      if (event.key !== 'Escape' || !interactiveRef.current || sendEscapeRef.current) return true;
      if (event.type === 'keydown') escapeExitRef.current?.();
      return false;
    });

    let disposed = false;
    /** True while the user is reading further up; suppresses auto-scroll. */
    let pinnedByUser = false;
    let capabilities: { dispose(): void } | null = null;

    const syncOverflow = () => {
      if (disposed) return;
      const measuredRow = measuredRowHeight(container, terminal);
      const overflow = Math.round(trailingBlankRows(terminal) * measuredRow);
      setBottomOverflow(current => (current === overflow ? current : overflow));

      // SAFETY: `.xterm-screen` is an element xterm renders into this container, so the match is an HTMLElement.
      const screen = container.querySelector('.xterm-screen') as HTMLElement | null;
      const wrapper = wrapperRef.current;
      // Edge against edge rather than width against width: the screen starts
      // inside the terminal's padding, so comparing widths alone misses the
      // last column or two — the ones actually being cut.
      const clipped = Boolean(
        screen && wrapper
        && screen.getBoundingClientRect().right > wrapper.getBoundingClientRect().right + 1
      );
      setClippedRight(current => (current === clipped ? current : clipped));

      // Both axes are checked against what actually rendered, not against the
      // arithmetic that chose the font: a fit computed from cell ratios is an
      // estimate, and the estimate being a few percent light is exactly how the
      // top rows of an expanded tile went missing. Height is the axis the tile
      // can still do something about, so it is the one reported.
      const budget = fitHeightRef.current > 0 ? fitHeightRef.current : (wrapper?.clientHeight ?? 0);
      const needed = matchPtyExactlyRef.current && container.clientHeight > 0
        ? Math.max(0, Math.ceil(container.clientHeight + EXPANDED_INSET_PX - overflow - budget))
        : 0;
      setHeightShortfall(current => (current === needed ? current : needed));
    };
    syncOverflowRef.current = syncOverflow;

    const scrollDisposable = terminal.onScroll(() => {
      const buffer = terminal.buffer.active;
      const atBottom = buffer.viewportY >= buffer.baseY - 1;
      pinnedByUser = !atBottom;
    });

    /**
     * True while xterm is producing the answer to a query we let through.
     *
     * xterm hands replies and keystrokes to the very same `onData` stream, and
     * the two need different destinations: a keystroke is this user typing, a
     * reply is this renderer claiming to be the agent's terminal. The parser
     * emits the reply synchronously while still inside the sequence, so the
     * flag only has to survive the current task — a microtask later, anything
     * arriving is a keystroke again.
     */
    let answeringQuery = false;
    /**
     * True while the saved buffer is being replayed into this terminal.
     *
     * The restore is a recording of bytes the agent already sent, queries
     * included, and the real terminal answered them at the time. Answering them
     * again on replay would put a cursor-position report on the PTY that
     * corresponds to nothing the agent just asked — the exact confusion this
     * arbitration exists to prevent, arriving from the other direction.
     */
    let replayingHistory = false;
    // Registered once the addons are on, not here: xterm tries CSI handlers
    // newest first, and the image addon's own size reports have to arrive
    // *under* the arbitration rather than over it.
    let queryHandlers: IDisposable[] = [];

    // Keystrokes reach the real PTY only for the focused tile. Query answers go
    // to `terminal:reply`, where main drops them unless this viewer is the one
    // designated to speak for the panel.
    const inputDisposable = terminal.onData(data => {
      if (answeringQuery) {
        void window.electronAPI.invoke('terminal:reply', panelId, data, VIEWER_ID).catch(() => {});
        return;
      }
      if (!interactiveRef.current) return;
      void window.electronAPI.invoke('terminal:input', panelId, data).catch(() => {});
    });

    // Output that arrives before the restore lands is held, not written: the
    // hydrate below replays the whole buffer, so anything written first would be
    // clobbered by an older screen and the tile would show stale or duplicated
    // content for a working agent. `TerminalPanel` restores before it
    // subscribes; a tile cannot, because the subscription is what proves the
    // panel is still producing, so it queues instead.
    let hydrated = false;
    const pendingOutput: string[] = [];

    const acknowledger = createTerminalOutputAcknowledger(bytes => {
      void window.electronAPI.invoke('terminal:ack', panelId, bytes, VIEWER_ID).catch(() => {});
    });

    const writeLiveOutput = (output: string) => {
      terminal.write(output, () => {
        if (disposed) return;
        acknowledger.acknowledge(output);
        // Follow new output, but never yank the view away from someone who
        // scrolled up to read.
        if (!pinnedByUser) scrollToLastContent(terminal);
        syncOverflow();
      });
    };

    const unsubscribe = subscribeToTerminalOutput(panelId, output => {
      if (!hydrated) {
        pendingOutput.push(output);
        return;
      }
      writeLiveOutput(output);
    });

    // Main only treats a panel as visible while a viewer says so, and viewer
    // entries go stale after a few minutes without a heartbeat.
    const visibilityTimer = window.setInterval(() => {
      void window.electronAPI.invoke('terminal:setVisibility', panelId, true, VIEWER_ID).catch(() => {});
    }, VISIBILITY_REFRESH_MS);

    const hydrate = async () => {
      try {
        const state = decodeOptionalBoundary(
          await window.electronAPI.invoke('terminal:getState', panelId),
          terminalStateSchema,
        );
        if (disposed) return;
        const scrollback = state?.scrollbackBuffer;
        const restore = state?.serializedBuffer
          ?? (Array.isArray(scrollback) ? scrollback.join('\n') : scrollback ?? '');
        if (restore) {
          replayingHistory = true;
          // xterm invokes write callbacks in write order, so this clears before
          // the live chunks below are parsed and they are answered normally.
          terminal.write(restore, () => { replayingHistory = false; });
        }
        // Flush in arrival order, after the restore, so live output lands on
        // top of the buffer it belongs after rather than under it.
        hydrated = true;
        const queued = pendingOutput.splice(0, pendingOutput.length);
        for (const chunk of queued) writeLiveOutput(chunk);
        terminal.write('', () => {
          if (disposed) return;
          scrollToLastContent(terminal);
          syncOverflow();
        });
        await window.electronAPI.invoke('terminal:setVisibility', panelId, true, VIEWER_ID);
        if (disposed) return;
        setError(null);
        // Hydration writes into the DOM the user just clicked; take the
        // keyboard back afterwards so the first keystroke lands on the agent.
        if (interactiveRef.current) terminal.focus();
      } catch (err: unknown) {
        // Open the gate even on failure: holding output back forever would
        // leave a permanently blank tile for an agent that is still running.
        replayingHistory = false;
        hydrated = true;
        for (const chunk of pendingOutput.splice(0, pendingOutput.length)) writeLiveOutput(chunk);
        if (!disposed) setError(err instanceof Error ? err.message : 'Could not attach to terminal');
      }
    };

    /**
     * Bring the tile up in the order the agent's bytes require.
     *
     * Capabilities first, so Unicode 11 widths and the image protocols are in
     * place before a single byte is parsed; then the query arbitration, which
     * has to sit above the addons that answer some of the same sequences; then
     * the buffer replay. Output that arrives meanwhile is queued, not written.
     */
    const setup = async () => {
      const loaded = await loadTerminalCapabilities(terminal, {
        label: `mission-control tile ${panelId}`,
        // A live tile is a screen the user reads a running agent in, so it
        // renders what the agent draws — sixel, iTerm2 and kitty graphics
        // included. The addon allocates image storage lazily, so a tile whose
        // agent never draws one costs nothing for having the ability.
        images: true,
        isStale: () => disposed,
      });
      // The teardown may have run while the addons were being fetched, in which
      // case it has no handle to dispose and this is the only owner left.
      if (disposed) {
        loaded.dispose();
        return;
      }
      capabilities = loaded;

      queryHandlers = registerTerminalQueryHandlers(terminal.parser, {
        // Only the tile holding the keyboard speaks. A tile the user is merely
        // watching stays quiet, exactly as a second view should — and `main`
        // has the final say either way.
        canAnswer: () => interactiveRef.current && !replayingHistory,
        onAnswering: () => {
          answeringQuery = true;
          queueMicrotask(() => { answeringQuery = false; });
        },
      });

      await hydrate();
    };

    void setup();

    return () => {
      disposed = true;
      acknowledger.dispose();
      syncOverflowRef.current = () => {};
      window.clearInterval(visibilityTimer);
      unsubscribe();
      inputDisposable.dispose();
      scrollDisposable.dispose();
      for (const handler of queryHandlers) handler.dispose();
      capabilities?.dispose();
      void window.electronAPI.invoke('terminal:setVisibility', panelId, false, VIEWER_ID).catch(() => {});
      // Never call clearTextureAtlas() here — it would poison other terminals.
      terminal.dispose();
      terminalRef.current = null;
    };
    // Geometry changes rebuild and re-hydrate rather than resizing a live
    // terminal — see the note on charWidthRatio.
  }, [
    panelId, geometry, measured, interactiveRef, sendEscapeRef, escapeExitRef,
    fontFamilyRef, highContrastRef, kittyKeyboardRef, fitHeightRef, matchPtyExactlyRef,
  ]);

  // A font or theme change is an option flip too: rebuilding every live tile
  // for a settings change would re-hydrate each one for nothing.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontFamily = fontFamily;
    terminal.options.minimumContrastRatio = getMinimumContrastRatio(highContrast);
    // vtExtensions is read per key event rather than at construction, so the
    // setting takes effect on a live tile without a rebuild.
    terminal.options.vtExtensions = { ...terminal.options.vtExtensions, kittyKeyboard: kittyKeyboardEnabled };
  }, [fontFamily, highContrast, kittyKeyboardEnabled]);

  // Collapsing back to preview size drops any growth the expanded view needed,
  // rather than leaving the tile tall until the rebuilt terminal measures again.
  useEffect(() => {
    if (!matchPtyExactly) setHeightShortfall(0);
  }, [matchPtyExactly]);

  // Toggling interactivity flips an option rather than rebuilding, so taking the
  // keyboard costs no re-hydrate. Expanding on focus is a different matter: the
  // tile really does change size, so geometry changes and the terminal is
  // rebuilt at the new one.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.disableStdin = !interactive;
    terminal.options.cursorBlink = interactive;
    syncHelperTextareaFocusability(containerRef.current, interactive);
    if (interactive) terminal.focus();
  }, [interactive]);

  /**
   * Hand the keyboard to this terminal.
   *
   * Clicks that land on the tile's padding — or on the chrome around the
   * terminal — otherwise leave focus on whatever the user clicked last, and the
   * keystrokes go nowhere.
   */
  const focusTerminal = useCallback(() => {
    if (!interactiveRef.current) return;
    terminalRef.current?.focus();
  }, [interactiveRef]);

  return { wrapperRef, containerRef, error, focusTerminal, bottomOverflow, clippedRight, heightShortfall };
}
