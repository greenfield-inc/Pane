import type { NotifyItem } from '../../../../../shared/types/notify';
import { leadingQn } from '../../../../../shared/autopilotDecision';

type ApprovalCardState = 'waiting' | 'answered' | 'closed';

/** What an approval card in the thread says: "Q-10 · answered · D-14", its question, and the answer. */
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
export type TodoEventIcon = 'done' | 'queued' | 'created' | 'stopped' | 'started' | 'waiting' | 'alert' | 'attached' | 'note';

export function todoEventIcon(body: string): TodoEventIcon {
  const text = body.toLowerCase();
  if (/\b(stuck|quiet|failed|restart(ed)?)\b/u.test(text)) return 'alert';
  if (/\b(asks?|asked|waits? on you|question)\b/u.test(text)) return 'waiting';
  if (/\b(held|queued|load)\b/u.test(text)) return 'queued';
  if (/\b(stopped|paused|dropped)\b/u.test(text)) return 'stopped';
  if (/\b(attached|detached)\b/u.test(text)) return 'attached';
  if (/\b(done|passed|answered|approved|accepted|merged)\b/u.test(text)) return 'done';
  if (/\b(created|added)\b/u.test(text)) return 'created';
  if (/\b(started|resumed|assigned|pushed|working)\b/u.test(text)) return 'started';
  return 'note';
}

/** A URL attachment opens as a page; anything else is a file on a machine. */
export function isWebTarget(target: string): boolean {
  return /^https?:\/\//iu.test(target.trim());
}
