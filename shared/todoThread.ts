import type { TodoActivity } from './types/todos';

/**
 * A to-do's thread, Linear-style (round 7, D-419): its stored activity rows worked out into what the
 * page shows, newest last. Nothing here is stored; the desktop, the web app and (later) the iPhone
 * app all read a to-do's thread through this one module.
 *
 * - One event is one line; two or more in a row fold into "Show N events: …". An event tied to a
 *   waiting approval never folds: the approval card shows in its place.
 * - An agent run card is one tab's messages (and its own events) in a row, until another author's
 *   message comes between. When unsure (no tab), a message stands as its own card.
 * - Comment cards hold the person's and the requester's messages.
 * - A row with `replyTo` sits under the card it answers, as does a reply to that reply.
 * - Approval cards sit where they were asked.
 */

export type TodoThreadApprovalState = 'waiting' | 'answered' | 'closed';

/** One approval linked to the to-do, as the thread needs it. */
export interface TodoThreadApproval {
  id: string;
  /** "Q-11". */
  qn?: string;
  question: string;
  state: TodoThreadApprovalState;
  /** The tab that asked, when known: its run reads Waiting on you while this waits. */
  askerTab?: string;
  /** "orchestrator", for "Q-11 · orchestrator asks you". */
  askerName?: string;
  /** What was answered, for "Q-11 answered: …". */
  answer?: string;
  /** How many options it offers. */
  optionCount?: number;
  createdAt: number;
  resolvedAt?: number;
}

export interface TodoThreadInput {
  /** The to-do's newest activity rows (the page loads 500), in any order. */
  activity: readonly TodoActivity[];
  /** Tabs mid-turn now (the Session spinner's settled test). */
  midTurnTabs: ReadonlySet<string>;
  /** Its approvals still known to Approvals. */
  approvals: readonly TodoThreadApproval[];
}

export type TodoRunState = 'working' | 'waiting' | 'finished';

/** Under a message the person sent: delivered, or waiting for the agent's turn to end. */
export interface TodoThreadDelivery {
  delivered: boolean;
  toName?: string;
}

/** A row under a card: the person's reply, or an agent's threaded answer. */
export interface TodoThreadReply {
  activity: TodoActivity;
  /** Only on rows the person sent. */
  delivery?: TodoThreadDelivery;
}

export interface TodoThreadRun {
  /** Absent for a message whose tab isn't known: such a run is never joined. */
  authorTab?: string;
  authorName: string;
  /** The avatar's letter. */
  initial: string;
  /** "started by orchestrator", when an event records it. */
  startedBy?: string;
  startedAt: number;
  latestAt: number;
  state: TodoRunState;
  /** While Waiting on you: the approval it waits on. */
  waitingApprovalId?: string;
  /** The first line of its latest message. */
  summary: string;
  /** Its messages and events, oldest first: expanded, messages as Markdown and events as steps. */
  steps: TodoActivity[];
  /** "Open in the Session chat": the latest turn that names one, else the tab. */
  chatRef?: TodoActivity['chatRef'];
  /** The row a reply under this card answers (its latest message). */
  replyTarget: number;
  replies: TodoThreadReply[];
}

export interface TodoThreadComment {
  activity: TodoActivity;
  /** Only on the person's own messages. */
  delivery?: TodoThreadDelivery;
  replyTarget: number;
  replies: TodoThreadReply[];
}

export interface TodoThreadFold {
  events: TodoActivity[];
  /** "started its own Session, added T-13…": the first two events, shortened. */
  summary: string;
}

export type TodoThreadItem =
  | { kind: 'event'; key: string; event: TodoActivity }
  | { kind: 'fold'; key: string; fold: TodoThreadFold }
  | { kind: 'run'; key: string; run: TodoThreadRun }
  | { kind: 'comment'; key: string; comment: TodoThreadComment }
  | { kind: 'approval'; key: string; approval: TodoThreadApproval };

/** A card being built: replies attach to it by any of its rows' ids. */
interface CardBuilder {
  replies: TodoThreadReply[];
}

interface RunBuilder extends CardBuilder {
  kind: 'run';
  authorTab?: string;
  authorName: string;
  steps: TodoActivity[];
  waitingApprovalId?: string;
}

interface CommentBuilder extends CardBuilder {
  kind: 'comment';
  activity: TodoActivity;
}

type Entry =
  | { kind: 'event'; at: number; row: TodoActivity }
  | { kind: 'run'; at: number; run: RunBuilder }
  | { kind: 'comment'; at: number; comment: CommentBuilder }
  | { kind: 'approval'; at: number; approval: TodoThreadApproval };

const PHRASE_MAX = 40;

export function buildTodoThread(input: TodoThreadInput): TodoThreadItem[] {
  const rows = [...input.activity].sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  const cardOf = new Map<number, RunBuilder | CommentBuilder>();
  const runsByTab = new Map<string, RunBuilder[]>();
  const entries: Entry[] = [];
  let openRun: RunBuilder | null = null;

  for (const row of rows) {
    const answered = row.replyTo === undefined ? undefined : cardOf.get(row.replyTo);
    if (answered) {
      answered.replies.push(threadReply(row));
      cardOf.set(row.id, answered);
      continue;
    }
    if (row.kind === 'event') {
      if (openRun && eventJoinsRun(openRun, row)) {
        openRun.steps.push(row);
        cardOf.set(row.id, openRun);
      } else {
        entries.push({ kind: 'event', at: row.createdAt, row });
      }
      continue;
    }
    if (row.authorKind === 'agent') {
      if (openRun && row.authorTab !== undefined && openRun.authorTab === row.authorTab) {
        openRun.steps.push(row);
        cardOf.set(row.id, openRun);
        continue;
      }
      const run: RunBuilder = { kind: 'run', authorName: row.authorName, steps: [row], replies: [] };
      if (row.authorTab !== undefined) {
        run.authorTab = row.authorTab;
        const runs = runsByTab.get(row.authorTab) ?? [];
        runs.push(run);
        runsByTab.set(row.authorTab, runs);
      }
      entries.push({ kind: 'run', at: row.createdAt, run });
      cardOf.set(row.id, run);
      // A message without a tab can't be told apart from another tab's: it stands alone.
      openRun = row.authorTab !== undefined ? run : null;
      continue;
    }
    const comment: CommentBuilder = { kind: 'comment', activity: row, replies: [] };
    entries.push({ kind: 'comment', at: row.createdAt, comment });
    cardOf.set(row.id, comment);
    openRun = null;
  }

  placeApprovals(entries, input.approvals, runsByTab);
  const startedBy = startedByNames(rows);
  return foldEvents(entries, input, runsByTab, startedBy);
}

function threadReply(row: TodoActivity): TodoThreadReply {
  const reply: TodoThreadReply = { activity: row };
  const delivery = deliveryOf(row);
  if (delivery) reply.delivery = delivery;
  return reply;
}

function deliveryOf(row: TodoActivity): TodoThreadDelivery | undefined {
  if (row.authorKind !== 'person' || row.kind !== 'message') return undefined;
  const delivery: TodoThreadDelivery = { delivered: row.deliveredAt !== undefined };
  if (row.toName) delivery.toName = row.toName;
  return delivery;
}

/** An event joins the open run when the same tab, or the same agent by name, wrote it. */
function eventJoinsRun(run: RunBuilder, row: TodoActivity): boolean {
  if (row.authorTab !== undefined) return row.authorTab === run.authorTab;
  return row.authorKind === 'agent' && row.authorName === run.authorName;
}

/**
 * A waiting approval takes the place of the event that asked it; any other approval goes after
 * everything that came before it. An approval its asking tab raised marks that tab's run.
 */
function placeApprovals(entries: Entry[], approvals: readonly TodoThreadApproval[], runsByTab: ReadonlyMap<string, RunBuilder[]>): void {
  const sorted = [...approvals].sort((a, b) => a.createdAt - b.createdAt);
  for (const approval of sorted) {
    const owner = approval.askerTab ? ownerRun(runsByTab.get(approval.askerTab), approval.createdAt) : undefined;
    if (owner && approval.state === 'waiting' && owner.waitingApprovalId === undefined) owner.waitingApprovalId = approval.id;
    const tied = approval.state === 'waiting' ? entries.findIndex((entry) => entry.kind === 'event' && eventAsks(entry.row.body, approval)) : -1;
    const card: Entry = { kind: 'approval', at: approval.createdAt, approval };
    if (tied >= 0) {
      entries[tied] = card;
      continue;
    }
    let at = entries.length;
    while (at > 0 && entries[at - 1].at > approval.createdAt) at -= 1;
    entries.splice(at, 0, card);
  }
}

/** The tab's run that was going when it asked: the last to start at or before then. */
function ownerRun(runs: readonly RunBuilder[] | undefined, at: number): RunBuilder | undefined {
  if (!runs || runs.length === 0) return undefined;
  let owner = runs[0];
  for (const run of runs) if (run.steps[0].createdAt <= at) owner = run;
  return owner;
}

function eventAsks(body: string, approval: TodoThreadApproval): boolean {
  const question = approval.question.trim();
  if (question.length >= 4 && body.includes(question)) return true;
  return approval.qn !== undefined && new RegExp(`(^|\\W)${approval.qn}(\\W|$)`, 'u').test(body);
}

/** "Assigned to implementer by orchestrator" → implementer was started by orchestrator. */
function startedByNames(rows: readonly TodoActivity[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const row of rows) {
    if (row.kind !== 'event') continue;
    const match = /^Assigned to (.+?) by (.+)$/u.exec(row.body.trim()) ?? /^(.+?) started by (.+)$/u.exec(row.body.trim());
    if (match) names.set(match[1], match[2]);
  }
  return names;
}

function foldEvents(entries: readonly Entry[], input: TodoThreadInput, runsByTab: ReadonlyMap<string, RunBuilder[]>, startedBy: ReadonlyMap<string, string>): TodoThreadItem[] {
  const items: TodoThreadItem[] = [];
  let pending: TodoActivity[] = [];
  const flush = () => {
    if (pending.length === 1) items.push({ kind: 'event', key: `event:${pending[0].id}`, event: pending[0] });
    else if (pending.length > 1) items.push({ kind: 'fold', key: `fold:${pending[0].id}`, fold: { events: pending, summary: foldSummary(pending) } });
    pending = [];
  };
  for (const entry of entries) {
    if (entry.kind === 'event') {
      pending.push(entry.row);
      continue;
    }
    flush();
    if (entry.kind === 'approval') items.push({ kind: 'approval', key: `approval:${entry.approval.id}`, approval: entry.approval });
    else if (entry.kind === 'comment') items.push({ kind: 'comment', key: `comment:${entry.comment.activity.id}`, comment: commentOf(entry.comment) });
    else items.push({ kind: 'run', key: `run:${entry.run.steps[0].id}`, run: runOf(entry.run, input, runsByTab, startedBy) });
  }
  flush();
  return items;
}

function commentOf(builder: CommentBuilder): TodoThreadComment {
  const comment: TodoThreadComment = { activity: builder.activity, replyTarget: builder.activity.id, replies: builder.replies };
  const delivery = deliveryOf(builder.activity);
  if (delivery) comment.delivery = delivery;
  return comment;
}

function runOf(builder: RunBuilder, input: TodoThreadInput, runsByTab: ReadonlyMap<string, RunBuilder[]>, startedBy: ReadonlyMap<string, string>): TodoThreadRun {
  const messages = builder.steps.filter((step) => step.kind === 'message');
  const latest = messages[messages.length - 1] ?? builder.steps[builder.steps.length - 1];
  const tab = builder.authorTab;
  const latestOfTab = tab !== undefined && runsByTab.get(tab)?.at(-1) === builder;
  const state: TodoRunState = builder.waitingApprovalId !== undefined ? 'waiting'
    : latestOfTab && tab !== undefined && input.midTurnTabs.has(tab) ? 'working'
      : 'finished';
  const run: TodoThreadRun = {
    authorName: builder.authorName,
    initial: (builder.authorName.trim()[0] ?? '·').toUpperCase(),
    startedAt: builder.steps[0].createdAt,
    latestAt: builder.steps[builder.steps.length - 1].createdAt,
    state,
    summary: firstLine(latest.body),
    steps: builder.steps,
    replyTarget: latest.id,
    replies: builder.replies,
  };
  if (tab !== undefined) run.authorTab = tab;
  const by = startedBy.get(builder.authorName);
  if (by) run.startedBy = by;
  if (builder.waitingApprovalId !== undefined) run.waitingApprovalId = builder.waitingApprovalId;
  const turn = [...messages].reverse().find((message) => message.chatRef);
  if (turn?.chatRef) run.chatRef = turn.chatRef;
  else if (tab !== undefined) run.chatRef = { panelId: tab };
  return run;
}

/** The first line with words, without Markdown's marks. */
function firstLine(body: string): string {
  const line = body.split('\n').map((text) => text.trim()).find((text) => text.length > 0) ?? '';
  return line.replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/u, '').replace(/\*\*|__|`/gu, '').trim();
}

function foldSummary(events: readonly TodoActivity[]): string {
  const phrases = events.slice(0, 2).map((event) => eventPhrase(event.body));
  return `${phrases.join(', ')}${events.length > 2 ? '…' : ''}`;
}

/** An event shortened for a fold's label: its first clause, lower-cased unless it starts with a ref or Pane's name. */
export function eventPhrase(body: string): string {
  let text = body.trim();
  const colon = text.indexOf(': ');
  if (colon > 0) text = text.slice(0, colon);
  if (/^[A-Z][a-z]/u.test(text) && !/^Pane\b/u.test(text)) text = text[0].toLowerCase() + text.slice(1);
  return text.length > PHRASE_MAX ? `${text.slice(0, PHRASE_MAX - 1).trimEnd()}…` : text;
}
