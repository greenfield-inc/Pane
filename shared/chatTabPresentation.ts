import { boundary, decodeOptionalBoundary, type JsonValue } from './validation/boundaryDecoder';
import type { AgentChatMessage, AgentChatPart, AgentChatPermission } from './types/agentChat';
import type { ChatTabQuestion } from './types/chatTab';
import { permissionToolId } from './agentChatPresentation';

/**
 * How a chat tab's conversation reads, shared by desktop, the PWA and the phone:
 * turns that start at each prompt, with the agent's steps grouped by kind
 * (round 2 · Option 1) and, by default, one row that folds a turn's activity (D-192).
 */
export type StepKind = 'explore' | 'edit' | 'run' | 'think' | 'other';

export interface ChatStep {
  id: string;
  kind: StepKind;
  title: string;
  status: Extract<AgentChatPart, { type: 'tool' }>['status'];
  /** The file a read or edit touched. */
  path?: string;
  added?: number;
  removed?: number;
  /** The diff shown on demand ("View diff"), never by default. */
  diff?: { path: string; oldText: string | null; newText: string };
  command?: string;
  /** Command output or tool result as text, for the step's own row. */
  output?: string;
  input?: JsonValue;
}

export interface StepGroup {
  id: string;
  kind: StepKind;
  /** "2 files, 1 search", "3 commands", or the file name of a single edit. */
  label: string;
  /** For commands: "pnpm test ×2, git fetch". */
  detail?: string;
  added: number;
  removed: number;
  steps: ChatStep[];
}

export interface PlanEntry { content: string; status: string; priority?: string }

/** ACP plan entries carry no id: key each by its text, numbering repeats, so a row keeps its key while the list grows. */
export function planEntryKeys(entries: readonly PlanEntry[]): string[] {
  const seen = new Map<string, number>();
  return entries.map(entry => {
    const count = (seen.get(entry.content) ?? 0) + 1;
    seen.set(entry.content, count);
    return count === 1 ? entry.content : `${entry.content}#${count}`;
  });
}

export type TurnItem =
  | { type: 'text'; id: string; text: string }
  | { type: 'thought'; id: string; text: string }
  | { type: 'image'; id: string; mimeType: string; data: string }
  | { type: 'steps'; id: string; groups: StepGroup[] }
  | { type: 'plan'; id: string; entries: PlanEntry[] }
  | { type: 'content'; id: string; content: JsonValue };

export interface ChatTurn {
  id: string;
  user?: AgentChatMessage;
  items: TurnItem[];
  running: boolean;
  /** The latest step, for the line that says what a running turn is doing. */
  current?: ChatStep;
  startedAt?: string;
  endedAt?: string;
  stopReason?: string;
}

const marker = boundary.object({ type: boundary.literal('pane_turn'), stopReason: boundary.string, startedAt: boundary.string, endedAt: boundary.string });
const plan = boundary.object({ type: boundary.literal('plan'), entries: boundary.array(boundary.object({ content: boundary.string, status: boundary.string, priority: boundary.optional(boundary.string) })) });
const diffContent = boundary.object({ type: boundary.literal('diff'), path: boundary.string, oldText: boundary.optional(boundary.nullable(boundary.string)), newText: boundary.string });
const textContent = boundary.object({ type: boundary.literal('content'), content: boundary.object({ type: boundary.literal('text'), text: boundary.string }) });
const image = boundary.object({ type: boundary.literal('image'), data: boundary.string, mimeType: boundary.string });
const commandInput = boundary.object({ command: boundary.optional(boundary.union(boundary.string, boundary.array(boundary.string))), cmd: boundary.optional(boundary.string), file_path: boundary.optional(boundary.string), path: boundary.optional(boundary.string) });
const toolResult = boundary.object({ stdout: boundary.optional(boundary.string), stderr: boundary.optional(boundary.string), output: boundary.optional(boundary.string), formatted_output: boundary.optional(boundary.string) });
const locationList = boundary.array(boundary.object({ path: boundary.string }));

/** An image content block, or undefined. */
export function imageOf(content: JsonValue): { mimeType: string; data: string } | undefined {
  return decodeOptionalBoundary(content, image);
}

function stepKind(kind: string | undefined): StepKind {
  switch (kind) {
    case 'read': case 'search': case 'fetch': return 'explore';
    case 'edit': case 'delete': case 'move': return 'edit';
    case 'execute': return 'run';
    case 'think': return 'think';
    default: return 'other';
  }
}

/** Lines added and removed, counted as a multiset difference (cheap, and exact for typical edits). */
export interface LineChanges { added: number; removed: number }

export function lineChanges(oldText: string | null, newText: string): LineChanges {
  const before = (oldText ?? '').split('\n');
  const after = newText.split('\n');
  if (before.at(-1) === '') before.pop();
  if (after.at(-1) === '') after.pop();
  const counts = new Map<string, number>();
  for (const line of before) counts.set(line, (counts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of after) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1); else added++;
  }
  let removed = 0;
  for (const left of counts.values()) removed += left;
  return { added, removed };
}

function outputText(output: JsonValue | undefined, content: JsonValue[] | undefined): string | undefined {
  const plain = decodeOptionalBoundary(output, boundary.string);
  if (plain !== undefined) return plain;
  const result = decodeOptionalBoundary(output, toolResult);
  const text = result?.formatted_output ?? result?.output ?? [result?.stdout, result?.stderr].filter(Boolean).join('\n');
  if (text) return text;
  const parts = (content ?? []).flatMap(entry => { const decoded = decodeOptionalBoundary(entry, textContent); return decoded ? [decoded.content.text] : []; });
  return parts.length ? parts.join('\n') : undefined;
}

type ToolPart = Extract<AgentChatPart, { type: 'tool' }>;

/** Steps by the part they came from: a part that kept its identity is not parsed again (its diff line counts are the costly part). */
const builtSteps = new WeakMap<ToolPart, ChatStep>();

function cachedStep(part: ToolPart): ChatStep {
  let step = builtSteps.get(part);
  if (!step) { step = toStep(part); builtSteps.set(part, step); }
  return step;
}

function toStep(part: ToolPart): ChatStep {
  const kind = stepKind(part.kind);
  const step: ChatStep = { id: part.id, kind, title: part.title, status: part.status };
  const input = decodeOptionalBoundary(part.input, commandInput);
  const location = decodeOptionalBoundary(part.locations, locationList)?.[0]?.path;
  for (const entry of part.content ?? []) {
    const diff = decodeOptionalBoundary(entry, diffContent);
    if (!diff) continue;
    const changes = lineChanges(diff.oldText ?? null, diff.newText);
    step.diff = { path: diff.path, oldText: diff.oldText ?? null, newText: diff.newText };
    step.added = (step.added ?? 0) + changes.added;
    step.removed = (step.removed ?? 0) + changes.removed;
    step.path ??= diff.path;
  }
  step.path ??= location ?? input?.file_path ?? input?.path;
  if (kind === 'run') step.command = Array.isArray(input?.command) ? input.command.join(' ') : input?.command ?? input?.cmd ?? part.title;
  const output = part.terminal ?? outputText(part.output, part.content);
  if (output) step.output = output;
  if (part.input !== undefined) step.input = part.input;
  return step;
}

const fileName = (file: string) => file.split(/[\\/]/).pop() ?? file;
const plural = (count: number, word: string, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;

function exploreLabel(steps: ChatStep[]): string {
  const files = new Set(steps.filter(step => step.path).map(step => step.path)).size;
  const searches = steps.filter(step => !step.path && /search|grep|glob|find/i.test(step.title)).length;
  const other = steps.length - steps.filter(step => step.path).length - searches;
  return [files && plural(files, 'file'), searches && plural(searches, 'search', 'searches'), other && plural(other, 'step')].filter(Boolean).join(', ');
}

function commandDetail(steps: ChatStep[]): string {
  const counts = new Map<string, number>();
  for (const step of steps) counts.set(step.command ?? step.title, (counts.get(step.command ?? step.title) ?? 0) + 1);
  return [...counts.entries()].map(([command, count]) => count > 1 ? `${command} ×${count}` : command).join(', ');
}

/** Consecutive steps of the same kind share one line; each edit to a different file gets its own. */
export function groupSteps(steps: ChatStep[]): StepGroup[] {
  const groups: StepGroup[] = [];
  for (const step of steps) {
    const last = groups.at(-1);
    const joins = last && last.kind === step.kind && (step.kind !== 'edit' || last.steps[0].path === step.path);
    if (joins) last.steps.push(step);
    else groups.push({ id: step.id, kind: step.kind, label: '', added: 0, removed: 0, steps: [step] });
  }
  for (const group of groups) {
    group.added = group.steps.reduce((sum, step) => sum + (step.added ?? 0), 0);
    group.removed = group.steps.reduce((sum, step) => sum + (step.removed ?? 0), 0);
    if (group.kind === 'explore') group.label = exploreLabel(group.steps);
    else if (group.kind === 'edit') group.label = group.steps[0].path ? fileName(group.steps[0].path) : group.steps[0].title;
    else if (group.kind === 'run') { group.label = plural(group.steps.length, 'command'); group.detail = commandDetail(group.steps); }
    else group.label = group.steps.length === 1 ? group.steps[0].title : plural(group.steps.length, 'step');
  }
  return groups;
}

/** Where each built turn came from, so a rebuild hands back the same object for a turn whose messages kept their identity. */
interface TurnSource { turn: ChatTurn; messages: AgentChatMessage[]; fromPart: number }
const builtTurns = new WeakMap<AgentChatMessage, TurnSource>();

/**
 * The conversation as turns. `running` marks the last turn as still in progress.
 * A turn whose messages are the same objects as on the last call comes back as the
 * same object, so memoized rows skip it while the latest turn streams.
 */
export function chatTurns(messages: readonly AgentChatMessage[], options: { running: boolean }): ChatTurn[] {
  const sources: TurnSource[] = [];
  let turn: ChatTurn | undefined;
  let pending: ChatStep[] = [];
  const flush = () => {
    if (!turn || !pending.length) return;
    turn.items.push({ type: 'steps', id: `steps:${pending[0].id}`, groups: groupSteps(pending) });
    pending = [];
  };
  const open = (id: string, message: AgentChatMessage, fromPart: number, user?: AgentChatMessage) => {
    flush();
    turn = { id, user, items: [], running: false };
    sources.push({ turn, messages: [message], fromPart });
    return turn;
  };
  for (const message of messages) {
    if (message.role === 'user') { open(`turn:${message.id}`, message, -1, message); continue; }
    for (const [index, part] of message.parts.entries()) {
      const id = `${message.id}:${index}`;
      const end = part.type === 'content' ? decodeOptionalBoundary(part.content, marker) : undefined;
      // A finished turn stays finished: what the agent does afterwards, with no prompt open, is a turn of its own.
      if (end && turn?.endedAt) continue;
      const current: ChatTurn = turn && !turn.endedAt ? turn : open(`turn:start:${message.id}`, message, index);
      const used = sources.at(-1)!.messages;
      if (used.at(-1) !== message) used.push(message);
      if (part.type === 'tool') { pending.push(cachedStep(part)); continue; }
      if (end) { flush(); current.startedAt = end.startedAt; current.endedAt = end.endedAt; current.stopReason = end.stopReason; continue; }
      flush();
      if (part.type === 'text' || part.type === 'thought') {
        if (part.text) current.items.push({ type: part.type, id, text: part.text });
        continue;
      }
      if (part.type !== 'content') continue;
      const todo = decodeOptionalBoundary(part.content, plan);
      if (todo) { current.items.push({ type: 'plan', id, entries: todo.entries.map(entry => entry.priority ? entry : { content: entry.content, status: entry.status }) }); continue; }
      const picture = decodeOptionalBoundary(part.content, image);
      if (picture) { current.items.push({ type: 'image', id, mimeType: picture.mimeType, data: picture.data }); continue; }
      current.items.push({ type: 'content', id, content: part.content });
    }
  }
  flush();
  const last = sources.at(-1)?.turn;
  if (last && options.running && !last.endedAt) {
    last.running = true;
    const steps = last.items.flatMap(item => item.type === 'steps' ? item.groups.flatMap(group => group.steps) : []);
    last.current = steps.at(-1);
  }
  return sources.map(source => {
    const before = builtTurns.get(source.messages[0]);
    const same = before && before.turn.id === source.turn.id && before.turn.running === source.turn.running && before.fromPart === source.fromPart
      && before.messages.length === source.messages.length && before.messages.every((message, index) => message === source.messages[index]);
    if (same) return before.turn;
    builtTurns.set(source.messages[0], source);
    return source.turn;
  });
}

const STOPPED = new Map([
  ['cancelled', 'Stopped.'], ['interrupted', 'Stopped when Pane closed.'], ['exited', 'Stopped: the agent exited.'],
  ['refusal', 'The agent declined this request.'], ['max_tokens', 'Stopped at the length limit.'], ['max_turn_requests', 'Stopped at the step limit.'], ['error', 'Stopped by an error.'],
]);

/** How a turn that did not end normally ended, in words; undefined for a normal end. */
export function stoppedText(turn: ChatTurn): string | undefined {
  if (!turn.stopReason || turn.stopReason === 'end_turn') return undefined;
  return STOPPED.get(turn.stopReason) ?? 'Stopped.';
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * A turn as it reads by default (D-192): the agent's text and pictures, with
 * everything it did in between (steps, thinking, notices, to-do lists) folded into
 * one row between `before` and `after`. While the turn runs, the row sits below the
 * text so far. The latest finished turn's row ends with when it finished (D-202).
 */
export interface TurnDisplay {
  before: TurnItem[];
  after: TurnItem[];
  activity: TurnItem[];
  /** The fold row, when the turn is running or did more than write. `waiting`: its current step waits on an approval. */
  fold?: { label: string; waiting: boolean };
  ended?: MessageTime;
}

export interface TurnDisplayOptions {
  /** The conversation's last turn. */
  latest?: boolean;
  /** Tool call ids with an approval pending. */
  waiting?: ReadonlySet<string>;
  now?: Date;
  locale?: string;
}

/** The tool calls waiting on the person: open approvals and questions (AskUserQuestion, ExitPlanMode). */
export function waitingToolIds(permissions: readonly AgentChatPermission[] = [], questions: readonly ChatTabQuestion[] = []): Set<string> {
  const ids = permissions.flatMap(permission => { const id = permissionToolId(permission); return id ? [id] : []; });
  return new Set([...ids, ...questions.flatMap(question => question.toolCallId ? [question.toolCallId] : [])]);
}

export function turnDisplay(turn: ChatTurn, options: TurnDisplayOptions = {}): TurnDisplay {
  const isShown = (item: TurnItem) => item.type === 'text' || item.type === 'image';
  const shown = turn.items.filter(isShown);
  const activity = turn.items.filter(item => !isShown(item));
  const firstActivity = turn.items.findIndex(item => !isShown(item));
  const foldAt = turn.running || firstActivity < 0 ? shown.length : Math.min(firstActivity, shown.length);
  const ended = messageTime(turn.endedAt, options.now, options.locale);
  const display: TurnDisplay = { before: shown.slice(0, foldAt), after: shown.slice(foldAt), activity, ended };
  if (turn.running || activity.length) {
    const label = options.latest && !turn.running ? turnFooter(turn, true, options.now, options.locale) ?? turnSummary(turn) : turnSummary(turn, options.waiting);
    display.fold = { label, waiting: !!turn.running && !!turn.current && !!options.waiting?.has(turn.current.id) };
  }
  return display;
}

const ACTIVITY_VERBS = { explore: 'Reading', edit: 'Editing', run: 'Running', think: 'Thinking', other: 'Using' } satisfies Record<StepKind, string>;

/** What a running turn is doing now, as one quiet line. */
export function currentActivity(turn: ChatTurn, waiting: ReadonlySet<string> = new Set()): string {
  if (turn.items.at(-1)?.type === 'thought') return 'Thinking';
  const step = turn.current;
  if (!step || (step.status !== 'pending' && step.status !== 'in_progress')) return 'Working';
  const subject = step.kind === 'run' ? (step.command ?? step.title).split('\n')[0] : step.path ? fileName(step.path) : step.title;
  // A search has no file to name; its title already says what it does ("grep foo").
  const line = step.kind === 'think' ? ACTIVITY_VERBS.think : step.kind === 'explore' && !step.path ? step.title : `${ACTIVITY_VERBS[step.kind]} ${subject}`;
  return waiting.has(step.id) ? `Waiting for you · ${line}` : line;
}

/** The fold row's words: "Worked for 27s", or what the turn is doing while it runs. */
function turnSummary(turn: ChatTurn, waiting?: ReadonlySet<string>): string {
  if (turn.running) return currentActivity(turn, waiting);
  const duration = turn.startedAt && turn.endedAt ? formatDuration(Date.parse(turn.endedAt) - Date.parse(turn.startedAt)) : undefined;
  if (duration) return `Worked for ${duration}`;
  // A reopened conversation's earlier turns have no times.
  const steps = turn.items.reduce((sum, item) => sum + (item.type === 'steps' ? item.groups.reduce((total, group) => total + group.steps.length, 0) : 0), 0);
  return steps ? `Worked · ${plural(steps, 'step')}` : 'Worked';
}

/** One worker of a Session, as one line in the orchestrator's chat (round 3 · A). */
export interface ChatWorkerLine {
  paneId: string;
  name: string;
  state: 'running' | 'waiting' | 'done' | 'failed' | 'idle' | 'missing';
  label: string;
  /** What it is doing or reported, in one short line. */
  detail?: string;
  pr?: number;
  attachedAt?: string;
  /** When its report last changed. */
  reportedAt?: string;
  /** The tab whose agent is working, when one is (D-276). */
  tab?: { panelId: string; title: string };
}

export interface WorkerPaneInput {
  paneId: string;
  name: string;
  missing: boolean;
  archived: boolean;
  panels: Array<{ state: string; missing?: boolean; panelId?: string; title?: string }>;
  report?: { state: string; pr?: number; summary?: string; question?: string; reportedAt?: string };
  git?: { prNumber?: number };
}

const WORKER_LABELS = { running: 'Running', waiting: 'Waiting', done: 'Done', failed: 'Failed', idle: 'Idle', missing: 'Missing' } as const;

/** Worker lines from Pane's own Session state (its Panes, their reports and agent states), never from text the agent wrote. */
export function workerLines(panes: readonly WorkerPaneInput[], attachedAt: ReadonlyMap<string, string> = new Map()): ChatWorkerLine[] {
  return panes.filter(pane => !pane.archived).map(pane => {
    const report = pane.report;
    const state: ChatWorkerLine['state'] = pane.missing ? 'missing'
      : report?.state === 'done' ? 'done'
        : report?.state === 'failed' ? 'failed'
          : report?.state === 'blocked' || pane.panels.some(panel => panel.state === 'blocked') ? 'waiting'
            : pane.panels.some(panel => panel.state === 'working') ? 'running' : 'idle';
    const firstLine = (text?: string) => text?.split('\n').map(line => line.trim()).find(Boolean)?.slice(0, 120);
    const line: ChatWorkerLine = { paneId: pane.paneId, name: pane.name, state, label: WORKER_LABELS[state] };
    const detail = state === 'waiting' ? firstLine(report?.question) ?? firstLine(report?.summary) : firstLine(report?.summary);
    if (detail) line.detail = detail;
    const pr = report?.pr ?? pane.git?.prNumber;
    if (pr) line.pr = pr;
    const at = attachedAt.get(pane.paneId);
    if (at) line.attachedAt = at;
    if (report?.reportedAt) line.reportedAt = report.reportedAt;
    const working = state === 'running' ? pane.panels.find(panel => panel.state === 'working' && panel.panelId) : undefined;
    if (working?.panelId) line.tab = { panelId: working.panelId, title: working.title ?? '' };
    return line;
  });
}

/** The agents actively working (D-276): only workers whose tab is working, never waiting, idle or finished ones. */
export function workingAgents(workers: readonly ChatWorkerLine[] | undefined): ChatWorkerLine[] {
  return (workers ?? []).filter(worker => worker.state === 'running');
}

/** When something happened, short for the chat and full for a tooltip (D-202). */
export interface MessageTime { short: string; full: string }

/**
 * "2:04 PM" today, "Yesterday 4:12 PM", "Nov 3, 4:12 PM" this year, with the year
 * before that; in the person's locale. Undefined when the time is unknown.
 */
const formatters = new Map<string, { time: Intl.DateTimeFormat; date: Intl.DateTimeFormat; dateYear: Intl.DateTimeFormat; full: Intl.DateTimeFormat }>();

/** Intl formatters are slow to build: one set per locale, built on first use. */
function formattersFor(locale: string | undefined) {
  const key = locale ?? '';
  let set = formatters.get(key);
  if (!set) {
    set = {
      time: new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }),
      date: new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }),
      dateYear: new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric' }),
      full: new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'medium' }),
    };
    formatters.set(key, set);
  }
  return set;
}

export function messageTime(iso: string | undefined, now = new Date(), locale?: string): MessageTime | undefined {
  const at = iso ? new Date(iso) : undefined;
  if (!at || Number.isNaN(at.getTime())) return undefined;
  const format = formattersFor(locale);
  const time = format.time.format(at);
  const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const daysAgo = Math.round((day(now) - day(at)) / 86_400_000);
  const date = () => (at.getFullYear() === now.getFullYear() ? format.date : format.dateYear).format(at);
  const short = daysAgo === 0 ? time : daysAgo === 1 ? `Yesterday ${time}` : `${date()}, ${time}`;
  return { short, full: format.full.format(at) };
}

/** The footer of the latest finished turn: "Worked for 27s · 2:04 PM", or the time alone with no activity. */
function turnFooter(turn: ChatTurn, hasActivity: boolean, now?: Date, locale?: string): string | undefined {
  const time = messageTime(turn.endedAt, now, locale);
  if (turn.running || !time) return hasActivity ? turnSummary(turn) : undefined;
  return hasActivity ? `${turnSummary(turn)} · ${time.short}` : time.short;
}

/** A worker the latest turn has news of, as one line: "approvals-global finished". */
export interface WorkerNote { worker: ChatWorkerLine; text: string }

/**
 * Which workers the Session chat mentions (D-201, narrowed by D-223): one that finished or
 * failed while the latest turn ran, once that turn has ended, so the line belongs to the turn
 * that reported it. A worker's question reaches the person as an approval the orchestrator
 * relays (D-220), never as a line here; idle, running and unchanged workers stay out too.
 */
export function workerNotes(turns: readonly ChatTurn[], workers: readonly ChatWorkerLine[]): WorkerNote[] {
  const latest = turns.at(-1);
  if (!latest || latest.running) return [];
  const since = Date.parse(latest.startedAt ?? turns.at(-2)?.endedAt ?? '');
  const until = Date.parse(latest.endedAt ?? '');
  const during = (at?: string) => {
    const time = Date.parse(at ?? '');
    return !Number.isNaN(time) && !Number.isNaN(since) && time >= since && (Number.isNaN(until) || time <= until);
  };
  return workers.flatMap(worker => {
    if ((worker.state !== 'done' && worker.state !== 'failed') || !during(worker.reportedAt)) return [];
    return [{ worker, text: `${worker.name} ${worker.state === 'done' ? 'finished' : 'failed'}` }];
  });
}
