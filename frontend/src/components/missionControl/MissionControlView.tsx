import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight, CheckSquare, ChevronDown, ChevronRight, LayoutGrid, Loader2,
  RefreshCw, Settings2, Square, X,
} from 'lucide-react';
import { API } from '../../utils/api';
import { panelApi } from '../../services/panelApi';
import { usePanelStore } from '../../stores/panelStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { canTakeKeyboard, describeMissionControlTile, groupMissionControlTiles } from '../../utils/missionControlGrouping';
import { cycleIndex } from '../../utils/arrayUtils';
import { PANE_CHAT_SESSION_ID } from '../../../../shared/types/paneChat';
import { useWindowActive } from '../../hooks/useWindowActive';
import { buildTerminalFontFamily, DEFAULT_TERMINAL_FONT_FAMILY } from '../../utils/terminalTheme';
import { DENSITY_OPTIONS, fitColumns, minTileWidth } from '../../utils/missionControlLayout';
import {
  createRequestGate, pruneSelection, pruneSnapshots, reconcileTileModels,
} from '../../utils/missionControlRoster';
import { useConfigStore } from '../../stores/configStore';
import { AgentStatusDot } from '../ui/AgentStatusDot';
import { Button } from '../ui/Button';
import { Dropdown, type DropdownItem } from '../ui/Dropdown';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../ui/Modal';
import { MissionControlTile } from './MissionControlTile';
import type {
  MissionControlAgentPanel,
  MissionControlDensity,
  MissionControlGrouping,
  MissionControlSnapshot,
  MissionControlTileModel,
} from '../../../../shared/types/missionControl';
import { MAX_MISSION_CONTROL_SNAPSHOT_PANELS } from '../../../../shared/types/missionControl';
import { boundary, decodeBoundary, type BoundarySchema } from '../../../../shared/validation/boundaryDecoder';

/** Snapshot cadence. Fast enough to feel live, slow enough to stay cheap. */
const POLL_INTERVAL_MS = 1500;
/** Debounce before a hovered tile is promoted to a real terminal. */
const PROMOTE_DELAY_MS = 250;
/** Coalescing window for the panel and session events that change the roster. */
const ROSTER_REFRESH_DEBOUNCE_MS = 150;

/** Tile header, footer and the group heading above an expanded tile. */
const EXPANDED_CHROME_PX = 96;
/** Enough to be worth expanding into before the grid has been measured. */
const MIN_EXPANDED_BODY_PX = 320;

const GROUPING_LABELS = {
  project: 'Project',
  status: 'Status',
  agent: 'Agent',
  none: 'None',
} satisfies Record<MissionControlGrouping, string>;

const GROUPING_VALUES: readonly MissionControlGrouping[] = ['project', 'status', 'agent', 'none'];

/**
 * Above this many tiles, "all live" is refused: each live tile is a real xterm
 * instance with its own output subscription, and the DOM renderer's cost grows
 * linearly. Hover mode stays available at any count.
 */
const MAX_LIVE_ALL_TILES = 12;

/** Lower density = larger tiles, so more of each terminal is worth fetching. */
const LINES_BY_DENSITY = { 1: 32, 2: 24, 3: 16, 4: 10 } satisfies Record<MissionControlDensity, number>;

/**
 * View options that outlive a visit. Both answer "what does my Mission Control
 * look like", which is a property of the user's workflow rather than of this
 * session: whether answering an agent should enlarge its tile, and which
 * project groups are folded away because nothing there needs attention today.
 */
const EXPAND_ON_FOCUS_KEY = 'pane.missionControl.expandOnFocus';
const COLLAPSED_GROUPS_KEY = 'pane.missionControl.collapsedGroups';
const SEND_ESCAPE_KEY = 'pane.missionControl.sendEscape';
const GROUPING_KEY = 'pane.missionControl.grouping';
const DENSITY_KEY = 'pane.missionControl.density';

const groupingSchema = boundary.enumeration('project', 'status', 'agent', 'none');
const densitySchema = boundary.enumeration(1, 2, 3, 4);
const collapsedGroupsSchema = boundary.array(boundary.string);

/**
 * Stored options are decoded, not cast: a value written by an older build, or
 * edited by hand, otherwise reaches layout maths as `NaN` tile heights or a
 * non-iterable group set that throws during render.
 */
function readStoredOption<T>(key: string, fallback: T, schema: BoundarySchema<T>): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : decodeBoundary(JSON.parse(raw), schema);
  } catch {
    // Corrupt or unavailable storage must never keep the view from rendering.
    return fallback;
  }
}

/** A `useState` whose value survives the visit, written on set rather than by effect. */
function usePersistedOption<T>(
  key: string,
  fallback: T,
  schema: BoundarySchema<T>,
): [T, (value: T | ((current: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => readStoredOption(key, fallback, schema));
  // The setter is the only writer, so this stays level with `value` without
  // being touched during render, and it keeps the storage write out of the
  // state updater, which has to stay pure.
  const latest = useRef(value);

  const set = useCallback((next: T | ((current: T) => T)) => {
    const resolved = next instanceof Function ? next(latest.current) : next;
    latest.current = resolved;
    writeStoredOption(key, resolved);
    setValue(resolved);
  }, [key]);

  return [value, set];
}

/** Grid movement for the arrow keys; a row is one density's worth of tiles. */
function arrowStep(key: string, density: MissionControlDensity): number | undefined {
  switch (key) {
    case 'ArrowRight': return 1;
    case 'ArrowLeft': return -1;
    case 'ArrowDown': return density;
    case 'ArrowUp': return -density;
    default: return undefined;
  }
}

function writeStoredOption<T>(key: string, value: T): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or a locked-down profile — the option just stays session-only.
  }
}

/** One count pill: the blocked variant becomes a button when it can act. */
function StatusCountPill({ status, count, label, compact, onClick, title }: {
  status: 'blocked' | 'working';
  count: number;
  label: string;
  compact?: boolean;
  onClick?: () => void;
  title?: string;
}) {
  if (count === 0) return null;

  const tone = status === 'blocked'
    ? 'bg-status-error/15 text-status-error'
    : 'bg-interactive/15 text-interactive';
  const className = `flex items-center gap-1 rounded-full px-2 py-px text-[10px] font-medium ${tone}${
    compact ? ' normal-case tracking-normal' : ''
  }${onClick ? ' transition-colors hover:bg-status-error/25 focus:outline-none focus-visible:ring-1 focus-visible:ring-status-error' : ''}`;

  const body = (
    <>
      <AgentStatusDot status={status} size="sm" />
      {count} {label}
      {onClick && <ArrowRight className="h-2.5 w-2.5" aria-hidden="true" />}
    </>
  );

  if (onClick) {
    return <button type="button" onClick={onClick} title={title} className={className}>{body}</button>;
  }
  return <span className={className}>{body}</span>;
}

/** The Group and Columns pickers: same markup, different option lists. */
function SegmentedControl<T extends string | number>({ legend, label, options, value, onChange, render, optionLabel }: {
  legend: string;
  label: string;
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  render: (option: T) => string;
  optionLabel?: (option: T) => string;
}) {
  // A `fieldset` keeps a `min-inline-size: min-content` floor, so at a narrow
  // window it refuses to shrink and its buttons paint past the edge. A group
  // role carries the same grouping semantics without the layout floor.
  return (
    <div role="group" aria-label={legend} className="flex min-w-0 flex-wrap items-center gap-1">
      <span className="text-[10px] uppercase tracking-wider text-text-muted">{label}</span>
      {options.map(option => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          aria-label={optionLabel?.(option)}
          onClick={() => onChange(option)}
          className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
            value === option
              ? 'bg-interactive text-text-on-interactive'
              : 'text-text-secondary hover:bg-surface-hover'
          }`}
        >
          {render(option)}
        </button>
      ))}
    </div>
  );
}

/**
 * Live grid of every agent pane across every session and project.
 *
 * Tiles poll a batched, ANSI-stripped snapshot while this view is visible, and
 * exactly one tile at a time is promoted to a real read-only terminal on hover
 * or focus. That cap is deliberate: xterm instances sharing a font and theme
 * share a WebGL texture atlas, and a grid of live terminals would exhaust
 * Chromium's GL contexts (see `TerminalPanel`'s header comment).
 */
export function MissionControlView() {
  const [agents, setAgents] = useState<MissionControlAgentPanel[]>([]);
  const [snapshots, setSnapshots] = useState<Record<string, MissionControlSnapshot>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [grouping, setGrouping] = usePersistedOption(GROUPING_KEY, 'project', groupingSchema);
  const [density, setDensity] = usePersistedOption(DENSITY_KEY, 3, densitySchema);
  const [liveTileId, setLiveTileId] = useState<string | null>(null);
  const [liveAll, setLiveAll] = useState(false);
  /** Panel currently open in the full-size interactive view, if any. */
  const [focusedPanelId, setFocusedPanelId] = useState<string | null>(null);
  /** The grid's roving keyboard cursor — selection, not focus. */
  const [selectedPanelId, setSelectedPanelId] = useState<string | null>(null);
  /** Tile awaiting a close confirmation. */
  const [pendingClose, setPendingClose] = useState<MissionControlTileModel | null>(null);
  const [closing, setClosing] = useState(false);
  /** A failed action, shown beside the grid rather than in place of it. */
  const [actionError, setActionError] = useState<string | null>(null);
  /**
   * Whether answering an agent enlarges its tile. Off, the tile keeps its size
   * and simply takes the keyboard — better when the grid layout itself is the
   * thing being watched.
   */
  const [expandOnFocus, setExpandOnFocus] = usePersistedOption(EXPAND_ON_FOCUS_KEY, true, boundary.boolean);
  const [collapsedGroupKeys, setCollapsedGroupKeys] = usePersistedOption<string[]>(
    COLLAPSED_GROUPS_KEY, [], collapsedGroupsSchema
  );
  /**
   * Whether Escape reaches the agent. Off, it leaves typing mode instead —
   * the usual intent in a grid, and unlike an interrupt it can be undone by
   * clicking the tile again.
   */
  const [sendEscape, setSendEscape] = usePersistedOption(SEND_ESCAPE_KEY, false, boundary.boolean);

  const promoteTimerRef = useRef<number | undefined>(undefined);
  const inFlightRef = useRef(false);
  /** Roster loads overlap; only the newest one gets to set the roster. */
  const rosterGateRef = useRef(createRequestGate());
  /** Coalesces a burst of panel and session events into one reload. */
  const rosterRefreshTimerRef = useRef<number | undefined>(undefined);
  /** Display order captured when a tile took the keyboard; see handleFocusAgent. */
  const frozenOrderRef = useRef<{ groups: string[]; tiles: string[] } | null>(null);
  /** Tile elements, so keyboard navigation can scroll a selection into view. */
  const tileElementsRef = useRef(new Map<string, HTMLElement>());
  const gridScrollerRef = useRef<HTMLDivElement | null>(null);
  const [gridWidth, setGridWidth] = useState(0);
  const [gridHeight, setGridHeight] = useState(0);

  const agentStatus = usePanelStore(state => state.agentStatus);
  const setActiveSession = useSessionStore(state => state.setActiveSession);
  const setActivePanelInStore = usePanelStore(state => state.setActivePanel);
  const removePanel = usePanelStore(state => state.removePanel);
  const activeView = useNavigationStore(state => state.activeView);
  /**
   * Idle cost follows the terminal power mode, the same setting `TerminalPanel`
   * reads, rather than a policy of this view's own.
   *
   * Performance keeps mounted terminals live, so the grid keeps polling and
   * keeps its hovered tile while the window sits behind something else. Battery
   * Saver suspends inactive rendering, so losing focus drops the live tile
   * (an xterm streaming PTY output is the expensive part) and stops the poll.
   */
  const { visible: windowVisible, focused: windowFocused } = useWindowActive();
  const terminalPowerMode = useConfigStore(state => state.config?.terminalPowerMode ?? 'performance');
  const userTerminalFont = useConfigStore(state => state.config?.terminalFontFamily) || DEFAULT_TERMINAL_FONT_FAMILY;
  const terminalFontFamily = buildTerminalFontFamily(userTerminalFont);
  const batterySaver = terminalPowerMode === 'batterySaver';
  const attentive = windowVisible && (windowFocused || !batterySaver);
  const navigateToSessions = useNavigationStore(state => state.navigateToSessions);
  const navigateToPaneChat = useNavigationStore(state => state.navigateToPaneChat);

  // Measured once per font rather than per group: the measurement touches the
  // DOM, and every group's column count asks for it.
  const tileWidth = useMemo(() => minTileWidth(terminalFontFamily), [terminalFontFamily]);
  // The stored density is what the user asked for; this is what fits. Also the
  // step the arrow keys move by, so it is counted over the whole grid rather
  // than per group.
  const columns = fitColumns(density, gridWidth, tileWidth, agents.length);
  const snapshotLines = LINES_BY_DENSITY[columns];
  // What is left for an expanded tile's terminal once its own chrome and the
  // group header above it are out of the way. Floored rather than allowed to
  // reach zero: on the frame before the grid reports its size there is no
  // measurement yet, and a zero ceiling would collapse the body.
  const maxExpandedBodyPx = Math.max(gridHeight - EXPANDED_CHROME_PX, MIN_EXPANDED_BODY_PX);

  useEffect(() => {
    const scroller = gridScrollerRef.current;
    if (!scroller) return;
    const observer = new ResizeObserver(([entry]) => {
      setGridWidth(entry.contentRect.width);
      setGridHeight(entry.contentRect.height);
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  const loadAgents = useCallback(async () => {
    // Request-owned: status churn, panel events and the refresh button can all
    // start a load, and over a remote daemon they do not come back in order. An
    // older roster landing last resurrects agents that are already gone.
    const isCurrent = rosterGateRef.current.start();
    try {
      const response = await API.missionControl.listAgents();
      if (!isCurrent()) return;
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Failed to list agents');
      }
      setAgents(response.data);
      setError(null);
    } catch (err: unknown) {
      if (!isCurrent()) return;
      setError(err instanceof Error ? err.message : 'Failed to list agents');
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, []);

  /**
   * Reload the roster after the events that change it, coalesced.
   *
   * Archiving a session deletes its panes one at a time, so a burst of five
   * `panel:deleted` events would otherwise be five list calls racing each
   * other.
   */
  const scheduleRosterRefresh = useCallback(() => {
    window.clearTimeout(rosterRefreshTimerRef.current);
    rosterRefreshTimerRef.current = window.setTimeout(() => { void loadAgents(); }, ROSTER_REFRESH_DEBOUNCE_MS);
  }, [loadAgents]);

  // Agents appearing or disappearing shows up as agent-status churn; refresh
  // the roster on it rather than polling the (heavier) list endpoint. This also
  // covers the initial load, since the effect runs on mount.
  // Values, not just keys: an agent that exits keeps its panel id and only
  // changes state, and the roster is where `isLive` comes from. Watching the
  // key set alone left a finished agent's tile live and interactive until
  // something else forced a reload.
  const agentStatusSignature = useMemo(
    () => Object.entries(agentStatus).sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, state]) => `${id}:${state}`).join(','),
    [agentStatus]
  );
  useEffect(() => {
    void loadAgents();
  }, [agentStatusSignature, loadAgents]);

  /**
   * Panels and sessions that come and go without touching agent status.
   *
   * Deleting a pane from RunPane, or archiving a session from the sidebar,
   * removes the PTY and the panel but leaves the status map exactly as it was —
   * the signature above never changes, so the roster never reloaded and the
   * dead pane's tile sat there saying "Waiting for output..." until something
   * unrelated forced a refresh. These events are the only notice the grid gets.
   */
  useEffect(() => {
    const events = window.electronAPI?.events;
    const unsubscribes = [
      events?.onPanelCreated?.(scheduleRosterRefresh),
      events?.onPanelDeleted?.(scheduleRosterRefresh),
      events?.onSessionCreated?.(scheduleRosterRefresh),
      events?.onSessionUpdated?.(scheduleRosterRefresh),
      events?.onSessionDeleted?.(scheduleRosterRefresh),
    ];
    return () => {
      window.clearTimeout(rosterRefreshTimerRef.current);
      for (const unsubscribe of unsubscribes) unsubscribe?.();
    };
  }, [scheduleRosterRefresh]);

  // Nothing in flight may set state after this view is gone.
  useEffect(() => {
    const gate = rosterGateRef.current;
    return () => gate.abandon();
  }, []);

  /** The panels the roster still knows about. */
  const rosterPanelIds = useMemo(
    () => new Set(agents.map(agent => agent.panelId)),
    [agents]
  );

  const canLiveAll = agents.length <= MAX_LIVE_ALL_TILES;
  const liveAllActive = liveAll && canLiveAll;

  /**
   * Tile models, reusing the previous object wherever nothing on a tile moved.
   *
   * One agent's new output changes one snapshot; rebuilding all sixty-four
   * models for it would make every memoised tile re-render, which is the whole
   * grid doing React work because one terminal printed a line.
   */
  const tilesRef = useRef<MissionControlTileModel[]>([]);
  const tiles: MissionControlTileModel[] = useMemo(
    () => {
      const next = reconcileTileModels(tilesRef.current, agents, agentStatus, snapshots);
      tilesRef.current = next;
      return next;
    },
    [agents, agentStatus, snapshots]
  );

  const groups = useMemo(() => groupMissionControlTiles(tiles, grouping), [tiles, grouping]);

  const collapsedGroups = useMemo(() => new Set(collapsedGroupKeys), [collapsedGroupKeys]);

  /**
   * `groups` in the order the user last saw them while typing.
   *
   * Content still updates — only the running order is pinned, and anything new
   * lands at the end rather than shuffling what is already on screen.
   */
  const displayedGroups = useMemo(() => {
    const frozen = focusedPanelId ? frozenOrderRef.current : null;
    if (!frozen) return groups;

    const groupRank = new Map(frozen.groups.map((key, index) => [key, index]));
    const tileRank = new Map(frozen.tiles.map((key, index) => [key, index]));
    const rankOf = (order: Map<string, number>, key: string) => order.get(key) ?? Number.MAX_SAFE_INTEGER;

    return [...groups]
      .sort((a, b) => rankOf(groupRank, a.key) - rankOf(groupRank, b.key))
      .map(group => ({
        ...group,
        tiles: [...group.tiles].sort(
          (a, b) => rankOf(tileRank, a.panelId) - rankOf(tileRank, b.panelId)
        ),
      }));
  }, [groups, focusedPanelId]);

  // A folded-away group costs nothing: its panels leave the snapshot batch, so
  // the emulators behind them are never woken for a tile nobody can see.
  /** Every tile on screen, in reading order, ignoring folded groups. */
  const visibleTiles = useMemo(() => {
    const tilesInOrder: MissionControlTileModel[] = [];
    for (const group of displayedGroups) {
      if (collapsedGroups.has(group.key)) continue;
      tilesInOrder.push(...group.tiles);
    }
    return tilesInOrder;
  }, [displayedGroups, collapsedGroups]);

  const panelIds = useMemo(() => {
    const ids: string[] = [];
    // The tile being typed into always makes the batch: it needs the PTY
    // dimensions that ride with a snapshot, and losing them would unmount its
    // terminal mid-keystroke once the grid grows past the cap.
    if (focusedPanelId) ids.push(focusedPanelId);
    for (const tile of visibleTiles) {
      if (ids.length >= MAX_MISSION_CONTROL_SNAPSHOT_PANELS) break;
      if (tile.panelId !== focusedPanelId) ids.push(tile.panelId);
    }
    return ids;
  }, [visibleTiles, focusedPanelId]);
  // Sorted: the set is what the poll depends on, but `groups` reorders on any
  // status change, and an order-sensitive key restarted the interval on
  // ordinary churn.
  const panelIdsKey = [...panelIds].sort().join(',');

  // Poll snapshots only while this view is actually on screen. A background
  // poll would keep every agent's emulator warm for nothing.
  useEffect(() => {
    if (activeView !== 'mission-control' || panelIds.length === 0 || !attentive) return;

    let cancelled = false;

    const tick = async () => {
      if (cancelled || inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const response = await API.missionControl.snapshots({ panelIds, maxLines: snapshotLines });
        if (cancelled || !response.success || !response.data) return;
        const incoming = response.data.snapshots;
        setSnapshots(current => {
          const next: Record<string, MissionControlSnapshot> = {};
          let changed = incoming.length !== Object.keys(current).length;
          for (const snapshot of incoming) {
            const previous = current[snapshot.panelId];
            // Keep the previous object when nothing a tile renders has moved:
            // a fresh object every tick re-renders every tile for nothing.
            const same = previous
              && previous.text === snapshot.text
              && previous.cols === snapshot.cols
              && previous.rows === snapshot.rows
              && previous.lastActivityAt === snapshot.lastActivityAt;
            next[snapshot.panelId] = same ? previous : snapshot;
            if (!same) changed = true;
          }
          return changed ? next : current;
        });
      } catch {
        // A dropped poll is not worth surfacing; the next tick retries.
      } finally {
        inFlightRef.current = false;
      }
    };

    void tick();
    // With every tile live, snapshots only still matter for stopped panels and
    // for PTY dimension changes, so the poll can back right off.
    // Battery Saver has already stopped the poll by the time focus is gone, and
    // Performance is meant to keep going, so blur does not change the cadence.
    const timer = window.setInterval(() => { void tick(); }, liveAllActive ? POLL_INTERVAL_MS * 6 : POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      // Release the in-flight guard with the effect: a request that never
      // settles would otherwise leave it set and make every later tick a no-op.
      inFlightRef.current = false;
      window.clearInterval(timer);
    };
    // panelIdsKey stands in for panelIds so a re-render with the same ids does
    // not restart the interval.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView, panelIdsKey, snapshotLines, liveAllActive, attentive]);

  // Battery Saver drops the hover promotion on blur; the focused tile keeps its
  // terminal either way, so alt-tabbing mid-answer never throws the keyboard
  // away. Performance leaves live tiles alone, as it does for panels.
  useEffect(() => {
    if (batterySaver && !windowFocused) setLiveTileId(null);
  }, [batterySaver, windowFocused]);

  const statusSummary = useMemo(() => ({
    blocked: tiles.filter(tile => tile.agentState === 'blocked').length,
    working: tiles.filter(tile => tile.agentState === 'working').length,
  }), [tiles]);

  // In "all live" mode hover is irrelevant — every tile is already live.
  const handleHoverStart = useCallback((panelId: string) => {
    if (liveAllActive) return;
    // The focused tile is already live and owns the keyboard.
    if (focusedPanelId === panelId) return;
    window.clearTimeout(promoteTimerRef.current);
    promoteTimerRef.current = window.setTimeout(() => setLiveTileId(panelId), PROMOTE_DELAY_MS);
  }, [liveAllActive, focusedPanelId]);

  const handleHoverEnd = useCallback((panelId: string) => {
    if (liveAllActive) return;
    // The focused tile keeps the keyboard even when the pointer leaves it.
    if (focusedPanelId === panelId) return;
    window.clearTimeout(promoteTimerRef.current);
    setLiveTileId(current => (current === panelId ? null : current));
  }, [liveAllActive, focusedPanelId]);

  useEffect(() => () => window.clearTimeout(promoteTimerRef.current), []);

  const handleFocusAgent = useCallback((tile: MissionControlTileModel) => {
    window.clearTimeout(promoteTimerRef.current);
    // Tiles are ordered by urgency, so answering an agent changes its state and
    // re-sorts the grid underneath the pointer — the tile the user is typing
    // into jumps to another column and back. Pin the running order for as long
    // as someone is typing.
    frozenOrderRef.current = {
      groups: groups.map(group => group.key),
      tiles: groups.flatMap(group => group.tiles.map(member => member.panelId)),
    };
    setFocusedPanelId(tile.panelId);
    // Keep it live regardless of where the pointer goes: demoting to a
    // snapshot mid-typing would drop the keyboard.
    setLiveTileId(tile.panelId);
  }, [groups]);

  // The frozen order is only ever read while a tile is focused, so releasing
  // focus is the whole of what this needs to do.
  const handleCloseFocus = useCallback(() => setFocusedPanelId(null), []);

  /**
   * Fold a group away, or bring it back.
   *
   * Hiding the group that holds the focused tile also releases the keyboard:
   * an agent nobody can see must not keep receiving what the user types.
   */
  const handleToggleGroup = useCallback((groupKey: string) => {
    const group = groups.find(candidate => candidate.key === groupKey);
    const isCollapsing = !collapsedGroups.has(groupKey);

    if (isCollapsing && group?.tiles.some(tile => tile.panelId === focusedPanelId)) {
      setFocusedPanelId(null);
      setLiveTileId(null);
    }

    setCollapsedGroupKeys(current => (
      current.includes(groupKey)
        ? current.filter(key => key !== groupKey)
        : [...current, groupKey]
    ));
  }, [groups, collapsedGroups, focusedPanelId, setCollapsedGroupKeys]);

  /**
   * Forget everything about a panel that has left the roster.
   *
   * A pane deleted through RunPane, or a session archived from the sidebar,
   * takes its PTY with it. Whatever the view was still holding by that panel's
   * id — the keyboard, the live terminal, the roving cursor, an open close
   * confirmation, its last snapshot, its element — refers to something that no
   * longer exists, and a close confirmation left open would fail on confirm.
   */
  useEffect(() => {
    const pruned = pruneSelection({
      focusedPanelId,
      liveTileId,
      selectedPanelId,
      pendingClosePanelId: pendingClose?.panelId ?? null,
    }, rosterPanelIds);

    if (pruned.focusedPanelId !== focusedPanelId) setFocusedPanelId(pruned.focusedPanelId);
    if (pruned.liveTileId !== liveTileId) setLiveTileId(pruned.liveTileId);
    if (pruned.selectedPanelId !== selectedPanelId) setSelectedPanelId(pruned.selectedPanelId);
    if (pruned.pendingClosePanelId === null && pendingClose) setPendingClose(null);

    setSnapshots(current => pruneSnapshots(current, rosterPanelIds));
    for (const panelId of [...tileElementsRef.current.keys()]) {
      if (!rosterPanelIds.has(panelId)) tileElementsRef.current.delete(panelId);
    }
  }, [rosterPanelIds, focusedPanelId, liveTileId, selectedPanelId, pendingClose]);

  // Drop the hover promotion when switching into all-live so the two modes
  // never both own a terminal for the same panel.
  useEffect(() => {
    if (liveAllActive) setLiveTileId(null);
  }, [liveAllActive]);

  /**
   * Open the agent this tile represents.
   *
   * The active panel is persisted *before* navigating: `SessionView` reloads a
   * session's panels on activation and takes the active panel from the
   * backend, which would otherwise immediately overwrite a client-only
   * selection and land the user on whatever panel was last open.
   */
  const handleOpen = useCallback(async (tile: MissionControlTileModel) => {
    setLiveTileId(null);
    // Pane Chat is listed here but is not a session in the sidebar, so the
    // sessions view would land on something the user cannot see.
    if (tile.sessionId === PANE_CHAT_SESSION_ID) {
      navigateToPaneChat();
      return;
    }
    try {
      await panelApi.setActivePanel(tile.sessionId, tile.panelId);
    } catch {
      // Fall through: the session still opens, just on its stored panel.
    }
    setActivePanelInStore(tile.sessionId, tile.panelId);
    await setActiveSession(tile.sessionId);
    navigateToSessions();
  }, [setActiveSession, setActivePanelInStore, navigateToSessions, navigateToPaneChat]);

  const handleOpenTile = useCallback((tile: MissionControlTileModel) => {
    void handleOpen(tile);
  }, [handleOpen]);

  // --- Keyboard navigation ---

  const registerTileElement = useCallback((panelId: string, element: HTMLElement | null) => {
    if (element) tileElementsRef.current.set(panelId, element);
    else tileElementsRef.current.delete(panelId);
  }, []);

  const revealTile = useCallback((panelId: string) => {
    tileElementsRef.current.get(panelId)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, []);

  const selectTile = useCallback((panelId: string) => {
    setSelectedPanelId(panelId);
    revealTile(panelId);
  }, [revealTile]);

  /**
   * Take the user to the next agent that is waiting on them.
   *
   * The whole point of Mission Control is answering agents; without this, finding the
   * one that is blocked means scanning a wall of tiles for a red dot.
   */
  const jumpToNextBlocked = useCallback(() => {
    const blocked = visibleTiles.filter(tile => tile.agentState === 'blocked');
    if (blocked.length === 0) return;

    const anchor = focusedPanelId ?? selectedPanelId;
    const currentIndex = blocked.findIndex(tile => tile.panelId === anchor);
    const next = blocked[cycleIndex(currentIndex, blocked.length, 'next')];

    selectTile(next.panelId);
    if (canTakeKeyboard(next)) handleFocusAgent(next);
  }, [visibleTiles, focusedPanelId, selectedPanelId, selectTile, handleFocusAgent]);

  /**
   * Arrows move a selection across the grid, Enter hands it the keyboard.
   *
   * Bound on the document rather than the grid so it works without clicking
   * first, and disabled the moment a tile is focused — those keys belong to the
   * agent then, and Escape is already spoken for.
   */
  useEffect(() => {
    if (activeView !== 'mission-control') return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (focusedPanelId || pendingClose) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      // SAFETY: The registered DOM-event source establishes this target shape.
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? '')) return;
      if (visibleTiles.length === 0) return;

      if (event.key.toLowerCase() === 'n') {
        event.preventDefault();
        jumpToNextBlocked();
        return;
      }

      const index = visibleTiles.findIndex(tile => tile.panelId === selectedPanelId);
      const step = arrowStep(event.key, columns);

      if (step !== undefined) {
        event.preventDefault();
        // Nothing selected yet: the first arrow lands on the first tile.
        const nextIndex = index === -1
          ? 0
          : Math.min(Math.max(index + step, 0), visibleTiles.length - 1);
        selectTile(visibleTiles[nextIndex].panelId);
        return;
      }

      if (event.key === 'Enter' && index !== -1) {
        const tile = visibleTiles[index];
        if (!canTakeKeyboard(tile)) return;
        event.preventDefault();
        handleFocusAgent(tile);
        return;
      }

      if (event.key === 'Escape' && selectedPanelId) {
        event.preventDefault();
        setSelectedPanelId(null);
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [
    activeView, focusedPanelId, pendingClose, visibleTiles, selectedPanelId,
    columns, selectTile, handleFocusAgent, jumpToNextBlocked,
  ]);

  const viewOptionItems: DropdownItem[] = useMemo(() => [
    {
      id: 'expand-on-click',
      label: 'Expand on click',
      description: expandOnFocus
        ? 'Clicking an agent enlarges its tile to the agent’s full screen'
        : 'Tiles keep their size and simply take the keyboard',
      icon: expandOnFocus ? CheckSquare : Square,
      onClick: () => setExpandOnFocus(current => !current),
    },
    {
      id: 'send-escape',
      label: 'Send Escape',
      description: sendEscape
        ? 'Escape reaches the agent, as in its own terminal'
        : 'Escape leaves typing mode and gives the keyboard back',
      icon: sendEscape ? CheckSquare : Square,
      onClick: () => setSendEscape(current => !current),
    },
    {
      id: 'all-live',
      label: 'All live',
      description: canLiveAll
        ? 'Render every agent as a live terminal instead of on hover'
        : `Only available with ${MAX_LIVE_ALL_TILES} agents or fewer`,
      icon: liveAllActive ? CheckSquare : Square,
      disabled: !canLiveAll,
      onClick: () => setLiveAll(current => !current),
    },
  ], [expandOnFocus, sendEscape, liveAllActive, canLiveAll, setExpandOnFocus, setSendEscape]);

  // --- Closing a pane ---

  const handleConfirmClose = useCallback(async () => {
    const tile = pendingClose;
    if (!tile) return;

    setClosing(true);
    try {
      await panelApi.deletePanel(tile.panelId);
      setActionError(null);
      // `removePanel` is what the other delete sites call: it forgets the
      // panel's agent status, activity and list entry together. Clearing only
      // the status here left the rest behind, and a stale blocked entry wedged
      // the sidebar's "needs input" badge.
      removePanel(tile.sessionId, tile.panelId);
      if (focusedPanelId === tile.panelId) handleCloseFocus();
      setLiveTileId(current => (current === tile.panelId ? null : current));
      setSelectedPanelId(current => (current === tile.panelId ? null : current));
      setPendingClose(null);
      await loadAgents();
    } catch (err: unknown) {
      // Not `setError`: that swaps the entire grid for an error panel, so one
      // failed close would take every tile off screen.
      setActionError(err instanceof Error ? err.message : 'Failed to close the pane');
      setPendingClose(null);
    } finally {
      setClosing(false);
    }
  }, [pendingClose, focusedPanelId, handleCloseFocus, loadAgents, removePanel]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-bg-primary">
      <header className="flex flex-shrink-0 flex-wrap items-center gap-3 border-b border-border-primary bg-surface-secondary px-4 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <LayoutGrid className="h-4 w-4 flex-shrink-0 text-text-tertiary" aria-hidden="true" />
          <h1 className="truncate text-sm font-medium text-text-primary">Mission Control</h1>
          <span className="text-[11px] text-text-tertiary">
            {tiles.length} {tiles.length === 1 ? 'agent' : 'agents'}
          </span>

          {/*
            At-a-glance roll-up, and the fastest way to act on it: the blocked
            count is the button that takes you to the next waiting agent.
          */}
          <StatusCountPill
            status="blocked"
            count={statusSummary.blocked}
            label="need input"
            onClick={jumpToNextBlocked}
            title="Go to the next agent waiting for you (N)"
          />
          <StatusCountPill status="working" count={statusSummary.working} label="working" />

          {/* A failed action reports beside the grid, never in place of it. */}
          {actionError && (
            <button
              type="button"
              onClick={() => setActionError(null)}
              title="Dismiss"
              className="flex items-center gap-1 rounded-full bg-status-error/15 px-2 py-px text-[10px] font-medium text-status-error transition-colors hover:bg-status-error/25"
            >
              {actionError}
              <X className="h-2.5 w-2.5" aria-hidden="true" />
            </button>
          )}
        </div>

        <div className="ml-auto flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
          <SegmentedControl
            legend="Group agents by"
            label="Group"
            options={GROUPING_VALUES}
            value={grouping}
            onChange={setGrouping}
            render={value => GROUPING_LABELS[value]}
          />

          <SegmentedControl
            legend="Tiles per row"
            label="Columns"
            options={DENSITY_OPTIONS}
            value={density}
            onChange={setDensity}
            render={option => `${option}×`}
            optionLabel={option => `${option} tiles per row`}
          />

          {/*
            Group and Columns are changed constantly and stay on the bar; these
            three are set once and would otherwise crowd it out.
          */}
          <Dropdown
            position="bottom-right"
            width="lg"
            closeOnSelect={false}
            items={viewOptionItems}
            trigger={
              <button
                type="button"
                aria-label="View options"
                title="View options"
                className="rounded p-1 transition-colors hover:bg-surface-hover"
              >
                <Settings2 className="h-3.5 w-3.5 text-text-tertiary" aria-hidden="true" />
              </button>
            }
          />

          <button
            type="button"
            onClick={() => { void loadAgents(); }}
            aria-label="Refresh agent list"
            className="rounded p-1 transition-colors hover:bg-surface-hover"
          >
            <RefreshCw className="h-3.5 w-3.5 text-text-tertiary" aria-hidden="true" />
          </button>
        </div>
      </header>

      <div ref={gridScrollerRef} className="min-h-0 flex-1 overflow-auto p-3">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-xs text-text-tertiary">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Finding agents…
          </div>
        ) : error ? (
          <div className="rounded border border-status-error/30 bg-status-error/10 p-4 text-sm text-status-error">
            {error}
          </div>
        ) : tiles.length === 0 ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-text-secondary">
            No agent panes yet. Start Claude or Codex in a session and it will appear here.
          </div>
        ) : (
          displayedGroups.map(group => {
            // Grouping "none" is one unlabelled bucket: no header, nothing to
            // fold it into.
            const isCollapsible = grouping !== 'none';
            const isCollapsed = isCollapsible && collapsedGroups.has(group.key);
            const blockedInGroup = group.tiles.filter(tile => tile.agentState === 'blocked').length;
            const workingInGroup = group.tiles.filter(tile => tile.agentState === 'working').length;

            return (
              <section key={group.key} className="mb-5 last:mb-0">
                {isCollapsible && (
                  <h2 className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
                    <button
                      type="button"
                      onClick={() => handleToggleGroup(group.key)}
                      aria-expanded={!isCollapsed}
                      title={isCollapsed ? `Show ${group.label}` : `Hide ${group.label}`}
                      className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 transition-colors hover:bg-surface-hover hover:text-text-secondary focus:outline-none focus-visible:ring-1 focus-visible:ring-interactive"
                    >
                      {isCollapsed
                        ? <ChevronRight className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
                        : <ChevronDown className="h-3 w-3 flex-shrink-0" aria-hidden="true" />}
                      <span className="truncate">{group.label}</span>
                      <span className="rounded-full bg-surface-tertiary px-1.5 text-[10px] tabular-nums text-text-muted">
                        {group.tiles.length}
                      </span>
                    </button>
                    {/*
                      Counts rather than a bare total, so a folded group says
                      exactly as much as an open one.
                    */}
                    <StatusCountPill status="blocked" count={blockedInGroup} label="waiting" compact />
                    <StatusCountPill status="working" count={workingInGroup} label="working" compact />
                    <span className="h-px flex-1 bg-border-primary" aria-hidden="true" />
                  </h2>
                )}
                {!isCollapsed && (
                  <div
                    className="grid items-start gap-2.5"
                    // Counted per group: a project with one agent gets one wide
                    // tile rather than a third of a row and two thirds of
                    // nothing.
                    style={{
                      gridTemplateColumns: `repeat(${
                        fitColumns(density, gridWidth, tileWidth, group.tiles.length)
                      }, minmax(0, 1fr))`,
                    }}
                  >
                    {group.tiles.map(tile => (
                      <MissionControlTile
                        key={tile.panelId}
                        tile={tile}
                        // The focused tile stays live no matter where the pointer
                        // goes: hovering a neighbour used to demote it back to a
                        // snapshot mid-typing, taking the keyboard with it.
                        isLiveView={liveAllActive || liveTileId === tile.panelId || focusedPanelId === tile.panelId}
                        onHoverStart={handleHoverStart}
                        onHoverEnd={handleHoverEnd}
                        onOpen={handleOpenTile}
                        snapshotLines={snapshotLines}
                        maxExpandedBodyPx={maxExpandedBodyPx}
                        isFocused={focusedPanelId === tile.panelId}
                        expandWhenFocused={expandOnFocus}
                        sendEscape={sendEscape}
                        isSelected={selectedPanelId === tile.panelId}
                        registerElement={registerTileElement}
                        onFocusAgent={handleFocusAgent}
                        onCollapse={handleCloseFocus}
                        onClose={setPendingClose}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })
        )}

        {agents.length > MAX_MISSION_CONTROL_SNAPSHOT_PANELS && (
          <p className="pt-2 text-[11px] text-text-muted">
            Live previews are limited to the first {MAX_MISSION_CONTROL_SNAPSHOT_PANELS} agents.
          </p>
        )}
      </div>

      {/*
        Closing kills the agent's process and drops its scrollback, and a stray
        click on a small icon must not be able to do that silently.
      */}
      <Modal
        isOpen={pendingClose !== null}
        onClose={() => setPendingClose(null)}
        size="sm"
        ariaLabel="Close pane"
        showCloseButton={false}
      >
        <ModalHeader
          title="Close this pane?"
          description={pendingClose ? describeMissionControlTile(pendingClose) : undefined}
        />
        <ModalBody>
          <p className="text-sm text-text-secondary">
            The agent process is stopped and this pane’s terminal history is deleted.
            The session and its worktree stay untouched.
          </p>
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" size="sm" onClick={() => setPendingClose(null)} disabled={closing}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => { void handleConfirmClose(); }}
            disabled={closing}
          >
            {closing ? 'Closing…' : 'Close pane'}
          </Button>
        </ModalFooter>
      </Modal>
    </div>
  );
}
