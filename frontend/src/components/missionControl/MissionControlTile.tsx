import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { GitBranch, Keyboard, Minimize2, Radio, TerminalSquare, Trash2, X } from 'lucide-react';
import { AgentStatusDot } from '../ui/AgentStatusDot';
import { useMissionControlTerminal } from '../../hooks/useMissionControlTerminal';
import { useConfigStore } from '../../stores/configStore';
import { toAgentDisplayStatus } from '../../utils/agentStatus';
import { buildTerminalFontFamily, DEFAULT_TERMINAL_FONT_FAMILY } from '../../utils/terminalTheme';
import {
  charWidthRatio, fittedWidth, fitFontSize, MIN_TILE_FONT_SIZE, rowHeight, widestLine,
} from '../../utils/terminalFit';
import { agentTypeLabel, describeMissionControlTile, STATE_LABEL } from '../../utils/missionControlGrouping';
import type { AgentDisplayStatus } from '../../../../shared/types/agentStatus';
import type { MissionControlTileModel } from '../../../../shared/types/missionControl';
import { formatTimeAgo } from '../../utils/timestampUtils';

/**
 * Row heights the tile budgets its body against.
 *
 * A row is the font's natural line box times xterm's line height, not the font
 * size times line height, so it runs about 1.5x the font rather than 1.2x.
 * These were calibrated against the smaller estimate, which is why an expanded
 * tile reserved less height than its own grid needed and the terminal had to
 * shrink to fit. Sized from the floor font and a readable focus font instead.
 */
const SNAPSHOT_FONT_SIZE_HINT = MIN_TILE_FONT_SIZE;
const FOCUS_FONT_SIZE_HINT = 14;

/**
 * How far outside the viewport a tile still counts as worth a real terminal.
 *
 * Generous on purpose: promotion costs a `terminal:getState` round trip and a
 * full-buffer replay, so a tile one flick of the wheel away should already be
 * live rather than blank when it arrives.
 */
const NEAR_VIEWPORT_MARGIN = '600px';
/**
 * Grace before a tile that scrolled away gives its terminal up.
 *
 * A tile scrolled just past the edge is usually coming straight back, and
 * tearing an xterm down and re-hydrating it costs more than holding it for a
 * moment longer.
 */
const OFFSCREEN_GRACE_MS = 2000;

/**
 * Whether this tile is close enough to the viewport to carry a live terminal.
 *
 * "All live" mounts every tile in every open group, and an offscreen xterm is
 * not a cheap one: it parses and paints every byte its agent produces, exactly
 * like the ones on screen. Scrolling away should reduce the load, so it does —
 * the tile falls back to its snapshot, which is a poll the grid pays for
 * anyway.
 */
function useNearViewport(elementRef: React.RefObject<HTMLElement | null>): boolean {
  const [nearViewport, setNearViewport] = useState(true);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    let graceTimer: number | undefined;
    const observer = new IntersectionObserver(([entry]) => {
      window.clearTimeout(graceTimer);
      if (entry.isIntersecting) {
        setNearViewport(true);
        return;
      }
      graceTimer = window.setTimeout(() => setNearViewport(false), OFFSCREEN_GRACE_MS);
    }, { rootMargin: NEAR_VIEWPORT_MARGIN });

    observer.observe(element);
    return () => {
      window.clearTimeout(graceTimer);
      observer.disconnect();
    };
  }, [elementRef]);

  return nearViewport;
}

/** Left accent per state, so a wall of tiles is scannable at a glance. */
const ACCENT = {
  blocked: 'bg-status-error',
  working: 'bg-interactive',
  done: 'bg-status-success',
  idle: 'bg-border-secondary',
  unknown: 'bg-border-secondary',
} satisfies Record<AgentDisplayStatus, string>;

// The group headings' labels, plus the one state only a tile can be in. Two
// maps would let a heading and the tile beneath it name the same state
// differently.
const STATUS_TEXT = { ...STATE_LABEL, done: 'Done' } satisfies Record<AgentDisplayStatus, string>;

/**
 * The screen is wider than the tile and the rest is cut off.
 *
 * A hard edge mid-word reads as a rendering fault, so say it with a fade: text
 * running into it is text there is more of.
 */
function ClippedRightFade() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-[color:var(--color-terminal-bg,#0b0b10)] to-transparent"
    />
  );
}

/**
 * The cheap body a tile wears until it is promoted.
 *
 * It fits the way the live terminal does — by choosing a font size against the
 * screen's own width, held to the same legibility floor — rather than by
 * rendering at a fixed size and letting the tile cut whatever misses. Sharing
 * the maths is what keeps a tile from changing scale under the pointer the
 * moment it goes live.
 */
function SnapshotSurface({ text, height, fontFamily, ptyCols, isLive }: {
  text: string;
  height: number;
  fontFamily: string;
  /** The PTY's width, when the snapshot still carried it. */
  ptyCols: number | null;
  isLive: boolean;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  // A stopped pane reports no dimensions, so the text is the only record of the
  // screen it was painted on. It cannot reflow either way — the snapshot is a
  // picture of a screen that no longer exists — so scaling it is the whole of
  // what a tile can do about width.
  const columns = ptyCols ?? widestLine(text);
  const ratio = charWidthRatio(fontFamily);
  const fontSize = fitFontSize(width, columns, ratio);
  // Below the legibility floor the surplus columns are clipped rather than
  // shrunk away, exactly as the live terminal clips them.
  const clipped = width > 0 && columns > 0 && fittedWidth(fontSize, columns, ratio) > width + 1;

  return (
    <div
      ref={boxRef}
      // Padding matched to the live terminal's own (see index.css), so text
      // lands on the same left edge before and after promotion.
      className="relative flex flex-col justify-end overflow-hidden bg-[color:var(--color-terminal-bg,#0b0b10)] pb-1.5 pl-3 pr-1.5 pt-1.5"
      style={{ height }}
    >
      {text ? (
        <pre
          aria-hidden="true"
          className="overflow-hidden whitespace-pre text-text-secondary"
          // Bottom-anchored like the live terminal: the newest rows, and the
          // prompt waiting for an answer, are what a tile is for, so anything
          // that does not fit is lost off the top.
          style={{ fontFamily, fontSize, lineHeight: `${Math.round(rowHeight(fontSize, fontFamily))}px` }}
        >
          {text}
        </pre>
      ) : (
        <p className="mb-auto pt-3 text-center text-[10px] text-text-muted">
          {isLive ? 'Waiting for output…' : 'Not running'}
        </p>
      )}
      {clipped && <ClippedRightFade />}
    </div>
  );
}

function LiveTerminalSurface({
  panelId,
  cols,
  rows,
  height,
  interactive,
  fitWholeGrid,
  sendEscape,
  onEscapeExit,
}: {
  panelId: string;
  cols: number | null;
  rows: number | null;
  height: number;
  interactive: boolean;
  /** Shrink the font until the agent's entire screen fits — expanded view. */
  fitWholeGrid: boolean;
  sendEscape: boolean;
  onEscapeExit: () => void;
}) {
  const {
    wrapperRef, containerRef, error, focusTerminal, bottomOverflow, clippedRight, heightShortfall,
  } = useMissionControlTerminal({
    panelId,
    cols,
    rows,
    interactive,
    matchPtyExactly: fitWholeGrid,
    fitHeightPx: height,
    sendEscape,
    onEscapeExit,
  });

  return (
    <div
      ref={wrapperRef}
      aria-hidden={interactive ? undefined : 'true'}
      // Pointer-down rather than click: a click on the tile's padding would
      // otherwise leave the keyboard wherever it was, and typing would be lost.
      onPointerDown={interactive ? focusTerminal : undefined}
      className={`relative w-full overflow-hidden bg-[color:var(--color-terminal-bg,#0b0b10)] ${
        interactive ? '' : 'pane-mission-control-surface'
      } ${fitWholeGrid ? 'p-1' : ''}`}
      // The budget, plus whatever the smallest legible font still could not fit
      // (expanded only). Growing is what turns "the top rows are gone" into "the
      // grid scrolls": the tile spans the row, so the height it takes is height
      // the grid's own scroller can reach.
      style={{ height: height + heightShortfall }}
    >
      {/*
        Bottom-anchored in every mode: the newest rows — and the prompt waiting
        for an answer — are what a tile is for, so anything that does not fit is
        lost off the top. `bottomOverflow` pushes the agent's empty trailing
        rows out below the tile, so the space goes to content instead of blanks.
      */}
      <div
        ref={containerRef}
        className={fitWholeGrid
          ? 'absolute left-1/2 -translate-x-1/2'
          : 'absolute inset-x-0'}
        style={{ bottom: (fitWholeGrid ? 4 : 0) - bottomOverflow }}
      />
      {/*
        The terminal is exactly as wide as the agent's PTY — anything wider than
        the tile is cut off.
      */}
      {clippedRight && <ClippedRightFade />}
      {error && (
        <p className="absolute inset-x-1 bottom-1 truncate text-[9px] text-status-error">{error}</p>
      )}
    </div>
  );
}

export interface MissionControlTileProps {
  tile: MissionControlTileModel;
  /** True when this tile is rendered as a live terminal rather than a snapshot. */
  isLiveView: boolean;
  onHoverStart: (panelId: string) => void;
  onHoverEnd: (panelId: string) => void;
  onOpen: (tile: MissionControlTileModel) => void;
  /** Trailing lines shown in snapshot mode; scales with grid density. */
  snapshotLines: number;
  /**
   * Ceiling on the expanded body, measured from the space the grid actually
   * has. A constant would waste a tall display and overflow a short one.
   */
  maxExpandedBodyPx: number;
  /** True while this tile's agent is open in the focus view. */
  isFocused: boolean;
  /**
   * Whether taking the keyboard also enlarges the tile to the agent's full
   * screen. Off, the tile keeps its grid size and is typed into where it sits.
   */
  expandWhenFocused: boolean;
  /** Forward Escape to the agent instead of using it to leave typing mode. */
  sendEscape: boolean;
  /** Hand this tile the keyboard. */
  onFocusAgent: (tile: MissionControlTileModel) => void;
  /** Return the tile to preview size. */
  onCollapse: () => void;
  /** Ask to close this pane for good — the view confirms before acting. */
  onClose: (tile: MissionControlTileModel) => void;
  /** True while the grid's roving keyboard cursor is on this tile. */
  isSelected: boolean;
  /** Report this tile's element so the grid can scroll it into view. */
  registerElement: (panelId: string, element: HTMLElement | null) => void;
}

/**
 * One agent in the grid.
 *
 * Renders a cheap ANSI-stripped snapshot by default and a real read-only
 * terminal when promoted, so a large grid costs one xterm instance rather than
 * one per agent.
 */
export const MissionControlTile = memo(function MissionControlTile({
  tile,
  isLiveView,
  onHoverStart,
  onHoverEnd,
  onOpen,
  snapshotLines,
  maxExpandedBodyPx,
  isFocused,
  expandWhenFocused,
  sendEscape,
  onFocusAgent,
  onCollapse,
  onClose,
  isSelected,
  registerElement,
}: MissionControlTileProps) {
  const articleRef = useRef<HTMLElement | null>(null);
  const registerTileElement = useCallback(
    (element: HTMLElement | null) => {
      articleRef.current = element;
      registerElement(tile.panelId, element);
    },
    [registerElement, tile.panelId],
  );
  const nearViewport = useNearViewport(articleRef);

  // A tile mirrors a real panel, so both of its bodies render in the typeface
  // that panel does — a preview that changed typeface on promotion would read
  // as the tile reloading rather than as the same agent.
  const userFont = useConfigStore(state => state.config?.terminalFontFamily) || DEFAULT_TERMINAL_FONT_FAMILY;
  const fontFamily = buildTerminalFontFamily(userFont);

  const status = toAgentDisplayStatus(tile.agentState, false);
  const agentLabel = agentTypeLabel(tile.agentType);
  const snapshotText = tile.snapshot?.text ?? '';
  const ptyCols = tile.snapshot?.cols ?? null;
  const ptyDims = ptyCols !== null && tile.snapshot?.rows != null
    ? { cols: ptyCols, rows: tile.snapshot.rows }
    : null;
  // A live terminal has to render at the PTY's exact size (rule 1), and the
  // dimensions ride along with the snapshot. Past the snapshot cap there is no
  // snapshot, so promoting would replay the stream into a guessed 80x24 grid
  // and wrap every line. Those tiles stay previews, which is what the footer
  // note already promises.
  // The focused tile keeps its terminal wherever it sits: it holds the keyboard,
  // and dropping it mid-answer would lose what the user was typing.
  const canInteract = tile.isLive && ptyDims !== null;
  const showLive = isLiveView && canInteract && (nearViewport || isFocused);
  // The body's footprint is fixed by the density budget rather than by whatever
  // font either body ended up fitting to, so hovering a tile never makes the
  // grid jump. Both bodies are bottom-anchored inside it, so the trailing rows
  // stay put whichever one is on screen.
  // A terminal shorter than the budget gets only the height it needs, instead
  // of reserving blank space below it.
  const ptyRows = ptyDims?.rows ?? 0;
  const visibleRows = showLive && ptyRows > 0 ? Math.min(ptyRows, snapshotLines) : snapshotLines;
  // Expanding is opt-in. On, the tile grows in place to show the agent's whole
  // grid at a readable size; off, it is typed into exactly where it sits and
  // the grid around it never reflows — the terminal fits itself to the tile
  // instead, and the bottom rows carrying the prompt stay visible.
  const isExpanded = isFocused && expandWhenFocused;
  const bodyHeight = isExpanded
    ? Math.min(Math.max(ptyRows, snapshotLines) * rowHeight(FOCUS_FONT_SIZE_HINT, fontFamily), maxExpandedBodyPx)
    : visibleRows * rowHeight(SNAPSHOT_FONT_SIZE_HINT, fontFamily);
  const lastActivity = formatTimeAgo(tile.snapshot?.lastActivityAt ?? null);
  // Only worth showing when it says something the session name does not.
  const branchLabel = tile.worktreeName && tile.worktreeName !== tile.sessionName
    ? tile.worktreeName
    : null;

  return (
    <article
      ref={registerTileElement}
      className={`group relative flex min-w-0 flex-col overflow-hidden rounded-md border bg-surface-secondary transition-colors ${
        isFocused
          ? 'border-interactive ring-1 ring-interactive/40'
          : isSelected
            ? 'border-interactive/70 ring-1 ring-interactive/20'
            : showLive
              ? 'border-interactive/50'
              : 'border-border-primary hover:border-border-secondary'
      }`}
      // Expanded, the tile takes the whole grid row: the agent's terminal needs
      // that width to stay both correct and readable.
      style={isExpanded ? { gridColumn: '1 / -1' } : undefined}
      onMouseEnter={() => onHoverStart(tile.panelId)}
      onMouseLeave={() => onHoverEnd(tile.panelId)}
    >
      {/* Status accent */}
      <span className={`absolute inset-y-0 left-0 w-0.5 ${ACCENT[status]}`} aria-hidden="true" />

      {/*
        `overflow-hidden` because the chrome on the right is deliberately
        unshrinkable: at a narrow tile the agent badge and the focus controls
        would otherwise paint outside the tile and past the window edge.
      */}
      <header className="flex min-w-0 flex-shrink-0 items-center gap-1.5 overflow-hidden border-b border-border-primary py-1 pl-2.5 pr-2">
        <AgentStatusDot status={status} size="sm" className="flex-shrink-0" />
        <button
          type="button"
          onClick={() => onOpen(tile)}
          onFocus={() => onHoverStart(tile.panelId)}
          onBlur={() => onHoverEnd(tile.panelId)}
          aria-label={`Open ${tile.sessionName} — ${agentLabel} — ${STATUS_TEXT[status]}`}
          title={describeMissionControlTile(tile)}
          className="min-w-0 flex-1 truncate rounded text-left text-[11px] font-medium leading-tight text-text-primary transition-colors hover:text-interactive focus:outline-none focus:ring-1 focus:ring-interactive"
        >
          {tile.sessionName}
        </button>
        {/*
          Within a project the worktree is the session's real identity — three
          sessions on "Super Forum" are only told apart by their branch.
        */}
        {branchLabel && (
          <span
            className="flex min-w-0 max-w-[45%] flex-shrink items-center gap-0.5 text-[9px] text-text-muted"
            title={tile.worktreePath ?? branchLabel}
          >
            <GitBranch className="h-2.5 w-2.5 flex-shrink-0" aria-hidden="true" />
            <span className="truncate">{branchLabel}</span>
          </span>
        )}
        <span
          className="flex-shrink-0 rounded-sm bg-surface-tertiary px-1 text-[9px] uppercase tracking-wide text-text-tertiary"
          aria-hidden="true"
        >
          {agentLabel}
        </span>
        {isFocused && (
          <button
            type="button"
            onClick={() => onCollapse()}
            title={isExpanded ? 'Return this tile to preview size' : 'Stop sending keystrokes to this agent'}
            className="flex flex-shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[9px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
          >
            {isExpanded
              ? <Minimize2 className="h-2.5 w-2.5" aria-hidden="true" />
              : <X className="h-2.5 w-2.5" aria-hidden="true" />}
            {isExpanded ? 'Collapse' : 'Release'}
          </button>
        )}
        {showLive
          ? <Radio className="h-2.5 w-2.5 flex-shrink-0 text-interactive" aria-label="Live" />
          : <TerminalSquare className="h-2.5 w-2.5 flex-shrink-0 text-text-muted" aria-hidden="true" />}
        {/*
          Closing a pane ends a process and drops its scrollback, so it stays
          out of the way until the tile is hovered — and asks first. A permanent
          panel (Pane Chat) has no close action at all: the delete would be
          refused, and offering it invites killing the agent for nothing.
        */}
        {!tile.isPermanent && (
          <button
            type="button"
            onClick={() => onClose(tile)}
            aria-label={`Close ${tile.sessionName}`}
            title="Close this pane"
            className="flex-shrink-0 rounded p-0.5 text-text-muted opacity-0 transition-opacity hover:bg-status-error/15 hover:text-status-error focus-visible:opacity-100 group-hover:opacity-100"
          >
            <Trash2 className="h-2.5 w-2.5" aria-hidden="true" />
          </button>
        )}
      </header>

      {showLive ? (
        <LiveTerminalSurface
          panelId={tile.panelId}
          cols={ptyDims.cols}
          rows={ptyDims.rows}
          height={bodyHeight}
          interactive={isFocused}
          fitWholeGrid={isExpanded}
          sendEscape={sendEscape}
          onEscapeExit={onCollapse}
        />
      ) : (
        <SnapshotSurface
          text={snapshotText}
          height={bodyHeight}
          fontFamily={fontFamily}
          ptyCols={ptyCols}
          isLive={tile.isLive}
        />
      )}

      {/*
        Activation target over the preview — snapshot or read-only terminal
        alike, so a running agent is one click from the keyboard and never
        needs to be hovered into life first. Removed once focused, leaving the
        terminal itself to receive every click and keystroke.
      */}
      {canInteract && !isFocused && (
        <button
          type="button"
          onClick={() => onFocusAgent(tile)}
          aria-label={`Interact with ${tile.sessionName}`}
          title="Click to answer or type"
          className="absolute inset-x-0 bottom-5 top-6 z-10 cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-interactive"
        >
          <span className="sr-only">Interact with {tile.sessionName}</span>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute bottom-1 right-1 flex items-center gap-1 rounded bg-surface-primary/85 px-1.5 py-0.5 text-[9px] text-text-secondary opacity-0 transition-opacity group-hover:opacity-100"
          >
            <Keyboard className="h-2.5 w-2.5" />
            Click to answer
          </span>
        </button>
      )}

      <footer className="flex flex-shrink-0 items-center gap-1.5 border-t border-border-primary py-0.5 pl-2.5 pr-2 text-[9px] text-text-muted">
        {isFocused ? (
          <span className="flex items-center gap-1 font-medium text-interactive">
            <Keyboard className="h-2.5 w-2.5" aria-hidden="true" />
            {sendEscape
              ? 'Typing goes to this agent — Escape is sent to it too'
              : 'Typing goes to this agent — Escape leaves'}
          </span>
        ) : (
          <span className="min-w-0 truncate">{tile.projectName}</span>
        )}
        <span className="ml-auto flex-shrink-0 whitespace-nowrap">
          {tile.isLive ? (lastActivity || STATUS_TEXT[status]) : 'stopped'}
        </span>
      </footer>
    </article>
  );
});
