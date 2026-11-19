import path from 'node:path';
import { boundary, type BoundarySchema } from './boundaryDecoder';
import type { ParsedArgs } from './commands';
import { invokeDaemon } from './daemonClient';
import { RunpaneError } from './errors';
import { cliTimeZone, formatSnoozeTime, formatUntil, readSnoozeTime } from './todoTimes';

// The CLI's copy of the `runpane todos` wire contract in shared/types/todos.ts, which this package cannot import.

interface TodoDoneWhenItem {
  text: string;
  met: boolean;
}

/** While a to-do is snoozed: `until` is ISO 8601 with its offset in `zone`. */
interface TodoSnooze {
  until: string;
  zone: string;
  note: string;
  action: string;
  by: string;
}

/** One to-do in `--json`, in the field order both CLIs print. */
interface Todo {
  ref: string;
  number: number;
  title: string;
  state: string;
  status: string;
  reason: string;
  parent: string | null;
  sessionId: string | null;
  requester: string;
  assignee: string | null;
  summary: string;
  doneWhen: TodoDoneWhenItem[];
  attachmentCount: number;
  updatedAt: string;
  snooze?: TodoSnooze;
}

interface TodoAttachment {
  id: number;
  kind: string;
  label: string;
  target: string;
  machine: string | null;
  note: string | null;
  addedBy: string;
  source: string;
  from: string | null;
  addedAt: string;
}

interface TodoActivity {
  id: number;
  kind: string;
  author: string;
  body: string;
  at: string;
}

interface TodoResult { ok: true; todo: Todo }
interface TodoListResult { ok: true; todos: Todo[] }
interface TodoShowResult { ok: true; todo: Todo; attachments: TodoAttachment[]; subTodos: Todo[]; activity: TodoActivity[] }
interface TodoAttachResult { ok: true; todo: string; attachment: TodoAttachment }
interface TodoDetachResult { ok: true; todo: string; detached: number }
interface TodoAskResult { ok: true; todo: string; routedTo: string; approvalId: string | null }
interface TodoCommentResult { ok: true; todo: string; activityId: number }
interface TodoReviewResult { ok: true; todo: Todo; approvalId: string }
interface TodoArchiveKept { name: string; reason: string }
interface TodoArchiveResult { ok: true; todo: string; archived: string[]; kept: TodoArchiveKept[]; sessionArchived: boolean }
interface TodoStartResult { ok: true; todo: Todo; queued: boolean }

type TodoJson = TodoResult | TodoListResult | TodoShowResult | TodoAttachResult | TodoDetachResult | TodoAskResult
  | TodoCommentResult | TodoReviewResult | TodoArchiveResult | TodoStartResult;

/** Every request may name the calling tab, as `panes create` does. */
interface TodoCaller {
  callerPanelId?: string;
}

interface TodoCreateRequest extends TodoCaller {
  title: string;
  summary?: string;
  doneWhen?: string[];
  parent?: string;
  project?: string;
  agent?: string;
  attach?: string[];
  start?: boolean;
}

interface TodoRefRequest extends TodoCaller {
  todo: string;
}

interface TodoUpdateRequest extends TodoRefRequest {
  title?: string;
  summary?: string;
  doneWhen?: string[];
  check?: number[];
  uncheck?: number[];
}

interface TodoAttachRequest extends TodoRefRequest {
  target: string;
  kind?: string;
  label?: string;
  note?: string;
}

interface TodoDetachRequest extends TodoRefRequest {
  attachment: number;
}

interface TodoListRequest {
  all?: boolean;
  status?: string;
}

interface TodoSnoozeRequest extends TodoRefRequest {
  /** ms since epoch (UTC), read in this CLI's zone. */
  until: number;
  zone: string;
  note?: string;
  remindMe?: boolean;
}

interface TodoAssignRequest extends TodoRefRequest {
  panel?: string;
}

interface TodoAskRequest extends TodoRefRequest {
  question: string;
}

interface TodoCommentRequest extends TodoRefRequest {
  body: string;
  escalate?: boolean;
}

interface TodoReviewRequest extends TodoRefRequest {
  summary?: string;
  noAttachments?: string;
}

interface TodoDoneRequest extends TodoRefRequest {
  personSaid?: string;
}

interface TodoDropRequest extends TodoRefRequest {
  reason?: string;
}

type TodoRequest = TodoCreateRequest | TodoRefRequest | TodoListRequest;

const nullableString = boundary.nullable(boundary.string);
const snoozeSchema: BoundarySchema<TodoSnooze> = boundary.object({
  until: boundary.string,
  zone: boundary.string,
  note: boundary.string,
  action: boundary.string,
  by: boundary.string,
});
const doneWhenSchema: BoundarySchema<TodoDoneWhenItem> = boundary.object({ text: boundary.string, met: boundary.boolean });
const todoSchema: BoundarySchema<Todo> = boundary.object({
  ref: boundary.string,
  number: boundary.number,
  title: boundary.string,
  state: boundary.string,
  status: boundary.string,
  reason: boundary.string,
  parent: nullableString,
  sessionId: nullableString,
  requester: boundary.string,
  assignee: nullableString,
  summary: boundary.string,
  doneWhen: boundary.array(doneWhenSchema),
  attachmentCount: boundary.number,
  updatedAt: boundary.string,
  snooze: boundary.optional(snoozeSchema),
});
const attachmentSchema: BoundarySchema<TodoAttachment> = boundary.object({
  id: boundary.number,
  kind: boundary.string,
  label: boundary.string,
  target: boundary.string,
  machine: nullableString,
  note: nullableString,
  addedBy: boundary.string,
  source: boundary.string,
  from: nullableString,
  addedAt: boundary.string,
});
const activitySchema: BoundarySchema<TodoActivity> = boundary.object({
  id: boundary.number,
  kind: boundary.string,
  author: boundary.string,
  body: boundary.string,
  at: boundary.string,
});
const ok = boundary.literal(true);
const todoResultSchema: BoundarySchema<TodoResult> = boundary.object({ ok, todo: todoSchema });
const todoListResultSchema: BoundarySchema<TodoListResult> = boundary.object({ ok, todos: boundary.array(todoSchema) });
const todoShowResultSchema: BoundarySchema<TodoShowResult> = boundary.object({
  ok,
  todo: todoSchema,
  attachments: boundary.array(attachmentSchema),
  subTodos: boundary.array(todoSchema),
  activity: boundary.array(activitySchema),
});
const todoAttachResultSchema: BoundarySchema<TodoAttachResult> = boundary.object({ ok, todo: boundary.string, attachment: attachmentSchema });
const todoDetachResultSchema: BoundarySchema<TodoDetachResult> = boundary.object({ ok, todo: boundary.string, detached: boundary.number });
const todoAskResultSchema: BoundarySchema<TodoAskResult> = boundary.object({ ok, todo: boundary.string, routedTo: boundary.string, approvalId: nullableString });
const todoCommentResultSchema: BoundarySchema<TodoCommentResult> = boundary.object({ ok, todo: boundary.string, activityId: boundary.number });
const todoReviewResultSchema: BoundarySchema<TodoReviewResult> = boundary.object({ ok, todo: todoSchema, approvalId: boundary.string });
const keptSchema: BoundarySchema<TodoArchiveKept> = boundary.object({ name: boundary.string, reason: boundary.string });
const todoArchiveResultSchema: BoundarySchema<TodoArchiveResult> = boundary.object({
  ok,
  todo: boundary.string,
  archived: boundary.array(boundary.string),
  kept: boundary.array(keptSchema),
  sessionArchived: boundary.boolean,
});
const todoStartResultSchema: BoundarySchema<TodoStartResult> = boundary.object({ ok, todo: todoSchema, queued: boundary.boolean });

const STATUS_LABELS = new Map([
  ['waiting', 'Waiting on you'],
  ['working', 'Working'],
  ['queued', 'Queued'],
  ['snoozed', 'Snoozed'],
  ['idle', 'Idle'],
  ['done', 'Done'],
  ['dropped', 'Dropped'],
]);
const SHOWN_STATUSES = [...STATUS_LABELS.keys()];
const ATTACH_KINDS = ['plan', 'mockup', 'design', 'pr', 'findings', 'decision', 'doc', 'image', 'link'];
const URL_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const TODO_REF_PATTERN = /^\s*(?:[tT]-?)?([0-9]+)\s*$/;
const LIST_NEXT = 'See your to-dos with `runpane todos list`.';

function invalid(message: string, next: string): RunpaneError {
  return new RunpaneError('ERR_RUNPANE_INVALID_ARGUMENT', `${message} Nothing was changed.`, next);
}

/** "T-12", "t12" or "12" as "T-12". */
function normalizeTodoRef(value: string, what: string): string {
  const match = TODO_REF_PATTERN.exec(value);
  const number = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(number) || number < 1) {
    throw invalid(`${what} "${value}" is not a to-do; a to-do is T-12 or 12.`, LIST_NEXT);
  }
  return `T-${number}`;
}

function todoWords(parsed: ParsedArgs): string[] {
  return parsed.todoArgs ?? [];
}

/** The to-do, the first word; `extra` says how many more words the verb takes ("none", or "text" for any). */
function todoRefFrom(parsed: ParsedArgs, extra: 'none' | 'text' | 'one'): string {
  const words = todoWords(parsed);
  const [first] = words;
  if (first === undefined) throw invalid(`runpane ${parsed.command} needs the to-do, such as T-12.`, LIST_NEXT);
  if (extra === 'none' && words.length > 1) {
    throw invalid(
      `runpane ${parsed.command} takes one to-do, but got ${words.length} words: ${words.join(' ')}.`,
      'Quote text and pass it with its option, such as --summary "...".',
    );
  }
  return normalizeTodoRef(first, 'The to-do');
}

/** The tab this CLI runs in ($PANE_PANEL_ID). */
function callerPanelId(): string | undefined {
  return process.env.PANE_PANEL_ID?.trim() || undefined;
}

function withCaller<Request extends TodoCaller>(request: Request): Request {
  const caller = callerPanelId();
  if (caller) request.callerPanelId = caller;
  return request;
}

/** A URL as given; a file path made absolute against the working directory. */
function attachTarget(value: string): string {
  return URL_PATTERN.test(value) ? value : path.resolve(value);
}

function statusLabel(status: string): string {
  return STATUS_LABELS.get(status) ?? status;
}

/** `T-12  Working  Keyboard sheet · why` */
function formatTodoLine(todo: Todo): string {
  const reason = todo.reason ? ` · ${todo.reason}` : '';
  return `${todo.ref}  ${statusLabel(todo.status)}  ${todo.title}${reason}`;
}

function oneLine(text: string, max = 200): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function printJson(value: TodoJson): void {
  console.log(JSON.stringify(value, null, 2));
}

async function call<Result>(parsed: ParsedArgs, verb: string, request: TodoRequest, schema: BoundarySchema<Result>): Promise<Result> {
  return invokeDaemon(`runpane:todos:${verb}`, [request], schema, { paneDir: parsed.paneDir });
}

function buildCreate(parsed: ParsedArgs): TodoCreateRequest {
  const title = todoWords(parsed).join(' ').trim();
  if (!title) {
    throw invalid('runpane todos create needs a title, such as `runpane todos create "Fix the login redirect"`.', 'Pass the title as the first word, in quotes.');
  }
  const request: TodoCreateRequest = { title };
  if (parsed.summary !== undefined) request.summary = parsed.summary;
  if (parsed.doneWhen !== undefined) request.doneWhen = parsed.doneWhen;
  if (parsed.todoParent !== undefined) request.parent = normalizeTodoRef(parsed.todoParent, '--parent');
  if (parsed.repo !== undefined) request.project = parsed.repo;
  if (parsed.agent !== undefined) request.agent = parsed.agent;
  if (parsed.attachments?.length) request.attach = parsed.attachments.map(attachTarget);
  if (parsed.noStart) request.start = false;
  return withCaller(request);
}

function buildUpdate(parsed: ParsedArgs): TodoUpdateRequest {
  const request: TodoUpdateRequest = { todo: todoRefFrom(parsed, 'none') };
  if (parsed.title !== undefined) request.title = parsed.title;
  if (parsed.summary !== undefined) request.summary = parsed.summary;
  if (parsed.doneWhen !== undefined) request.doneWhen = parsed.doneWhen;
  if (parsed.todoCheck !== undefined) request.check = parsed.todoCheck;
  if (parsed.todoUncheck !== undefined) request.uncheck = parsed.todoUncheck;
  if (Object.keys(request).length === 1) {
    throw invalid(
      'runpane todos update needs something to change: --title, --summary, --done-when, --check or --uncheck.',
      'Pass what changed, such as `runpane todos update T-12 --check 1`.',
    );
  }
  return withCaller(request);
}

function buildAttach(parsed: ParsedArgs): TodoAttachRequest {
  const todo = todoRefFrom(parsed, 'one');
  const words = todoWords(parsed);
  if (words.length !== 2 || !words[1].trim()) {
    throw invalid(
      'runpane todos attach takes the to-do and one file or URL, such as `runpane todos attach T-12 docs/plan.html`.',
      'Attach one file or URL at a time, and quote a path with spaces.',
    );
  }
  if (parsed.kind !== undefined && !ATTACH_KINDS.includes(parsed.kind)) {
    throw invalid(`--kind must be one of: ${ATTACH_KINDS.join(', ')}; got "${parsed.kind}".`, 'Pick the nearest kind, or leave --kind out and Pane picks one.');
  }
  const request: TodoAttachRequest = { todo, target: attachTarget(words[1]) };
  if (parsed.kind !== undefined) request.kind = parsed.kind;
  if (parsed.label !== undefined) request.label = parsed.label;
  if (parsed.note !== undefined) request.note = parsed.note;
  return withCaller(request);
}

function buildDetach(parsed: ParsedArgs): TodoDetachRequest {
  const todo = todoRefFrom(parsed, 'one');
  const words = todoWords(parsed);
  const match = words.length === 2 ? /^#?([0-9]+)$/.exec(words[1]) : null;
  const attachment = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(attachment) || attachment < 1) {
    throw invalid(
      'runpane todos detach takes the to-do and an attachment id, such as `runpane todos detach T-12 3`.',
      'See attachment ids with `runpane todos show <todo>`.',
    );
  }
  return withCaller<TodoDetachRequest>({ todo, attachment });
}

/** The words after the to-do, as one text: ask's question, comment's message. */
function textAfterTodo(parsed: ParsedArgs, what: string, example: string): string {
  const text = todoWords(parsed).slice(1).join(' ').trim();
  if (!text) throw invalid(`runpane ${parsed.command} needs the ${what} after the to-do, such as \`${example}\`.`, `Pass the ${what} in quotes after the to-do.`);
  return text;
}

/** `--until` read in this machine's zone, so the host gets an instant it never reinterprets. */
function buildSnooze(parsed: ParsedArgs, now: number): TodoSnoozeRequest {
  const todo = todoRefFrom(parsed, 'none');
  if (parsed.snoozeUntil === undefined) {
    throw invalid(
      'runpane todos snooze needs --until, the time to wake it.',
      'Pass a time, such as `runpane todos snooze T-12 --until tomorrow --note "Check Sentry"`.',
    );
  }
  const zone = cliTimeZone();
  const request: TodoSnoozeRequest = { todo, until: readSnoozeTime(parsed.snoozeUntil, now, zone), zone };
  if (parsed.note !== undefined) request.note = parsed.note;
  if (parsed.remindMe) request.remindMe = true;
  return withCaller(request);
}

/** "Snoozed T-14 until Wed 18 Nov 2026, 9:00 AM PST (in 17h). Its agents stop after their current step." */
function describeSnoozed(todo: Todo, now: number): string {
  if (!todo.snooze) return `Snoozed ${formatTodoLine(todo)}`;
  const then = todo.snooze.action === 'remind' ? 'Pane raises a reminder card for you then.' : 'Its agents stop after their current step.';
  return `Snoozed ${todo.ref} until ${snoozeWhen(todo.snooze, now)}. ${then}`;
}

/** "Wed 18 Nov 2026, 9:00 AM PST (in 17h)", in this machine's zone, naming the zone it was set in when that differs. */
function snoozeWhen(snooze: TodoSnooze, now: number): string {
  const at = Date.parse(snooze.until);
  const zone = cliTimeZone();
  const setIn = snooze.zone === zone ? '' : `, set in ${snooze.zone}`;
  return `${formatSnoozeTime(at, zone)} (${formatUntil(at, now)}${setIn})`;
}

function refRequest(parsed: ParsedArgs): TodoRefRequest {
  return withCaller<TodoRefRequest>({ todo: todoRefFrom(parsed, 'none') });
}

export async function runTodos(parsed: ParsedArgs): Promise<number> {
  switch (parsed.command) {
    case 'todos create': return printTodo(parsed, 'Created', await call(parsed, 'create', buildCreate(parsed), todoResultSchema));
    case 'todos update': return printTodo(parsed, 'Updated', await call(parsed, 'update', buildUpdate(parsed), todoResultSchema));
    case 'todos attach': {
      const result = await call(parsed, 'attach', buildAttach(parsed), todoAttachResultSchema);
      return print(parsed, result, [`Attached #${result.attachment.id} ${result.attachment.kind} "${result.attachment.label}" to ${result.todo}.`]);
    }
    case 'todos detach': {
      const result = await call(parsed, 'detach', buildDetach(parsed), todoDetachResultSchema);
      return print(parsed, result, [`Detached #${result.detached} from ${result.todo}.`]);
    }
    case 'todos show': {
      const result = await call(parsed, 'show', refRequest(parsed), todoShowResultSchema);
      return print(parsed, result, describeShow(result));
    }
    case 'todos list': return runList(parsed);
    case 'todos assign': {
      const request: TodoAssignRequest = refRequest(parsed);
      if (parsed.panelId !== undefined) request.panel = parsed.panelId;
      const result = await call(parsed, 'assign', request, todoResultSchema);
      return print(parsed, result, [`${result.todo.ref} is assigned to ${result.todo.assignee ?? "its Session's orchestrator"}.`]);
    }
    case 'todos ask': {
      const todo = todoRefFrom(parsed, 'text');
      const request = withCaller<TodoAskRequest>({ todo, question: textAfterTodo(parsed, 'question', 'runpane todos ask T-12 "Which shortcuts?"') });
      const result = await call(parsed, 'ask', request, todoAskResultSchema);
      const who = result.routedTo === 'person' ? 'the person' : 'the requester';
      const approval = result.approvalId ? ` (approval ${result.approvalId})` : '';
      return print(parsed, result, [`Asked ${who} about ${result.todo}${approval}.`]);
    }
    case 'todos comment': {
      const todo = todoRefFrom(parsed, 'text');
      const request = withCaller<TodoCommentRequest>({ todo, body: textAfterTodo(parsed, 'message', 'runpane todos comment T-12 "Sheet done."') });
      if (parsed.escalate) request.escalate = true;
      const result = await call(parsed, 'comment', request, todoCommentResultSchema);
      return print(parsed, result, [parsed.escalate ? `Commented on ${result.todo} and asked the person.` : `Commented on ${result.todo}.`]);
    }
    case 'todos review': {
      const request: TodoReviewRequest = refRequest(parsed);
      if (parsed.summary !== undefined) request.summary = parsed.summary;
      if (parsed.noAttachments !== undefined) request.noAttachments = parsed.noAttachments;
      const result = await call(parsed, 'review', request, todoReviewResultSchema);
      return print(parsed, result, [`Sent for review: ${formatTodoLine(result.todo)} (approval ${result.approvalId})`]);
    }
    case 'todos done': {
      const request: TodoDoneRequest = refRequest(parsed);
      if (parsed.personSaid !== undefined) request.personSaid = parsed.personSaid;
      return printTodo(parsed, 'Closed', await call(parsed, 'done', request, todoResultSchema));
    }
    case 'todos drop': {
      const request: TodoDropRequest = refRequest(parsed);
      if (parsed.reason !== undefined) request.reason = parsed.reason;
      return printTodo(parsed, 'Dropped', await call(parsed, 'drop', request, todoResultSchema));
    }
    case 'todos archive': {
      const result = await call(parsed, 'archive', refRequest(parsed), todoArchiveResultSchema);
      return print(parsed, result, describeArchive(result));
    }
    case 'todos start': {
      const result = await call(parsed, 'start', refRequest(parsed), todoStartResultSchema);
      return print(parsed, result, [`${result.queued ? 'Queued' : 'Started'} ${formatTodoLine(result.todo)}`]);
    }
    case 'todos stop': return printTodo(parsed, 'Stopped', await call(parsed, 'stop', refRequest(parsed), todoResultSchema));
    case 'todos snooze': {
      const result = await call(parsed, 'snooze', buildSnooze(parsed, Date.now()), todoResultSchema);
      return print(parsed, result, [describeSnoozed(result.todo, Date.now())]);
    }
    case 'todos wake': return printTodo(parsed, 'Woke', await call(parsed, 'wake', refRequest(parsed), todoResultSchema));
    default: throw new Error(`Unsupported command: ${parsed.command}`);
  }
}

async function runList(parsed: ParsedArgs): Promise<number> {
  if (todoWords(parsed).length > 0) {
    throw invalid(`runpane todos list takes no words, but got: ${todoWords(parsed).join(' ')}.`, 'Show one to-do with `runpane todos show <todo>`.');
  }
  const request: TodoListRequest = {};
  if (parsed.all) request.all = true;
  if (parsed.todoStatus !== undefined) {
    if (!SHOWN_STATUSES.includes(parsed.todoStatus)) {
      throw invalid(`--status must be one of: ${SHOWN_STATUSES.join(', ')}; got "${parsed.todoStatus}".`, 'Pick one, such as `runpane todos list --status snoozed`.');
    }
    request.status = parsed.todoStatus;
  }
  const result = await call(parsed, 'list', request, todoListResultSchema);
  const none = parsed.todoStatus === undefined ? (parsed.all ? 'No to-dos.' : 'No open to-dos.') : `No to-dos are ${statusLabel(parsed.todoStatus)}.`;
  const empty = `${none} Create one with \`runpane todos create "<title>"\`.`;
  return print(parsed, result, result.todos.length === 0 ? [empty] : result.todos.map(formatTodoLine));
}

function print(parsed: ParsedArgs, result: TodoJson, lines: readonly string[]): number {
  if (parsed.json) printJson(result);
  else for (const line of lines) console.log(line);
  return 0;
}

function printTodo(parsed: ParsedArgs, verb: string, result: TodoResult): number {
  return print(parsed, result, [`${verb} ${formatTodoLine(result.todo)}`]);
}

/** Attachments first, then the to-do, its sub-to-dos and recent activity. */
function describeShow(result: TodoShowResult): string[] {
  const { todo } = result;
  const lines: string[] = [];
  if (result.attachments.length === 0) {
    lines.push('Attachments: none');
  } else {
    lines.push('Attachments:');
    for (const attachment of result.attachments) {
      const machine = attachment.machine ? ` on ${attachment.machine}` : '';
      const from = attachment.from ? `  (from ${attachment.from})` : '';
      lines.push(`  #${attachment.id}  ${attachment.kind}  ${attachment.label}  ${attachment.target}${machine}${from}`);
      if (attachment.note) lines.push(`      ${oneLine(attachment.note)}`);
    }
  }
  lines.push(formatTodoLine(todo));
  const parent = todo.parent ? ` · sub-to-do of ${todo.parent}` : '';
  lines.push(`  Requested by ${todo.requester} · working: ${todo.assignee ?? "its Session's orchestrator"}${parent}`);
  if (todo.snooze) {
    const then = todo.snooze.action === 'remind' ? 'raises a reminder card' : 'wakes its agents';
    lines.push(`  Snoozed until ${snoozeWhen(todo.snooze, Date.now())} · ${then} · set by ${todo.snooze.by}`);
    if (todo.snooze.note.trim()) lines.push(`  Wake-up note: ${oneLine(todo.snooze.note)}`);
  }
  for (const line of todo.summary.split('\n')) if (line.trim()) lines.push(`  ${line}`);
  if (todo.doneWhen.length > 0) {
    lines.push('  Done when:');
    todo.doneWhen.forEach((item, index) => lines.push(`    [${item.met ? 'x' : ' '}] ${index + 1}. ${item.text}`));
  }
  if (result.subTodos.length > 0) {
    lines.push('Sub-to-dos:');
    for (const sub of result.subTodos) lines.push(`  ${formatTodoLine(sub)}`);
  }
  if (result.activity.length > 0) {
    lines.push('Recent activity:');
    for (const entry of result.activity) lines.push(`  ${entry.at}  ${entry.author}: ${oneLine(entry.body)}`);
  }
  return lines;
}

function describeArchive(result: TodoArchiveResult): string[] {
  const archived = result.archived.length > 0 ? `: ${result.archived.join(', ')}` : '';
  const lines = [`Archived ${result.todo}${archived}.`];
  for (const kept of result.kept) lines.push(`Kept ${kept.name}: ${kept.reason}`);
  if (result.sessionArchived) lines.push('Archived its Session.');
  return lines;
}

/**
 * `agents start --todo`: hand the to-do to the new tab once it is ready. A failure is a warning on
 * stderr; the agent itself started.
 */
export async function assignTodoToPanel(parsed: ParsedArgs, panelId: string): Promise<void> {
  if (parsed.todo === undefined) return;
  try {
    const request = withCaller<TodoAssignRequest>({ todo: normalizeTodoRef(parsed.todo, '--todo'), panel: panelId });
    await invokeDaemon('runpane:todos:assign', [request], todoResultSchema, { paneDir: parsed.paneDir });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`Warning: the agent started, but ${parsed.todo} was not assigned to its tab: ${reason} Assign it with \`runpane todos assign ${parsed.todo} --panel ${panelId}\`.`);
  }
}
