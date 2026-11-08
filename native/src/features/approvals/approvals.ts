import { decisionLine, receiptLine } from '@shared/approvalReceipts';
import { RemoteUnconfirmedResultError } from '@shared/remoteClient';
import type { NotifyItem, NotifyLink, NotifyRemoteOpenLink, NotifySharedState } from '@shared/types/notify';

import { NOTIFY_KIND_LABEL } from '@/features/notify/notifyQuestions';

/** The group for items asked outside any Session (and every item from an older host). */
export const NOT_IN_A_SESSION = 'Not in a Session';

/** The group for items outside any project (and every item from an older host). */
export const NO_PROJECT = 'No project';

/** How Approvals lists: flat with the newest on top, or in groups. Remembered per device. */
export type ApprovalSort = 'recent' | 'session' | 'project';

export const APPROVAL_SORTS: ReadonlyArray<{ id: ApprovalSort; label: string }> = [
  { id: 'recent', label: 'Most recent' },
  { id: 'session', label: 'By Session' },
  { id: 'project', label: 'By project' },
];

export function parseApprovalSort(value: string | null): ApprovalSort {
  return APPROVAL_SORTS.find(sort => sort.id === value)?.id ?? 'recent';
}

/** What Approvals groups: a Notify item or a permission request, on one machine. */
export interface ApprovalEntry {
  /** Unique on the list. */
  key: string;
  /** The saved profile id of the machine it's on. */
  machineKey: string;
  /** The Session it belongs to; none files it under "Not in a Session". */
  session?: { id: string; name: string };
  /** The project it belongs to; none files it under "No project". */
  project?: string;
  /** Epoch ms it sorts by, newest first: when it was asked, or when it was answered once it's done. */
  at: number;
  /** It waits on you: an open question, a fallback item, or a permission request. False for an answer held for Undo. */
  waiting: boolean;
}

export interface ApprovalGroup<T extends ApprovalEntry> {
  key: string;
  /** Empty for Most recent's one group, which has no header. */
  label: string;
  /** The machine of a Session's or project's group; the groups for neither mix machines and have none. */
  machineKey?: string;
  entries: T[];
}

/**
 * Approvals on home, newest first. Most recent is one flat group; By Session and By project group
 * by that and machine, with each group placed by its newest entry.
 * The desktop's queue column sorts the same way (frontend/src/components/approvals/approvalGroups.ts).
 */
export function groupApprovals<T extends ApprovalEntry>(entries: readonly T[], sort: ApprovalSort): ApprovalGroup<T>[] {
  // By key on a tie, so entries of the same millisecond don't swap as reads arrive.
  const newestFirst = [...entries].sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
  if (sort === 'recent') return newestFirst.length > 0 ? [{ key: 'recent', label: '', entries: newestFirst }] : [];
  const groups = new Map<string, ApprovalGroup<T>>();
  for (const entry of newestFirst) {
    const fresh = sort === 'session' ? sessionGroup<T>(entry) : projectGroup<T>(entry);
    const group = groups.get(fresh.key) ?? fresh;
    groups.set(fresh.key, group);
    group.entries.push(entry);
  }
  return [...groups.values()];
}

function sessionGroup<T extends ApprovalEntry>({ machineKey, session }: ApprovalEntry): ApprovalGroup<T> {
  if (!session) return { key: 'none', label: NOT_IN_A_SESSION, entries: [] };
  return { key: sessionKey(machineKey, session.id), label: session.name || 'Untitled', machineKey, entries: [] };
}

function projectGroup<T extends ApprovalEntry>({ machineKey, project }: ApprovalEntry): ApprovalGroup<T> {
  if (!project) return { key: 'no-project', label: NO_PROJECT, entries: [] };
  return { key: `${machineKey}:project:${project}`, label: project, machineKey, entries: [] };
}

/** A row's who and where, since Most recent has no group header to say it: "api-fix in Sales Skill". */
export function askerLine(asker: string, session?: { name: string }): string {
  return session ? `${asker} in ${session.name || 'Untitled'}` : asker;
}

/** A Session on one machine: Session ids can repeat from one machine to the next. */
export function sessionKey(machineKey: string, sessionId: string): string {
  return `${machineKey}:${sessionId}`;
}

export interface WaitingCounts {
  /** What waits from each Session, by `sessionKey`; a Session with none isn't listed. */
  bySession: ReadonlyMap<string, number>;
  /** Approvals' header: every Session's count plus what waits outside any Session. */
  total: number;
}

/**
 * Home's amber counts (D-38): what waits on you from each Session row, and the total on the
 * Approvals header. Answers held for Undo don't count; fallback items count toward their Session.
 */
export function waitingCounts(entries: readonly ApprovalEntry[]): WaitingCounts {
  const bySession = new Map<string, number>();
  let total = 0;
  for (const entry of entries) {
    if (!entry.waiting) continue;
    total += 1;
    if (!entry.session) continue;
    const key = sessionKey(entry.machineKey, entry.session.id);
    bySession.set(key, (bySession.get(key) ?? 0) + 1);
  }
  return { bySession, total };
}

/** Waiting 3 days unanswered (D-147): it goes to the Stale group and leaves every count. */
export function isStale(item: NotifyItem): boolean {
  return item.state === 'waiting' && item.staleSince !== undefined;
}

/**
 * The Notify items Approvals lists: open questions, an older machine's fallback items, and answers
 * still held for Undo (so a card answered here stays on screen with its Undo until the agent has it).
 */
export function approvalItems(state: NotifySharedState | undefined): NotifyItem[] {
  return (state?.items ?? []).filter(item => (item.state === 'waiting' || item.state === 'sent') && !isStale(item)).sort((a, b) => a.createdAt - b.createdAt);
}

/** The collapsed Stale group at the bottom of Waiting, oldest first. */
export function staleItems(state: NotifySharedState | undefined): NotifyItem[] {
  return (state?.items ?? []).filter(isStale).sort((a, b) => a.createdAt - b.createdAt);
}

/** How long the Answered group lists an item, as the desktop's Answered list does. */
const ANSWERED_WINDOW_MS = 24 * 60 * 60 * 1000;

/** It was answered or closed: its card shows a receipt, and it takes an Override or a Reopen. */
export function isResolved(item: NotifyItem): boolean {
  return item.state === 'answered' || item.state === 'expired';
}

/** The collapsed Answered group: the last 24 hours' answered and closed items, newest first. */
export function answeredItems(state: NotifySharedState | undefined, now: number): NotifyItem[] {
  const resolvedAt = (item: NotifyItem) => item.resolvedAt ?? item.createdAt;
  return (state?.items ?? []).filter(item => isResolved(item) && now - resolvedAt(item) <= ANSWERED_WINDOW_MS).sort((a, b) => resolvedAt(b) - resolvedAt(a));
}

/** Which of Approvals' lists the approval screen steps through. */
export type ApprovalList = 'waiting' | 'stale' | 'answered';

export function parseApprovalList(value: string | undefined): ApprovalList {
  return value === 'stale' || value === 'answered' ? value : 'waiting';
}

/** The ids the approval screen steps through and counts for `list`: the order home shows them in. */
export function approvalListOrder(state: NotifySharedState | undefined, list: ApprovalList, now: number, sort: ApprovalSort): string[] {
  if (list === 'stale') return staleItems(state).map(item => item.id);
  return orderOf(list === 'answered' ? answeredItems(state, now) : approvalItems(state), sort);
}

/** When an item sorts: as it was answered once it's done, else as it was asked. */
export function approvalAt(item: NotifyItem): number {
  return isResolved(item) ? item.resolvedAt ?? item.createdAt : item.createdAt;
}

/** A Notify item as an Approvals entry. */
export function itemEntry(item: NotifyItem, machineKey: string): ApprovalEntry & { item: NotifyItem } {
  const { session, project } = item.source;
  return { key: `${machineKey}:question:${item.id}`, machineKey, at: approvalAt(item), waiting: item.state === 'waiting', item, ...(session ? { session: { id: session.id, name: session.name } } : {}), ...(project ? { project } : {}) };
}

function orderOf(items: readonly NotifyItem[], sort: ApprovalSort): string[] {
  return groupApprovals(items.map(item => itemEntry(item, 'here')), sort).flatMap(group => group.entries.map(entry => entry.item.id));
}

/** The approval screen's order, the same as home's: item ids group by group. "1 of N" counts these. */
export function approvalOrder(state: NotifySharedState | undefined, sort: ApprovalSort): string[] {
  return orderOf(approvalItems(state), sort);
}

/** "1 of 5": where `id` sits in `order`, or null when it isn't there. */
export function approvalPosition(order: readonly string[], id: string): string | null {
  const index = order.indexOf(id);
  return index < 0 ? null : `${index + 1} of ${order.length}`;
}

/** The item after `id`, wrapping to the first; null when `id` is the only one. */
export function nextApproval(order: readonly string[], id: string): string | null {
  const index = order.indexOf(id);
  const next = order[(index + 1) % order.length];
  return next !== undefined && next !== id ? next : null;
}

/**
 * What the approval screen shows for `selected`, given the order now and the order it last showed.
 * show: it's still listed. move: it was answered or withdrawn elsewhere, so step to the one that
 * followed it (or, at the end, the one before). home: it went and nothing is left. gone: it was
 * never on screen (an old alert) and nothing else waits, so say so instead of closing at once.
 */
export type ApprovalSelection =
  | { kind: 'show'; id: string }
  | { kind: 'move'; id: string }
  | { kind: 'home' }
  | { kind: 'gone' };

export function resolveSelection(order: readonly string[], selected: string, shown: readonly string[]): ApprovalSelection {
  if (order.includes(selected)) return { kind: 'show', id: selected };
  const at = shown.indexOf(selected);
  if (at < 0) return order[0] !== undefined ? { kind: 'move', id: order[0] } : { kind: 'gone' };
  const after = shown.slice(at + 1).find(id => order.includes(id));
  const before = shown.slice(0, at).reverse().find(id => order.includes(id));
  const next = after ?? before ?? order[0];
  return next !== undefined ? { kind: 'move', id: next } : { kind: 'home' };
}

/**
 * The workspace under a card: a Session's (with its orchestrator chat), or one Pane's tabs.
 * `panelId` is the tab that asked, which a Pane's workspace opens on until you pick another.
 */
export type ApprovalWorkspace =
  | { kind: 'session'; sessionId: string; paneId: string }
  | { kind: 'pane'; paneId: string; panelId?: string }
  | { kind: 'none' };

/**
 * An orchestrator's item, or a fallback item (which asks you to talk to the orchestrator), opens
 * above its Session's workspace, where typing reaches the orchestrator. Any other item opens above
 * the Pane that asked. `hint` is the Pane a push alert named, for an item the phone can't read.
 */
export function approvalWorkspace(item: NotifyItem | undefined, hint?: string): ApprovalWorkspace {
  const session = item?.source.session;
  if (session && (session.orchestrator || item?.relay)) return { kind: 'session', sessionId: session.id, paneId: session.paneId };
  const paneId = item ? item.source.paneId : hint;
  if (!paneId) return { kind: 'none' };
  const workspace: ApprovalWorkspace = { kind: 'pane', paneId };
  // The asking tab, not whichever tab the desktop has in front.
  if (item?.source.panelId) workspace.panelId = item.source.panelId;
  return workspace;
}

/**
 * The route params for showing approval `notifyId`. Each item starts on its own tab, so the tab
 * picked for the last one is dropped; tabs picked while this one shows stay in `panelId`.
 */
export function approvalParams(notifyId: string): { notifyId: string; panelId: undefined } {
  return { notifyId, panelId: undefined };
}

/**
 * The host's command to open `item`'s link `index` beside its card. The host tries the shown
 * Pane, then a file page there, then the asking Pane. A saved machine's card carries the id
 * `<machineId>:<id>`; the host knows it by the part after the prefix.
 */
export function openLinkCommand(item: NotifyItem, index: number, shownPaneId: string | undefined): NotifyRemoteOpenLink {
  const prefix = item.machineId && item.machineId !== 'local' ? `${item.machineId}:` : null;
  const id = prefix && item.id.startsWith(prefix) ? item.id.slice(prefix.length) : item.id;
  const command: NotifyRemoteOpenLink = { type: 'open-link', id, index };
  if (shownPaneId) command.paneId = shownPaneId;
  return command;
}

/** What tapping a related link did. `panelId` is a new tab in the shown Pane, to bring forward. */
export type LinkOpenOutcome =
  | { kind: 'opened'; panelId?: string }
  | { kind: 'unknown'; message: string }
  | { kind: 'failed'; message: string };

export interface LinkOpener {
  /** Sends one `notify:remote-command`. Never retried here: the host does the fallbacks. */
  send: (command: NotifyRemoteOpenLink) => Promise<unknown>;
  /** The shown Pane's tab ids, read again from the host (and refreshed on screen). */
  readPanels: () => Promise<readonly string[]>;
}

/**
 * Opens a related link with one command. A lost reply is final: the host may have opened it,
 * so the tabs are read again and the person is told to look, never that nothing opened.
 * A definite rejection shows the host's own message. `before` is the shown Pane's tab ids
 * before the tap, to find the tab that opened.
 */
export async function openApprovalLink(
  item: NotifyItem,
  index: number,
  shownPaneId: string | undefined,
  before: readonly string[] | undefined,
  opener: LinkOpener,
): Promise<LinkOpenOutcome> {
  const label = item.links?.[index]?.label ?? 'the link';
  try {
    await opener.send(openLinkCommand(item, index, shownPaneId));
  } catch (error) {
    if (error instanceof RemoteUnconfirmedResultError) {
      await opener.readPanels().catch(() => undefined);
      return { kind: 'unknown', message: `The connection dropped before Pane confirmed it, so Pane may have opened ${label}. Check the tabs before tapping it again.` };
    }
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
  if (!shownPaneId || !before) return { kind: 'opened' };
  const after = await opener.readPanels().catch(() => undefined);
  const added = after?.find(id => !before.includes(id));
  return added ? { kind: 'opened', panelId: added } : { kind: 'opened' };
}

/**
 * Where a `{ label, approval }` link opens on the approval screen: the item it names (by id) and
 * the list that holds it, so Next and "1 of N" step through that list. Null when none of
 * Approvals' lists holds it (a Q-n, which only the computer resolves, or an item past a day).
 */
export function approvalLinkTarget(state: NotifySharedState | undefined, ref: string, now: number): { id: string; list: ApprovalList } | null {
  const lists: ApprovalList[] = ['waiting', 'stale', 'answered'];
  const list = lists.find(candidate => approvalListOrder(state, candidate, now, 'recent').includes(ref));
  return list ? { id: ref, list } : null;
}

/** A related link's chip icon: a page, another approval, or a file. */
export function linkIcon(link: NotifyLink) {
  if ('url' in link) return { ios: 'globe', android: 'language' } as const;
  if ('approval' in link) return { ios: 'checkmark.circle', android: 'check_circle' } as const;
  return { ios: 'doc.text', android: 'description' } as const;
}

/** An older machine's mirror of a worker's question: it takes no answer here. */
export const OLDER_MACHINE_NOTE = 'Its machine runs an older Pane, so only its orchestrator can answer this one. Update Pane there to answer it here.';

/** The card's top line: what it needs, or what happened to it. */
export function approvalKindLabel(item: NotifyItem): string {
  if (item.state === 'answered') return 'Answered';
  if (item.state === 'expired') return item.closed ? 'Closed' : 'Ended';
  return NOTIFY_KIND_LABEL[item.ui];
}

/** Every receipt a card shows: who acted, the decision it was recorded as, and the latest correction. */
export function receiptLines(item: NotifyItem): string[] {
  const correction = item.corrections?.at(-1);
  return [
    receiptLine(item),
    decisionLine(item),
    correction ? `Corrected by ${correction.by === 'you' ? 'you' : correction.by === 'autopilot' ? 'Autopilot' : 'the orchestrator'}: ${correction.summary}` : undefined,
  ].filter(line => line !== undefined);
}

/** What to open from an item's connected row. Null: there's nothing on the phone to open. */
export type ConnectedTarget =
  | { kind: 'session'; sessionId: string }
  | { kind: 'pane'; paneId: string }
  | { kind: 'autopilot' };

export interface ConnectedLink {
  kind: 'session' | 'pane' | 'autopilot' | 'machine';
  text: string;
  target: ConnectedTarget | null;
}

/**
 * What an opened item is connected to (D-168, J32): its Session, its Pane outside a Session,
 * Autopilot, or just the machine. `machine` is the phone's saved name for the item's machine, also
 * used instead of the name the host gave a machine-level item. An older machine sends no
 * `connected`, so it is read from the item's source.
 */
export function connectedLink(item: NotifyItem, machine: string): ConnectedLink {
  const connected = item.connected;
  const session = connected?.kind === 'session' ? connected : connected ? undefined : item.source.session;
  if (session) return { kind: 'session', text: `Session · ${session.name || 'Untitled'} · ${machine}`, target: { kind: 'session', sessionId: session.id } };
  if (connected?.kind === 'autopilot' || (!connected && item.source.autopilot)) return { kind: 'autopilot', text: `Autopilot · ${machine}`, target: { kind: 'autopilot' } };
  const pane = connected?.kind === 'pane' ? connected : !connected && item.source.paneId ? { id: item.source.paneId, name: item.source.name } : undefined;
  if (pane) return { kind: 'pane', text: `Pane · ${pane.name} · ${machine}`, target: { kind: 'pane', paneId: pane.id } };
  return { kind: 'machine', text: machine, target: null };
}

/** One saved machine that isn't online: its approvals collapse to this row (D-147). */
export interface OfflineMachine {
  key: string;
  name: string;
  /** What was waiting there when it was last read. */
  waiting: number;
}

export function machineOfflineLine(machine: string, waiting: number): string {
  return `${machine} offline · ${waiting} waiting · they come back when ${machine} is online`;
}

/** Each Pane's Session, from the host's Session list, for permission requests (which name only their Pane). */
export function sessionsByPane(sessions: ReadonlyArray<{ id: string; name: string; archived?: boolean; associations: ReadonlyArray<{ paneId: string }> }> | undefined): Map<string, { id: string; name: string }> {
  return new Map((sessions ?? []).filter(session => !session.archived)
    .flatMap(session => session.associations.map(association => [association.paneId, { id: session.id, name: session.name }] as const)));
}

/** A question's row on home: its title, what was sent while the answer is held for Undo, or its receipt once it's done. */
export function questionDetail(item: NotifyItem): string {
  if (item.state === 'sent') return `Sent: ${item.answerSummary ?? 'your answer'}`;
  if (!isResolved(item)) return item.title;
  const receipt = receiptLine(item) ?? item.answerSummary;
  return receipt ? `${receipt} · ${item.title}` : item.title;
}
