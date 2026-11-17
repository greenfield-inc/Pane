/**
 * To-dos (D-408, D-409): one list of agent work that keeps itself moving. Rows live in the host
 * machine's sessions.db (todos, todo_attachments, todo_activity, approvals.todo_id). The status the
 * person sees (Waiting on you, Working, Queued, Idle) is never stored: Pane works it out from these
 * rows, the to-do's approvals, the load gate's hold and whether its agent is mid-turn.
 */

/** The stored lifecycle state. */
export const TODO_STATES = ['todo', 'in_progress', 'in_review', 'accepted', 'stopped', 'done', 'dropped'] as const;
export type TodoState = typeof TODO_STATES[number];

/** States that keep a to-do in the Open list. */
export const OPEN_TODO_STATES: readonly TodoState[] = ['todo', 'in_progress', 'in_review', 'accepted', 'stopped'];
/** States the supervisor keeps moving. */
export const MOVING_TODO_STATES: readonly TodoState[] = ['in_progress', 'accepted'];

export function isOpenTodoState(state: TodoState): boolean {
  return OPEN_TODO_STATES.includes(state);
}

/** The status shown on every surface, worked out each time. */
export type TodoShownStatus = 'waiting' | 'working' | 'queued' | 'idle' | 'done' | 'dropped';

/** Why an open to-do reads Idle. */
export type TodoIdleReason = 'not_started' | 'stopped' | 'usage_limit' | 'offline' | 'quiet' | 'between_turns' | 'in_review';

export interface TodoStatus {
  status: TodoShownStatus;
  /** The words after the title, e.g. "devbox is busy · starts when load comes down". Empty for Working. */
  reason: string;
  idleReason?: TodoIdleReason;
  /** Shown in red: the to-do is quiet and Pane is acting on it. */
  alert?: boolean;
  /** For Waiting on you: the approval it waits on (the first, oldest). */
  waitingApprovalId?: string;
  waitingQuestion?: string;
  waitingQn?: string;
  /** How many approvals are waiting on this to-do and its open sub-to-dos. */
  waitingCount?: number;
}

export const TODO_ATTACHMENT_KINDS = ['plan', 'mockup', 'design', 'pr', 'findings', 'decision', 'doc', 'image', 'link', 'status', 'checklist'] as const;
export type TodoAttachmentKind = typeof TODO_ATTACHMENT_KINDS[number];

/** How an attachment came: attached by hand or command, or one Pane attached on its own. */
export type TodoAttachmentSource = 'attached' | 'pr' | 'approval' | 'opened';

export interface TodoAttachment {
  id: number;
  todoNumber: number;
  kind: TodoAttachmentKind;
  /** A file path on `machine`, or a URL. */
  target: string;
  /** The machine the file is on; absent for a URL. */
  machine?: string;
  label: string;
  note?: string;
  /** "you", an agent's name, or "Pane". */
  addedBy: string;
  addedByTab?: string;
  source: TodoAttachmentSource;
  addedAt: number;
  removedAt?: number;
}

/** An attachment as a to-do's page shows it: its own, or inherited from its parent or a sub-to-do. */
export interface TodoAttachmentGroup {
  /** Absent for the to-do's own; the to-do it comes from otherwise. */
  from?: { number: number; relation: 'parent' | 'sub' };
  attachments: TodoAttachment[];
}

export type TodoAuthorKind = 'person' | 'agent' | 'requester' | 'pane';

export interface TodoActivity {
  id: number;
  todoNumber: number;
  kind: 'message' | 'event';
  authorKind: TodoAuthorKind;
  authorName: string;
  authorTab?: string;
  /** Markdown for a message; the event's words otherwise. */
  body: string;
  /** The chat tab and turn that wrote an agent's reply. */
  chatRef?: { panelId: string; messageId?: string };
  /** For a message sent to an agent: the tab it was sent to, and when it arrived. */
  toTab?: string;
  toName?: string;
  deliveredAt?: number;
  /** The activity row this one answers (round 7): your reply under a card, or an agent's answer under your reply. */
  replyTo?: number;
  createdAt: number;
}

export interface TodoRequester {
  kind: 'person' | 'orchestrator';
  sessionId?: string;
  panelId?: string;
  /** "you", or the requesting Session's name ("UI/UX improvements orchestrator"). */
  name: string;
  /** The requesting Session was archived or deleted. */
  gone?: boolean;
}

export interface TodoDoneWhenItem {
  text: string;
  met: boolean;
}

export type TodoLoadHold = 'queued' | 'paused';

/** A to-do as stored, with what the list and page need around it. */
export interface TodoRecord {
  number: number;
  /** "T-12". */
  ref: string;
  sessionId: string | null;
  parentNumber: number | null;
  title: string;
  summary: string;
  doneWhen: TodoDoneWhenItem[];
  state: TodoState;
  requester: TodoRequester;
  projectId: number | null;
  /** The agent its orchestrator runs (an agent id from the contract), when chosen. */
  agent: string | null;
  /** The tab doing the work; null means the Session's orchestrator. */
  assignee: { panelId: string; paneId?: string; name?: string } | null;
  createdBy: string;
  createdAt: number;
  startedAt: number | null;
  updatedAt: number;
  acceptedAt: number | null;
  closedAt: number | null;
  lastProgressAt: number | null;
  stuckSince: number | null;
  episodeReminders: number;
  episodeRestarts: number;
  stallsToday: number;
  stallsDay: string | null;
  attachRemindedAt: number | null;
  /** Agent mid-turn time while in progress, for the attachment reminder. */
  workMs: number;
  loadHold: TodoLoadHold | null;
  loadHoldSince: number | null;
  loadOverride: 'never_pause' | null;
  /** Set by Pane when the stuck card was raised; cleared by progress. */
  stuckCardId: string | null;
}

export function todoRef(number: number): string {
  return `T-${number}`;
}

/** "T-12", "t12", "12" → 12. */
export function parseTodoRef(value: string): number | null {
  const match = /^\s*(?:t-?)?(\d+)\s*$/i.exec(value);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** One to-do as a list row shows it. */
export interface TodoListRow {
  todo: TodoRecord;
  status: TodoStatus;
  /** The to-do's own Session's display name, or the parent's for a sub-to-do. */
  sessionName?: string;
  /** The repo's name. */
  projectName?: string;
  /** The machine it runs on, as the list groups it. */
  machine: string;
  machineId?: string;
  /** Sub-to-dos: done count / total. */
  subCounts?: { done: number; total: number };
  /** A PR found on an assigned or Session Pane: "#1390 · CI running". */
  pr?: { number?: number; label: string; url?: string };
  /** Unread agent replies. */
  unread?: number;
  /** The agent of its working tab, for the agent dot. */
  agentId?: string;
}

/** Everything one to-do's page shows. */
export interface TodoDetail extends TodoListRow {
  subTodos: TodoListRow[];
  parent?: TodoListRow;
  attachments: TodoAttachmentGroup[];
  activity: TodoActivity[];
  /** Approvals linked to it (and its sub-to-dos), as ids, for chat cards. */
  approvalIds: string[];
  /** Who its chat goes to now. */
  chatTarget: { panelId: string | null; name: string; kind: 'orchestrator' | 'assignee' };
  orchestrator?: { panelId: string; name: string; agentId?: string };
  load: { gate: LoadGateState; canPause: boolean; reason?: string };
  keepMoving: string;
}

export type LoadGateState = 'normal' | 'holding' | 'shedding';

export interface LoadGateSnapshot {
  state: LoadGateState;
  enabled: boolean;
  /** "This Mac is busy: memory pressure high for 3 min". */
  line?: string;
  since: number;
  cpuPercent?: number;
  memoryPressure?: 'ok' | 'warning' | 'critical' | 'unknown';
}

/** What the To-dos screen reads: every to-do on this machine. */
export interface TodosSnapshot {
  rows: TodoListRow[];
  gate: LoadGateSnapshot;
  machine: string;
  /** Sessions that belong to a top-level to-do: kept out of the sidebar, All machines and Mod+1–9. */
  ownSessionIds: string[];
}

/** Inputs the person sends from the New to-do dialog. */
export interface TodoCreateInput {
  title: string;
  summary?: string;
  doneWhen?: string[];
  subTodos?: string[];
  projectId?: number | null;
  agent?: string | null;
  startNow?: boolean;
  parentNumber?: number | null;
  attach?: Array<{ target: string; kind?: TodoAttachmentKind; label?: string; note?: string }>;
}

export const TODO_AGENT_REPLY_MAX = 2000;

// ── The person's actions from the To-dos screens (app channel `todos:act`) ────

export type TodoAction =
  | { kind: 'start'; number: number; anyway?: boolean }
  | { kind: 'stop'; number: number }
  | { kind: 'resume'; number: number }
  | { kind: 'done'; number: number }
  | { kind: 'drop'; number: number; reason?: string }
  | { kind: 'archive'; number: number }
  | { kind: 'reopen'; number: number }
  | { kind: 'never-pause'; number: number; on: boolean }
  /** A comment, or with `replyTo` a reply under that card, typed to the card's author (round 7). */
  | { kind: 'comment'; number: number; body: string; toOrchestrator?: boolean; replyTo?: number }
  | { kind: 'attach'; number: number; target: string; label?: string; attachmentKind?: TodoAttachmentKind }
  | { kind: 'detach'; number: number; attachmentId: number }
  | { kind: 'check'; number: number; index: number; met: boolean }
  | { kind: 'rename'; number: number; title: string };

/** What `todos:act` resolves with: the to-do after the action, and a line for archive's result. */
export interface TodoActionResult {
  todo: TodoRecord;
  message?: string;
}

// ── `runpane todos …` over the daemon (channels `runpane:todos:<verb>`) ──────

/** Every runpane todos request may name the calling tab, as `panes create` does. */
export interface RunpaneTodoCaller {
  callerPanelId?: string;
}

export interface RunpaneTodoCreateRequest extends RunpaneTodoCaller {
  title: string;
  summary?: string;
  doneWhen?: string[];
  /** "T-12": makes a sub-to-do in T-12's Session. */
  parent?: string;
  /** A repo: its name or id from runpane repos list. */
  project?: string;
  agent?: string;
  /** Files or URLs to attach at once. */
  attach?: string[];
  /** Default true: start it now (its own Session and orchestrator), through the load gate. */
  start?: boolean;
}

export interface RunpaneTodoRefRequest extends RunpaneTodoCaller {
  /** "T-12" or "12". */
  todo: string;
}

export interface RunpaneTodoUpdateRequest extends RunpaneTodoRefRequest {
  title?: string;
  summary?: string;
  /** Replaces the done-when list; unchanged lines keep their checks. */
  doneWhen?: string[];
  /** 1-based done-when lines to mark met or unmet. */
  check?: number[];
  uncheck?: number[];
}

export interface RunpaneTodoAttachRequest extends RunpaneTodoRefRequest {
  target: string;
  kind?: string;
  label?: string;
  note?: string;
}

export interface RunpaneTodoDetachRequest extends RunpaneTodoRefRequest {
  attachment: number;
}

export interface RunpaneTodoListRequest {
  /** Include done and dropped to-dos from the last 7 days. */
  all?: boolean;
}

export interface RunpaneTodoAssignRequest extends RunpaneTodoRefRequest {
  /** A tab id; absent hands it back to the Session's orchestrator. */
  panel?: string;
}

export interface RunpaneTodoAskRequest extends RunpaneTodoRefRequest {
  question: string;
}

export interface RunpaneTodoCommentRequest extends RunpaneTodoRefRequest {
  body: string;
  /** From the requester: it can't settle the question, so Pane asks the person. */
  escalate?: boolean;
}

export interface RunpaneTodoReviewRequest extends RunpaneTodoRefRequest {
  summary?: string;
  /** Why there is nothing to attach; required when the to-do has no attachments. */
  noAttachments?: string;
}

export interface RunpaneTodoDoneRequest extends RunpaneTodoRefRequest {
  /** The person's own words telling the agent to close it. */
  personSaid?: string;
}

export interface RunpaneTodoDropRequest extends RunpaneTodoRefRequest {
  reason?: string;
}

/** One to-do in `--json`: field order is the byte order npm and Python both print. */
export interface RunpaneTodo {
  ref: string;
  number: number;
  title: string;
  state: TodoState;
  status: TodoShownStatus;
  reason: string;
  parent: string | null;
  sessionId: string | null;
  requester: string;
  assignee: string | null;
  summary: string;
  doneWhen: TodoDoneWhenItem[];
  attachmentCount: number;
  updatedAt: string;
}

export interface RunpaneTodoAttachment {
  id: number;
  kind: string;
  label: string;
  target: string;
  machine: string | null;
  note: string | null;
  addedBy: string;
  source: TodoAttachmentSource;
  /** "T-12" when inherited from a parent or a sub-to-do; null for its own. */
  from: string | null;
  addedAt: string;
}

export interface RunpaneTodoActivity {
  id: number;
  kind: 'message' | 'event';
  author: string;
  body: string;
  at: string;
}

export interface RunpaneTodoResult { ok: true; todo: RunpaneTodo }
export interface RunpaneTodoListResult { ok: true; todos: RunpaneTodo[] }
export interface RunpaneTodoShowResult { ok: true; todo: RunpaneTodo; attachments: RunpaneTodoAttachment[]; subTodos: RunpaneTodo[]; activity: RunpaneTodoActivity[] }
export interface RunpaneTodoAttachResult { ok: true; todo: string; attachment: RunpaneTodoAttachment }
export interface RunpaneTodoDetachResult { ok: true; todo: string; detached: number }
export interface RunpaneTodoAskResult { ok: true; todo: string; routedTo: 'requester' | 'person'; approvalId: string | null }
export interface RunpaneTodoCommentResult { ok: true; todo: string; activityId: number }
export interface RunpaneTodoReviewResult { ok: true; todo: RunpaneTodo; approvalId: string }
export interface RunpaneTodoArchiveResult { ok: true; todo: string; archived: string[]; kept: Array<{ name: string; reason: string }>; sessionArchived: boolean }
export interface RunpaneTodoStartResult { ok: true; todo: RunpaneTodo; queued: boolean }

/** The `runpane todos` verbs; each is the daemon channel `runpane:todos:<verb>`. */
export const RUNPANE_TODO_VERBS = ['create', 'update', 'attach', 'detach', 'show', 'list', 'assign', 'ask', 'comment', 'review', 'done', 'drop', 'archive', 'start', 'stop'] as const;
export type RunpaneTodoVerb = typeof RUNPANE_TODO_VERBS[number];
