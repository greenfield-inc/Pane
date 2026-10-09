import type { AgentState } from '../../../shared/types/agentStatus';
import type {
  MissionControlAgentPanel,
  MissionControlSnapshot,
  MissionControlTileModel,
} from '../../../shared/types/missionControl';

/**
 * Keeping the grid's model honest as panels come and go.
 *
 * Mission Control watches agents it does not own. A pane can be deleted from
 * RunPane, a session archived from the sidebar, a project closed — all while
 * the grid is open and none of it routed through the grid. Two things have to
 * survive that: the roster must stop showing what is gone, and everything the
 * view remembers *about* what is gone must be forgotten with it, or a tile that
 * no longer has a PTY sits there saying "Waiting for output..." forever.
 */

/**
 * Tile models that keep their object identity while nothing they render moved.
 *
 * The tiles are memoised on this object, so rebuilding all of them for one
 * agent's new output re-renders the whole grid: sixty-four tiles' worth of
 * React work because one of them printed a line. Reusing the previous model
 * whenever the agent row, its state and its snapshot are all unchanged is what
 * makes that memo mean something.
 *
 * The snapshot poll already preserves unchanged snapshot objects, so an
 * identity comparison here is enough — and is the comparison that matters,
 * since a new object with equal fields is still a new render.
 */
export function reconcileTileModels(
  previous: readonly MissionControlTileModel[],
  agents: readonly MissionControlAgentPanel[],
  agentStatus: Readonly<Record<string, AgentState>>,
  snapshots: Readonly<Record<string, MissionControlSnapshot>>,
): MissionControlTileModel[] {
  const byPanelId = new Map(previous.map(tile => [tile.panelId, tile]));

  return agents.map(agent => {
    const agentState = agentStatus[agent.panelId] ?? 'unknown';
    const snapshot = snapshots[agent.panelId] ?? null;
    const existing = byPanelId.get(agent.panelId);

    if (
      existing
      && existing.agentState === agentState
      && existing.snapshot === snapshot
      && sameAgentRow(existing, agent)
    ) {
      return existing;
    }

    return { ...agent, agentState, snapshot };
  });
}

/** Every field of the roster row a tile actually renders. */
function sameAgentRow(tile: MissionControlTileModel, agent: MissionControlAgentPanel): boolean {
  return tile.sessionId === agent.sessionId
    && tile.sessionName === agent.sessionName
    && tile.projectId === agent.projectId
    && tile.projectName === agent.projectName
    && tile.worktreePath === agent.worktreePath
    && tile.worktreeName === agent.worktreeName
    && tile.panelTitle === agent.panelTitle
    && tile.agentType === agent.agentType
    && tile.isPermanent === agent.isPermanent
    && tile.isLive === agent.isLive;
}

/** The panels the view is holding on to by id. */
export interface MissionControlSelection {
  focusedPanelId: string | null;
  liveTileId: string | null;
  selectedPanelId: string | null;
  pendingClosePanelId: string | null;
}

/**
 * Drop every reference to a panel that is no longer on the roster.
 *
 * All four are ids of things the user is in the middle of: typing into,
 * watching live, moving the keyboard cursor over, confirming the deletion of.
 * A panel that vanished takes all of them with it — including the close
 * confirmation, which would otherwise ask about a pane that is already gone
 * and fail when confirmed.
 */
export function pruneSelection(
  selection: MissionControlSelection,
  panelIds: ReadonlySet<string>,
): MissionControlSelection {
  const keep = (id: string | null) => (id !== null && panelIds.has(id) ? id : null);
  const next = {
    focusedPanelId: keep(selection.focusedPanelId),
    liveTileId: keep(selection.liveTileId),
    selectedPanelId: keep(selection.selectedPanelId),
    pendingClosePanelId: keep(selection.pendingClosePanelId),
  };

  // Same object when nothing changed, so a caller can use it as a state
  // updater without scheduling a render on every roster refresh.
  const unchanged = next.focusedPanelId === selection.focusedPanelId
    && next.liveTileId === selection.liveTileId
    && next.selectedPanelId === selection.selectedPanelId
    && next.pendingClosePanelId === selection.pendingClosePanelId;
  return unchanged ? selection : next;
}

/** Forget the snapshots of panels that have left the roster. */
export function pruneSnapshots(
  snapshots: Readonly<Record<string, MissionControlSnapshot>>,
  panelIds: ReadonlySet<string>,
): Record<string, MissionControlSnapshot> {
  const entries = Object.entries(snapshots).filter(([panelId]) => panelIds.has(panelId));
  if (entries.length === Object.keys(snapshots).length) return snapshots;
  return Object.fromEntries(entries);
}

/**
 * Apply only the newest of several overlapping requests.
 *
 * The roster reloads on status churn, on panel and session events, and on the
 * refresh button, so two loads are easily in flight at once — and over a remote
 * daemon they do not come back in the order they were sent. Applying whichever
 * lands last resurrects dead agents until something else forces a refresh.
 */
export interface RequestGate {
  /** Claim the newest slot. The predicate says whether it still is the newest. */
  start(): () => boolean;
  /** Invalidate everything in flight, for unmount. */
  abandon(): void;
}

export function createRequestGate(): RequestGate {
  let generation = 0;

  return {
    start() {
      const mine = ++generation;
      return () => mine === generation;
    },
    abandon() {
      // A token that can never be current again: the generation moves past every
      // request already handed out.
      generation += 1;
    },
  };
}
