import type { AgentDisplayStatus } from '@shared/types/agentStatus';
import type { NotifyItem, NotifySharedState } from '@shared/types/notify';
import type { OrchestrationSessionRecord } from '@shared/types/orchestrationSession';
import type { TerminalPausedMark } from '@shared/types/panels';
import type { PanePermissionRequest } from '@shared/types/permissions';

import { answeredItems, approvalAt, approvalItems, sessionKey, staleItems, waitingCounts, type OfflineMachine } from '@/features/approvals/approvals';
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

/** What Approvals sorts by: the Session and project a question or request belongs to, and its time. */
interface WaitingBase extends RowBase {
  session?: { id: string; name: string };
  project?: string;
  at: number;
  /** False for an answer held for Undo: it shows, but doesn't count. */
  waiting: boolean;
}

type QuestionRow = WaitingBase & { type: 'question'; item: NotifyItem };

export type WaitingRow =
  | QuestionRow
  | WaitingBase & { type: 'permission'; request: PanePermissionRequest; paneName: string };

export interface AllPane {
  id: string;
  name: string;
  repository: string;
  /** The Session this Pane works for, when one does. */
  session?: string;
  pinned: boolean;
  status: AgentDisplayStatus;
  agent?: string;
  paused?: TerminalPausedMark;
  /** Epoch ms of its last activity, or its creation. */
  activeAt: number;
}

export type RecentRow =
  | RowBase & { type: 'pane'; pane: AllPane }
  | RowBase & {
    type: 'session';
    session: OrchestrationSessionRecord;
    paneCount: number;
    activeAt: number;
    /** The approvals waiting from this Session on its machine: the row's amber count. */
    waiting: number;
  };

export interface AllMachinesList {
  /** Every online machine's questions (with answers held for Undo), oldest first, then its permission requests. */
  waiting: WaitingRow[];
  /** Online machines' stale questions, oldest first: a collapsed group, out of the counts. */
  staleQuestions: QuestionRow[];
  /** Online machines' answered and closed questions of the last 24 hours, newest first: a collapsed group, out of the counts. */
  answered: QuestionRow[];
  /** One row per machine that isn't online and had something waiting, instead of its cards. */
  offline: OfflineMachine[];
  /** Every Pane and Session, newest activity first. */
  recent: RecentRow[];
}

/**
 * All machines on home: what's waiting on you from every machine, then every Pane and Session by
 * newest activity. Archived and hidden ones stay out. `query` keeps rows whose name, repository,
 * Session or machine contains every word.
 */
export function buildAllMachinesList(machines: readonly MachineFeed[], query: string, now: number = Date.now()): AllMachinesList {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (...texts: Array<string | undefined>) => {
    const text = texts.filter(Boolean).join(' ').toLowerCase();
    return words.every(word => text.includes(word));
  };

  const questions: WaitingRow[] = [];
  const permissions: WaitingRow[] = [];
  const staleQuestions: QuestionRow[] = [];
  const answered: QuestionRow[] = [];
  const offline: OfflineMachine[] = [];
  const recent: RecentRow[] = [];
  for (const machine of machines) {
    const snapshot = machine.snapshot;
    if (!snapshot) continue;
    const base = (kind: string, id: string): RowBase => ({ key: `${machine.key}:${kind}:${id}`, machineKey: machine.key, stale: machine.offlineSince !== undefined });
    const pending = snapshot.permissions ?? [];
    const asked = approvalItems(snapshot.notify);
    const blocked = new Set([...pending.map(request => request.sessionId), ...asked.flatMap(item => (item.state === 'waiting' && item.source.paneId) || [])]);
    const sessions = (snapshot.sessions ?? []).filter(session => !session.archived);
    const sessionOf = new Map(sessions.flatMap(session => session.associations.map(association => [association.paneId, { id: session.id, name: session.name }] as const)));
    const paneNames = new Map<string, string>();
    const projectOfPane = new Map<string, string>();

    for (const project of snapshot.projects) {
      for (const pane of project.sessions ?? []) {
        paneNames.set(pane.id, pane.name);
        projectOfPane.set(pane.id, project.name);
        if (pane.archived || pane.isHidden) continue;
        const session = sessionOf.get(pane.id)?.name;
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
            paused: pane.paused,
            activeAt: timeOf(pane.lastActivity) ?? timeOf(pane.createdAt) ?? 0,
          },
        });
      }
    }
    for (const session of sessions) {
      if (!matches(session.name, machine.name)) continue;
      const paneCount = session.associations.filter(association => paneNames.has(association.paneId)).length;
      recent.push({ ...base('session', session.id), type: 'session', session, paneCount, activeAt: timeOf(session.updatedAt) ?? 0, waiting: 0 });
    }
    // A machine that isn't online shows one row with its count, never cards you can't act on.
    if (machine.offlineSince !== undefined) {
      const count = asked.filter(item => item.state === 'waiting').length + pending.length;
      if (count > 0) offline.push({ key: machine.key, name: machine.name, waiting: count });
      continue;
    }
    const questionRow = (item: NotifyItem): QuestionRow => {
      const { session, project } = item.source;
      return { ...base('question', item.id), type: 'question', item, at: approvalAt(item), waiting: item.state === 'waiting', ...(session ? { session: { id: session.id, name: session.name } } : {}), ...(project ? { project } : {}) };
    };
    questions.push(...asked.map(questionRow));
    staleQuestions.push(...staleItems(snapshot.notify).map(questionRow));
    answered.push(...answeredItems(snapshot.notify, now).map(questionRow));
    permissions.push(...pending.map(request => {
      const session = sessionOf.get(request.sessionId);
      const project = projectOfPane.get(request.sessionId);
      return {
        ...base('permission', request.id),
        type: 'permission' as const,
        request,
        paneName: paneNames.get(request.sessionId) ?? 'Pane',
        at: request.timestamp,
        waiting: true,
        ...(session ? { session } : {}),
        ...(project ? { project } : {}),
      };
    }));
  }

  const questionTime = (row: WaitingRow) => (row.type === 'question' ? row.item.createdAt : 0);
  const recentTime = (row: RecentRow) => (row.type === 'pane' ? row.pane.activeAt : row.activeAt);
  const waiting = [...questions.sort((a, b) => questionTime(a) - questionTime(b)), ...permissions];
  const counts = waitingCounts(waiting).bySession;
  return {
    waiting,
    staleQuestions: staleQuestions.sort((a, b) => a.item.createdAt - b.item.createdAt),
    answered: answered.sort((a, b) => (b.item.resolvedAt ?? b.item.createdAt) - (a.item.resolvedAt ?? a.item.createdAt)),
    offline,
    recent: recent
      .map(row => (row.type === 'session' ? { ...row, waiting: counts.get(sessionKey(row.machineKey, row.session.id)) ?? 0 } : row))
      .sort((a, b) => recentTime(b) - recentTime(a)),
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
