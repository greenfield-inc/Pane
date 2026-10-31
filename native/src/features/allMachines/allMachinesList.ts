import type { AgentDisplayStatus } from '@shared/types/agentStatus';
import type { NotifyItem, NotifySharedState } from '@shared/types/notify';
import type { OrchestrationSessionRecord } from '@shared/types/orchestrationSession';
import type { PanePermissionRequest } from '@shared/types/permissions';

import { waitingQuestions } from '@/features/notify/notifyQuestions';
import { paneAgent, paneDisplayStatus, type AgentStatusSnapshot } from '@/features/panes/agentStatus';
import type { ProjectWithPanes } from '@/features/panes/paneList';

/** What home lists for one machine; every read but the projects may be missing. */
export interface MachineSnapshot {
  projects: ProjectWithPanes[];
  statuses?: AgentStatusSnapshot;
  permissions?: PanePermissionRequest[];
  notify?: NotifySharedState;
  /** Orchestrator Sessions; missing on hosts without them. */
  sessions?: OrchestrationSessionRecord[];
}

/** One saved machine's rows for All machines. */
export interface MachineFeed {
  /** The saved profile id: with a row's own id, it names the row. */
  key: string;
  name: string;
  /** Undefined until the first read answers. */
  snapshot: MachineSnapshot | undefined;
  /** Set while the machine can't be reached: its rows are from this time, and are drawn dimmed. */
  offlineSince?: number;
}

interface RowBase {
  /** Unique across machines: project ids and Pane ids can repeat from one machine to the next. */
  key: string;
  machineKey: string;
  /** Its machine can't be reached; the row is from `offlineSince`. */
  stale: boolean;
}

export type WaitingRow =
  | RowBase & { type: 'question'; item: NotifyItem }
  | RowBase & { type: 'permission'; request: PanePermissionRequest; paneName: string };

export interface AllPane {
  id: string;
  name: string;
  repository: string;
  /** The Session this Pane works for, when one does. */
  session?: string;
  pinned: boolean;
  status: AgentDisplayStatus;
  agent?: string;
  /** Epoch ms of its last activity, or its creation. */
  activeAt: number;
}

export type RecentRow =
  | RowBase & { type: 'pane'; pane: AllPane }
  | RowBase & { type: 'session'; session: OrchestrationSessionRecord; paneCount: number; activeAt: number };

export interface AllMachinesList {
  /** Every machine's questions, oldest first, then its permission requests. */
  waiting: WaitingRow[];
  /** Every Pane and Session, newest activity first. */
  recent: RecentRow[];
}

/**
 * All machines on home: what's waiting on you from every machine, then every Pane and Session by
 * newest activity. Archived and hidden ones stay out. `query` keeps rows whose name, repository,
 * Session or machine contains every word.
 */
export function buildAllMachinesList(machines: readonly MachineFeed[], query: string): AllMachinesList {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (...texts: Array<string | undefined>) => {
    const text = texts.filter(Boolean).join(' ').toLowerCase();
    return words.every(word => text.includes(word));
  };

  const questions: WaitingRow[] = [];
  const permissions: WaitingRow[] = [];
  const recent: RecentRow[] = [];
  for (const machine of machines) {
    const snapshot = machine.snapshot;
    if (!snapshot) continue;
    const base = (kind: string, id: string): RowBase => ({ key: `${machine.key}:${kind}:${id}`, machineKey: machine.key, stale: machine.offlineSince !== undefined });
    const pending = snapshot.permissions ?? [];
    const asked = waitingQuestions(snapshot.notify);
    const blocked = new Set([...pending.map(request => request.sessionId), ...asked.flatMap(item => item.source.paneId ?? [])]);
    const sessions = (snapshot.sessions ?? []).filter(session => !session.archived);
    const sessionOf = new Map(sessions.flatMap(session => session.associations.map(association => [association.paneId, session.name] as const)));
    const paneNames = new Map<string, string>();

    for (const project of snapshot.projects) {
      for (const pane of project.sessions ?? []) {
        paneNames.set(pane.id, pane.name);
        if (pane.archived || pane.isHidden) continue;
        const session = sessionOf.get(pane.id);
        if (!matches(pane.name, project.name, session, machine.name)) continue;
        recent.push({
          ...base('pane', pane.id),
          type: 'pane',
          pane: {
            id: pane.id,
            name: pane.name,
            repository: project.name,
            session,
            pinned: Boolean(pane.isFavorite),
            status: blocked.has(pane.id) ? 'blocked' : snapshot.statuses ? paneDisplayStatus(snapshot.statuses, pane.id) : 'unknown',
            agent: snapshot.statuses ? paneAgent(snapshot.statuses, pane.id) : undefined,
            activeAt: timeOf(pane.lastActivity) ?? timeOf(pane.createdAt) ?? 0,
          },
        });
      }
    }
    for (const session of sessions) {
      if (!matches(session.name, machine.name)) continue;
      const paneCount = session.associations.filter(association => paneNames.has(association.paneId)).length;
      recent.push({ ...base('session', session.id), type: 'session', session, paneCount, activeAt: timeOf(session.updatedAt) ?? 0 });
    }
    questions.push(...asked.map(item => ({ ...base('question', item.id), type: 'question' as const, item })));
    permissions.push(...pending.map(request => ({
      ...base('permission', request.id),
      type: 'permission' as const,
      request,
      paneName: paneNames.get(request.sessionId) ?? 'Pane',
    })));
  }

  const questionTime = (row: WaitingRow) => (row.type === 'question' ? row.item.createdAt : 0);
  const recentTime = (row: RecentRow) => (row.type === 'pane' ? row.pane.activeAt : row.activeAt);
  return {
    waiting: [...questions.sort((a, b) => questionTime(a) - questionTime(b)), ...permissions],
    recent: recent.sort((a, b) => recentTime(b) - recentTime(a)),
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long ago, in the row's few characters: "now", "9 min", "3 h", "2 days". */
export function sinceLabel(at: number, now: number): string {
  const elapsed = Math.max(0, now - at);
  if (elapsed < MINUTE) return 'now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h`;
  const days = Math.floor(elapsed / DAY);
  return days === 1 ? '1 day' : `${days} days`;
}

function timeOf(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? undefined : time;
}
