import { rollupAgentState, toAgentDisplayStatus } from './agentStatus';
import { moveWithinOwnPlaces } from '../../../shared/utils/sessionOrder';
import type { AgentDisplayStatus, AgentState, PanelAgentStatusEvent } from '../../../shared/types/agentStatus';
import type { NotifySharedState } from '../../../shared/types/notify';
import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';
import type { PanePermissionRequest } from '../../../shared/types/permissions';
import type { Project } from '../types/project';
import type { Session } from '../types/session';
import type { MachineOs } from './machineList';

/** Who a row belongs to: a machine's id (`local` or a saved profile id), name, OS, colour slot and letters. */
export interface MachineRef {
  id: string;
  name: string;
  os: MachineOs | null;
  slot: number;
  letters: string;
}

/** One machine's lists, as its `machines:read` answers gave them. */
export interface MachineSnapshot {
  /** `sessions:get-all-with-projects`: every project with its Panes. */
  projects: Array<Project & { sessions: Session[] }>;
  /** `orchestration-sessions:list`. */
  sessions: OrchestrationSessionRecord[];
  /** `panels:agent-statuses`. */
  statuses: PanelAgentStatusEvent[];
  /** `notify:remote-snapshot`. */
  notify: Pick<NotifySharedState, 'items'> | null;
  /** `permission:getPending`. */
  permissions: PanePermissionRequest[];
}

export interface MachineView {
  machine: MachineRef;
  /** Null until the machine's first read answers. */
  snapshot: MachineSnapshot | null;
  /** Its rows are from when it stopped answering. */
  offline: boolean;
}

export interface AllMachinesPane {
  /** `<machine id>:<Pane id>`: Pane ids are unique per machine only. */
  key: string;
  machine: MachineRef;
  offline: boolean;
  pane: Session;
  status: AgentDisplayStatus;
  /** A Notify question or a permission request from this Pane is waiting on you. */
  waiting: boolean;
  /** The oldest permission request waiting on this Pane. */
  permission: PanePermissionRequest | null;
}

export interface AllMachinesSession {
  key: string;
  machine: MachineRef;
  offline: boolean;
  session: OrchestrationSessionRecord;
  status: AgentDisplayStatus;
  /** Its Panes on the same machine. */
  panes: AllMachinesPane[];
}

interface AllMachinesProject {
  /** The repository the project is matched by across machines (`repo:<identity>` or `name:<name>`). */
  key: string;
  name: string;
  /** The project row on each machine that has it, so its actions reach the right one. */
  entries: Array<{ machine: MachineRef; project: Project; offline: boolean }>;
  panes: AllMachinesPane[];
}

export interface AllMachinesTree {
  sessions: AllMachinesSession[];
  projects: AllMachinesProject[];
  /** Every Pane row, for search. */
  panes: AllMachinesPane[];
}

const time = (iso: string | undefined) => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : 0;
};

/**
 * The key that merges one repository's project rows across machines: its repository identity
 * (the origin remote each host reads). A project without one, from a machine on an older Pane
 * or with no origin, joins a row with its name, else stands on its own.
 */
function projectKeys(views: readonly MachineView[]): (project: Pick<Project, 'name' | 'repository'>) => string {
  const nameOf = (project: Pick<Project, 'name'>) => project.name.trim().toLowerCase();
  const identityByName = new Map<string, string>();
  for (const { snapshot } of views) {
    for (const project of snapshot?.projects ?? []) {
      if (project.repository && !identityByName.has(nameOf(project))) identityByName.set(nameOf(project), `repo:${project.repository}`);
    }
  }
  return (project) => (project.repository ? `repo:${project.repository}` : identityByName.get(nameOf(project)) ?? `name:${nameOf(project)}`);
}

/**
 * How this computer arranged All Machines: Session keys across machines, and each project's
 * Pane keys. Null or absent until the first move; rows are then in their machines' own order.
 */
export interface AllMachinesArrangement {
  sessions: string[] | null;
  /** By project key. */
  panes: Record<string, string[]>;
}

const EMPTY_ARRANGEMENT: AllMachinesArrangement = { sessions: null, panes: {} };

/**
 * Rows in the saved order, pinned first. With no saved order they keep the order given (each
 * machine's own). A row the saved order does not name is new: it goes first, newest first.
 * Agent status and activity never move a row.
 */
function arrange<Row>(rows: readonly Row[], saved: readonly string[] | null | undefined, keyOf: (row: Row) => string, createdOf: (row: Row) => string | undefined, pinnedOf: (row: Row) => boolean): Row[] {
  let ordered = [...rows];
  if (saved) {
    const place = new Map(saved.map((key, index) => [key, index]));
    const unnamed = ordered.filter(row => !place.has(keyOf(row))).sort((a, b) => time(createdOf(b)) - time(createdOf(a)));
    const named = ordered.filter(row => place.has(keyOf(row))).sort((a, b) => place.get(keyOf(a))! - place.get(keyOf(b))!);
    ordered = [...unnamed, ...named];
  }
  return [...ordered.filter(pinnedOf), ...ordered.filter(row => !pinnedOf(row))];
}

function statusesBySession(statuses: PanelAgentStatusEvent[]): Map<string, AgentState[]> {
  const bySession = new Map<string, AgentState[]>();
  for (const status of statuses) {
    const states = bySession.get(status.sessionId);
    if (states) states.push(status.state);
    else bySession.set(status.sessionId, [status.state]);
  }
  return bySession;
}

/**
 * Today's Sessions and Projects tree, filled from every machine, in the order this computer
 * arranged it. Rows are keyed by machine and id; a repository open on several machines is one
 * project with each machine's Panes.
 */
export function buildAllMachinesTree(views: readonly MachineView[], arrangement: AllMachinesArrangement = EMPTY_ARRANGEMENT): AllMachinesTree {
  const sessions: AllMachinesSession[] = [];
  const projects = new Map<string, AllMachinesProject>();
  const panes: AllMachinesPane[] = [];
  const repositoryKey = projectKeys(views);

  for (const { machine, snapshot, offline } of views) {
    if (!snapshot) continue;
    const states = statusesBySession(snapshot.statuses);
    const statusOf = (id: string) => toAgentDisplayStatus(rollupAgentState(states.get(id) ?? []), false);
    const waitingPanes = new Set<string>();
    for (const item of snapshot.notify?.items ?? []) {
      if (item.state === 'waiting' && item.source.paneId) waitingPanes.add(item.source.paneId);
    }
    const permissions = [...snapshot.permissions].sort((a, b) => a.timestamp - b.timestamp);
    const paneById = new Map<string, AllMachinesPane>();

    for (const project of snapshot.projects) {
      const key = repositoryKey(project);
      let merged = projects.get(key);
      if (!merged) {
        merged = { key, name: project.name, entries: [], panes: [] };
        projects.set(key, merged);
      }
      const { sessions: projectPanes, ...projectRow } = project;
      merged.entries.push({ machine, project: projectRow, offline });
      // In the host's saved Pane order (newest first until arranged).
      for (const pane of projectPanes) {
        if (pane.archived || pane.isHidden) continue;
        const permission = permissions.find(request => request.sessionId === pane.id) ?? null;
        const row: AllMachinesPane = {
          key: `${machine.id}:${pane.id}`,
          machine,
          offline,
          pane,
          status: statusOf(pane.id),
          waiting: waitingPanes.has(pane.id) || permission !== null,
          permission,
        };
        merged.panes.push(row);
        panes.push(row);
        paneById.set(pane.id, row);
      }
    }

    for (const session of snapshot.sessions) {
      if (session.archived) continue;
      sessions.push({
        key: `${machine.id}:${session.id}`,
        machine,
        offline,
        session,
        status: statusOf(session.internalSessionId),
        panes: session.associations.flatMap(association => paneById.get(association.paneId) ?? []),
      });
    }
  }

  for (const project of projects.values()) {
    project.panes = arrange(project.panes, arrangement.panes[project.key], row => row.key, row => row.pane.createdAt, row => Boolean(row.pane.isFavorite));
  }
  return {
    sessions: arrange(sessions, arrangement.sessions, row => row.key, row => row.session.createdAt, row => Boolean(row.session.isPinned)),
    projects: [...projects.values()],
    panes,
  };
}

/**
 * The saved order after a move: the rows shown (`shown`, already in their new order) fill the
 * places shown rows hold, and rows the list no longer shows (archived, or on a removed machine)
 * keep theirs, so a restored row comes back where it was. New rows go first.
 */
export function savedOrderAfterMove(saved: readonly string[] | null, shown: readonly string[]): string[] {
  const kept = saved ?? [];
  const known = new Set(kept);
  return moveWithinOwnPlaces([...shown.filter(key => !known.has(key)), ...kept], shown, key => key);
}

/** An arrangement plus the first looks it has taken: `sessions:<machine id>` and `projects:<machine id>`. */
export interface SeededArrangement extends AllMachinesArrangement {
  seeded: string[];
}

/**
 * Takes each machine's first look into the arrangement: the first time a machine's Session list
 * (or project list) answers on this computer, its rows join the saved order in that machine's own
 * order, placed by the machine menu: after the rows of machines listed before it, however late it
 * answers. Rows that appear after a machine's first look are then
 * arrivals, which the tree puts first. Returns null when nothing changes.
 */
export function seedArrangement(
  arrangement: SeededArrangement,
  views: readonly MachineView[],
  answered: (machineId: string, list: 'sessions' | 'projects') => boolean,
): SeededArrangement | null {
  const seeded = new Set(arrangement.seeded);
  let sessions = arrangement.sessions;
  const panes = { ...arrangement.panes };
  let changed = false;
  // Views come in machine-menu order. A machine's first look goes after the last row of any machine
  // before it in that order, or first when there is none, so the order never depends on which
  // machine answered first, and rows you moved keep their places.
  const menuPlace = new Map(views.map(({ machine }, index) => [machine.id, index]));
  const machineOf = (key: string) => views.find(({ machine }) => key.startsWith(`${machine.id}:`))?.machine.id;
  const insert = (saved: readonly string[] | null | undefined, machineId: string, keys: readonly string[]) => {
    const list = saved ?? [];
    const known = new Set(list);
    const place = menuPlace.get(machineId) ?? views.length;
    let at = 0;
    list.forEach((key, index) => {
      const owner = machineOf(key);
      if (owner !== undefined && (menuPlace.get(owner) ?? views.length) < place) at = index + 1;
    });
    return [...list.slice(0, at), ...keys.filter(key => !known.has(key)), ...list.slice(at)];
  };
  const repositoryKey = projectKeys(views);

  for (const { machine, snapshot } of views) {
    if (!snapshot) continue;
    const sessionsLook = `sessions:${machine.id}`;
    if (!seeded.has(sessionsLook) && answered(machine.id, 'sessions')) {
      sessions = insert(sessions, machine.id, snapshot.sessions.filter(session => !session.archived).map(session => `${machine.id}:${session.id}`));
      seeded.add(sessionsLook);
      changed = true;
    }
    const projectsLook = `projects:${machine.id}`;
    if (!seeded.has(projectsLook) && answered(machine.id, 'projects')) {
      for (const project of snapshot.projects) {
        const key = repositoryKey(project);
        panes[key] = insert(panes[key], machine.id, project.sessions.filter(pane => !pane.archived && !pane.isHidden).map(pane => `${machine.id}:${pane.id}`));
      }
      seeded.add(projectsLook);
      changed = true;
    }
  }
  return changed ? { sessions, panes, seeded: [...seeded] } : null;
}
