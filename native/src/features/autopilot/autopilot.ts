import type { DecisionModel } from '@shared/autopilotDecision';
import type { AutopilotSnapshot, AutopilotStackEntry } from '@shared/types/autopilot';
import type { NotifyItem } from '@shared/types/notify';

/**
 * Autopilot on the phone (package 5, D-75 to D-77): one chat with its agent, approvals as
 * decision cards in it, an opened approval full screen, a document full screen. No tabs.
 * The card's content comes from shared/autopilotDecision.ts and the chat's blocks and Pane lines
 * from shared/autopilotTranscript.ts, which the desktop reads too.
 */

/** Stack entries not yet resolved. */
function openStackCount(snapshot: AutopilotSnapshot): number {
  return snapshot.stack.entries.filter(entry => entry.doneAt === undefined).length;
}

/** What home's Autopilot row says on its right: Start before Start, Paused, or how many are open. */
export type AutopilotRowState = { kind: 'start'; blocked?: string } | { kind: 'sentinel' } | { kind: 'paused' } | { kind: 'open'; count: number };

export function autopilotRowState(snapshot: AutopilotSnapshot): AutopilotRowState {
  if (snapshot.state !== 'stopped' && snapshot.sentinel) return { kind: 'sentinel' };
  if (snapshot.state === 'paused') return { kind: 'paused' };
  if (snapshot.state === 'running') return { kind: 'open', count: openStackCount(snapshot) };
  const blocked = startBlocked(snapshot);
  return blocked ? { kind: 'start', blocked } : { kind: 'start' };
}

/** Why Start can't run here, with the next step, or undefined when it can. */
export function startBlocked(snapshot: AutopilotSnapshot): string | undefined {
  if (!snapshot.entitlement.entitled) return [snapshot.entitlement.reason, snapshot.entitlement.next].filter(Boolean).join(' ') || 'Autopilot is not available on this computer.';
  if (!snapshot.chatTabsEnabled) return 'Autopilot runs as a chat tab, and chat tabs are off on this computer. Turn on Chat tabs in Settings › Advanced › Experimental there, then press Start.';
  return undefined;
}

export interface WalkChip {
  id: string;
  name: string;
  waiting: number;
  current: boolean;
}

/** The walk bar (D-59): Running or Paused, then every Session with something waiting, the current one marked. */
export function walkBar(snapshot: AutopilotSnapshot): { status: 'Sentinel' | 'Running' | 'Paused' | 'Not started'; chips: WalkChip[] } {
  // Sentinel Mode (package 7) keeps Sessions moving while the person is away; the bar says so.
  const status = snapshot.sentinel && snapshot.state !== 'stopped' ? 'Sentinel' : snapshot.state === 'paused' ? 'Paused' : snapshot.state === 'running' ? 'Running' : 'Not started';
  const chips = snapshot.walk.sessions
    .filter(session => session.waiting > 0 || session.id === snapshot.walk.sessionId)
    .map(session => ({ id: session.id, name: session.name, waiting: session.waiting, current: session.id === snapshot.walk.sessionId }));
  return { status, chips };
}

/** The stack entry for an item, if Autopilot put it there. */
export function stackEntryFor(snapshot: AutopilotSnapshot | undefined, notifyId: string): AutopilotStackEntry | undefined {
  return snapshot?.stack.entries.find(entry => entry.ref.kind === 'item' && entry.ref.notifyId === notifyId);
}

/**
 * "1 of 4" on the approval screen: where the item sits among the items Autopilot put on the stack,
 * or, for one it hasn't, among `fallback` (Approvals' order). Null when it is in neither.
 */
export function itemPosition(snapshot: AutopilotSnapshot | undefined, notifyId: string, fallback: readonly string[]): string | null {
  const onStack = (snapshot?.stack.entries ?? []).flatMap(entry => entry.ref.kind === 'item' ? [entry.ref.notifyId] : []);
  const order = onStack.includes(notifyId) ? onStack : fallback;
  const index = order.indexOf(notifyId);
  return index < 0 ? null : `${index + 1} of ${order.length}`;
}

/** The composer's hint while an item is on screen: "Ask about Q-14…". */
export function composerPlaceholder(snapshot: AutopilotSnapshot | undefined, items: readonly NotifyItem[], model: (item: NotifyItem) => DecisionModel): string {
  const ref = snapshot?.stack.entries.find(entry => entry.id === snapshot.stack.shownId)?.ref;
  const item = ref?.kind === 'item' ? items.find(candidate => candidate.id === ref.notifyId) : undefined;
  const qn = item?.state === 'waiting' ? model(item).qn : undefined;
  return qn ? `Ask about ${qn}…` : 'Message Autopilot…';
}

type DocIcon = 'file' | 'image' | 'globe';

/** One row under "Related docs": a file on the computer or a page. */
export type RelatedDoc =
  | { key: string; kind: 'file'; label: string; path: string; icon: DocIcon; detail: string }
  | { key: string; kind: 'url'; label: string; url: string; icon: DocIcon; detail: string };

const IMAGE = /\.(png|jpe?g|gif|webp|svg|heic)$/i;

/** A file's folder as the row's right-hand detail: its last three folders ("runs/1/docs"). */
function folderDetail(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.slice(-4, -1).join('/');
}

function urlDetail(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname);
  } catch {
    return url;
  }
}

/**
 * An item's related documents: its own links, then the files and pages Autopilot added to its
 * stack entry, each once.
 */
export function relatedDocs(item: NotifyItem, entry?: AutopilotStackEntry): RelatedDoc[] {
  const docs: RelatedDoc[] = [];
  const seen = new Set<string>();
  const add = (doc: RelatedDoc) => {
    if (seen.has(doc.key)) return;
    seen.add(doc.key);
    docs.push(doc);
  };
  const file = (label: string, path: string) => add({ key: `file:${path}`, kind: 'file', label, path, icon: IMAGE.test(path) ? 'image' : 'file', detail: folderDetail(path) });
  const page = (label: string, url: string) => add({ key: `url:${url}`, kind: 'url', label, url, icon: 'globe', detail: urlDetail(url) });
  for (const link of item.links ?? []) {
    if ('path' in link) file(link.label, link.path);
    else page(link.label, link.url);
  }
  for (const tab of entry?.tabs ?? []) {
    if (tab.kind === 'file') file(tab.label, tab.path);
    else if (tab.kind === 'url') page(tab.label, tab.url);
  }
  return docs;
}

/** The context section's right-hand label: who wrote it. */
export function contextSource(model: DecisionModel): string {
  return model.byAutopilot ? 'written by Autopilot' : `from ${model.who}`;
}

/** What the card shows: an open decision, an answer held for Undo, a recorded answer, or why it takes none. */
export type CardState =
  | { kind: 'open' }
  | { kind: 'held'; answer: string }
  | { kind: 'answered'; answer: string; recorded: string }
  | { kind: 'closed'; message: string };

export function cardState(item: NotifyItem | undefined): CardState {
  if (!item) return { kind: 'closed', message: 'No longer waiting.' };
  if (item.relay) return { kind: 'closed', message: `Waiting on the ${item.source.session?.name ?? 'Session'} orchestrator, which answers ${item.relay.worker}.` };
  switch (item.state) {
    case 'waiting':
      return item.agentPrompt?.inTerminal ? { kind: 'closed', message: `${item.source.agent} is asking in the terminal now. Answer it on the computer.` } : { kind: 'open' };
    case 'sent':
      return { kind: 'held', answer: item.answerSummary ?? 'Your answer' };
    case 'answered':
      // Only the person answers (D-66): the item records who took it.
      return { kind: 'answered', answer: item.answerSummary ?? 'Answered', recorded: `by you · ${item.source.autopilot ? 'Autopilot' : item.source.session?.name ?? item.source.name} recorded it` };
    case 'expired':
      return { kind: 'closed', message: `${item.source.agent} stopped waiting.` };
    case 'info':
      return { kind: 'closed', message: 'An update. There is nothing to answer.' };
  }
}

/**
 * The approval screen's bottom bar: the options as buttons (two or fewer), "Pick one above"
 * (more), a text field (an open question), or nothing to press.
 */
export function answerBar(model: DecisionModel, state: CardState): 'buttons' | 'pick' | 'text' | 'none' {
  if (state.kind !== 'open' || !model.answerable) return 'none';
  if (model.freeText) return 'text';
  return model.options.length <= 2 ? 'buttons' : 'pick';
}

/** The document screen's back label: the item's Q-n, or its kind. */
export function docBackLabel(model: DecisionModel | undefined): string {
  return model?.qn ?? model?.kind ?? 'Back';
}

/** A file's name from its path. */
export function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Hosts from before Autopilot answer its channels with "No Pane daemon command registered". */
export function autopilotUnsupported(error: Error | null): boolean {
  return error?.message.includes('No Pane daemon command registered') ?? false;
}
