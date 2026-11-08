import type { NotifyChoice, NotifyItem, NotifyLink, NotifySubQuestion, NotifyVersion } from '../../../../shared/types/notify';

/**
 * The approval column's logic (P3 of the approval card), kept apart from its rendering: the
 * questions an item asks, how each option changed since the version before, how the person's
 * reply was taken, and the order the pager walks.
 */

/** One question as the column shows it: an options approval's own choices count as one. */
export interface CardQuestion {
  title: string;
  choices: CardChoice[];
  /** Choices the version before had and this one dropped: shown struck out, once. */
  removed: string[];
}

export interface CardChoice extends NotifyChoice {
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
  if (!before) return current.map(question => ({ title: question.title, choices: question.choices.map(choice => ({ ...choice })), removed: [] }));
  const earlier = questionsOf({ ui: item.ui, title: before.title, choices: before.choices, questions: before.questions });
  return current.map((question, index) => {
    const old = earlier[index]?.choices ?? [];
    const used = new Set<string>();
    const choices = question.choices.map((choice): CardChoice => {
      const match = old.find(candidate => candidate.label === (choice.was ?? choice.label));
      if (!match) return { ...choice, mark: 'new' };
      used.add(match.label);
      if (match.label !== choice.label || (match.detail ?? '') !== (choice.detail ?? '')) {
        return { ...choice, mark: 'reworded', before: { label: match.label, ...(match.detail ? { detail: match.detail } : {}) } };
      }
      return { ...choice };
    });
    return { title: question.title, choices, removed: old.filter(choice => !used.has(choice.label)).map(choice => choice.label) };
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
  const reader = reply.reader?.name ?? item.source.name;
  switch (reply.state) {
    case 'reading':
      return { tone: 'muted', text: reply.reader?.kind === 'autopilot' ? 'Autopilot is reading your reply…' : 'Reading your reply…' };
    case 'answer':
      return { tone: 'success', text: `Taken as your answer${reply.picks?.length ? `: ${reply.picks.join(' · ')}, with your note “${reply.text}”` : `: “${reply.text}”`}`, ...(reply.fixed ? {} : { fix: { as: 'question' as const, label: 'It was a question' } }) };
    case 'question':
      return { tone: 'warning', text: `Taken as a question: asking ${reader}. ${reply.status ?? 'Getting more context…'}`, ...(reply.fixed ? {} : { fix: { as: 'answer' as const, label: 'It was my answer' } }) };
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
  if (item.reply?.state === 'question') return { tone: 'warning', text: item.reply.status ?? 'Getting more context…' };
  if (item.reply?.state === 'reading') return { tone: 'muted', text: 'Reading your reply…' };
  return null;
}

/** Being read or asked about: Send moves past it (J14). */
export function isBeingRead(item: NotifyItem): boolean {
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

/** After a send, the next approval to open: the next one along that isn't being read, else none. */
export function nextAfterSend(order: readonly string[], sentId: string, items: ReadonlyMap<string, NotifyItem>): string | undefined {
  const start = order.indexOf(sentId);
  for (let step = 1; step < order.length; step += 1) {
    const id = order[(Math.max(start, 0) + step) % order.length];
    const item = items.get(id);
    if (item && item.state === 'waiting' && !isBeingRead(item) && id !== sentId) return id;
  }
  return undefined;
}

/**
 * Whether Send can go: an answer needs one pick per question; anything typed is a reply. A
 * permission prompt takes only its options.
 */
export function canSend(item: NotifyItem, picks: readonly string[], text: string): boolean {
  if (item.state !== 'waiting') return false;
  if (text.trim() && !item.agentPrompt) return true;
  const questions = questionsOf(item);
  return questions.length > 0 && questions.every((_, index) => Boolean(picks[index]));
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
    { kind: 'qa', key: 'qa', label: 'Questions & answers' },
    { kind: 'summary', key: 'summary', label: 'Summary' },
  ];
  (item.links ?? []).forEach((link, index) => tabs.push({ kind: 'link', key: `link:${index}:${link.label}`, label: link.label, link, index }));
  const origin = originPanel(item);
  if (origin && origin !== inChat) tabs.push({ kind: 'origin', key: 'origin', label: `${item.source.session?.orchestrator ? `${item.source.session.name} orchestrator` : item.source.name}'s tab` });
  return tabs;
}

/** The tab where it was asked, when it was asked from one. */
export function originPanel(item: NotifyItem): string | undefined {
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

/** The Summary (D-225), written by Pane from the approval's own fields, the same way every time. */
export interface CardSummary {
  why?: string;
  recommendation: Array<{ question?: string; label: string; detail?: string }>;
  questions: NotifySubQuestion[];
  references: Array<{ label: string; kind: 'file' | 'url' | 'approval' | 'origin'; detail: string }>;
  history: Array<{ version: number; at: number; asked?: string; whatChanged: string[]; by?: string }>;
}

export function cardSummary(item: NotifyItem): CardSummary {
  const questions = questionsOf(item);
  const recommendation = questions.flatMap(question => question.choices.filter(choice => choice.recommended).map(choice => ({
    ...(questions.length > 1 ? { question: question.title } : {}),
    label: choice.label,
    ...(choice.detail ? { detail: choice.detail } : {}),
  })));
  const references: CardSummary['references'] = (item.links ?? []).map(link => (
    'path' in link ? { label: link.label, kind: 'file' as const, detail: link.path }
      : 'url' in link ? { label: link.label, kind: 'url' as const, detail: link.url }
        : { label: link.label, kind: 'approval' as const, detail: 'another approval' }
  ));
  if (originPanel(item)) references.push({ label: `${item.source.name}'s tab`, kind: 'origin', detail: 'where it was asked' });
  const history: CardSummary['history'] = [
    ...(item.versions ?? []).map(version => ({ version: version.version, at: version.at, ...(version.revision ? { asked: version.revision.asked, whatChanged: version.revision.whatChanged, by: version.revision.by } : { whatChanged: [] }) })),
    { version: item.version ?? 1, at: item.revision?.at ?? item.createdAt, ...(item.revision ? { asked: item.revision.asked, whatChanged: item.revision.whatChanged, by: item.revision.by } : { whatChanged: [] }) },
  ];
  return { ...(item.context ? { why: item.context } : {}), recommendation, questions, references, history };
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
