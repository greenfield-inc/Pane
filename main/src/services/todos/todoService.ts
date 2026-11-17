import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { PaneError } from '../../../../shared/paneError';
import type { NotifyItem, NotifyLink, NotifyResult, NotifyTodoLink } from '../../../../shared/types/notify';
import {
  MOVING_TODO_STATES, TODO_AGENT_REPLY_MAX, TODO_ATTACHMENT_KINDS, isOpenTodoState, parseTodoRef, todoRef,
  type LoadGateSnapshot, type TodoActivity, type TodoAttachment, type TodoAttachmentGroup, type TodoAttachmentKind,
  type TodoAttachmentSource, type TodoCreateInput, type TodoDetail, type TodoListRow, type TodoRecord, type TodoStatus, type TodosSnapshot,
} from '../../../../shared/types/todos';
import { LOAD_GATE, LoadGate, pickShedTarget, type LoadSample } from './loadGate';
import {
  acceptedText, assignedText, capacityBackText, changesText, orchestratorStartText, personMessageText, requesterQuestionText,
  requesterReplyText, requesterUpdateText, restartText, resumeText, shedText, stopText, subTodoAddedText, type RequesterUpdate,
} from './todoMessages';
import { SUPERVISOR, dayOf, decideSupervisorAction, lastMovedAt, reminderText, attachReminderText, stuckCardText, type SupervisorInputs } from './supervisorRules';
import { STATUS_ORDER, deriveTodoStatus, workingTabOf } from './todoStatus';
import type { LinkedApproval, TodoPatch, TodoStore } from './todoStore';

/** Who acts: the person (Pane's own UI), or an agent through runpane or the MCP. */
export type TodoActor =
  | { kind: 'person' }
  | { kind: 'agent'; panelId?: string; paneId?: string };

export interface TodoPanelInfo {
  name: string;
  sessionId: string | null;
  sessionName?: string;
  /** The tab is its Session's orchestrator. */
  orchestrator: boolean;
  agentId?: string;
  paneId?: string;
}

export interface TodoSessionInfo {
  id: string;
  name: string;
  orchestratorPanelId: string | null;
  archived: boolean;
  paneIds: string[];
  agentId?: string;
}

export interface CreatedTodoSession {
  sessionId: string;
  orchestratorPanelId: string | null;
  prompted: boolean;
}

export type TypeResult = 'delivered' | 'busy' | 'gone' | 'unsupported' | 'outdated';

export interface TodoCard {
  id: string;
  title: string;
  context?: string;
  choices: string[];
  links?: NotifyLink[];
  todo: TodoRecord;
  kind: 'review' | 'stuck' | 'question';
  /** The tab whose question this is; its answer is typed there. Absent: Pane's own card. */
  askerPanelId?: string;
}

/** What TodoService needs from the rest of Pane. The adapter in todoHost.ts wires the real services. */
export interface TodoHost {
  machineName(): string;
  /** Creates the to-do's own hidden Session; `prompted` says the opening prompt rode on its launch (else Pane types it once ready). */
  createSession(input: { name: string; projectId: number | null; agent: string | null; openingPrompt: string }): Promise<CreatedTodoSession>;
  session(sessionId: string): TodoSessionInfo | null;
  panel(panelId: string): TodoPanelInfo | null;
  projectName(projectId: number): string | null;
  /** The tab's agent is mid-turn now (raw; TodoService settles it). */
  isMidTurn(panelId: string): boolean;
  hasUnsentText(panelId: string): Promise<boolean>;
  /** The tab's process stopped or its tab is gone. */
  isPanelDown(panelId: string): Promise<boolean>;
  typeIntoTab(panelId: string, text: string): Promise<TypeResult>;
  resumePanel(panelId: string): Promise<boolean>;
  /** Pauses the tabs' processes, keeping their conversations. */
  pausePanels(panelIds: string[]): Promise<void>;
  /** A pinned or focused Pane holds the tab. */
  isPanelProtected(panelId: string): boolean;
  usageLimitUntil(panelId: string): number | null;
  /** Raises an approval; resolves with its answer (or never, if Pane quits first). */
  ask(card: TodoCard): Promise<NotifyResult>;
  archiveSessionPanes(sessionId: string): Promise<{ archived: string[]; kept: Array<{ name: string; reason: string }>; sessionArchived: boolean }>;
  restoreSession(sessionId: string): Promise<void>;
  sampleLoad(): Promise<Omit<LoadSample, 'at'>>;
  loadGateEnabled(): boolean;
  /** The PR on any of these Panes: "#1390 · CI running". */
  prOf(paneIds: string[]): TodoListRow['pr'] | undefined;
  log(message: string, error?: Error | string): void;
}

interface OutboxEntry {
  panelId: string;
  text: string;
  todoNumber: number;
  /** The chat row to mark Delivered. */
  activityId?: number;
  /** Resume the tab first when it is down (an answer, a comment). */
  resumeIfDown: boolean;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SETTLE_MS = 10_000;

function notFound(ref: string): PaneError {
  return new PaneError('ERR_TODO_NOT_FOUND', `There is no to-do ${ref} on this machine.`, 'Run runpane todos list to see the to-dos here.');
}

function attachmentKindOf(target: string, kind?: string): TodoAttachmentKind {
  const known = TODO_ATTACHMENT_KINDS.find(candidate => candidate === kind);
  if (known) return known;
  if (/\/pull\/\d+/.test(target)) return 'pr';
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(target)) return 'image';
  if (/^https?:\/\//.test(target)) return 'link';
  return 'doc';
}

function labelOf(target: string): string {
  const pr = /\/pull\/(\d+)/.exec(target);
  if (pr) return `PR #${pr[1]}`;
  const trimmed = target.replace(/[?#].*$/, '').replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || target;
}

/**
 * To-dos (D-408, D-409): the store's rules, statuses, delivery, the supervisor and the load gate on
 * one machine. Runs on the machine that hosts the Sessions; other machines read it.
 */
export class TodoService extends EventEmitter {
  readonly gate: LoadGate;
  private readonly outbox: OutboxEntry[] = [];
  private flushing: Promise<void> | null = null;
  private flushAgain: Promise<void> | null = null;
  /** Raw mid-turn since, and last seen mid-turn, per tab: settled into Working after 10 s. */
  private readonly activity = new Map<string, { since: number | null; lastSeen: number | null }>();
  private readonly settled = new Set<string>();
  private readonly pendingWork = new Map<number, number>();
  private readonly lastRestartAt = new Map<number, number>();
  private readonly usageLimited = new Set<number>();
  private readonly busyRefused = new Set<string>();
  private readonly ladderLog: Array<{ at: number; kind: 'reminder' | 'restart' }> = [];
  private readonly shedAsked = new Map<number, number>();
  private lastFastTick = 0;
  private readonly answered = new Set<string>();
  private readonly startedAt: number;
  private lastSupervisorPass = 0;
  private lastSampleAt = 0;
  private statusDigest = '';

  constructor(private readonly store: TodoStore, private readonly host: TodoHost, private readonly now: () => number = Date.now) {
    super();
    this.startedAt = now();
    this.gate = new LoadGate(() => host.loadGateEnabled());
    for (const message of store.undelivered()) {
      if (message.toTab) this.outbox.push({ panelId: message.toTab, text: personMessageText(this.require(message.todoNumber), message.body), todoNumber: message.todoNumber, activityId: message.id, resumeIfDown: true });
    }
  }

  private changed(): void {
    this.emit('changed');
  }

  // ── Reading ─────────────────────────────────────────────────────────────

  get(number: number): TodoRecord | undefined {
    return this.store.get(number);
  }

  require(number: number): TodoRecord {
    const todo = this.store.get(number);
    if (!todo) throw notFound(todoRef(number));
    return todo;
  }

  /** The tab that orchestrates a to-do: its Session's orchestrator. */
  orchestratorOf(todo: TodoRecord): string | null {
    return todo.sessionId ? this.host.session(todo.sessionId)?.orchestratorPanelId ?? null : null;
  }

  /** Mid-turn, settled for 10 s like the Session spinner, in both directions. */
  isWorkingTab(panelId: string): boolean {
    return this.settled.has(panelId);
  }

  private waitingByTodo(): Map<number, LinkedApproval[]> {
    const byTodo = new Map<number, LinkedApproval[]>();
    for (const approval of this.store.waitingApprovals()) byTodo.set(approval.todoNumber, [...(byTodo.get(approval.todoNumber) ?? []), approval]);
    return byTodo;
  }

  private statusOf(todo: TodoRecord, all: Map<number, TodoRecord[]>, waiting: Map<number, LinkedApproval[]>): TodoStatus {
    const openChildren = (all.get(todo.number) ?? []).filter(child => isOpenTodoState(child.state));
    const linked = [...(waiting.get(todo.number) ?? []), ...openChildren.flatMap(child => waiting.get(child.number) ?? [])].sort((a, b) => a.createdAt - b.createdAt);
    const orchestrator = this.orchestratorOf(todo);
    const tab = workingTabOf(todo, orchestrator);
    return deriveTodoStatus({
      todo, openChildren, waiting: linked, orchestratorPanelId: orchestrator, isMidTurn: panelId => this.isWorkingTab(panelId),
      machineName: this.host.machineName(), usageLimitUntil: tab ? this.host.usageLimitUntil(tab) : null, now: this.now(),
    });
  }

  private childrenIndex(todos: readonly TodoRecord[]): Map<number, TodoRecord[]> {
    const index = new Map<number, TodoRecord[]>();
    for (const todo of todos) if (todo.parentNumber !== null) index.set(todo.parentNumber, [...(index.get(todo.parentNumber) ?? []), todo]);
    return index;
  }

  private rowOf(todo: TodoRecord, children: Map<number, TodoRecord[]>, waiting: Map<number, LinkedApproval[]>, byNumber: Map<number, TodoRecord>): TodoListRow {
    const owner = todo.parentNumber !== null ? byNumber.get(todo.parentNumber) ?? this.store.get(todo.parentNumber) : todo;
    const session = owner?.sessionId ? this.host.session(owner.sessionId) : null;
    const subs = children.get(todo.number) ?? [];
    const tab = workingTabOf(todo, this.orchestratorOf(todo));
    const projectId = todo.projectId ?? owner?.projectId ?? null;
    const agentId = (tab ? this.host.panel(tab)?.agentId : undefined) ?? todo.agent ?? session?.agentId;
    const pr = session ? this.host.prOf(todo.assignee?.paneId ? [todo.assignee.paneId] : session.paneIds) : undefined;
    const requesterSession = todo.requester.kind === 'orchestrator' && todo.requester.sessionId ? this.host.session(todo.requester.sessionId) : undefined;
    const shown = requesterSession === null || requesterSession?.archived ? { ...todo, requester: { ...todo.requester, gone: true } } : todo;
    return {
      todo: shown, status: this.statusOf(todo, children, waiting), machine: this.host.machineName(),
      sessionName: session?.name,
      projectName: projectId !== null ? this.host.projectName(projectId) ?? undefined : undefined,
      subCounts: subs.length > 0 ? { done: subs.filter(sub => sub.state === 'done').length, total: subs.filter(sub => sub.state !== 'dropped').length } : undefined,
      pr,
      agentId: agentId ?? undefined,
    };
  }

  gateSnapshot(): LoadGateSnapshot {
    const latest = this.gate.latest;
    return {
      state: this.gate.state, enabled: this.host.loadGateEnabled(), since: this.gate.since,
      line: this.gate.line(this.host.machineName(), this.now()),
      cpuPercent: latest?.cpuPercent ?? undefined,
      memoryPressure: latest?.memory,
    };
  }

  snapshot(options: { closedSince?: number } = {}): TodosSnapshot {
    const todos = this.store.list({ closedSince: options.closedSince ?? this.now() - 7 * 24 * HOUR });
    const children = this.childrenIndex(todos);
    const waiting = this.waitingByTodo();
    const byNumber = new Map(todos.map(todo => [todo.number, todo]));
    const rows = todos.map(todo => this.rowOf(todo, children, waiting, byNumber));
    rows.sort((a, b) => STATUS_ORDER[a.status.status] - STATUS_ORDER[b.status.status] || b.todo.updatedAt - a.todo.updatedAt);
    return { rows, gate: this.gateSnapshot(), machine: this.host.machineName(), ownSessionIds: this.store.ownSessionIds() };
  }

  /** Own attachments, then the parent's (for a sub-to-do) or each sub-to-do's (for a parent). Read, never copied. */
  attachmentGroups(todo: TodoRecord): TodoAttachmentGroup[] {
    const groups: TodoAttachmentGroup[] = [{ attachments: this.store.attachments(todo.number) }];
    if (todo.parentNumber !== null) {
      const parentAttachments = this.store.attachments(todo.parentNumber);
      if (parentAttachments.length > 0) groups.push({ from: { number: todo.parentNumber, relation: 'parent' }, attachments: parentAttachments });
    } else {
      for (const child of this.store.children(todo.number)) {
        const childAttachments = this.store.attachments(child.number);
        if (childAttachments.length > 0) groups.push({ from: { number: child.number, relation: 'sub' }, attachments: childAttachments });
      }
    }
    return groups;
  }

  /** Files attached to this machine's to-dos: another machine may read these to show them in a to-do's split. */
  attachedFiles(): string[] {
    return this.store.attachedFiles();
  }

  /** Each to-do's attachments, own and from its sub-to-dos, as the list counts them. */
  attachmentCounts(): Map<number, number> {
    const own = this.store.attachmentCounts();
    const counts = new Map(own);
    for (const todo of this.store.list()) {
      if (todo.parentNumber !== null) counts.set(todo.parentNumber, (counts.get(todo.parentNumber) ?? 0) + (own.get(todo.number) ?? 0));
    }
    return counts;
  }

  private attachmentCount(todo: TodoRecord): number {
    return this.store.attachments(todo.number).length + this.store.children(todo.number).reduce((sum, child) => sum + this.store.attachments(child.number).length, 0);
  }

  detail(number: number): TodoDetail {
    const todo = this.require(number);
    const family = [todo, ...this.store.children(todo.number)];
    const parent = todo.parentNumber !== null ? this.store.get(todo.parentNumber) : undefined;
    if (parent) family.push(parent, ...this.store.children(parent.number).filter(sibling => sibling.number !== todo.number));
    const children = this.childrenIndex(family);
    const waiting = this.waitingByTodo();
    const byNumber = new Map(family.map(item => [item.number, item]));
    const row = this.rowOf(todo, children, waiting, byNumber);
    const orchestratorPanelId = this.orchestratorOf(todo);
    const orchestratorInfo = orchestratorPanelId ? this.host.panel(orchestratorPanelId) : null;
    const target = this.chatTarget(todo);
    const canPause = todo.loadOverride !== 'never_pause';
    const lastMoved = lastMovedAt(todo, null);
    const quietMinutes = Math.max(0, Math.round((this.now() - lastMoved) / MINUTE));
    return {
      ...row,
      subTodos: (children.get(todo.number) ?? []).map(child => this.rowOf(child, children, waiting, byNumber)),
      parent: parent ? this.rowOf(parent, children, waiting, byNumber) : undefined,
      attachments: this.attachmentGroups(todo),
      activity: this.store.activity(todo.number),
      approvalIds: this.store.approvalIds(family.filter(item => item.number === todo.number || item.parentNumber === todo.number).map(item => item.number)),
      chatTarget: target,
      orchestrator: orchestratorPanelId && orchestratorInfo ? { panelId: orchestratorPanelId, name: orchestratorInfo.name, agentId: orchestratorInfo.agentId } : undefined,
      load: { gate: this.gate.state, canPause, reason: this.gate.line(this.host.machineName(), this.now()) },
      keepMoving: MOVING_TODO_STATES.includes(todo.state)
        ? `quiet ${quietMinutes}m · ${todo.episodeReminders} reminder${todo.episodeReminders === 1 ? '' : 's'}${todo.episodeRestarts > 0 ? ` · restarted ${todo.episodeRestarts}×` : ''}`
        : '–',
    };
  }

  /** Where the to-do's chat goes: a parent's orchestrator; a sub-to-do's assignee, or the orchestrator. */
  chatTarget(todo: TodoRecord, toOrchestrator = false): TodoDetail['chatTarget'] {
    const orchestrator = this.orchestratorOf(todo);
    if (!toOrchestrator && todo.parentNumber !== null && todo.assignee) {
      return { panelId: todo.assignee.panelId, name: todo.assignee.name ?? this.host.panel(todo.assignee.panelId)?.name ?? 'its agent', kind: 'assignee' };
    }
    return { panelId: orchestrator, name: 'orchestrator', kind: 'orchestrator' };
  }

  /** Session ids kept out of the sidebar: every top-level to-do's own Session. */
  ownSessionIds(): string[] {
    return this.store.ownSessionIds();
  }

  // ── Who is acting ───────────────────────────────────────────────────────

  private actorName(actor: TodoActor): string {
    if (actor.kind === 'person') return 'you';
    const info = actor.panelId ? this.host.panel(actor.panelId) : null;
    if (!info) return 'an agent';
    return info.orchestrator && info.sessionName ? `${info.sessionName} orchestrator` : info.name;
  }

  private event(todo: TodoRecord, body: string, authorKind: TodoActivity['authorKind'] = 'pane', authorName = 'Pane'): TodoActivity {
    return this.store.addActivity({ todoNumber: todo.number, kind: 'event', authorKind, authorName, body, now: this.now() });
  }

  /** Something moved the work: the supervisor's clock and ladder start again. */
  private progress(todo: TodoRecord, extra: TodoPatch = {}): TodoRecord {
    const updated = this.store.update(todo.number, { lastProgressAt: this.now(), stuckSince: null, episodeReminders: 0, episodeRestarts: 0, ...extra }, this.now());
    this.lastRestartAt.delete(todo.number);
    if (updated.parentNumber !== null) {
      const parent = this.store.get(updated.parentNumber);
      if (parent && MOVING_TODO_STATES.includes(parent.state)) this.store.update(parent.number, { lastProgressAt: this.now(), stuckSince: null, episodeReminders: 0, episodeRestarts: 0 }, this.now());
    }
    return updated;
  }

  private requireOpen(todo: TodoRecord, doing: string): void {
    if (!isOpenTodoState(todo.state)) {
      throw new PaneError('ERR_TODO_CLOSED', `${todo.ref} is ${todo.state === 'done' ? 'done' : 'dropped'}, so it can't be ${doing}. Nothing changed.`, `Reopen it from the To-dos page first, or create a new to-do.`);
    }
  }

  // ── Creating ────────────────────────────────────────────────────────────

  async create(input: TodoCreateInput, actor: TodoActor): Promise<TodoRecord> {
    const title = input.title.trim();
    if (!title) throw new PaneError('ERR_TODO_TITLE', 'A to-do needs a title. Nothing was created.', 'Pass a title, e.g. runpane todos create "Fix the invoice PDFs".');
    const now = this.now();
    const parent = input.parentNumber ? this.require(input.parentNumber) : undefined;
    if (parent && parent.parentNumber !== null) {
      throw new PaneError('ERR_TODO_TOO_DEEP', `${parent.ref} is already a sub-to-do; sub-to-dos go one level deep. Nothing was created.`, `Add it under ${todoRef(parent.parentNumber)} instead: --parent ${todoRef(parent.parentNumber)}.`);
    }
    if (parent) this.requireOpen(parent, 'given sub-to-dos');
    const requesterPanel = actor.kind === 'agent' && actor.panelId ? this.host.panel(actor.panelId) : null;
    const requester = parent
      ? parent.requester
      : actor.kind === 'person'
        ? { kind: 'person' as const, name: 'you' }
        : { kind: 'orchestrator' as const, name: this.actorName(actor), sessionId: requesterPanel?.sessionId ?? undefined, panelId: actor.panelId };
    const todo = this.store.transaction(() => {
      const created = this.store.create({
        title, summary: input.summary ?? '', doneWhen: (input.doneWhen ?? []).map(text => text.trim()).filter(Boolean).map(text => ({ text, met: false })),
        parentNumber: parent?.number ?? null, sessionId: parent?.sessionId ?? null, state: parent && MOVING_TODO_STATES.includes(parent.state) ? 'in_progress' : 'todo',
        requester, projectId: input.projectId ?? parent?.projectId ?? null, agent: input.agent ?? null, createdBy: this.actorName(actor), now,
      });
      this.event(created, parent
        ? `Sub-to-do of ${parent.ref}, created by ${actor.kind === 'person' ? 'you' : this.actorName(actor)}`
        : actor.kind === 'person' ? 'Created by you' : `Created by ${this.actorName(actor)}`, actor.kind === 'person' ? 'person' : 'agent', this.actorName(actor));
      for (const attach of input.attach ?? []) {
        this.store.attach({ todoNumber: created.number, kind: attachmentKindOf(attach.target, attach.kind), target: attach.target, machine: /^https?:/.test(attach.target) ? undefined : this.host.machineName(), label: attach.label ?? labelOf(attach.target), note: attach.note, addedBy: this.actorName(actor), addedByTab: actor.kind === 'agent' ? actor.panelId : undefined, source: 'attached', now });
      }
      for (const subTitle of (input.subTodos ?? []).map(text => text.trim()).filter(Boolean)) {
        const sub = this.store.create({ title: subTitle, parentNumber: created.number, state: 'todo', requester, projectId: created.projectId, createdBy: this.actorName(actor), now });
        this.event(sub, `Sub-to-do of ${created.ref}, created by ${this.actorName(actor)}`);
      }
      return created;
    });
    if (parent) {
      this.event(parent, `Sub-to-do ${todo.ref} added: ${todo.title}`, actor.kind === 'person' ? 'person' : 'agent', this.actorName(actor));
      const orchestrator = this.orchestratorOf(parent);
      if (actor.kind === 'person' && orchestrator) this.enqueue({ panelId: orchestrator, text: subTodoAddedText(parent, todo, this.attachmentGroups(todo)), todoNumber: parent.number, resumeIfDown: false });
      if (parent.state === 'todo') this.store.update(todo.number, { state: 'todo' }, now);
      this.progress(parent);
    } else if (input.startNow !== false) {
      await this.start(todo.number, actor);
    }
    this.changed();
    return this.require(todo.number);
  }

  // ── Starting, stopping, resuming ────────────────────────────────────────

  /** Start: create the to-do's own Session and orchestrator, through the load gate. */
  async start(number: number, actor: TodoActor, options: { anyway?: boolean } = {}): Promise<{ todo: TodoRecord; queued: boolean }> {
    const todo = this.require(number);
    this.requireOpen(todo, 'started');
    if (todo.parentNumber !== null) {
      const updated = this.store.update(number, { state: 'in_progress', startedAt: todo.startedAt ?? this.now(), lastProgressAt: this.now() }, this.now());
      this.event(updated, `Started by ${this.actorName(actor)}`);
      this.changed();
      return { todo: updated, queued: false };
    }
    if (options.anyway) {
      this.store.update(number, { loadOverride: 'never_pause' }, this.now());
      this.event(todo, `Start anyway by ${this.actorName(actor)}: starts now and won't be paused for load`, actor.kind === 'person' ? 'person' : 'agent', this.actorName(actor));
    }
    if (!options.anyway && !this.gate.allowsStart()) {
      const queued = this.store.update(number, { state: 'in_progress', loadHold: 'queued', loadHoldSince: this.now() }, this.now());
      this.event(queued, `Queued: ${this.gate.line(this.host.machineName(), this.now()) ?? 'the machine is busy'} · starts when load comes down`);
      this.changed();
      return { todo: queued, queued: true };
    }
    await this.launch(number, actor);
    this.changed();
    return { todo: this.require(number), queued: false };
  }

  /** Creates the Session (first start) or resumes its orchestrator, and marks the to-do in progress. */
  private async launch(number: number, actor: TodoActor | null): Promise<void> {
    const todo = this.require(number);
    const now = this.now();
    if (!todo.sessionId) {
      const subs = this.store.children(number);
      const openingPrompt = orchestratorStartText({ ...todo, state: 'in_progress' }, this.attachmentGroups(todo), subs, todo.projectId !== null ? this.host.projectName(todo.projectId) : null);
      const { sessionId, orchestratorPanelId, prompted } = await this.host.createSession({
        name: `${todo.ref} · ${todo.title}`.slice(0, 120), projectId: todo.projectId, agent: todo.agent, openingPrompt,
      });
      if (!prompted && orchestratorPanelId) this.enqueue({ panelId: orchestratorPanelId, text: openingPrompt, todoNumber: number, resumeIfDown: false });
      this.store.transaction(() => {
        this.store.update(number, { sessionId, state: 'in_progress', startedAt: now, lastProgressAt: now, loadHold: null, loadHoldSince: null }, now);
        for (const sub of subs) this.store.update(sub.number, { sessionId }, now);
      });
      this.event(todo, `Started${actor ? ` by ${this.actorName(actor)}` : ''}: its own Session and orchestrator`);
      return;
    }
    const orchestrator = this.orchestratorOf(todo);
    if (orchestrator && await this.host.isPanelDown(orchestrator)) await this.host.resumePanel(orchestrator);
    this.store.update(number, { state: 'in_progress', startedAt: todo.startedAt ?? now, lastProgressAt: now, loadHold: null, loadHoldSince: null }, now);
    if (orchestrator) this.enqueue({ panelId: orchestrator, text: resumeText(todo), todoNumber: number, resumeIfDown: true });
  }

  stop(number: number, actor: TodoActor): TodoRecord {
    const todo = this.require(number);
    this.requireOpen(todo, 'stopped');
    const orchestrator = this.orchestratorOf(todo);
    if (orchestrator && MOVING_TODO_STATES.includes(todo.state)) this.enqueue({ panelId: orchestrator, text: stopText(todo), todoNumber: number, resumeIfDown: false });
    const stopped = this.store.update(number, { state: 'stopped', loadHold: null, loadHoldSince: null }, this.now());
    this.event(stopped, `Stopped by ${this.actorName(actor)}`, actor.kind === 'person' ? 'person' : 'agent', this.actorName(actor));
    this.changed();
    return stopped;
  }

  async resume(number: number, actor: TodoActor): Promise<{ todo: TodoRecord; queued: boolean }> {
    const todo = this.require(number);
    this.requireOpen(todo, 'resumed');
    if (!todo.sessionId) return this.start(number, actor);
    if (!this.gate.allowsStart()) {
      const queued = this.store.update(number, { state: 'in_progress', loadHold: 'queued', loadHoldSince: this.now() }, this.now());
      this.event(queued, 'Resume queued: the machine is busy · starts when load comes down');
      this.changed();
      return { todo: queued, queued: true };
    }
    await this.launch(number, actor);
    this.event(todo, `Resumed by ${this.actorName(actor)}`, actor.kind === 'person' ? 'person' : 'agent', this.actorName(actor));
    this.changed();
    return { todo: this.require(number), queued: false };
  }

  setNeverPause(number: number, on: boolean, actor: TodoActor): TodoRecord {
    const updated = this.store.update(number, { loadOverride: on ? 'never_pause' : null }, this.now());
    this.event(updated, on ? `Never pause turned on by ${this.actorName(actor)}` : `Never pause turned off by ${this.actorName(actor)}`, actor.kind === 'person' ? 'person' : 'agent', this.actorName(actor));
    this.changed();
    return updated;
  }

  // ── Editing ─────────────────────────────────────────────────────────────

  update(number: number, patch: { title?: string; summary?: string; doneWhen?: string[]; check?: number[]; uncheck?: number[] }, actor: TodoActor): TodoRecord {
    const todo = this.require(number);
    this.requireOpen(todo, 'edited');
    const doneWhen = patch.doneWhen ? patch.doneWhen.map(text => text.trim()).filter(Boolean).map(text => ({ text, met: todo.doneWhen.find(item => item.text === text)?.met ?? false })) : [...todo.doneWhen];
    for (const index of patch.check ?? []) if (doneWhen[index - 1]) doneWhen[index - 1] = { ...doneWhen[index - 1], met: true };
    for (const index of patch.uncheck ?? []) if (doneWhen[index - 1]) doneWhen[index - 1] = { ...doneWhen[index - 1], met: false };
    const title = patch.title?.trim();
    const updated = this.progress(todo, { title: title || undefined, summary: patch.summary, doneWhen });
    const what = [title && title !== todo.title ? `renamed to “${title}”` : '', patch.summary !== undefined ? 'summary edited' : '', patch.doneWhen ? 'done-when edited' : '',
      ...(patch.check ?? []).map(index => doneWhen[index - 1] ? `checked “${doneWhen[index - 1].text}”` : ''), ...(patch.uncheck ?? []).map(index => doneWhen[index - 1] ? `unchecked “${doneWhen[index - 1].text}”` : '')].filter(Boolean);
    if (what.length > 0) this.event(updated, `${what.join(', ')} by ${this.actorName(actor)}`, actor.kind === 'person' ? 'person' : 'agent', this.actorName(actor));
    this.changed();
    return updated;
  }

  // ── Attachments ─────────────────────────────────────────────────────────

  attach(number: number, input: { target: string; kind?: string; label?: string; note?: string; machine?: string; source?: TodoAttachmentSource }, actor: TodoActor): TodoAttachment {
    const todo = this.require(number);
    const target = input.target.trim();
    if (!target) throw new PaneError('ERR_TODO_ATTACH_TARGET', 'Nothing to attach: the file or URL is empty. Nothing changed.', `Pass a file path or URL: runpane todos attach ${todo.ref} <file|url>.`);
    const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(target) && !target.startsWith('file://');
    const path = target.startsWith('file://') ? decodeURIComponent(target.slice('file://'.length)) : target;
    const attachment = this.store.attach({
      todoNumber: number, kind: attachmentKindOf(path, input.kind), target: isUrl ? target : path, machine: isUrl ? undefined : input.machine ?? this.host.machineName(),
      label: input.label?.trim() || labelOf(path), note: input.note?.trim() || undefined, addedBy: input.source && input.source !== 'attached' ? 'Pane' : this.actorName(actor),
      addedByTab: actor.kind === 'agent' ? actor.panelId : undefined, source: input.source ?? 'attached', now: this.now(),
    });
    this.progress(todo);
    const how = { attached: '', pr: ' (its PR)', approval: ' (from an approval)', opened: ' (opened beside you)' }[attachment.source];
    this.event(todo, `${attachment.addedBy === 'you' ? 'You' : attachment.addedBy} attached ${attachment.kind}: ${attachment.label}${how}`, actor.kind === 'person' ? 'person' : attachment.source === 'attached' ? 'agent' : 'pane', attachment.addedBy);
    this.changed();
    return attachment;
  }

  detach(number: number, attachmentId: number, actor: TodoActor): void {
    const todo = this.require(number);
    const attachment = this.store.attachment(attachmentId);
    if (!attachment || attachment.todoNumber !== number || !this.store.detach(attachmentId, this.now())) {
      throw new PaneError('ERR_TODO_ATTACHMENT', `${todo.ref} has no attachment ${attachmentId}. Nothing changed.`, `Run runpane todos show ${todo.ref} to see its attachments and their ids.`);
    }
    this.progress(todo);
    this.event(todo, `${this.actorName(actor)} detached ${attachment.label}`, actor.kind === 'person' ? 'person' : 'agent', this.actorName(actor));
    this.changed();
  }

  /** Pane attaches what it can see: a PR, an approval's files, a page opened beside you. Repeats are skipped. */
  autoAttach(number: number, target: string, source: Exclude<TodoAttachmentSource, 'attached'>, label?: string): void {
    const todo = this.store.get(number);
    if (!todo || !isOpenTodoState(todo.state) || this.store.hasTarget(number, target)) return;
    this.attach(number, { target, source, label, kind: source === 'pr' ? 'pr' : undefined }, { kind: 'agent' });
  }

  /** The open to-dos a tab works on: assigned to it, or orchestrated by it. */
  todosOfPanel(panelId: string): TodoRecord[] {
    return this.store.listOpen().filter(todo => todo.assignee?.panelId === panelId || (todo.parentNumber === null && this.orchestratorOf(todo) === panelId));
  }

  /**
   * The to-do a question is about (D-408): `--todo T-n` when given, which must exist and be open;
   * else the one open to-do the asking tab is assigned to, if exactly one.
   */
  todoLinkFor(panelId: string | undefined, explicit: string | undefined): NotifyTodoLink | undefined {
    let todo: TodoRecord | undefined;
    if (explicit) {
      const number = parseTodoRef(explicit);
      todo = number === null ? undefined : this.store.get(number);
      if (!todo) throw notFound(explicit);
      this.requireOpen(todo, 'asked about');
    } else if (panelId) {
      todo = this.soleTodoOfPanel(panelId);
    }
    if (!todo) return undefined;
    this.progress(todo);
    this.changed();
    return { number: todo.number, title: todo.title };
  }

  /** The one open to-do a tab is assigned to, if exactly one (unlinked questions link to it). */
  soleTodoOfPanel(panelId: string): TodoRecord | undefined {
    const assigned = this.store.listOpen().filter(todo => todo.assignee?.panelId === panelId);
    if (assigned.length === 1) return assigned[0];
    if (assigned.length > 1) return undefined;
    const orchestrated = this.todosOfPanel(panelId).filter(todo => todo.parentNumber === null);
    return orchestrated.length === 1 ? orchestrated[0] : undefined;
  }

  /** A commit or push landed in a Pane: progress for the to-dos working there. */
  noteProgressForPane(paneId: string): void {
    for (const todo of this.store.listOpen()) {
      if (!MOVING_TODO_STATES.includes(todo.state)) continue;
      const owner = todo.parentNumber === null ? todo : this.store.get(todo.parentNumber);
      const session = owner?.sessionId ? this.host.session(owner.sessionId) : null;
      if (todo.assignee?.paneId === paneId || session?.paneIds.includes(paneId)) this.progress(todo);
    }
  }

  onPanelOpened(panelId: string, target: string): void {
    for (const todo of this.todosOfPanel(panelId)) this.autoAttach(todo.number, target, 'opened');
  }

  onPr(paneId: string, pr: { url: string; number: number; title?: string }): void {
    for (const todo of this.store.listOpen()) {
      const owner = todo.parentNumber === null ? todo : this.store.get(todo.parentNumber);
      const assigned = todo.assignee?.paneId === paneId;
      const inSession = todo.parentNumber === null && owner?.sessionId && this.host.session(owner.sessionId)?.paneIds.includes(paneId);
      if (assigned || inSession) this.autoAttach(todo.number, pr.url, 'pr', `#${pr.number}${pr.title ? ` ${pr.title}` : ''}`);
    }
  }

  // ── Assigning ───────────────────────────────────────────────────────────

  assign(number: number, panelId: string | null, actor: TodoActor): TodoRecord {
    const todo = this.require(number);
    this.requireOpen(todo, 'assigned');
    const info = panelId ? this.host.panel(panelId) : null;
    if (panelId && !info) throw new PaneError('ERR_TODO_ASSIGN_TAB', `There is no tab ${panelId} in Pane. ${todo.ref} was not assigned.`, 'Pass a tab id from runpane panels list --json.');
    const startsSub = todo.state === 'todo' && todo.parentNumber !== null;
    const updated = this.progress(todo, {
      assignee: panelId ? { panelId, paneId: info?.paneId, name: info?.name ?? 'agent' } : null,
      state: startsSub ? 'in_progress' : undefined, startedAt: startsSub ? this.now() : undefined,
    });
    this.event(updated, panelId ? `Assigned to ${info?.name ?? panelId} by ${this.actorName(actor)}` : `Back with the orchestrator (${this.actorName(actor)})`, actor.kind === 'person' ? 'person' : 'agent', this.actorName(actor));
    if (panelId && panelId !== this.orchestratorOf(todo)) {
      const parent = todo.parentNumber !== null ? this.store.get(todo.parentNumber) : undefined;
      this.enqueue({ panelId, text: assignedText(updated, parent, this.attachmentGroups(updated)), todoNumber: number, resumeIfDown: false });
    }
    this.changed();
    return updated;
  }

  // ── The chat ────────────────────────────────────────────────────────────

  /**
   * A message on a to-do. From you, it is typed into the agent working it when that tab is idle.
   * From an agent, it is a short reply (at most 2,000 characters); from the requester's tab it is a
   * reply to the to-do's orchestrator; with `escalate`, the requester passes the question to you.
   */
  async comment(number: number, body: string, actor: TodoActor, options: { toOrchestrator?: boolean; escalate?: boolean; chatRef?: { panelId: string; messageId?: string } } = {}): Promise<TodoActivity> {
    const todo = this.require(number);
    const text = body.trim();
    if (!text) throw new PaneError('ERR_TODO_COMMENT_EMPTY', 'The message is empty. Nothing was sent.', `Pass the text: runpane todos comment ${todo.ref} "…".`);
    if (actor.kind === 'person') {
      const target = this.chatTarget(todo, options.toOrchestrator);
      const message = this.store.addActivity({ todoNumber: number, kind: 'message', authorKind: 'person', authorName: 'you', body: text, toTab: target.panelId ?? undefined, toName: target.panelId ? target.name : undefined, now: this.now() });
      if (target.panelId) this.enqueue({ panelId: target.panelId, text: personMessageText(todo, text), todoNumber: number, activityId: message.id, resumeIfDown: true });
      this.progress(todo);
      this.changed();
      void this.flush();
      return message;
    }
    if (text.length > TODO_AGENT_REPLY_MAX) {
      throw new PaneError('ERR_TODO_REPLY_TOO_LONG', `That reply is ${text.length} characters; a to-do's chat takes at most ${TODO_AGENT_REPLY_MAX}. Nothing was posted.`, 'Summarise it in a few sentences: the person reads the full turn in the Session chat.');
    }
    const name = this.actorName(actor);
    const orchestrator = this.orchestratorOf(todo.parentNumber !== null ? this.store.get(todo.parentNumber) ?? todo : todo);
    const fromRequester = todo.requester.kind === 'orchestrator' && actor.panelId !== undefined && actor.panelId === todo.requester.panelId;
    if (fromRequester && options.escalate) {
      const message = this.store.addActivity({ todoNumber: number, kind: 'message', authorKind: 'requester', authorName: todo.requester.name, authorTab: actor.panelId, body: text, now: this.now() });
      const question = this.store.activity(number).reverse().find(row => row.kind === 'event' && row.body.startsWith('Asked the requester: '))?.body.slice('Asked the requester: '.length) ?? text;
      this.raiseQuestion(todo, question, `${todo.requester.name} couldn't settle it: ${text}`, orchestrator ?? undefined);
      this.progress(todo);
      this.changed();
      return message;
    }
    const message = this.store.addActivity({
      todoNumber: number, kind: 'message', authorKind: fromRequester ? 'requester' : 'agent', authorName: fromRequester ? todo.requester.name : name,
      authorTab: actor.panelId, body: text, chatRef: options.chatRef ?? (actor.panelId ? { panelId: actor.panelId } : undefined), now: this.now(),
    });
    // From any tab other than the to-do's own orchestrator, the reply reaches that orchestrator.
    if (orchestrator && actor.panelId !== orchestrator) {
      this.enqueue({ panelId: orchestrator, text: requesterReplyText(todo, fromRequester ? todo.requester.name : name, text), todoNumber: number, resumeIfDown: true });
    }
    this.progress(todo);
    this.changed();
    return message;
  }

  /** The orchestrator asks: its requester first, or you when the requester is you or gone. */
  async ask(number: number, question: string, actor: TodoActor): Promise<{ routedTo: 'requester' | 'person'; approvalId?: string }> {
    const todo = this.require(number);
    const text = question.trim();
    if (!text) throw new PaneError('ERR_TODO_ASK_EMPTY', 'The question is empty. Nothing was asked.', `Pass it: runpane todos ask ${todo.ref} "…".`);
    const owner = todo.parentNumber !== null ? this.store.get(todo.parentNumber) ?? todo : todo;
    const requester = owner.requester;
    const requesterSession = requester.sessionId ? this.host.session(requester.sessionId) : null;
    const requesterTab = requester.kind === 'orchestrator' && requesterSession && !requesterSession.archived ? requester.panelId ?? requesterSession.orchestratorPanelId : null;
    this.progress(todo);
    if (requesterTab) {
      this.event(todo, `Asked the requester: ${text}`, 'agent', this.actorName(actor));
      this.enqueue({ panelId: requesterTab, text: requesterQuestionText(todo, text), todoNumber: number, resumeIfDown: true });
      this.changed();
      return { routedTo: 'requester' };
    }
    const id = this.raiseQuestion(todo, text, requester.kind === 'orchestrator' ? `${requester.name} is gone, so this comes to you.` : undefined, actor.kind === 'agent' ? actor.panelId : undefined);
    this.changed();
    return { routedTo: 'person', approvalId: id };
  }

  private raiseQuestion(todo: TodoRecord, question: string, context: string | undefined, askerPanelId: string | undefined): string {
    const id = randomUUID();
    this.event(todo, `Asked you: ${question}`);
    void this.host.ask({ id, title: question, context, choices: [], todo, kind: 'question', askerPanelId })
      .then(result => this.onQuestionAnswered(todo.number, result))
      .catch(error => this.host.log(`[Todos] ${todo.ref} question failed`, error));
    return id;
  }

  private onQuestionAnswered(number: number, result: NotifyResult): void {
    const todo = this.store.get(number);
    if (!todo) return;
    const answer = 'answer' in result ? result.answer : 'reply' in result ? result.reply : 'approved' in result ? (result.approved ? 'Approved' : 'Denied') : null;
    if (answer === null) return;
    this.progress(todo);
    this.event(todo, `You answered: ${answer}`, 'person', 'you');
    this.changed();
  }

  /** Approvals changed: attach linked approvals' files, log answers, and refresh statuses. */
  onApprovalsChanged(items: readonly NotifyItem[]): void {
    for (const item of items) {
      // Only this machine's cards: another machine's to-dos are its own.
      if (item.machineId !== undefined && item.machineId !== 'local') continue;
      if (item.todo) this.onApprovalItem(item);
    }
    this.changed();
  }

  /** An approval linked to a to-do changed (asked by an agent with --todo, or answered anywhere). */
  onApprovalItem(item: NotifyItem): void {
    const number = item.todo?.number;
    if (number === undefined) return;
    const todo = this.store.get(number);
    if (!todo) return;
    // An answer is progress; Pane's own cards log theirs where they're handled.
    if (item.state === 'answered' && !this.answered.has(item.id) && (item.resolvedAt ?? 0) >= this.startedAt && item.todo?.kind === undefined) {
      this.answered.add(item.id);
      this.progress(todo);
      const qn = /^Q-\d+/.exec(item.title)?.[0];
      this.event(todo, `You answered ${qn ?? 'its question'}: ${item.answerSummary ?? 'answered'}`, 'person', 'you');
    }
    // Pane attaches the files on an approval linked to the to-do.
    for (const link of item.links ?? []) {
      if ('path' in link) this.autoAttach(number, link.path, 'approval', link.label);
      else if ('url' in link) this.autoAttach(number, link.url, 'approval', link.label);
    }
    this.changed();
  }

  // ── Review, done, drop ──────────────────────────────────────────────────

  async review(number: number, options: { summary?: string; noAttachments?: string }, actor: TodoActor): Promise<{ todo: TodoRecord; approvalId: string }> {
    const todo = this.require(number);
    this.requireOpen(todo, 'sent for review');
    const count = this.attachmentCount(todo);
    if (count === 0 && !options.noAttachments?.trim()) {
      throw new PaneError('ERR_TODO_REVIEW_NO_ATTACHMENTS', `${todo.ref} has no attachments, so there is nothing for the person to review. Nothing was sent.`,
        `Attach what you are asking them to review (runpane todos attach ${todo.ref} <file|url>), or pass --no-attachments "<why>".`);
    }
    const groups = this.attachmentGroups(todo);
    const links: NotifyLink[] = groups.flatMap(group => group.attachments).slice(0, 6).map(attachment => /^https?:/.test(attachment.target) ? { label: attachment.label.slice(0, 80), url: attachment.target } : { label: attachment.label.slice(0, 80), path: attachment.target });
    const id = randomUUID();
    const context = [options.summary?.trim(), count === 0 ? `No attachments: ${options.noAttachments?.trim()}` : `Attachments: ${groups.flatMap(group => group.attachments).map(attachment => `${attachment.kind} · ${attachment.label}`).join('; ')}`].filter(Boolean).join('\n\n');
    const updated = this.progress(todo, { state: 'in_review' });
    this.event(updated, `${this.actorName(actor)} asked for your review${options.summary ? `: ${options.summary.trim()}` : ''}`, 'agent', this.actorName(actor));
    this.notifyRequester(updated, 'review');
    void this.host.ask({ id, title: `Review ${todo.ref}: ${todo.title}`, context, choices: ['Accept', 'Ask for changes'], links, todo: updated, kind: 'review' })
      .then(result => this.onReviewAnswered(number, result))
      .catch(error => this.host.log(`[Todos] ${todo.ref} review failed`, error));
    this.changed();
    return { todo: updated, approvalId: id };
  }

  private onReviewAnswered(number: number, result: NotifyResult): void {
    const todo = this.store.get(number);
    if (!todo || todo.state !== 'in_review') return;
    const pick = 'answer' in result ? result.answer : 'reply' in result ? result.picks?.[0] ?? null : null;
    const note = 'answer' in result ? result.note ?? '' : 'reply' in result ? result.reply : '';
    const orchestrator = this.orchestratorOf(todo.parentNumber !== null ? this.store.get(todo.parentNumber) ?? todo : todo);
    if (pick === 'Accept') {
      const accepted = this.progress(todo, { state: 'accepted', acceptedAt: this.now() });
      this.event(accepted, 'You accepted it. The orchestrator wraps up, then marks it done.', 'person', 'you');
      if (orchestrator) this.enqueue({ panelId: orchestrator, text: acceptedText(accepted), todoNumber: number, resumeIfDown: true });
    } else if (pick === 'Ask for changes' || 'reply' in result) {
      const back = this.progress(todo, { state: 'in_progress' });
      this.event(back, `You asked for changes${note ? `: ${note}` : ''}`, 'person', 'you');
      if (orchestrator) this.enqueue({ panelId: orchestrator, text: changesText(back, note), todoNumber: number, resumeIfDown: true });
    } else {
      return;
    }
    this.changed();
    void this.flush();
  }

  /**
   * Marks a to-do done. A sub-to-do: any time. A top-level to-do by an agent: only after your
   * Accept, or with --person-said quoting you. You can always mark one done.
   */
  done(number: number, options: { personSaid?: string }, actor: TodoActor): TodoRecord {
    const todo = this.require(number);
    this.requireOpen(todo, 'marked done');
    const personSaid = options.personSaid?.trim();
    if (actor.kind === 'agent' && todo.parentNumber === null && todo.state !== 'accepted' && !personSaid) {
      throw new PaneError('ERR_TODO_DONE_NEEDS_REVIEW', `${todo.ref} is a top-level to-do the person hasn't accepted, so an agent can't mark it done. Nothing changed.`,
        `Ask for review with runpane todos review ${todo.ref}; after they Accept, wrap up and run runpane todos done ${todo.ref}. If they told you to close it, pass --person-said "<their words>".`);
    }
    const done = this.store.update(number, { state: 'done', closedAt: this.now(), loadHold: null, loadHoldSince: null, stuckSince: null }, this.now());
    if (personSaid) this.store.addActivity({ todoNumber: number, kind: 'message', authorKind: 'agent', authorName: this.actorName(actor), body: `Marked done because you said: “${personSaid}”`, now: this.now() });
    this.event(done, `Done · marked by ${this.actorName(actor)}`, actor.kind === 'person' ? 'person' : 'agent', this.actorName(actor));
    if (todo.parentNumber !== null) {
      const parent = this.store.get(todo.parentNumber);
      if (parent) {
        this.event(parent, `Sub-to-do ${todo.ref} done: ${todo.title}`);
        this.progress(parent);
      }
    } else {
      this.notifyRequester(done, 'done');
    }
    this.changed();
    return done;
  }

  drop(number: number, options: { reason?: string }, actor: TodoActor): TodoRecord {
    const todo = this.require(number);
    this.requireOpen(todo, 'dropped');
    const dropped = this.store.update(number, { state: 'dropped', closedAt: this.now(), loadHold: null, loadHoldSince: null }, this.now());
    this.event(dropped, `Dropped by ${this.actorName(actor)}${options.reason ? `: ${options.reason}` : ''}`, actor.kind === 'person' ? 'person' : 'agent', this.actorName(actor));
    if (todo.parentNumber === null) {
      this.notifyRequester(dropped, 'dropped');
      const orchestrator = this.orchestratorOf(todo);
      if (orchestrator && MOVING_TODO_STATES.includes(todo.state) && actor.kind === 'person') this.enqueue({ panelId: orchestrator, text: personMessageText(todo, `Dropped ${todo.ref}${options.reason ? `: ${options.reason}` : ''}. Stop work on it after your current step.`), todoNumber: number, resumeIfDown: false });
    } else {
      const parent = this.store.get(todo.parentNumber);
      if (parent) this.event(parent, `Sub-to-do ${todo.ref} dropped`);
    }
    this.changed();
    return dropped;
  }

  /** Archive: the to-do's own Session's Panes, with Pane archive's checks. Skips and names what's at risk. */
  async archive(number: number, actor: TodoActor): Promise<{ archived: string[]; kept: Array<{ name: string; reason: string }>; sessionArchived: boolean }> {
    const todo = this.require(number);
    if (isOpenTodoState(todo.state) && todo.state !== 'accepted') {
      throw new PaneError('ERR_TODO_ARCHIVE_OPEN', `${todo.ref} is still open, so its Panes weren't archived.`, `Mark it done or drop it first (runpane todos done ${todo.ref} or drop ${todo.ref}).`);
    }
    if (todo.parentNumber !== null || !todo.sessionId) {
      this.event(todo, 'Nothing to archive: a sub-to-do’s Panes belong to its parent’s Session.');
      return { archived: [], kept: [], sessionArchived: false };
    }
    const result = await this.host.archiveSessionPanes(todo.sessionId);
    const kept = result.kept.map(pane => `${pane.name}: ${pane.reason}`).join('; ');
    this.event(todo, `Archived ${result.archived.length} Pane${result.archived.length === 1 ? '' : 's'}.${kept ? ` Kept ${kept}.` : ''}${result.sessionArchived ? ' The Session is archived.' : ''}`, actor.kind === 'person' ? 'person' : 'agent', this.actorName(actor));
    this.changed();
    return result;
  }

  async reopen(number: number, actor: TodoActor): Promise<TodoRecord> {
    const todo = this.require(number);
    if (todo.sessionId && todo.parentNumber === null) await this.host.restoreSession(todo.sessionId);
    const reopened = this.store.update(number, { state: 'stopped', closedAt: null }, this.now());
    this.event(reopened, `Reopened by ${this.actorName(actor)}. Press Resume to carry it on.`, actor.kind === 'person' ? 'person' : 'agent', this.actorName(actor));
    this.changed();
    return reopened;
  }

  private notifyRequester(todo: TodoRecord, update: RequesterUpdate): void {
    if (todo.parentNumber !== null || todo.requester.kind !== 'orchestrator') return;
    const session = todo.requester.sessionId ? this.host.session(todo.requester.sessionId) : null;
    if (!session || session.archived) return;
    const tab = todo.requester.panelId ?? session.orchestratorPanelId;
    if (tab) this.enqueue({ panelId: tab, text: requesterUpdateText(todo, update), todoNumber: todo.number, resumeIfDown: false });
  }

  /**
   * Before an agent start (panes create, panels create, agents start): refused with machine_busy
   * while the gate holds when the caller works in a to-do's Session or names a to-do. Returns how
   * to assign the new tab to the named to-do once it exists.
   */
  beforeAgentStart(callerPanelId: string | undefined, todoArg: string | undefined): { assign: (panelId: string) => void } | undefined {
    const number = todoArg ? parseTodoRef(todoArg) : null;
    if (todoArg && (number === null || !this.store.get(number))) throw notFound(todoArg);
    const sessionId = callerPanelId ? this.host.panel(callerPanelId)?.sessionId ?? null : null;
    this.checkAgentStart(sessionId, number, callerPanelId ?? null);
    if (number === null) return undefined;
    return {
      assign: panelId => {
        try {
          this.assign(number, panelId, { kind: 'agent', panelId: callerPanelId });
        } catch (error) {
          this.host.log(`[Todos] assigning ${todoRef(number)} failed`, error instanceof Error ? error : String(error));
        }
      },
    };
  }

  /** `agents start --todo T-n` and agent starts from a to-do's Session: refused while the gate holds. */
  checkAgentStart(sessionId: string | null, todoNumber: number | null, callerPanelId: string | null): void {
    const inTodoSession = sessionId !== null && this.store.inSession(sessionId).some(todo => isOpenTodoState(todo.state));
    if (!inTodoSession && todoNumber === null) return;
    if (this.gate.allowsStart()) return;
    if (todoNumber !== null) {
      const todo = this.store.get(todoNumber);
      if (todo && isOpenTodoState(todo.state)) this.store.update(todoNumber, { loadHold: 'queued', loadHoldSince: this.now(), state: todo.state === 'todo' ? 'in_progress' : todo.state }, this.now());
      this.changed();
    }
    if (callerPanelId) this.busyRefused.add(callerPanelId);
    const line = this.gate.line(this.host.machineName(), this.now()) ?? `${this.host.machineName()} is busy`;
    throw new PaneError('ERR_MACHINE_BUSY', `machine_busy: ${line}, so Pane is holding new agents for to-dos. No agent was started.`, 'Wait: Pane types "Capacity is back" into your tab when load comes down, then start it again.');
  }

  // ── Delivery ────────────────────────────────────────────────────────────

  private enqueue(entry: OutboxEntry): void {
    this.outbox.push(entry);
  }

  /** Types queued messages into tabs that are idle with no unsent text; leaves the rest queued. */
  async flush(): Promise<void> {
    if (this.flushing) {
      // A flush asked for while one runs waits for it, then runs once more.
      this.flushAgain ??= this.flushing.then(() => {
        this.flushAgain = null;
        return this.flush();
      });
      return this.flushAgain;
    }
    this.flushing = this.flushOnce();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }

  private async flushOnce(): Promise<void> {
    const tried = new Set<string>();
    for (const entry of [...this.outbox]) {
      if (tried.has(entry.panelId)) continue;
      tried.add(entry.panelId);
      if (await this.host.isPanelDown(entry.panelId)) {
        if (!entry.resumeIfDown || !this.gate.allowsStart()) continue;
        // Resume before delivery: the asker's tab is down after a restart.
        await this.host.resumePanel(entry.panelId);
        continue;
      }
      if (this.host.isMidTurn(entry.panelId) || await this.host.hasUnsentText(entry.panelId)) continue;
      const result = await this.host.typeIntoTab(entry.panelId, entry.text);
      if (result === 'busy') continue;
      this.outbox.splice(this.outbox.indexOf(entry), 1);
      if (entry.activityId !== undefined && result === 'delivered') this.store.markDelivered(entry.activityId, this.now());
      if (result !== 'delivered') {
        const todo = this.store.get(entry.todoNumber);
        if (todo) this.event(todo, `Couldn't reach ${this.host.panel(entry.panelId)?.name ?? 'the tab'}: ${result === 'gone' ? 'its tab closed' : 'it takes no typed messages'}`);
      }
      if (entry.activityId !== undefined) this.changed();
    }
  }

  /** Undelivered messages waiting on a tab, for tests and the page. */
  queuedFor(panelId: string): string[] {
    return this.outbox.filter(entry => entry.panelId === panelId).map(entry => entry.text);
  }

  // ── Timers ──────────────────────────────────────────────────────────────

  private trackedTabs(open: readonly TodoRecord[]): Set<string> {
    const tabs = new Set<string>();
    for (const todo of open) {
      const tab = workingTabOf(todo, this.orchestratorOf(todo.parentNumber !== null ? this.store.get(todo.parentNumber) ?? todo : todo));
      if (tab) tabs.add(tab);
      const orchestrator = this.orchestratorOf(todo);
      if (orchestrator) tabs.add(orchestrator);
    }
    return tabs;
  }

  /** Every 2 s: settle mid-turn into Working, count work time, deliver, and announce status changes. */
  async fastTick(): Promise<void> {
    const now = this.now();
    const elapsed = this.lastFastTick === 0 ? 0 : Math.min(now - this.lastFastTick, 10_000);
    this.lastFastTick = now;
    const open = this.store.listOpen();
    const tabs = this.trackedTabs(open);
    for (const tab of tabs) {
      const raw = this.host.isMidTurn(tab);
      const seen = this.activity.get(tab) ?? { since: null, lastSeen: null };
      if (raw) {
        seen.since ??= now;
        seen.lastSeen = now;
        if (now - seen.since >= SETTLE_MS) this.settled.add(tab);
      } else {
        seen.since = null;
        if (seen.lastSeen === null || now - seen.lastSeen >= SETTLE_MS) this.settled.delete(tab);
      }
      this.activity.set(tab, seen);
    }
    for (const tab of [...this.activity.keys()]) if (!tabs.has(tab)) { this.activity.delete(tab); this.settled.delete(tab); }
    for (const todo of open) {
      if (todo.state !== 'in_progress' || elapsed === 0) continue;
      const tab = workingTabOf(todo, this.orchestratorOf(todo.parentNumber !== null ? this.store.get(todo.parentNumber) ?? todo : todo));
      if (tab && this.host.isMidTurn(tab)) this.pendingWork.set(todo.number, (this.pendingWork.get(todo.number) ?? 0) + elapsed);
    }
    await this.flush();
    const digest = open.map(todo => `${todo.number}:${todo.updatedAt}`).join(',') + '|' + [...this.settled].sort().join(',') + '|' + this.gate.state;
    if (digest !== this.statusDigest) {
      this.statusDigest = digest;
      this.changed();
    }
  }

  /** Every 10 s while a to-do is in progress or queued: read load and act on the gate. */
  async loadTick(): Promise<void> {
    const open = this.store.listOpen();
    const active = open.some(todo => MOVING_TODO_STATES.includes(todo.state) || todo.loadHold !== null);
    const now = this.now();
    if (!active) {
      this.gate.forgetSamples();
      return;
    }
    if (now - this.lastSampleAt < LOAD_GATE.sampleEveryMs - 500) return;
    this.lastSampleAt = now;
    const sample = await this.host.sampleLoad();
    const change = this.gate.record({ at: now, ...sample });
    if (change) {
      this.host.log(`[Todos] load gate ${change.from} → ${change.to}: ${change.why}`);
      if (change.to === 'normal') {
        for (const tab of this.busyRefused) this.enqueue({ panelId: tab, text: capacityBackText(this.host.machineName()), todoNumber: 0, resumeIfDown: false });
        this.busyRefused.clear();
      }
      this.changed();
    }
    await this.applyGate(open, now);
  }

  private async applyGate(open: readonly TodoRecord[], now: number): Promise<void> {
    // Paused ones resume first, oldest paused first; then queued starts, first in first out.
    const paused = open.filter(todo => todo.loadHold === 'paused').sort((a, b) => (a.loadHoldSince ?? 0) - (b.loadHoldSince ?? 0));
    const queued = open.filter(todo => todo.loadHold === 'queued').sort((a, b) => (a.loadHoldSince ?? 0) - (b.loadHoldSince ?? 0));
    if (paused.length > 0 && this.gate.mayResumePaused(now)) {
      this.gate.noteResume(now);
      await this.resumeFromLoad(paused[0]);
    } else if (paused.length === 0 && queued.length > 0 && this.gate.mayStartQueued(now)) {
      this.gate.noteQueuedStart(now);
      const next = queued[0];
      this.store.update(next.number, { loadHold: null, loadHoldSince: null }, now);
      try {
        await this.launch(next.number, null);
        this.event(next, 'Load came down: started');
      } catch (error) {
        this.host.log(`[Todos] ${next.ref} start failed`, error instanceof Error ? error : String(error));
      }
      this.changed();
    }
    if (this.gate.mayShed(now)) await this.shedOne(open, now);
    await this.finishShedding(now);
  }

  private async resumeFromLoad(todo: TodoRecord): Promise<void> {
    const tabs = this.tabsOf(todo);
    for (const tab of tabs) if (await this.host.isPanelDown(tab)) await this.host.resumePanel(tab);
    this.store.update(todo.number, { loadHold: null, loadHoldSince: null, lastProgressAt: this.now() }, this.now());
    const orchestrator = this.orchestratorOf(todo);
    if (orchestrator) this.enqueue({ panelId: orchestrator, text: restartText([{ todo, groups: this.attachmentGroups(todo) }], 'load'), todoNumber: todo.number, resumeIfDown: true });
    this.event(todo, 'Load came down: resumed in the same conversations');
    this.changed();
  }

  private async liveTabs(tabs: readonly string[]): Promise<string[]> {
    const down = await Promise.all(tabs.map(tab => this.host.isPanelDown(tab)));
    return tabs.filter((_, index) => !down[index]);
  }

  /** The tabs a to-do runs: its orchestrator (top-level), its assignee, and its open sub-to-dos' assignees. */
  private tabsOf(todo: TodoRecord): string[] {
    const tabs = new Set<string>();
    if (todo.parentNumber === null) {
      const orchestrator = this.orchestratorOf(todo);
      if (orchestrator) tabs.add(orchestrator);
    }
    if (todo.assignee) tabs.add(todo.assignee.panelId);
    for (const child of this.store.children(todo.number)) if (isOpenTodoState(child.state) && child.assignee) tabs.add(child.assignee.panelId);
    return [...tabs];
  }

  private async shedOne(open: readonly TodoRecord[], now: number): Promise<void> {
    const waiting = this.waitingByTodo();
    const running = open.filter(todo => todo.parentNumber === null && MOVING_TODO_STATES.includes(todo.state) && todo.loadHold === null && todo.sessionId !== null);
    const candidates = await Promise.all(running.map(async todo => {
      const tabs = this.tabsOf(todo);
      const unsent = (await Promise.all(tabs.map(tab => this.host.hasUnsentText(tab)))).some(Boolean);
      const children = this.store.children(todo.number);
      return {
        number: todo.number, startedAt: todo.startedAt ?? 0, neverPause: todo.loadOverride === 'never_pause',
        waitingOnYou: (waiting.get(todo.number)?.length ?? 0) > 0 || children.some(child => (waiting.get(child.number)?.length ?? 0) > 0),
        protectedTab: unsent || tabs.some(tab => this.host.isPanelProtected(tab)),
      };
    }));
    const target = pickShedTarget(candidates);
    if (target === null) return;
    this.gate.noteShed(now);
    const todo = this.require(target);
    const orchestrator = this.orchestratorOf(todo);
    if (orchestrator) this.enqueue({ panelId: orchestrator, text: shedText(todo), todoNumber: target, resumeIfDown: false });
    this.shedAsked.set(target, now);
    this.store.update(target, { loadHold: 'paused', loadHoldSince: now }, now);
    this.event(todo, 'Pausing for machine load: the orchestrator finishes its step, then its tabs pause with their conversations kept');
    this.changed();
  }

  /** Pauses a shed to-do's tabs once they are idle, or after 10 minutes at most. */
  private async finishShedding(now: number): Promise<void> {
    for (const [number] of [...this.shedAsked]) {
      const todo = this.store.get(number);
      if (!todo) {
        this.shedAsked.delete(number);
        continue;
      }
      const askedAt = this.shedAsked.get(todo.number);
      if (askedAt === undefined || todo.loadHold !== 'paused') {
        this.shedAsked.delete(todo.number);
        continue;
      }
      const tabs = await this.liveTabs(this.tabsOf(todo));
      const idle = tabs.every(tab => !this.host.isMidTurn(tab)) && this.queuedFor(this.orchestratorOf(todo) ?? '').length === 0;
      const unsent = (await Promise.all(tabs.map(tab => this.host.hasUnsentText(tab)))).some(Boolean);
      if (unsent) continue;
      if (idle || now - askedAt >= LOAD_GATE.shedGraceMs) {
        await this.host.pausePanels(tabs);
        this.shedAsked.delete(todo.number);
        this.event(todo, 'Paused for load · resumes when load comes down');
        this.changed();
      }
    }
  }

  // ── The supervisor ──────────────────────────────────────────────────────

  private machineCounts(now: number): SupervisorInputs['machine'] {
    while (this.ladderLog.length > 0 && this.ladderLog[0].at < now - HOUR) this.ladderLog.shift();
    return { remindersLastHour: this.ladderLog.filter(entry => entry.kind === 'reminder').length, restartsLastHour: this.ladderLog.filter(entry => entry.kind === 'restart').length };
  }

  /** Once a minute: keep every in-progress and accepted to-do moving (P6). */
  async supervisorPass(): Promise<void> {
    const now = this.now();
    if (now - this.lastSupervisorPass < SUPERVISOR.passEveryMs - 1000) return;
    this.lastSupervisorPass = now;
    for (const [number, ms] of this.pendingWork) {
      const todo = this.store.get(number);
      if (todo) this.store.update(number, { workMs: todo.workMs + ms }, todo.updatedAt);
    }
    this.pendingWork.clear();
    const waiting = this.waitingByTodo();
    const open = this.store.listOpen();
    const children = this.childrenIndex(open);
    let moving = false;
    for (const todo of open) {
      if (todo.parentNumber !== null) continue;
      moving ||= MOVING_TODO_STATES.includes(todo.state);
      try {
        await this.superviseOne(todo, (children.get(todo.number) ?? []).filter(child => isOpenTodoState(child.state)), waiting, now);
      } catch (error) {
        this.host.log(`[Todos] supervisor failed on ${todo.ref}`, error instanceof Error ? error : String(error));
      }
    }
    // "quiet 12m" moves on every minute.
    if (moving) this.changed();
  }

  private async superviseOne(todo: TodoRecord, children: readonly TodoRecord[], waiting: Map<number, LinkedApproval[]>, now: number): Promise<void> {
    // Cheap checks first: most to-dos are skipped here without reading a tab.
    if (!MOVING_TODO_STATES.includes(todo.state) || todo.loadHold !== null || todo.stuckCardId !== null || !todo.sessionId) return;
    const waitingOnYou = (waiting.get(todo.number)?.length ?? 0) > 0 || children.some(child => (waiting.get(child.number)?.length ?? 0) > 0);
    if (waitingOnYou) return;
    const orchestrator = this.orchestratorOf(todo);
    if (!orchestrator) return;
    const tabs = [orchestrator, ...(todo.assignee ? [todo.assignee.panelId] : []), ...children.flatMap(child => (child.assignee ? [child.assignee.panelId] : []))];
    if (tabs.some(tab => this.host.isMidTurn(tab))) return;
    const usage = this.host.usageLimitUntil(orchestrator);
    if (usage !== null && usage > now) {
      this.usageLimited.add(todo.number);
      return;
    }
    if (this.usageLimited.delete(todo.number)) {
      // At the reset, one reminder.
      this.enqueue({ panelId: orchestrator, text: reminderText(todo, Math.round((now - lastMovedAt(todo, null)) / MINUTE)), todoNumber: todo.number, resumeIfDown: true });
      this.store.update(todo.number, { lastProgressAt: now }, now);
      this.event(todo, 'Usage limit reset: Pane reminded the orchestrator');
      return;
    }
    const quietFor = now - lastMovedAt(todo, null);
    const mayRemindToAttach = todo.state === 'in_progress' && todo.attachRemindedAt === null && todo.workMs >= SUPERVISOR.attachReminderWorkMs;
    const inputs: SupervisorInputs = {
      todo, now, waitingOnYou: false, anyMidTurn: false, unsentText: false, usageLimitUntil: usage, offline: false,
      // A dead or hung tab is looked for only once it has been quiet for the hung window.
      orchestratorDown: quietFor >= SUPERVISOR.hungMs ? await this.host.isPanelDown(orchestrator) : false,
      externalProgressAt: null, lastRestartAt: this.lastRestartAt.get(todo.number) ?? null,
      machine: this.machineCounts(now), gateAllowsStart: this.gate.allowsStart(), hasAttachments: mayRemindToAttach ? this.attachmentCount(todo) > 0 : true,
    };
    let action = decideSupervisorAction(inputs);
    // Your unsent text is read only when Pane would type: it then waits.
    if ((action.kind === 'remind' || action.kind === 'restart' || action.kind === 'attach_reminder') && await this.host.hasUnsentText(orchestrator)) {
      action = decideSupervisorAction({ ...inputs, unsentText: true });
    }
    const quietMinutes = Math.round((now - lastMovedAt(todo, null)) / MINUTE);
    const newEpisode = todo.stuckSince === null && action.kind !== 'none' && action.kind !== 'attach_reminder';
    const day = dayOf(now);
    const stalls: TodoPatch = newEpisode ? { stuckSince: now, stallsToday: todo.stallsDay === day ? todo.stallsToday + 1 : 1, stallsDay: day } : {};
    switch (action.kind) {
      case 'none':
        return;
      case 'attach_reminder':
        this.ladderLog.push({ at: now, kind: 'reminder' });
        this.enqueue({ panelId: orchestrator, text: attachReminderText(todo), todoNumber: todo.number, resumeIfDown: false });
        this.store.update(todo.number, { attachRemindedAt: now }, todo.updatedAt);
        this.event(todo, 'Pane reminded the orchestrator to attach its plan, PR, findings or decision pages');
        break;
      case 'remind':
        this.ladderLog.push({ at: now, kind: 'reminder' });
        this.enqueue({ panelId: orchestrator, text: reminderText(todo, quietMinutes), todoNumber: todo.number, resumeIfDown: false });
        this.store.update(todo.number, { ...stalls, episodeReminders: todo.episodeReminders + 1 }, todo.updatedAt);
        this.event(todo, `Quiet ${quietMinutes}m: Pane reminded the orchestrator (${action.rung} of 2)`);
        break;
      case 'restart':
        this.ladderLog.push({ at: now, kind: 'restart' });
        this.lastRestartAt.set(todo.number, now);
        this.store.update(todo.number, { ...stalls, episodeRestarts: todo.episodeRestarts + 1 }, todo.updatedAt);
        await this.host.resumePanel(orchestrator);
        this.enqueue({ panelId: orchestrator, text: reminderText(todo, quietMinutes, true), todoNumber: todo.number, resumeIfDown: true });
        this.event(todo, action.why === 'down' ? 'The orchestrator was down or hung: Pane restarted it in its same conversation' : `Quiet ${quietMinutes}m: Pane restarted the orchestrator in its same conversation`);
        break;
      case 'queue_restart':
        this.store.update(todo.number, { ...stalls, loadHold: 'queued', loadHoldSince: now }, todo.updatedAt);
        this.event(todo, 'Restart queued: the machine is busy');
        break;
      case 'card': {
        const id = randomUUID();
        this.store.update(todo.number, { ...stalls, stuckCardId: id }, todo.updatedAt);
        const title = stuckCardText(todo, quietMinutes);
        this.event(todo, `Stuck: Pane asked you what to do${action.why === 'repeat' ? ' (stuck 3 times today)' : action.why !== 'ladder' ? ' (machine limit reached)' : ''}`);
        this.notifyRequester(todo, 'stuck');
        void this.host.ask({ id, title, choices: ['Restart its agents', 'Stop it', "I'll look"], todo, kind: 'stuck' })
          .then(result => this.onStuckAnswered(todo.number, result))
          .catch(error => this.host.log(`[Todos] ${todo.ref} stuck card failed`, error));
        break;
      }
    }
    this.changed();
  }

  private async onStuckAnswered(number: number, result: NotifyResult): Promise<void> {
    const todo = this.store.get(number);
    if (!todo) return;
    const pick = 'answer' in result ? result.answer : 'reply' in result ? result.picks?.[0] ?? result.reply : null;
    this.progress(todo, { stuckCardId: null });
    if (pick === 'Stop it') {
      this.stop(number, { kind: 'person' });
      return;
    }
    if (pick === 'Restart its agents') {
      for (const tab of this.tabsOf(todo)) await this.host.resumePanel(tab);
      const orchestrator = this.orchestratorOf(todo);
      if (orchestrator) this.enqueue({ panelId: orchestrator, text: restartText([{ todo, groups: this.attachmentGroups(todo) }], 'supervisor'), todoNumber: number, resumeIfDown: true });
      this.event(todo, 'You restarted its agents', 'person', 'you');
    } else if (pick) {
      this.event(todo, `You answered the stuck card: ${pick}`, 'person', 'you');
    }
    this.changed();
  }

  // ── Launch resume ───────────────────────────────────────────────────────

  /**
   * When Pane starts (or wakes): restart the orchestrators and assigned tabs of every in-progress or
   * accepted to-do, in their same conversations, three at a time and only as the gate allows.
   * Waiting, stopped and to-do items stay down. Re-raises a review that lost its card.
   */
  async resumeOnLaunch(why: 'launch' | 'wake' = 'launch'): Promise<{ restarted: number; queued: number }> {
    const now = this.now();
    const waiting = this.waitingByTodo();
    const top = this.store.listOpen().filter(todo => todo.parentNumber === null && todo.sessionId !== null);
    for (const todo of top) {
      if (todo.stuckCardId && !(waiting.get(todo.number) ?? []).some(approval => approval.id === todo.stuckCardId)) this.store.update(todo.number, { stuckCardId: null }, todo.updatedAt);
      if (todo.state === 'in_review' && (waiting.get(todo.number)?.length ?? 0) === 0 && why === 'launch') {
        this.store.update(todo.number, { state: 'in_progress' }, now);
        await this.review(todo.number, { noAttachments: 're-raised after Pane restarted' }, { kind: 'agent' }).catch(error => this.host.log('[Todos] review re-raise failed', error));
      }
    }
    const due = this.store.listOpen().filter(todo => todo.parentNumber === null && todo.sessionId !== null && MOVING_TODO_STATES.includes(todo.state) && todo.loadHold === null
      && (waiting.get(todo.number)?.length ?? 0) === 0 && !this.store.children(todo.number).some(child => (waiting.get(child.number)?.length ?? 0) > 0));
    const bySession = new Map<string, TodoRecord[]>();
    for (const todo of due) if (todo.sessionId) bySession.set(todo.sessionId, [...(bySession.get(todo.sessionId) ?? []), todo]);
    let restarted = 0;
    let queued = 0;
    const jobs: Array<() => Promise<void>> = [];
    for (const [, todos] of bySession) {
      const orchestrator = this.orchestratorOf(todos[0]);
      if (!orchestrator) continue;
      const all = [orchestrator, ...todos.flatMap(todo => this.tabsOf(todo))].filter((tab, index, list) => list.indexOf(tab) === index);
      const live = new Set(await this.liveTabs(all));
      const needed = all.filter(tab => !live.has(tab));
      if (needed.length === 0) continue;
      if (!this.gate.allowsStart()) {
        for (const todo of todos) this.store.update(todo.number, { loadHold: 'queued', loadHoldSince: now }, todo.updatedAt);
        queued += todos.length;
        continue;
      }
      if (this.machineCounts(now).restartsLastHour >= SUPERVISOR.perMachineHour.restarts) {
        for (const todo of todos) this.event(todo, 'Not restarted: Pane already restarted 4 agents this hour');
        continue;
      }
      for (const tab of needed) {
        jobs.push(async () => {
          await this.host.resumePanel(tab);
          restarted += 1;
        });
      }
      this.ladderLog.push({ at: now, kind: 'restart' });
      this.enqueue({ panelId: orchestrator, text: restartText(todos.map(todo => ({ todo, groups: this.attachmentGroups(todo) })), 'launch'), todoNumber: todos[0].number, resumeIfDown: true });
      for (const todo of todos) {
        this.store.update(todo.number, { lastProgressAt: now }, todo.updatedAt);
        this.event(todo, why === 'launch' ? 'Pane restarted: its agents were restarted in their same conversations' : 'Pane woke: its stopped agents were restarted');
      }
    }
    // Three at a time.
    for (let index = 0; index < jobs.length; index += 3) {
      await Promise.all(jobs.slice(index, index + 3).map(job => job().catch(error => this.host.log('[Todos] launch resume failed', error))));
    }
    this.changed();
    return { restarted, queued };
  }

  /** Retention: closed to-dos go 30 days after closing. */
  prune(): void {
    this.store.pruneClosed(this.now());
  }
}
