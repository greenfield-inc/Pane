import type { NotifyChoice, NotifyItem, NotifyLink, NotifySubQuestion, NotifyVersion } from '../../../../shared/types/notify';
import { approvalStatus, replyReader, sentenceStart } from '../../../../shared/approvalStatus';

/**
 * The approval column's logic (P3 of the approval card), kept apart from its rendering: the
 * questions an item asks, how each option changed since the version before, how the person's
 * reply was taken, and the order the pager walks.
 */

/** One question as the column shows it: an options approval's own choices count as one. */
export interface CardQuestion {
  title: string;
  /** Why this question matters, shown under it. */
  why?: string;
  choices: CardChoice[];
  /** Choices the version before had and this one dropped: shown struck out, once. */
  removed: string[];
}

interface CardChoice extends NotifyChoice {
  /** NEW: added in this version. REWORDED: its label or detail changed (the old one struck through). */
  mark?: 'new' | 'reworded';
  /** What it said before, for a reworded choice. */
  before?: { label: string; detail?: string };
}

/** The questions an item asks, with no marks: approve reads as Approve or Deny. */
export function questionsOf(item: Pick<NotifyItem, 'ui' | 'title' | 'choices' | 'questions'>): NotifySubQuestion[] {
  if (item.questions?.length) return item.questions;
  if (item.ui === 'options' && item.choices?.length) return [{ title: item.title, choices: item.choices }];
  if (item.ui === 'approve') return [{ title: item.title, choices: [{ label: 'Approve', recommended: false }, { label: 'Deny' }] }];
  return [];
}

/** The version before this one, if the asker updated it. */
export function previousVersion(item: NotifyItem): NotifyVersion | undefined {
  return item.versions?.at(-1);
}

/**
 * The current questions, each choice marked against the version before (D-246): NEW where it was
 * added, REWORDED where its label (named by `was`) or its detail changed, and the dropped ones.
 */
export function markedQuestions(item: NotifyItem): CardQuestion[] {
  const current = questionsOf(item);
  const before = previousVersion(item);
  const withWhy = (question: NotifySubQuestion, card: Omit<CardQuestion, 'why'>): CardQuestion => (question.why ? { ...card, why: question.why } : card);
  if (!before) return current.map(question => withWhy(question, { title: question.title, choices: question.choices.map(choice => ({ ...choice })), removed: [] }));
  const earlier = questionsOf({ ui: item.ui, title: before.title, choices: before.choices, questions: before.questions });
  return current.map((question, index) => {
    const old = earlier[index]?.choices ?? [];
    const used = new Set<string>();
    const choices = question.choices.map((choice): CardChoice => {
      const match = old.find(candidate => candidate.label === (choice.was ?? choice.label));
      if (!match) return { ...choice, mark: 'new' };
      used.add(match.label);
      if (match.label !== choice.label || (match.detail ?? '') !== (choice.detail ?? '')) {
        const before: NonNullable<CardChoice['before']> = { label: match.label };
        if (match.detail) before.detail = match.detail;
        return { ...choice, mark: 'reworded', before };
      }
      return { ...choice };
    });
    const removed: string[] = [];
    for (const choice of old) if (!used.has(choice.label)) removed.push(choice.label);
    return withWhy(question, { title: question.title, choices, removed });
  });
}

/** How the person's reply stands, as one quiet line with its tone and its fix. */
export interface ReplyLine {
  tone: 'muted' | 'success' | 'warning' | 'info';
  text: string;
  fix?: { as: 'answer' | 'question'; label: string };
}

/** What the approval says about the person's last reply, or nothing when there's none. */
export function replyLine(item: NotifyItem): ReplyLine | null {
  const reply = item.reply;
  if (!reply) return null;
  const status = approvalStatus(item);
  switch (reply.state) {
    case 'reading':
      return { tone: 'muted', text: `${status?.text ?? `${sentenceStart(replyReader(item))} is reading your reply`}…` };
    case 'answer': {
      const line: ReplyLine = { tone: 'success', text: `Taken as your answer${reply.picks?.some(Boolean) ? `: ${reply.picks.map(pick => pick || '—').join(' · ')}, with your note “${reply.text}”` : `: “${reply.text}”`}` };
      // A fix is one click, once.
      if (!reply.fixed) line.fix = { as: 'question', label: 'It was a question' };
      return line;
    }
    case 'question': {
      const line: ReplyLine = { tone: 'warning', text: `Taken as a question: ${status?.text ?? `${sentenceStart(replyReader(item))} is getting more context`}${status?.text.includes(':') ? '' : '…'}` };
      if (!reply.fixed) line.fix = { as: 'answer', label: 'It was my answer' };
      return line;
    }
    case 'sent':
      return { tone: 'success', text: `Sent to ${reply.reader?.name ?? item.source.agent}` };
    case 'unread':
      return { tone: 'warning', text: 'No agent can read replies right now. You can still pick an option.' };
  }
}

/** The approval's chip: where it stands at a glance (list rows, the pager, inline cards). */
export type CardChip = { tone: 'info' | 'warning' | 'muted' | 'success'; text: string } | null;

export function cardChip(item: NotifyItem): CardChip {
  if (item.state === 'answered') return { tone: 'success', text: 'Answered' };
  if (item.state !== 'waiting') return null;
  if (item.readyAgain !== undefined) return { tone: 'info', text: 'Updated · ready again' };
  // The reader by name, for every kind of reader (P7).
  if (item.reply?.state === 'question') return { tone: 'warning', text: `${sentenceStart(replyReader(item))} is getting more context` };
  if (item.reply?.state === 'reading') return { tone: 'muted', text: `${sentenceStart(replyReader(item))} is reading your reply` };
  return null;
}

/** The last reply reached its reader, which hasn't said how it took it yet. */
export function replyBeingRead(item: NotifyItem): boolean {
  return item.reply?.state === 'reading' && item.reply.deliveredAt !== undefined;
}

/** Being read or asked about: Send moves past it (J14). */
function isBeingRead(item: NotifyItem): boolean {
  return item.state === 'waiting' && (item.reply?.state === 'reading' || item.reply?.state === 'question');
}

/** A pager dot's colour: the open one, ready again, being read or asked about, or waiting. */
export function dotTone(item: NotifyItem | undefined, current: boolean): 'current' | 'info' | 'warning' | 'muted' {
  if (current) return 'current';
  if (!item) return 'muted';
  if (item.readyAgain !== undefined && item.state === 'waiting') return 'info';
  if (isBeingRead(item)) return 'warning';
  return 'muted';
}

/**
 * Whether Send can go: an answer needs one pick per question; anything typed is a reply. A
 * permission prompt takes only its options.
 */
export function canSend(item: NotifyItem, picks: readonly string[], text: string): boolean {
  if (item.state !== 'waiting') return false;
  // One reply at a time with its reader (F-2): while it reads the last one, only picks can go.
  if (text.trim() && !item.agentPrompt && !item.optionsOnly) return !replyBeingRead(item);
  const questions = questionsOf(item);
  return questions.length > 0 && picks.length >= questions.length && questions.every((_, index) => Boolean(picks[index]));
}

/** The column's tabs, in order (D-224): Questions & answers, Summary, each reference, the chat where it was asked. */
export type CardTab =
  | { kind: 'qa'; key: 'qa'; label: string }
  | { kind: 'summary'; key: 'summary'; label: string }
  | { kind: 'link'; key: string; label: string; link: NotifyLink; index: number }
  | { kind: 'origin'; key: 'origin'; label: string };

/** `inChat`: the panel the person is already looking at; the origin tab is left out when it's that one. */
export function cardTabs(item: NotifyItem, inChat?: string): CardTab[] {
  const tabs: CardTab[] = [
    { kind: 'qa', key: 'qa', label: 'Decide' },
    { kind: 'summary', key: 'summary', label: 'Summary' },
  ];
  (item.links ?? []).forEach((link, index) => tabs.push({ kind: 'link', key: `link:${index}:${link.label}`, label: link.label, link, index }));
  const origin = originPanel(item);
  if (origin && origin !== inChat) tabs.push({ kind: 'origin', key: 'origin', label: `${item.source.session?.orchestrator ? `${item.source.session.name} orchestrator` : item.source.name}'s tab` });
  return tabs;
}

/** The tab where it was asked, when it was asked from one. */
function originPanel(item: NotifyItem): string | undefined {
  if (item.source.autopilot || item.summaryOf) return undefined;
  return item.source.panelId;
}

/** "doozy-overhaul asks · relayed · Doozy · tylers-mac-mini": who asked, from where. */
export function askedBy(item: NotifyItem): string[] {
  const parts = [`${item.source.session?.orchestrator ? `${item.source.session.name} orchestrator` : item.source.name} asks`];
  if (item.relayedBy || item.originKind === 'worker') parts.push('relayed');
  const session = item.source.session?.name ?? (item.connected?.kind === 'session' ? item.connected.name : undefined);
  if (session && !item.source.session?.orchestrator) parts.push(session);
  if (item.machine) parts.push(item.machine);
  return parts;
}

/** Waiting items connected to a Session (its own, its workers', Autopilot's about it), oldest first. */
export function sessionApprovals(items: readonly NotifyItem[], sessionId: string): NotifyItem[] {
  return items
    .filter(item => item.state === 'waiting' && !item.relay && item.staleSince === undefined
      && (item.source.session?.id === sessionId || (item.connected?.kind === 'session' && item.connected.id === sessionId)))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** "1 ready": how many of these came back updated and wait again. */
export function readyCount(items: readonly NotifyItem[]): number {
  return items.filter(item => item.state === 'waiting' && item.readyAgain !== undefined).length;
}

/** Which approval a Session's count opens: its newest ready-again one, else its first waiting one (J15). */
export function firstToOpen(items: readonly NotifyItem[]): NotifyItem | undefined {
  const ready = items.filter(item => item.readyAgain !== undefined).sort((a, b) => (b.readyAgain ?? 0) - (a.readyAgain ?? 0));
  return ready[0] ?? items.find(item => !isBeingRead(item)) ?? items[0];
}

/** The picks a fresh card starts with: each question's recommended option, '' where none is. */
export function recommendedPicks(item: NotifyItem): string[] {
  if (item.agentPrompt) return [];
  return questionsOf(item).map(question => question.choices.find(choice => choice.recommended)?.label ?? '');
}

/**
 * The approvals a chat's compact card pages through (P5, P6): waiting on the person, not the
 * chat's own bridged question (AskUserQuestion or a permission prompt from that same chat, which
 * the chat already shows as Claude's card), and not one an agent is reading a reply to, until it
 * comes back ready again.
 */
export function dockApprovals(items: readonly NotifyItem[], chatPanelId?: string): NotifyItem[] {
  return items.filter(item => !bridgedFrom(item, chatPanelId) && (!isBeingRead(item) || item.readyAgain !== undefined));
}

/** A question the chat tab itself asked (its AskUserQuestion or permission prompt), copied to Approvals. */
export function bridgedFrom(item: NotifyItem, chatPanelId: string | undefined): boolean {
  return chatPanelId !== undefined && item.source.panelId === chatPanelId && Boolean(item.replyIsAnswer || item.optionsOnly || item.agentPrompt);
}

/**
 * The chat's status line after a send (P7, D-344): the Session's approval the person replied to
 * most recently, while its reply is being read, asked about or came back ready again, or once it
 * was taken as the answer (until the person dismisses it).
 */
export function latestReplied(items: readonly NotifyItem[], sessionId: string, dismissed: ReadonlySet<string>): NotifyItem | undefined {
  return items
    .filter(item => item.reply && !dismissed.has(item.reply.id) && (item.source.session?.id === sessionId || (item.connected?.kind === 'session' && item.connected.id === sessionId)))
    .filter(item => (item.state === 'waiting' && (item.reply?.state === 'reading' || item.reply?.state === 'question' || item.reply?.state === 'unread' || item.readyAgain !== undefined))
      || (item.state === 'answered' && item.reply?.state === 'answer'))
    .sort((a, b) => (b.readyAgain ?? b.reply?.at ?? 0) - (a.readyAgain ?? a.reply?.at ?? 0))[0];
}

/** "3 references": the card's links. */
export function referenceCount(item: Pick<NotifyItem, 'links'>): string | undefined {
  const count = item.links?.length ?? 0;
  return count ? `${count} reference${count === 1 ? '' : 's'}` : undefined;
}
