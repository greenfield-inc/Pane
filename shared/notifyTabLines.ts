import { leadingQn } from './autopilotDecision';
import type { NotifyItem, NotifyReply } from './types/notify';

/**
 * The lines Pane types into an asking or reading tab about an approval (`answer: Q-39 → Yes (by you)`,
 * `reply: Q-20 → "…" (by you)`, `closed: Q-1 (by you): …`). Main types them (notifyQueue); a chat
 * tab matches its messages against them so it can show Pane's line as Pane's, not the person's (T-133).
 */

/** One line: a newline in an answer would submit early, and a control character is a key press. */
export function oneLine(text: string): string {
  return text.replace(/\p{Cc}+/gu, ' ');
}

/** A tab's close line, for one close or several waiting for the same tab: `closed: Q-1, Q-2 (by you): <reason>`. */
export function closedLine(refs: readonly string[], tail: string): string {
  return oneLine(`closed: ${refs.join(', ')} ${tail}`);
}

/** How a tab line names an approval: its Q-n, else its title in quotes (cut at 80 characters). */
export function askerRef(item: Pick<NotifyItem, 'title'>): string {
  return leadingQn(item.title) ?? `"${item.title.length > 80 ? `${item.title.slice(0, 79)}…` : item.title}"`;
}

/** Without a Q-n, a line names the item's id too, so its reader can pass it to --took and --update. */
export function idTag(item: Pick<NotifyItem, 'title' | 'id'>): string {
  return leadingQn(item.title) ? '' : ` [id ${item.id}]`;
}

/** The line a tab receives: `answer: Q-39 → Yes (by you)`. */
export function answerLine(item: NotifyItem): string {
  const by = item.answeredBy?.by === 'autopilot' ? 'Autopilot' : item.answeredBy?.by === 'orchestrator' ? 'the orchestrator' : 'you';
  return `answer: ${askerRef(item)} → ${item.answerSummary ?? ''}${idTag(item)} (by ${by})`;
}

/** Picks in question order; one left unpicked reads "—", so each pick stays beside its own question. */
export function picksText(picks: readonly string[]): string {
  return picks.map(pick => pick || '—').join(' · ');
}

/** The line a reader receives: `reply: Q-20 → "…" (picked: Yes · One train) (by you)`. */
export function replyLine(item: NotifyItem, reply: NotifyReply): string {
  const picked = reply.picks?.length ? ` (picked: ${picksText(reply.picks)})` : '';
  return `reply: ${askerRef(item)} → "${reply.text}"${picked}${idTag(item)} (by you)`;
}

/** What a Pane approval line in a chat is: which kind, and the approval it names. */
export interface PaneApprovalLine {
  kind: 'answer' | 'reply' | 'closed' | 'correction';
  /** The approval's Q-n or quoted title, as the line names it (several for a close of several). */
  refs: string[];
}

const KINDS = ['answer', 'reply', 'correction'] as const;
const LINE = /^(answer|reply|correction): (Q-[0-9]+|"[^\n]*?") → [^\n]*\(by [^\n()]+\)$/u;
const CLOSED = /^closed: ((?:Q-[0-9]+|"[^\n]*?")(?:, (?:Q-[0-9]+|"[^\n]*?"))*) \(by [^\n()]+\)/u;

/** Only the shape: a line shaped like Pane's proves nothing by itself (the person can type one). */
function lineKindOf(text: string): PaneApprovalLine | undefined {
  const line = LINE.exec(text);
  const kind = line ? KINDS.find(known => known === line[1]) : undefined;
  if (line && kind) return { kind, refs: [line[2]] };
  const closed = CLOSED.exec(text);
  return closed ? { kind: 'closed', refs: closed[1].split(', ') } : undefined;
}

/** The tabs Pane types an approval's lines into: the asker's, its reply's reader's, and the orchestrator that relayed it. */
export function typesInto(item: NotifyItem, panelId: string): boolean {
  return item.source.panelId === panelId || item.reply?.reader?.panelId === panelId || item.relayedBy?.panelId === panelId;
}

/** The text as typed: Pane's line is one line, so only the ends' whitespace may differ. */
const same = (a: string, b: string) => oneLine(a).trim() === oneLine(b).trim();

/**
 * A message typed into this tab that Pane's approval records vouch for: an approval this tab asks,
 * reads or relayed has the line's ref and the state it reports, and for an answer or a reply, the
 * exact text Pane types. Undefined for anything else, which stays the person's own message.
 */
export function paneApprovalLine(text: string, panelId: string, items: readonly NotifyItem[]): PaneApprovalLine | undefined {
  const typed = text.trim();
  const parsed = lineKindOf(typed);
  if (!parsed) return undefined;
  const id = /\[id ([^\]\s]+)\] \(by [^\n()]+\)/u.exec(typed)?.[1];
  const mine = items.filter(item => typesInto(item, panelId) && (!id || item.id === id));
  const named = (ref: string) => mine.filter(item => askerRef(item) === ref);
  switch (parsed.kind) {
    case 'answer':
      return named(parsed.refs[0]).some(item => item.answerSummary !== undefined && same(answerLine(item), typed)) ? parsed : undefined;
    case 'reply':
      return named(parsed.refs[0]).some(item => item.reply && same(replyLine(item, item.reply), typed)) ? parsed : undefined;
    case 'correction':
      return named(parsed.refs[0]).some(item => (item.corrections?.length ?? 0) > 0 || item.reply?.fixed !== undefined || item.relayedBy !== undefined) ? parsed : undefined;
    case 'closed':
      return parsed.refs.every(ref => named(ref).some(item => item.closed !== undefined || item.state === 'expired')) ? parsed : undefined;
  }
}

/** The approvals whose lines Pane types into this tab. */
export function approvalsTypedInto(items: readonly NotifyItem[], panelId: string): NotifyItem[] {
  return items.filter(item => typesInto(item, panelId));
}
