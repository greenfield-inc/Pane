import type { NotifyItem } from '../../../../../shared/types/notify';
import type { TodoActivity } from '../../../../../shared/types/todos';
import { leadingQn } from '../../../../../shared/autopilotDecision';

/** One entry of a to-do's chat, in time order: an activity row, or a card for one of its approvals. */
export type TodoChatEntry =
  | { kind: 'activity'; at: number; activity: TodoActivity }
  | { kind: 'approval'; at: number; item: NotifyItem };

/**
 * The chat as the page shows it: the to-do's activity with a card for each linked approval, placed
 * by when it was asked. An approval no longer in the Notify snapshot has nothing to show and is left
 * out. Entries at the same time keep activity first, then the order they came in.
 */
export function mergeTodoChat(activity: readonly TodoActivity[], approvalIds: readonly string[], items: readonly NotifyItem[]): TodoChatEntry[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const entries: TodoChatEntry[] = activity.map((row) => ({ kind: 'activity', at: row.createdAt, activity: row }));
  for (const id of approvalIds) {
    const item = byId.get(id);
    if (!item || seen.has(id)) continue;
    seen.add(id);
    entries.push({ kind: 'approval', at: item.createdAt, item });
  }
  // Array.prototype.sort is stable, so equal times keep activity (pushed first) ahead of cards.
  return entries.sort((a, b) => a.at - b.at);
}

type ApprovalCardState = 'waiting' | 'answered' | 'closed';

/** What an approval card in the chat says: "Q-10 · answered · D-14", its question, and the answer. */
export interface ApprovalCardView {
  qn?: string;
  question: string;
  context?: string;
  state: ApprovalCardState;
  /** "Q-11 · waiting on you", "Q-10 · answered · D-14", "Q-9 · closed". */
  label: string;
  answer?: string;
}

export function approvalCardView(item: NotifyItem): ApprovalCardView {
  const qn = leadingQn(item.title);
  const question = qn ? item.title.slice(item.title.indexOf(qn) + qn.length).replace(/^\s*[:·.–—-]?\s*/u, '') || item.title : item.title;
  const state: ApprovalCardState = item.state === 'waiting' ? 'waiting'
    : item.state === 'answered' || item.state === 'sent' ? 'answered'
      : 'closed';
  const head = qn ?? 'Approval';
  const label = state === 'waiting' ? `${head} · waiting on you`
    : state === 'answered' ? `${head} · answered${item.decision ? ` · ${item.decision}` : ''}`
      : `${head} · ${item.closed ? `closed: ${item.closed.reason}` : 'closed'}`;
  const view: ApprovalCardView = { question, state, label };
  if (qn) view.qn = qn;
  if (item.context) view.context = item.context;
  if (state === 'answered' && item.answerSummary) view.answer = item.answerSummary;
  return view;
}

/** The small icon an event row carries, read from its words (Pane writes events as plain lines). */
export type TodoEventIcon = 'done' | 'queued' | 'created' | 'stopped' | 'started' | 'waiting' | 'alert' | 'note';

export function todoEventIcon(body: string): TodoEventIcon {
  const text = body.toLowerCase();
  if (/\b(stuck|quiet|failed|restart(ed)?)\b/u.test(text)) return 'alert';
  if (/\b(asks?|asked|waits? on you|question)\b/u.test(text)) return 'waiting';
  if (/\b(held|queued|load)\b/u.test(text)) return 'queued';
  if (/\b(stopped|paused|dropped)\b/u.test(text)) return 'stopped';
  if (/\b(done|passed|answered|approved|accepted|merged)\b/u.test(text)) return 'done';
  if (/\b(created|added)\b/u.test(text)) return 'created';
  if (/\b(started|resumed|assigned|pushed|working)\b/u.test(text)) return 'started';
  return 'note';
}

/** How a message the person sent reads under it: delivered, or why not yet. */
export function deliveryLine(activity: Pick<TodoActivity, 'deliveredAt' | 'toName'>): string {
  if (activity.deliveredAt !== undefined) return activity.toName ? `Delivered to ${activity.toName}` : 'Delivered';
  return 'waiting for the agent to finish its turn';
}

/** A URL attachment opens as a page; anything else is a file on a machine. */
export function isWebTarget(target: string): boolean {
  return /^https?:\/\//iu.test(target.trim());
}
