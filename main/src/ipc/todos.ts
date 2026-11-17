import path from 'path';
import { PaneError } from '../../../shared/paneError';
import {
  TODO_ATTACHMENT_KINDS, parseTodoRef, todoRef,
  type RunpaneTodo, type RunpaneTodoActivity, type RunpaneTodoArchiveResult, type RunpaneTodoAskResult, type RunpaneTodoAttachResult,
  type RunpaneTodoAttachment, type RunpaneTodoCommentResult, type RunpaneTodoDetachResult, type RunpaneTodoListResult, type RunpaneTodoResult,
  type RunpaneTodoReviewResult, type RunpaneTodoShowResult, type RunpaneTodoStartResult, type TodoAction, type TodoActionResult, type TodoCreateInput,
  type TodoDetail, type TodoListRow, type TodoRecord, type TodosSnapshot,
} from '../../../shared/types/todos';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { paneCommandCaller, type IpcMainHandleLike, type PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import type { TodoActor, TodoService } from '../services/todos/todoService';
import type { AppServices } from './types';

/** The app's own channels: the To-dos screens act as the person. */
export const TODO_APP_CHANNELS = ['todos:snapshot', 'todos:detail', 'todos:create', 'todos:act'] as const;

interface TodoResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

async function respond<T>(work: () => T | Promise<T>): Promise<TodoResponse<T>> {
  try {
    return { success: true, data: await work() };
  } catch (error) {
    const next = error instanceof PaneError && error.next ? ` ${error.next}` : '';
    return { success: false, error: `${error instanceof Error ? error.message : String(error)}${next}` };
  }
}

function requireTodoService(services: Pick<AppServices, 'todoService'>): TodoService {
  if (!services.todoService) {
    throw new PaneError('ERR_TODOS_UNAVAILABLE', 'To-dos are unavailable: this Pane has not started its to-do service. Nothing was changed.', 'Restart Pane, then run the command again.');
  }
  return services.todoService;
}

const optionalString = boundary.optional(boundary.string);
const optionalStrings = boundary.optional(boundary.array(boundary.string));
const optionalNumbers = boundary.optional(boundary.array(boundary.number));
const attachmentKind = boundary.optional(boundary.enumeration(...TODO_ATTACHMENT_KINDS));

const createInputSchema = boundary.object({
  title: boundary.string, summary: optionalString, doneWhen: optionalStrings, subTodos: optionalStrings,
  projectId: boundary.optional(boundary.nullable(boundary.number)), agent: boundary.optional(boundary.nullable(boundary.string)),
  startNow: boundary.optional(boundary.boolean), parentNumber: boundary.optional(boundary.nullable(boundary.number)),
  attach: boundary.optional(boundary.array(boundary.object({ target: boundary.string, kind: attachmentKind, label: optionalString, note: optionalString }))),
});

const number = boundary.number;
const actionSchema = boundary.union(
  boundary.object({ kind: boundary.literal('start'), number, anyway: boundary.optional(boundary.boolean) }),
  boundary.object({ kind: boundary.literal('stop'), number }),
  boundary.object({ kind: boundary.literal('resume'), number }),
  boundary.object({ kind: boundary.literal('done'), number }),
  boundary.object({ kind: boundary.literal('drop'), number, reason: optionalString }),
  boundary.object({ kind: boundary.literal('archive'), number }),
  boundary.object({ kind: boundary.literal('reopen'), number }),
  boundary.object({ kind: boundary.literal('never-pause'), number, on: boundary.boolean }),
  boundary.object({ kind: boundary.literal('comment'), number, body: boundary.string, toOrchestrator: boundary.optional(boundary.boolean), replyTo: boundary.optional(boundary.number) }),
  boundary.object({ kind: boundary.literal('attach'), number, target: boundary.string, label: optionalString, attachmentKind }),
  boundary.object({ kind: boundary.literal('detach'), number, attachmentId: boundary.number }),
  boundary.object({ kind: boundary.literal('check'), number, index: boundary.number, met: boundary.boolean }),
  boundary.object({ kind: boundary.literal('rename'), number, title: boundary.string }),
);

const PERSON: TodoActor = { kind: 'person' };

/** Runs one of the person's actions from the To-dos screens. */
async function runTodoAction(service: TodoService, action: TodoAction): Promise<TodoActionResult> {
  switch (action.kind) {
    case 'start': return { todo: (await service.start(action.number, PERSON, { anyway: action.anyway })).todo };
    case 'stop': return { todo: service.stop(action.number, PERSON) };
    case 'resume': return { todo: (await service.resume(action.number, PERSON)).todo };
    case 'done': return { todo: service.done(action.number, {}, PERSON) };
    case 'drop': return { todo: service.drop(action.number, { reason: action.reason }, PERSON) };
    case 'archive': {
      const result = await service.archive(action.number, PERSON);
      const kept = result.kept.map(pane => `${pane.name}: ${pane.reason}`).join('; ');
      return { todo: service.require(action.number), message: `Archived ${result.archived.length} Pane${result.archived.length === 1 ? '' : 's'}.${kept ? ` Kept ${kept}.` : ''}` };
    }
    case 'reopen': return { todo: await service.reopen(action.number, PERSON) };
    case 'never-pause': return { todo: service.setNeverPause(action.number, action.on, PERSON) };
    case 'comment':
      await service.comment(action.number, action.body, PERSON, { toOrchestrator: action.toOrchestrator, replyTo: action.replyTo });
      return { todo: service.require(action.number) };
    case 'attach':
      service.attach(action.number, { target: action.target, label: action.label, kind: action.attachmentKind }, PERSON);
      return { todo: service.require(action.number) };
    case 'detach':
      service.detach(action.number, action.attachmentId, PERSON);
      return { todo: service.require(action.number) };
    case 'check':
      return { todo: service.update(action.number, action.met ? { check: [action.index + 1] } : { uncheck: [action.index + 1] }, PERSON) };
    case 'rename':
      return { todo: service.update(action.number, { title: action.title }, PERSON) };
  }
}

// ── runpane todos ─────────────────────────────────────────────────────────

const callerField = { callerPanelId: optionalString };
const refSchema = boundary.object({ todo: boundary.string, ...callerField });

function requireRef(value: string): number {
  const parsed = parseTodoRef(value);
  if (parsed === null) throw new PaneError('ERR_TODO_REF', `"${value}" is not a to-do: name one as T-12.`, 'Run runpane todos list to see the to-dos here.');
  return parsed;
}

/** The calling agent's tab: the request names it, else the daemon caller. Never the person. */
function agentActor(callerPanelId: string | undefined): TodoActor {
  const caller = paneCommandCaller();
  return { kind: 'agent', panelId: callerPanelId ?? caller?.panelId, paneId: caller?.paneId };
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

function runpaneTodoOf(row: TodoListRow, attachmentCount: number): RunpaneTodo {
  const { todo } = row;
  return {
    ref: todo.ref, number: todo.number, title: todo.title, state: todo.state, status: row.status.status, reason: row.status.reason,
    parent: todo.parentNumber !== null ? todoRef(todo.parentNumber) : null, sessionId: todo.sessionId, requester: todo.requester.name,
    assignee: todo.assignee?.name ?? null, summary: todo.summary, doneWhen: todo.doneWhen, attachmentCount, updatedAt: iso(todo.updatedAt),
  };
}

function runpaneAttachments(detail: TodoDetail): RunpaneTodoAttachment[] {
  return detail.attachments.flatMap(group => group.attachments.map(attachment => ({
    id: attachment.id, kind: attachment.kind, label: attachment.label, target: attachment.target, machine: attachment.machine ?? null,
    note: attachment.note ?? null, addedBy: attachment.addedBy, source: attachment.source, from: group.from ? todoRef(group.from.number) : null,
    addedAt: iso(attachment.addedAt),
  })));
}

function runpaneTodo(service: TodoService, todoNumber: number): RunpaneTodo {
  const detail = service.detail(todoNumber);
  return runpaneTodoOf(detail, detail.attachments.reduce((sum, group) => sum + group.attachments.length, 0));
}

function absoluteTarget(target: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) || path.isAbsolute(target)) return target;
  // The CLIs send absolute paths; a relative one from an older CLI resolves against Pane's own folder at worst.
  return path.resolve(target);
}

/** What the to-do handlers read from Pane's services. */
export type TodoHandlerServices = Pick<AppServices, 'todoService'> & { databaseService: Pick<AppServices['databaseService'], 'getAllProjects'> };

function projectIdOf(services: TodoHandlerServices, project: string | undefined): number | null {
  if (!project) return null;
  const projects = services.databaseService.getAllProjects();
  const byId = Number(project);
  const found = Number.isSafeInteger(byId) ? projects.find(candidate => candidate.id === byId) : undefined;
  const match = found ?? projects.find(candidate => candidate.name.toLocaleLowerCase() === project.toLocaleLowerCase());
  if (!match) throw new PaneError('ERR_TODO_REPO', `There is no repo "${project}" in Pane. Nothing was created.`, 'Pass a repo name or id from runpane repos list.');
  return match.id;
}

export function registerTodoHandlers(ipcMain: IpcMainHandleLike, services: TodoHandlerServices, commandRegistry: PaneCommandRegistry): void {
  const service = () => requireTodoService(services);

  // The app (the person).
  commandRegistry.register('todos:snapshot', () => respond((): TodosSnapshot => service().snapshot()));
  commandRegistry.register('todos:detail', (value: PaneCommandValue) => respond((): TodoDetail => service().detail(decodeBoundary(value, boundary.number))));
  commandRegistry.register('todos:create', (value: PaneCommandValue) => respond((): Promise<TodoRecord> => service().create(decodeBoundary(value, createInputSchema) satisfies TodoCreateInput, PERSON)));
  commandRegistry.register('todos:act', (value: PaneCommandValue) => respond((): Promise<TodoActionResult> => runTodoAction(service(), decodeBoundary(value, actionSchema))));
  commandRegistry.bindChannels(ipcMain, TODO_APP_CHANNELS);

  // runpane todos … (agents).
  commandRegistry.register('runpane:todos:create', async (value: PaneCommandValue): Promise<RunpaneTodoResult> => {
    const request = decodeBoundary(value, boundary.object({
      title: boundary.string, summary: optionalString, doneWhen: optionalStrings, parent: optionalString, project: optionalString,
      agent: optionalString, attach: optionalStrings, start: boundary.optional(boundary.boolean), ...callerField,
    }));
    const created = await service().create({
      title: request.title, summary: request.summary, doneWhen: request.doneWhen, parentNumber: request.parent ? requireRef(request.parent) : null,
      projectId: projectIdOf(services, request.project), agent: request.agent ?? null, startNow: request.start !== false,
      attach: (request.attach ?? []).map(target => ({ target: absoluteTarget(target) })),
    }, agentActor(request.callerPanelId));
    return { ok: true, todo: runpaneTodo(service(), created.number) };
  });

  commandRegistry.register('runpane:todos:update', (value: PaneCommandValue): RunpaneTodoResult => {
    const request = decodeBoundary(value, boundary.object({
      todo: boundary.string, title: optionalString, summary: optionalString, doneWhen: optionalStrings, check: optionalNumbers, uncheck: optionalNumbers, ...callerField,
    }));
    const updated = service().update(requireRef(request.todo), { title: request.title, summary: request.summary, doneWhen: request.doneWhen, check: request.check, uncheck: request.uncheck }, agentActor(request.callerPanelId));
    return { ok: true, todo: runpaneTodo(service(), updated.number) };
  });

  commandRegistry.register('runpane:todos:attach', (value: PaneCommandValue): RunpaneTodoAttachResult => {
    const request = decodeBoundary(value, boundary.object({ todo: boundary.string, target: boundary.string, kind: optionalString, label: optionalString, note: optionalString, ...callerField }));
    const todoNumber = requireRef(request.todo);
    service().attach(todoNumber, { target: absoluteTarget(request.target), kind: request.kind, label: request.label, note: request.note }, agentActor(request.callerPanelId));
    const attachments = runpaneAttachments(service().detail(todoNumber)).filter(attachment => attachment.from === null);
    return { ok: true, todo: todoRef(todoNumber), attachment: attachments[attachments.length - 1] };
  });

  commandRegistry.register('runpane:todos:detach', (value: PaneCommandValue): RunpaneTodoDetachResult => {
    const request = decodeBoundary(value, boundary.object({ todo: boundary.string, attachment: boundary.number, ...callerField }));
    const todoNumber = requireRef(request.todo);
    service().detach(todoNumber, request.attachment, agentActor(request.callerPanelId));
    return { ok: true, todo: todoRef(todoNumber), detached: request.attachment };
  });

  commandRegistry.register('runpane:todos:show', (value: PaneCommandValue): RunpaneTodoShowResult => {
    const request = decodeBoundary(value, refSchema);
    const detail = service().detail(requireRef(request.todo));
    const attachments = runpaneAttachments(detail);
    return {
      ok: true, todo: runpaneTodoOf(detail, attachments.length), attachments,
      subTodos: detail.subTodos.map(sub => runpaneTodo(service(), sub.todo.number)),
      activity: detail.activity.slice(-20).map((row): RunpaneTodoActivity => ({ id: row.id, kind: row.kind, author: row.authorName, body: row.body, at: iso(row.createdAt) })),
    };
  });

  commandRegistry.register('runpane:todos:list', (value: PaneCommandValue): RunpaneTodoListResult => {
    const request = decodeBoundary(value ?? {}, boundary.object({ all: boundary.optional(boundary.boolean) }));
    const snapshot = service().snapshot();
    const counts = service().attachmentCounts();
    const rows = request.all ? snapshot.rows : snapshot.rows.filter(row => row.status.status !== 'done' && row.status.status !== 'dropped');
    return { ok: true, todos: rows.map(row => runpaneTodoOf(row, counts.get(row.todo.number) ?? 0)) };
  });

  commandRegistry.register('runpane:todos:assign', (value: PaneCommandValue): RunpaneTodoResult => {
    const request = decodeBoundary(value, boundary.object({ todo: boundary.string, panel: optionalString, ...callerField }));
    const updated = service().assign(requireRef(request.todo), request.panel ?? null, agentActor(request.callerPanelId));
    return { ok: true, todo: runpaneTodo(service(), updated.number) };
  });

  commandRegistry.register('runpane:todos:ask', async (value: PaneCommandValue): Promise<RunpaneTodoAskResult> => {
    const request = decodeBoundary(value, boundary.object({ todo: boundary.string, question: boundary.string, ...callerField }));
    const todoNumber = requireRef(request.todo);
    const result = await service().ask(todoNumber, request.question, agentActor(request.callerPanelId));
    return { ok: true, todo: todoRef(todoNumber), routedTo: result.routedTo, approvalId: result.approvalId ?? null };
  });

  commandRegistry.register('runpane:todos:comment', async (value: PaneCommandValue): Promise<RunpaneTodoCommentResult> => {
    const request = decodeBoundary(value, boundary.object({ todo: boundary.string, body: boundary.string, escalate: boundary.optional(boundary.boolean), ...callerField }));
    const todoNumber = requireRef(request.todo);
    const activity = await service().comment(todoNumber, request.body, agentActor(request.callerPanelId), { escalate: request.escalate });
    return { ok: true, todo: todoRef(todoNumber), activityId: activity.id };
  });

  commandRegistry.register('runpane:todos:review', async (value: PaneCommandValue): Promise<RunpaneTodoReviewResult> => {
    const request = decodeBoundary(value, boundary.object({ todo: boundary.string, summary: optionalString, noAttachments: optionalString, ...callerField }));
    const result = await service().review(requireRef(request.todo), { summary: request.summary, noAttachments: request.noAttachments }, agentActor(request.callerPanelId));
    return { ok: true, todo: runpaneTodo(service(), result.todo.number), approvalId: result.approvalId };
  });

  commandRegistry.register('runpane:todos:done', (value: PaneCommandValue): RunpaneTodoResult => {
    const request = decodeBoundary(value, boundary.object({ todo: boundary.string, personSaid: optionalString, ...callerField }));
    const done = service().done(requireRef(request.todo), { personSaid: request.personSaid }, agentActor(request.callerPanelId));
    return { ok: true, todo: runpaneTodo(service(), done.number) };
  });

  commandRegistry.register('runpane:todos:drop', (value: PaneCommandValue): RunpaneTodoResult => {
    const request = decodeBoundary(value, boundary.object({ todo: boundary.string, reason: optionalString, ...callerField }));
    const dropped = service().drop(requireRef(request.todo), { reason: request.reason }, agentActor(request.callerPanelId));
    return { ok: true, todo: runpaneTodo(service(), dropped.number) };
  });

  commandRegistry.register('runpane:todos:archive', async (value: PaneCommandValue): Promise<RunpaneTodoArchiveResult> => {
    const request = decodeBoundary(value, refSchema);
    const todoNumber = requireRef(request.todo);
    const result = await service().archive(todoNumber, agentActor(request.callerPanelId));
    return { ok: true, todo: todoRef(todoNumber), ...result };
  });

  commandRegistry.register('runpane:todos:start', async (value: PaneCommandValue): Promise<RunpaneTodoStartResult> => {
    const request = decodeBoundary(value, refSchema);
    const result = await service().start(requireRef(request.todo), agentActor(request.callerPanelId));
    return { ok: true, todo: runpaneTodo(service(), result.todo.number), queued: result.queued };
  });

  commandRegistry.register('runpane:todos:stop', (value: PaneCommandValue): RunpaneTodoResult => {
    const request = decodeBoundary(value, refSchema);
    const stopped = service().stop(requireRef(request.todo), agentActor(request.callerPanelId));
    return { ok: true, todo: runpaneTodo(service(), stopped.number) };
  });
}
