import { receiptLine } from '@shared/approvalReceipts';
import { approvalStatus } from '@shared/approvalStatus';
import type { NotifyAnswer, NotifyItem, NotifyRevision, NotifySharedState, NotifyUi } from '@shared/types/notify';

/** The desktop card's kind labels (frontend/src/components/notify/notifyFormat.ts). */
export const NOTIFY_KIND_LABEL = {
  options: 'Needs a choice',
  approve: 'Needs approval',
  ask: 'Needs an answer',
  secret: 'Asking for a secret',
  info: 'Update',
} satisfies Record<NotifyUi, string>;

/** This phone's answer, from the moment the host accepted it: the snapshot it was answered over. */
export interface AnsweredHere {
  epoch: string;
  revision: number;
}

export type NotifySheetState =
  | { kind: 'question'; item: NotifyItem }
  /** An answer every screen holds for Undo; `title` says who answered. */
  | { kind: 'held'; title: string; summary?: string }
  /** This phone's answer reached the agent, so the sheet closes. */
  | { kind: 'done'; title: string; summary?: string }
  /** Nothing left to answer here; `message` says why. */
  | { kind: 'closed'; message: string };

/**
 * What the sheet shows for a question, from the host's snapshot. Until a snapshot newer than
 * `answeredHere` arrives, this phone's answer reads as sent; after that the host's state decides.
 */
export function notifySheetState(shared: NotifySharedState, notifyId: string, answeredHere: AnsweredHere | null): NotifySheetState {
  const item = shared.items.find(candidate => candidate.id === notifyId);
  if (!item) return { kind: 'closed', message: 'This question is no longer waiting.' };
  // A secret's answer goes to the host's store, not to the agent; its summary says where.
  const sentTo = item.ui === 'secret' ? 'Answered' : `Sent to ${item.source.agent}`;
  switch (item.state) {
    case 'waiting': {
      if (item.agentPrompt?.inTerminal) return { kind: 'closed', message: inTerminalMessage(item) };
      const olderThanAnswer = answeredHere !== null && shared.epoch === answeredHere.epoch && shared.revision <= answeredHere.revision;
      if (!olderThanAnswer) return { kind: 'question', item };
      // The host saves a secret and delivers at once, with no Undo to hold for.
      return item.ui === 'secret' ? { kind: 'done', title: sentTo } : { kind: 'held', title: sentTo };
    }
    case 'sent':
      return { kind: 'held', title: answeredHere ? sentTo : `Answered on ${item.answeredOn ?? 'another screen'}`, summary: item.answerSummary };
    case 'answered':
      return answeredHere
        ? { kind: 'done', title: sentTo, summary: item.answerSummary }
        : { kind: 'closed', message: receiptLine(item) ?? `Already answered on ${item.answeredOn ?? 'another screen'}` };
    case 'expired':
      return { kind: 'closed', message: receiptLine(item) ?? `${item.source.agent} stopped waiting` };
    case 'info':
      return { kind: 'closed', message: 'This is an update. There is nothing to answer.' };
  }
}

/** Questions still waiting for an answer, oldest first. */
export function waitingQuestions(state: NotifySharedState | undefined): NotifyItem[] {
  return (state?.items ?? []).filter(item => item.state === 'waiting').sort((a, b) => a.createdAt - b.createdAt);
}

/** An agent prompt whose agent stopped waiting on Pane: only its terminal can answer it now. */
export function inTerminalMessage(item: NotifyItem): string {
  return `${item.source.agent} is asking in the terminal now. Open the Pane to answer.`;
}

/** How a reply's status line is coloured: green taken as the answer, amber asked about, blue ready again. */
export type ReplyTone = 'success' | 'warning' | 'accent' | 'muted';

/**
 * What the phone says about the person's typed reply, or about an approval that came back
 * updated (the desktop's chips, as text). `fix` is the one-tap correction it offers, if any.
 */
export interface ReplyStatus {
  text: string;
  tone: ReplyTone;
  /** A second line: what the reader is doing, or the reply as typed. */
  detail?: string;
  /** "It was a question" sends `question`; "It was my answer" sends `answer`. */
  fix?: { as: 'answer' | 'question'; label: string };
}

/**
 * Where the person's reply stands, in the words every surface uses (`approvalStatus` in
 * shared/approvalStatus.ts, which names the reader for every kind), with this phone's tone.
 */
export function replyStateLine(item: NotifyItem): { text: string; tone: ReplyTone } | null {
  const status = approvalStatus(item);
  return status ? { text: status.text, tone: status.tone === 'info' ? 'accent' : status.tone } : null;
}

export function replyStatus(item: NotifyItem): ReplyStatus | null {
  const line = replyStateLine(item);
  const reply = item.reply;
  if (!line || !reply || (item.state === 'waiting' && item.readyAgain !== undefined)) return line;
  const quote = `You wrote: “${reply.text}”${reply.picks?.some(Boolean) ? ` (picked: ${reply.picks.filter(Boolean).join(' · ')})` : ''}`;
  switch (reply.state) {
    case 'answer':
      return { ...line, detail: quote, ...(reply.fixed ? {} : { fix: { as: 'question' as const, label: 'It was a question' } }) };
    case 'question':
      return { ...line, detail: quote, ...(reply.fixed ? {} : { fix: { as: 'answer' as const, label: 'It was my answer' } }) };
    default:
      return { ...line, detail: quote };
  }
}

/** The detail screen's What changed: the version, the person's question, and the asker's lines. */
export interface RevisionNote {
  version: number;
  asked: string;
  by: string;
  whatChanged: string[];
}

export function revisionNote(item: NotifyItem): RevisionNote | null {
  const revision: NotifyRevision | undefined = item.revision;
  if (!revision) return null;
  return { version: item.version ?? 2, asked: revision.asked, by: revision.by, whatChanged: revision.whatChanged.filter(line => line.trim()) };
}

/**
 * An options answer from the phone. Picks alone keep today's answer (`{ choice }` for one
 * question, `{ picks }` for several, once each has one); anything typed goes as a reply,
 * `{ picks, text }`, with an empty string for each question left unpicked. Null: nothing to send.
 */
export function optionsAnswer(item: NotifyItem, picks: readonly (string | undefined)[], typed: string): NotifyAnswer | null {
  const count = item.questions?.length ?? 1;
  const all = Array.from({ length: count }, (_, index) => picks[index] ?? '');
  // A choice-only question ignores typed words: the host would refuse them (F-10).
  const text = item.optionsOnly ? '' : typed.trim();
  if (text) return { picks: all, text };
  if (!all.every(Boolean)) return null;
  return item.questions ? { picks: all } : { choice: all[0] };
}

/** Several questions' first picks: each question's recommended choice, or none (J1). */
export function initialPicks(item: NotifyItem): string[] {
  return (item.questions ?? []).map(question => question.choices.find(choice => choice.recommended)?.label ?? '');
}

/** A typed reply, which its reader takes as an answer or a question, rather than an answer as it stands. */
export function isReply(answer: NotifyAnswer): boolean {
  return 'picks' in answer && Boolean(answer.text?.trim());
}
