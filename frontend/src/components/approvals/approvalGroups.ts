import type { NotifyConnected, NotifyItem, NotifySession } from '../../../../shared/types/notify';
import type { OrchestrationSessionRecord } from '../../../../shared/types/orchestrationSession';
import { decisionLine, originLine, receiptLine } from '../../../../shared/approvalReceipts';
import { countsAsWaiting } from '../../stores/notifyStore';
import { approvalHolder, type ApprovalHolder } from '../../../../shared/approvalStatus';

export type ApprovalsTab = 'waiting' | 'answered';

/**
 * How the queue column lists a tab: flat with the newest on top, or in groups. `sidebar` groups by
 * Session in the order the left sidebar shows them.
 */
export type ApprovalsSort = 'recent' | 'session' | 'project' | 'sidebar';

export const APPROVALS_SORTS: ReadonlyArray<{ id: ApprovalsSort; label: string }> = [
  { id: 'recent', label: 'Most recent' },
  { id: 'session', label: 'By Session' },
  { id: 'project', label: 'By project' },
  { id: 'sidebar', label: 'Sidebar order' },
];

const SORT_KEY = 'pane-approvals-sort';

export function parseApprovalsSort(value: string | null): ApprovalsSort {
  return APPROVALS_SORTS.find((sort) => sort.id === value)?.id ?? 'recent';
}

/** The sort this computer last chose. A bad value or a blocked store reads as Most recent. */
export function readApprovalsSort(read: () => string | null = () => localStorage.getItem(SORT_KEY)): ApprovalsSort {
  try {
    return parseApprovalsSort(read());
  } catch {
    return 'recent';
  }
}

/** Remembers the sort on this computer; when the store refuses, it lasts until the app closes. */
export function saveApprovalsSort(sort: ApprovalsSort, write: (value: string) => void = (value) => localStorage.setItem(SORT_KEY, value)): void {
  try {
    write(sort);
  } catch {
    // Nothing to tell the person: the list already shows their choice.
  }
}

/** One group in the queue column: a Session or project on one machine, or the items with neither. */
export interface ApprovalGroup {
  key: string;
  label: string;
  session?: NotifySession;
  /** The machine the group's items come from, when the screen shows more than one. */
  machineId?: string;
  machine?: string;
  /** Autopilot's own items (D-60): shown violet, "written by Autopilot". */
  autopilot?: boolean;
  /** A group of the By project sort. */
  project?: boolean;
  /** Most recent's groups (P7): waiting on you, or with the agent reading your reply. */
  holder?: ApprovalHolder;
  items: NotifyItem[];
}

const NOT_IN_A_SESSION = 'Not in a Session';
const NO_PROJECT = 'No project';
const AUTOPILOT = 'Autopilot';

/** The queue column's content for one tab, with both tabs' counts. */
export interface ApprovalQueue {
  /** Items still waiting on you (an answer in its Undo hold no longer counts). */
  waiting: number;
  answered: number;
  /** Every item the tab lists, in the order it shows them. */
  list: NotifyItem[];
  /** The list's groups; none under Most recent, which has no headers. */
  groups: ApprovalGroup[];
  /** Waiting only: items 3 days unanswered, oldest first, for the collapsed Stale group at the bottom. */
  stale: NotifyItem[];
  /** Waiting only: one row per machine that can't be reached, in place of its items. */
  offline: OfflineRow[];
}

/** One machine's waiting items while it can't be reached: not cards, nothing to select. */
export interface OfflineRow {
  machineId: string;
  machine: string;
  count: number;
}

/** Waiting holds open questions, fallback items and answers still in their Undo hold. */
const isWaiting = (item: NotifyItem) => item.state === 'waiting' || item.state === 'sent';
const isOffline = (item: NotifyItem) => isWaiting(item) && item.unreachable === true;
const isStale = (item: NotifyItem) => item.state === 'waiting' && !item.unreachable && item.staleSince !== undefined;
/** Answered also keeps today's updates: with no strip inside Pane, they'd otherwise show nowhere there. */
const isAnswered = (item: NotifyItem) => item.state === 'answered' || item.state === 'expired' || item.state === 'info';
const resolved = (item: NotifyItem) => item.resolvedAt ?? item.createdAt;
const oldestFirst = (a: NotifyItem, b: NotifyItem) => a.createdAt - b.createdAt;

/** The open items that can't be reached, as one row per machine. */
export function offlineRows(items: readonly NotifyItem[]): OfflineRow[] {
  const rows = new Map<string, OfflineRow>();
  for (const item of items) {
    if (!isOffline(item)) continue;
    const machineId = item.machineId ?? 'local';
    const row = rows.get(machineId) ?? { machineId, machine: item.machine ?? 'Its machine', count: 0 };
    row.count += 1;
    rows.set(machineId, row);
  }
  return [...rows.values()];
}

export function offlineRowText({ machine, count }: OfflineRow): string {
  return `${machine} offline · ${count} waiting · they come back when ${machine} is online`;
}

/** Waiting's items the person works through, then the two kinds set apart from them. */
interface WaitingSplit {
  live: NotifyItem[];
  stale: NotifyItem[];
  offline: OfflineRow[];
}

export function splitWaiting(items: readonly NotifyItem[]): WaitingSplit {
  return {
    live: items.filter((item) => isWaiting(item) && !isOffline(item) && !isStale(item)).sort(oldestFirst),
    stale: items.filter(isStale).sort(oldestFirst),
    offline: offlineRows(items),
  };
}

/** A new group for `item`'s Session on its machine, Autopilot's, or the one for items in no Session. */
function sessionGroup(item: NotifyItem): ApprovalGroup {
  const { autopilot, session } = item.source;
  const { machineId, machine } = item;
  if (autopilot) return { key: `${machineId ?? 'local'}:autopilot`, label: AUTOPILOT, autopilot: true, machineId, machine, items: [] };
  if (!session) return { key: 'none', label: NOT_IN_A_SESSION, items: [] };
  return { key: `${machineId ?? 'local'}:${session.id}`, label: session.name, session, machineId, machine, items: [] };
}

/** A new group for `item`'s project on its machine, or the one for items with none. */
function projectGroup(item: NotifyItem): ApprovalGroup {
  const { project } = item.source;
  if (!project) return { key: 'no-project', label: NO_PROJECT, project: true, items: [] };
  const { machineId, machine } = item;
  return { key: `${machineId ?? 'local'}:project:${project}`, label: project, project: true, machineId, machine, items: [] };
}

/** Files a newest-first list into groups: each group lands where its newest item does. */
function intoGroups(list: readonly NotifyItem[], groupOf: (item: NotifyItem) => ApprovalGroup): ApprovalGroup[] {
  const groups = new Map<string, ApprovalGroup>();
  for (const item of list) {
    const fresh = groupOf(item);
    const group = groups.get(fresh.key) ?? fresh;
    groups.set(fresh.key, group);
    // The orchestrator's own item says the most about the Session: keep its marking.
    if (fresh.session?.orchestrator && !group.session?.orchestrator) group.session = fresh.session;
    group.items.push(item);
  }
  return [...groups.values()];
}

/**
 * The one-machine sidebar's Sessions as Sidebar order keys, top first: Pinned in their saved order,
 * then the rest in theirs (`sessions` is the host's saved order). Archived Sessions aren't shown.
 */
export function sidebarSessionKeys(sessions: ReadonlyArray<Pick<OrchestrationSessionRecord, 'id' | 'archived' | 'isPinned'>>, machineId: string): string[] {
  const shown = sessions.filter((session) => session.archived !== true);
  return [...shown.filter((session) => session.isPinned === true), ...shown.filter((session) => session.isPinned !== true)].map((session) => `${machineId}:${session.id}`);
}

/**
 * Puts Session groups in the sidebar's order (`sidebarOrder`: `<machine id>:<Session id>` keys, top
 * first). Groups the sidebar doesn't show (another machine's Session, an archived one, Autopilot,
 * items in no Session) follow, in the newest-first order they came in.
 */
function inSidebarOrder(groups: ApprovalGroup[], sidebarOrder: readonly string[]): ApprovalGroup[] {
  const place = new Map(sidebarOrder.map((key, index) => [key, index]));
  const shown = groups.filter((group) => place.has(group.key)).sort((a, b) => (place.get(a.key) ?? 0) - (place.get(b.key) ?? 0));
  return [...shown, ...groups.filter((group) => !place.has(group.key))];
}

/**
 * The Approvals queue for one tab: newest first, by when it was asked on Waiting and when it was
 * answered on Answered. Most recent lists them flat; By Session and By project group them, with each
 * group placed by its newest item; Sidebar order groups by Session in `sidebarOrder` (the keys of
 * the Sessions the sidebar shows, top first; see `inSidebarOrder`). Stale and offline machines stay
 * apart from the sort.
 */
export function groupApprovals(items: NotifyItem[], tab: ApprovalsTab, sort: ApprovalsSort, sidebarOrder: readonly string[] = []): ApprovalQueue {
  const answeredItems = items.filter(isAnswered);
  const { live, stale, offline } = splitWaiting(items);
  const listedAt = tab === 'waiting' ? (item: NotifyItem) => item.createdAt : resolved;
  // By id on a tie, so items of the same millisecond don't swap as snapshots arrive.
  const newestFirst = [...(tab === 'waiting' ? live : answeredItems)].sort((a, b) => listedAt(b) - listedAt(a) || a.id.localeCompare(b.id));
  const groups = sort === 'recent' ? (tab === 'waiting' ? byHolder(newestFirst) : [])
    : sort === 'project' ? intoGroups(newestFirst, projectGroup)
      : sort === 'sidebar' ? inSidebarOrder(intoGroups(newestFirst, sessionGroup), sidebarOrder)
        : intoGroups(newestFirst, sessionGroup);
  return {
    // An answer in its Undo hold still shows, but no longer waits on you.
    waiting: items.filter(countsAsWaiting).length,
    answered: answeredItems.length,
    list: sort === 'recent' ? newestFirst : groups.flatMap((group) => group.items),
    groups,
    stale: tab === 'waiting' ? stale : [],
    offline: tab === 'waiting' ? offline : [],
  };
}

/**
 * Most recent's Waiting tab, once something is with an agent (P7, D-344): "Waiting on you" first,
 * then "With the agent" for approvals whose reply an agent is reading or asking about. Flat (no
 * groups) while everything waits on you.
 */
function byHolder(items: NotifyItem[]): ApprovalGroup[] {
  const withAgent = items.filter(item => approvalHolder(item) === 'agent');
  if (withAgent.length === 0) return [];
  const onYou = items.filter(item => approvalHolder(item) !== 'agent');
  const groups: ApprovalGroup[] = [];
  if (onYou.length) groups.push({ key: 'holder:you', label: 'Waiting on you', holder: 'you', items: onYou });
  groups.push({ key: 'holder:agent', label: 'With the agent', holder: 'agent', items: withAgent });
  return groups;
}

/**
 * The ids of the items a queue lists, top to bottom: the order the pager steps through, grouped as
 * the list shows them under every sort. `withStale` adds the Stale group's items after them, in
 * their own oldest-first order, for a pager that also steps into it.
 */
export function approvalIdsInListOrder(queue: Pick<ApprovalQueue, 'list' | 'stale'>, { withStale = false }: { withStale?: boolean } = {}): string[] {
  const ids = queue.list.map((item) => item.id);
  return withStale ? [...ids, ...queue.stale.map((item) => item.id)] : ids;
}

/** A group header's count: how many of its items still wait on you, or on Answered how many it lists. */
export function groupCountText(group: ApprovalGroup, tab: ApprovalsTab): string {
  if (group.holder === 'agent') return `${group.items.length} sent`;
  return tab === 'waiting' ? `${group.items.filter(countsAsWaiting).length} waiting` : `${group.items.length} answered`;
}

/** What an item is connected to: its Session, else its Pane, Autopilot, or (no link at all) a name. */
export function connectedOf(item: NotifyItem): NotifyConnected {
  if (item.connected) return item.connected;
  // An older machine sends no connection: its source says the same.
  const { source } = item;
  if (source.autopilot) return { kind: 'autopilot', id: 'autopilot', name: 'Autopilot' };
  if (source.session) return { kind: 'session', id: source.session.id, name: source.session.name, paneId: source.session.paneId };
  if (source.paneId) return { kind: 'pane', id: source.paneId, name: source.name };
  return { kind: 'machine', id: item.machineId ?? 'local', name: source.name };
}

/** What shows beside the selected item. */
export type Beside =
  | { kind: 'session'; sessionId: string; paneId: string; name: string }
  | { kind: 'pane'; paneId: string; panelId?: string; name: string }
  | { kind: 'machine'; machineId: string; machine: string; connected: NotifyConnected }
  | { kind: 'autopilot' }
  | { kind: 'none'; name?: string };

/**
 * An orchestrator's item (and an older machine's mirror of a worker's question) shows its Session,
 * as does Autopilot's item about one; a worker's question or a standalone Pane's shows the asking
 * Pane. An item from any machine other than the one the app is on (`activeMachineId`, `local` for
 * this computer) shows that machine's context instead, in both directions, and never mounts a
 * terminal here.
 */
export function besideOf(item: NotifyItem, activeMachineId: string): Beside {
  const machineId = item.machineId ?? 'local';
  const connected = connectedOf(item);
  if (machineId !== activeMachineId) return { kind: 'machine', machineId, machine: item.machine ?? 'this computer', connected };
  // Autopilot's own item (D-60): it lives in Autopilot, not in a Pane the person opens.
  if (connected.kind === 'autopilot') return { kind: 'autopilot' };
  // Pane closed it because its asker is gone: there may be no Session or Pane left to mount.
  if (item.closed?.by === 'pane') return { kind: 'none', name: connected.name };
  const { source } = item;
  const orchestrator = source.session?.orchestrator || item.originKind === 'orchestrator';
  if (source.paneId && !source.autopilot && !orchestrator && !item.relay) return { kind: 'pane', paneId: source.paneId, panelId: source.panelId, name: source.name };
  if (connected.kind === 'session') return { kind: 'session', sessionId: connected.id, paneId: connected.paneId, name: connected.name };
  if (connected.kind === 'pane') return { kind: 'pane', paneId: connected.id, name: connected.name };
  return { kind: 'none', name: connected.name };
}

/** An older machine's mirror of a worker's question: it says where the answer goes, in one line. */
export function relayReadOnlyLine(item: NotifyItem): string {
  return `Read-only: ${item.machine ?? 'its machine'} runs an older Pane. Answer there.`;
}

/** A row's text: `acted` is what happened to it (absent while nothing has), `origin` where it came from. */
export function approvalRowLines(item: NotifyItem): { acted?: string; origin: string } {
  const origin = originLine(item);
  const receipt = receiptLine(item);
  const decision = decisionLine(item);
  const answered = [item.answerSummary && `→ ${item.answerSummary}`, receipt, decision].filter(Boolean).join(' · ');
  const acted = item.relay ? 'Read-only'
    : item.closed ? receipt
      : item.state === 'expired' ? 'Expired'
        : item.state === 'info' ? 'Update'
          : answered || undefined;
  return acted ? { acted, origin } : { origin };
}
