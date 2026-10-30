import { rollupAgentState, toAgentDisplayStatus } from './agentStatus';
import type { AgentDisplayStatus, AgentState, PanelAgentStatusEvent } from '../../../shared/types/agentStatus';
import type { NotifySharedState } from '../../../shared/types/notify';
import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';
import type { PanePermissionRequest } from '../../../shared/types/permissions';
import type { Project } from '../types/project';
import type { Session } from '../types/session';
import type { MachineOs } from './machineList';

/** Who a row belongs to: a machine's id (`local` or a saved profile id), name, OS and colour slot. */
export interface MachineRef {
  id: string;
  name: string;
  os: MachineOs | null;
  slot: number;
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
  /** The repository the project is matched by across machines. */
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
 * A project row carries no remote URL, so the same repository on two machines is matched
 * by its project name, which defaults to the repository's folder name.
 */
function repositoryKey(project: Pick<Project, 'name'>): string {
  return project.name.trim().toLowerCase();
}

const needsYou = (row: Pick<AllMachinesPane, 'waiting' | 'status'>) => row.waiting || row.status === 'blocked';

/** Waiting on you first, then working, then newest activity. */
function comparePanes(a: AllMachinesPane, b: AllMachinesPane): number {
  return Number(needsYou(b)) - Number(needsYou(a))
    || Number(b.status === 'working') - Number(a.status === 'working')
    || time(b.pane.lastActivity ?? b.pane.createdAt) - time(a.pane.lastActivity ?? a.pane.createdAt);
}

function compareSessions(a: AllMachinesSession, b: AllMachinesSession): number {
  return Number(b.status === 'blocked') - Number(a.status === 'blocked')
    || Number(b.status === 'working') - Number(a.status === 'working')
    || time(b.session.updatedAt) - time(a.session.updatedAt);
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
 * Today's Sessions and Projects tree, filled from every machine. Rows are keyed by machine
 * and id; a repository open on several machines is one project with each machine's Panes.
 */
export function buildAllMachinesTree(views: readonly MachineView[]): AllMachinesTree {
  const sessions: AllMachinesSession[] = [];
  const projects = new Map<string, AllMachinesProject>();
  const panes: AllMachinesPane[] = [];

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
        panes: session.associations.flatMap(association => paneById.get(association.paneId) ?? []).sort(comparePanes),
      });
    }
  }

  for (const project of projects.values()) project.panes.sort(comparePanes);
  return { sessions: sessions.sort(compareSessions), projects: [...projects.values()], panes };
}
