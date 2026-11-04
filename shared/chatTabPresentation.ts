import { boundary, decodeOptionalBoundary, type JsonValue } from './validation/boundaryDecoder';
import type { AgentChatMessage, AgentChatPart } from './types/agentChat';

/**
 * How a chat tab's conversation reads, shared by desktop, the PWA and the phone:
 * turns that start at each prompt, with the agent's steps grouped by kind
 * (round 2 · Option 1) and a one-line summary for folded turns (round 3 · A).
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
  /** The step in progress, shown alone while a turn runs in a quiet chat. */
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

export function toStep(part: Extract<AgentChatPart, { type: 'tool' }>): ChatStep {
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

/** The conversation as turns. `running` marks the last turn as still in progress. */
export function chatTurns(messages: readonly AgentChatMessage[], options: { running: boolean }): ChatTurn[] {
  const turns: ChatTurn[] = [];
  let turn: ChatTurn | undefined;
  let pending: ChatStep[] = [];
  const flush = () => {
    if (!turn || !pending.length) return;
    turn.items.push({ type: 'steps', id: `steps:${pending[0].id}`, groups: groupSteps(pending) });
    pending = [];
  };
  const open = (id: string, user?: AgentChatMessage) => {
    flush();
    turn = { id, user, items: [], running: false };
    turns.push(turn);
    return turn;
  };
  for (const message of messages) {
    if (message.role === 'user') { open(`turn:${message.id}`, message); continue; }
    const current = turn ?? open(`turn:start:${message.id}`);
    for (const [index, part] of message.parts.entries()) {
      const id = `${message.id}:${index}`;
      if (part.type === 'tool') { pending.push(toStep(part)); continue; }
      if (part.type === 'content') {
        const end = decodeOptionalBoundary(part.content, marker);
        if (end) { flush(); current.startedAt = end.startedAt; current.endedAt = end.endedAt; current.stopReason = end.stopReason; continue; }
      }
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
  const last = turns.at(-1);
  if (last && options.running && !last.endedAt) {
    last.running = true;
    const steps = last.items.flatMap(item => item.type === 'steps' ? item.groups.flatMap(group => group.steps) : []);
    last.current = steps.at(-1);
  }
  return turns;
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
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} m ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} m`;
}

/** "Worked 2 m 40 s · 14 steps · edited 2 files · ran 9 commands" (round 3 · A). */
export function turnSummary(turn: ChatTurn): string {
  const steps = turn.items.flatMap(item => item.type === 'steps' ? item.groups.flatMap(group => group.steps) : []);
  const duration = turn.startedAt && turn.endedAt ? formatDuration(Date.parse(turn.endedAt) - Date.parse(turn.startedAt)) : undefined;
  if (turn.stopReason && turn.stopReason !== 'end_turn') return `Stopped${duration ? ` after ${duration}` : ''}`;
  const edited = new Set(steps.filter(step => step.kind === 'edit').map(step => step.path ?? step.id)).size;
  const commands = steps.filter(step => step.kind === 'run').length;
  const head = turn.running ? 'Working' : duration ? `Worked ${duration}` : 'Worked';
  return [head, plural(steps.length, 'step'), edited && `edited ${plural(edited, 'file')}`, commands && `ran ${plural(commands, 'command')}`].filter(Boolean).join(' · ');
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
}

export interface WorkerPaneInput {
  paneId: string;
  name: string;
  missing: boolean;
  archived: boolean;
  panels: Array<{ state: string; missing?: boolean }>;
  report?: { state: string; pr?: number; summary?: string; question?: string };
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
    return line;
  });
}

/**
 * Where each worker line goes: after the last turn that started before the worker
 * joined the Session, or after the conversation when no turn's time is known.
 */
export interface WorkerPlacement { byTurn: Map<string, ChatWorkerLine[]>; trailing: ChatWorkerLine[] }

export function placeWorkers(turns: readonly ChatTurn[], workers: readonly ChatWorkerLine[]): WorkerPlacement {
  const byTurn = new Map<string, ChatWorkerLine[]>();
  const trailing: ChatWorkerLine[] = [];
  for (const worker of workers) {
    const joined = worker.attachedAt ? Date.parse(worker.attachedAt) : NaN;
    const anchor = Number.isNaN(joined) ? undefined : [...turns].reverse().find(turn => turn.startedAt && Date.parse(turn.startedAt) <= joined);
    if (anchor && anchor !== turns.at(-1)) byTurn.set(anchor.id, [...(byTurn.get(anchor.id) ?? []), worker]);
    else trailing.push(worker);
  }
  return { byTurn, trailing };
}
