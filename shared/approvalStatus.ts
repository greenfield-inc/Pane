import type { NotifyItem } from './types/notify';

/**
 * Where an approval stands after the person sends (P7, D-344), in the words every surface uses:
 * the chat's status line, the Approvals list, the column and the phone. The reader is named for
 * every kind (the asker's tab, the orchestrator that relayed it, Autopilot), never "its reader".
 */

export type ApprovalHolder = 'you' | 'agent' | 'done';

export type ApprovalStatusKind = 'reading' | 'asking' | 'ready-again' | 'taken' | 'sent' | 'unread';

export interface ApprovalStatus {
  kind: ApprovalStatusKind;
  /** One line, such as "okta-sso-account is reading your reply to Q-42". */
  text: string;
  tone: 'muted' | 'warning' | 'info' | 'success';
}

/** "Q-42", when the title leads with one. */
export function approvalQn(item: Pick<NotifyItem, 'title'>): string | undefined {
  return /^\s*(Q-\d+)\b/u.exec(item.title)?.[1];
}

/** "the Doozy orchestrator" opens a sentence as "The Doozy orchestrator"; a tab's name ("okta-sso-account") stays as it is. */
export function sentenceStart(text: string): string {
  return /^the\s/u.test(text) ? `T${text.slice(1)}` : text;
}

/** Who reads the person's reply, as the approval names it: the reader, else the asker. */
export function replyReader(item: Pick<NotifyItem, 'reply' | 'source'>): string {
  return item.reply?.reader?.name ?? item.source.name;
}

/** Who holds the approval now: the person, the agent reading their reply, or nobody (done). */
export function approvalHolder(item: Pick<NotifyItem, 'state' | 'reply' | 'readyAgain'>): ApprovalHolder {
  if (item.state !== 'waiting') return 'done';
  if (item.readyAgain !== undefined) return 'you';
  if (item.reply?.state === 'reading' || item.reply?.state === 'question') return 'agent';
  return 'you';
}

/**
 * The status line after a send, or null while the approval simply waits on the person. `withQn`
 * names the approval ("… your reply to Q-42"), for lines shown away from its card.
 */
export function approvalStatus(item: Pick<NotifyItem, 'title' | 'state' | 'reply' | 'readyAgain' | 'source' | 'answerSummary'>, withQn = false): ApprovalStatus | null {
  const qn = withQn ? approvalQn(item) : undefined;
  const to = qn ? ` to ${qn}` : '';
  const on = qn ? ` on ${qn}` : '';
  const reader = replyReader(item);
  if (item.state === 'waiting' && item.readyAgain !== undefined) return { kind: 'ready-again', text: `${qn ? `${qn} · ` : ''}Updated · ready again`, tone: 'info' };
  const reply = item.reply;
  if (!reply) return null;
  switch (reply.state) {
    case 'reading':
      return item.state === 'waiting' ? { kind: 'reading', text: `${sentenceStart(reader)} is reading your reply${to}`, tone: 'muted' } : null;
    case 'question':
      return item.state === 'waiting' ? { kind: 'asking', text: `${sentenceStart(reader)} is getting more context${on}${reply.status && !/^getting more context/iu.test(reply.status) ? `: ${reply.status}` : ''}`, tone: 'warning' } : null;
    case 'answer': {
      const picked = reply.picks?.filter(Boolean) ?? [];
      const what = picked.length ? `${picked.join(' · ')}, with your note` : `“${reply.text}”`;
      return { kind: 'taken', text: `Taken as your answer${on}: ${what}`, tone: 'success' };
    }
    case 'sent':
      return { kind: 'sent', text: `Sent to ${reader}${qn ? ` (${qn})` : ''}`, tone: 'success' };
    case 'unread':
      return item.state === 'waiting' ? { kind: 'unread', text: `No agent can read your reply${to} right now. You can still pick an option.`, tone: 'warning' } : null;
  }
}
