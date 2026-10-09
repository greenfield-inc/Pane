import type { AgentState } from '../../../shared/types/agentStatus';
import type {
  MissionControlAgentType,
  MissionControlGroup,
  MissionControlGrouping,
  MissionControlTileModel,
} from '../../../shared/types/missionControl';

/**
 * Sort weight for agent states — the panes that need a human come first, so
 * the top-left of the grid is always the most urgent thing.
 */
const STATE_ORDER = {
  blocked: 0,
  working: 1,
  idle: 2,
  unknown: 3,
} satisfies Record<AgentState, number>;

export const STATE_LABEL = {
  blocked: 'Needs input',
  working: 'Working',
  idle: 'Idle',
  unknown: 'Not running',
} satisfies Record<AgentState, string>;

/** One collator for every comparison; `localeCompare` builds a fresh one per call. */
const COLLATOR = new Intl.Collator();

/** How an agent is named in the interface. */
export function agentTypeLabel(agentType: MissionControlAgentType | null, fallback = 'Agent'): string {
  if (agentType === 'claude') return 'Claude';
  if (agentType === 'codex') return 'Codex';
  return fallback;
}

export function compareMissionControlTiles(a: MissionControlTileModel, b: MissionControlTileModel): number {
  const byState = STATE_ORDER[a.agentState] - STATE_ORDER[b.agentState];
  if (byState !== 0) return byState;

  const byProject = COLLATOR.compare(a.projectName, b.projectName);
  if (byProject !== 0) return byProject;

  const bySession = COLLATOR.compare(a.sessionName, b.sessionName);
  if (bySession !== 0) return bySession;

  return COLLATOR.compare(a.panelTitle, b.panelTitle);
}

/**
 * Bucket tiles for display. Groups are ordered by their most urgent member so
 * a project with a blocked agent floats above one that is merely idle.
 */
export function groupMissionControlTiles(tiles: MissionControlTileModel[], grouping: MissionControlGrouping): MissionControlGroup[] {
  const sorted = [...tiles].sort(compareMissionControlTiles);

  if (grouping === 'none') {
    return sorted.length > 0 ? [{ key: 'all', label: 'All agents', tiles: sorted }] : [];
  }

  const buckets = new Map<string, MissionControlGroup>();

  for (const tile of sorted) {
    let key: string;
    let label: string;

    if (grouping === 'project') {
      key = tile.projectId === null ? 'no-project' : `project-${tile.projectId}`;
      label = tile.projectName;
    } else if (grouping === 'status') {
      key = `status-${tile.agentState}`;
      label = STATE_LABEL[tile.agentState];
    } else {
      key = `agent-${tile.agentType ?? 'other'}`;
      label = agentTypeLabel(tile.agentType, 'Other agents');
    }

    const bucket = buckets.get(key);
    if (bucket) bucket.tiles.push(tile);
    else buckets.set(key, { key, label, tiles: [tile] });
  }

  return [...buckets.values()].sort((a, b) => {
    const urgency = STATE_ORDER[a.tiles[0].agentState] - STATE_ORDER[b.tiles[0].agentState];
    if (urgency !== 0) return urgency;
    return COLLATOR.compare(a.label, b.label);
  });
}

/**
 * Where a pane lives, written out once.
 *
 * Project, session and panel usually name three different things — "Super
 * Forum / security / Terminal". Sometimes they name the same one: Pane Chat's
 * session, project and panel are all called "Pane Chat", and spelling that out
 * gave "Pane Chat / Pane Chat — Pane Chat". Repeating a name adds nothing, so
 * each distinct one appears once.
 */
export function describeMissionControlTile(tile: Pick<MissionControlTileModel, 'projectName' | 'sessionName' | 'panelTitle'>): string {
  const parts = [tile.projectName, tile.sessionName, tile.panelTitle]
    .map(part => part?.trim())
    .filter((part): part is string => Boolean(part));

  const seen = new Set<string>();
  return parts
    .filter(part => {
      const key = part.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(' / ');
}

/**
 * Whether a tile can be handed the keyboard.
 *
 * A live terminal has to render at the PTY's exact size, and those dimensions
 * ride along with the snapshot, so a running agent whose snapshot has not
 * arrived yet (or that sits past the snapshot cap) cannot take input: focusing
 * it would remove the click affordance and swallow every keystroke.
 */
export function canTakeKeyboard(tile: MissionControlTileModel): boolean {
  return tile.isLive && tile.snapshot?.cols != null && tile.snapshot?.rows != null;
}
