import { RemoteUnconfirmedResultError } from '@shared/remoteClient';
import type { NotifyItem, NotifyRemoteOpenLink, NotifySharedState } from '@shared/types/notify';

/** The last group on Approvals, for items asked outside any Session (and every item from an older host). */
export const NOT_IN_A_SESSION = 'Not in a Session';

/** What Approvals groups: a Notify item or a permission request, on one machine. */
export interface ApprovalEntry {
  /** Unique on the list. */
  key: string;
  /** The saved profile id of the machine it's on. */
  machineKey: string;
  /** The Session it belongs to; none files it under "Not in a Session". */
  session?: { id: string; name: string };
  /** Epoch ms it was asked: each group lists oldest first. */
  at: number;
  /** It waits on you: an open question, a fallback item, or a permission request. False for an answer held for Undo. */
  waiting: boolean;
}

export interface ApprovalGroup<T extends ApprovalEntry> {
  key: string;
  label: string;
  /** The machine of a Session's group; "Not in a Session" mixes machines and has none. */
  machineKey?: string;
  entries: T[];
}

/**
 * Approvals on home: entries grouped by Session and machine, oldest first, so a new one never
 * moves the one being answered. Groups follow their oldest entry; "Not in a Session" comes last.
 * The desktop's queue column groups the same way (frontend/src/components/approvals/approvalGroups.ts).
 */
export function groupBySession<T extends ApprovalEntry>(entries: readonly T[]): ApprovalGroup<T>[] {
  const groups = new Map<string, ApprovalGroup<T>>();
  let loose: ApprovalGroup<T> | undefined;
  for (const entry of [...entries].sort((a, b) => a.at - b.at)) {
    if (!entry.session) {
      loose ??= { key: 'none', label: NOT_IN_A_SESSION, entries: [] };
      loose.entries.push(entry);
      continue;
    }
    const key = sessionKey(entry.machineKey, entry.session.id);
    let group = groups.get(key);
    if (!group) {
      group = { key, label: entry.session.name || 'Untitled', machineKey: entry.machineKey, entries: [] };
      groups.set(key, group);
    }
    group.entries.push(entry);
  }
  return [...groups.values(), ...(loose ? [loose] : [])];
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

/**
 * The Notify items Approvals lists: open questions, fallback items, and answers still held for
 * Undo (so a card answered here stays on screen with its Undo until the agent has it).
 */
export function approvalItems(state: NotifySharedState | undefined): NotifyItem[] {
  return (state?.items ?? []).filter(item => item.state === 'waiting' || item.state === 'sent').sort((a, b) => a.createdAt - b.createdAt);
}

/** A Notify item as an Approvals entry. */
export function itemEntry(item: NotifyItem, machineKey: string): ApprovalEntry & { item: NotifyItem } {
  const session = item.source.session;
  return { key: `${machineKey}:question:${item.id}`, machineKey, at: item.createdAt, waiting: item.state === 'waiting', item, ...(session ? { session: { id: session.id, name: session.name } } : {}) };
}

/** The approval screen's order, the same as home's: item ids group by group. "1 of N" counts these. */
export function approvalOrder(state: NotifySharedState | undefined, machineKey = 'here'): string[] {
  return groupBySession(approvalItems(state).map(item => itemEntry(item, machineKey))).flatMap(group => group.entries.map(entry => entry.item.id));
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

/** A fallback item's line: it takes no answer here. */
export function relayLine(item: NotifyItem): string | null {
  if (!item.relay) return null;
  const session = item.source.session?.name || 'Session';
  return `Waiting on the ${session} orchestrator: ${item.relay.worker} asks “${item.relay.question}”`;
}

/** The card's top line: what kind, then who asked. */
export function approvalMeta(item: NotifyItem): string {
  return [item.source.name, item.source.agent].filter(Boolean).join(' · ');
}

/** Each Pane's Session, from the host's Session list, for permission requests (which name only their Pane). */
export function sessionsByPane(sessions: ReadonlyArray<{ id: string; name: string; archived?: boolean; associations: ReadonlyArray<{ paneId: string }> }> | undefined): Map<string, { id: string; name: string }> {
  return new Map((sessions ?? []).filter(session => !session.archived)
    .flatMap(session => session.associations.map(association => [association.paneId, { id: session.id, name: session.name }] as const)));
}

/** A question's row on home: its title, what was sent while the answer is held for Undo, or that it waits on an orchestrator. */
export function questionDetail(item: NotifyItem): string {
  if (item.state === 'sent') return `Sent: ${item.answerSummary ?? 'your answer'}`;
  return item.relay ? `Waiting on the orchestrator: ${item.title}` : item.title;
}
