import type { NotifyItem, NotifySession } from '../../../../shared/types/notify';

export type ApprovalsTab = 'waiting' | 'answered';

/** One group in the queue column: a Session on one machine, or every item not in a Session. */
export interface ApprovalGroup {
  key: string;
  label: string;
  session?: NotifySession;
  /** The machine the group's items come from, when the screen shows more than one. */
  machineId?: string;
  machine?: string;
  /** Autopilot's own items (D-60): shown violet, "written by Autopilot". */
  autopilot?: boolean;
  items: NotifyItem[];
}

const NOT_IN_A_SESSION = 'Not in a Session';
const AUTOPILOT = 'Autopilot';

/** The queue column's content for one tab, with both tabs' counts. */
export interface ApprovalQueue {
  /** Items still waiting on you (an answer in its Undo hold no longer counts). */
  waiting: number;
  answered: number;
  groups: ApprovalGroup[];
}

/** Waiting holds open questions, fallback items and answers still in their Undo hold. */
const isWaiting = (item: NotifyItem) => item.state === 'waiting' || item.state === 'sent';
/** Answered also keeps today's updates: with no strip inside Pane, they'd otherwise show nowhere there. */
const isAnswered = (item: NotifyItem) => item.state === 'answered' || item.state === 'expired' || item.state === 'info';
const resolved = (item: NotifyItem) => item.resolvedAt ?? item.createdAt;

/**
 * The Approvals queue: the tab's items grouped by Session and machine. Waiting lists oldest
 * first, so a new item never moves the one being answered; Answered lists newest first.
 * Autopilot's own items come after the Sessions, and "Not in a Session" last.
 */
export function groupApprovals(items: NotifyItem[], tab: ApprovalsTab): ApprovalQueue {
  const waitingItems = items.filter(isWaiting);
  const answeredItems = items.filter(isAnswered);
  const shown = tab === 'waiting'
    ? [...waitingItems].sort((a, b) => a.createdAt - b.createdAt)
    : [...answeredItems].sort((a, b) => resolved(b) - resolved(a));
  const groups = new Map<string, ApprovalGroup>();
  let loose: ApprovalGroup | undefined;
  const autopilot = new Map<string, ApprovalGroup>();
  for (const item of shown) {
    if (item.source.autopilot) {
      const key = `${item.machineId ?? 'local'}:autopilot`;
      const group = autopilot.get(key) ?? { key, label: AUTOPILOT, autopilot: true, machineId: item.machineId, machine: item.machine, items: [] };
      autopilot.set(key, group);
      group.items.push(item);
      continue;
    }
    const session = item.source.session;
    if (!session) {
      loose ??= { key: 'none', label: NOT_IN_A_SESSION, items: [] };
      loose.items.push(item);
      continue;
    }
    const key = `${item.machineId ?? 'local'}:${session.id}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, label: session.name, session, machineId: item.machineId, machine: item.machine, items: [] };
      groups.set(key, group);
    }
    // The orchestrator's own item says the most about the Session: keep its marking.
    if (session.orchestrator && !group.session?.orchestrator) group.session = session;
    group.items.push(item);
  }
  return {
    // An answer in its Undo hold still shows, but no longer waits on you.
    waiting: waitingItems.filter(item => item.state === 'waiting').length,
    answered: answeredItems.length,
    groups: [...groups.values(), ...autopilot.values(), ...(loose ? [loose] : [])],
  };
}

/** What shows beside the selected item. */
export type Beside =
  | { kind: 'session'; sessionId: string; paneId: string; name: string }
  | { kind: 'pane'; paneId: string; panelId?: string; name: string }
  | { kind: 'machine'; machineId: string; machine: string }
  | { kind: 'autopilot' }
  | { kind: 'none' };

/**
 * An orchestrator's item (and a stuck worker question, which waits on the orchestrator) shows
 * its Session; a worker's prompt or a standalone Pane's question shows the asking Pane. An item
 * from any machine other than the one the app is on (`activeMachineId`, `local` for this
 * computer) offers to switch there instead, in both directions.
 */
export function besideOf(item: NotifyItem, activeMachineId: string): Beside {
  const machineId = item.machineId ?? 'local';
  if (machineId !== activeMachineId) return { kind: 'machine', machineId, machine: item.machine ?? 'this computer' };
  // Autopilot's own item (D-60): it lives in Autopilot, not in a Pane the person opens.
  if (item.source.autopilot) return { kind: 'autopilot' };
  const session = item.source.session;
  if (session && (session.orchestrator || item.relay)) return { kind: 'session', sessionId: session.id, paneId: session.paneId, name: session.name };
  if (item.source.paneId) return { kind: 'pane', paneId: item.source.paneId, panelId: item.source.panelId, name: item.source.name };
  return { kind: 'none' };
}
