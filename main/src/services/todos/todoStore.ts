import type Database from 'better-sqlite3-multiple-ciphers';
import {
  TODO_ATTACHMENT_KINDS, TODO_STATES, todoRef,
  type TodoActivity, type TodoAttachment, type TodoAttachmentKind, type TodoAttachmentSource, type TodoAuthorKind,
  type TodoDoneWhenItem, type TodoRecord, type TodoRequester, type TodoState,
} from '../../../../shared/types/todos';
import { boundary, decodeBoundary, type BoundarySchema } from '../../../../shared/validation/boundaryDecoder';
import { ensureApprovalsSchema } from '../../database/approvalsSchema';
import { ensureTodosSchema } from '../../database/todosSchema';

/** A closed to-do, with its attachments and chat, stays this long after closing. */
export const TODO_RETENTION_MS = 30 * 24 * 60 * 60_000;

const num = boundary.nullable(boundary.number);
const str = boundary.nullable(boundary.string);

const todoRowSchema = boundary.object({
  number: boundary.number, session_id: str, parent_id: num, title: boundary.string, summary: boundary.string, done_when: boundary.string,
  state: boundary.enumeration(...TODO_STATES), requester_kind: boundary.enumeration('person', 'orchestrator'),
  requester_session_id: str, requester_panel_id: str, requester_name: boundary.string, project: num, agent: str,
  assignee_panel_id: str, assignee_pane_id: str, assignee_name: str, created_by: boundary.string, created_at: boundary.number,
  started_at: num, updated_at: boundary.number, accepted_at: num, closed_at: num, last_progress_at: num, stuck_since: num,
  episode_reminders: boundary.number, episode_restarts: boundary.number, stalls_today: boundary.number, stalls_day: str,
  attach_reminded_at: num, work_ms: boundary.number, stuck_card_id: str,
  load_hold: boundary.nullable(boundary.enumeration('queued', 'paused')), load_hold_since: num,
  load_override: boundary.nullable(boundary.literal('never_pause')),
});

const doneWhenSchema = boundary.array(boundary.object({ text: boundary.string, met: boundary.boolean }));

const attachmentRowSchema = boundary.object({
  id: boundary.number, todo_id: boundary.number, kind: boundary.string, target: boundary.string, machine: str, label: boundary.string,
  note: str, added_by: boundary.string, added_by_tab: str, source: boundary.enumeration('attached', 'pr', 'approval', 'opened'),
  added_at: boundary.number, removed_at: num,
});

const activityRowSchema = boundary.object({
  id: boundary.number, todo_id: boundary.number, kind: boundary.enumeration('message', 'event'),
  author_kind: boundary.enumeration('person', 'agent', 'requester', 'pane'), author: boundary.string, author_tab: str,
  body: boundary.string, chat_ref: str, to_tab: str, to_name: str, delivered_at: num, reply_to: num, created_at: boundary.number,
});

const chatRefSchema = boundary.object({ panelId: boundary.string, messageId: boundary.optional(boundary.string) });

/** A row or nothing; a row that doesn't decode throws instead of reading as absent. */
function optionalRow<Value>(value: SqliteRow, schema: BoundarySchema<Value>): Value | undefined {
  return value === undefined ? undefined : decodeBoundary(value, schema);
}

/** What better-sqlite3's `get()` hands back before decoding. */
type SqliteRow = ReturnType<Database.Statement['get']>;

type TodoRow = ReturnType<typeof todoRowSchema.decode>;

function decodeDoneWhen(json: string): TodoDoneWhenItem[] {
  try {
    return decodeBoundary(JSON.parse(json), doneWhenSchema);
  } catch {
    return [];
  }
}

function requesterOf(row: TodoRow): TodoRequester {
  if (row.requester_kind === 'person') return { kind: 'person', name: row.requester_name };
  const requester: TodoRequester = { kind: 'orchestrator', name: row.requester_name };
  if (row.requester_session_id) requester.sessionId = row.requester_session_id;
  if (row.requester_panel_id) requester.panelId = row.requester_panel_id;
  return requester;
}

function assigneeOf(row: TodoRow): TodoRecord['assignee'] {
  if (!row.assignee_panel_id) return null;
  const assignee: NonNullable<TodoRecord['assignee']> = { panelId: row.assignee_panel_id };
  if (row.assignee_pane_id) assignee.paneId = row.assignee_pane_id;
  if (row.assignee_name) assignee.name = row.assignee_name;
  return assignee;
}

function toRecord(row: TodoRow): TodoRecord {
  return {
    number: row.number, ref: todoRef(row.number), sessionId: row.session_id, parentNumber: row.parent_id, title: row.title, summary: row.summary,
    doneWhen: decodeDoneWhen(row.done_when), state: row.state, requester: requesterOf(row), projectId: row.project, agent: row.agent,
    assignee: assigneeOf(row),
    createdBy: row.created_by, createdAt: row.created_at, startedAt: row.started_at, updatedAt: row.updated_at, acceptedAt: row.accepted_at,
    closedAt: row.closed_at, lastProgressAt: row.last_progress_at, stuckSince: row.stuck_since, episodeReminders: row.episode_reminders,
    episodeRestarts: row.episode_restarts, stallsToday: row.stalls_today, stallsDay: row.stalls_day, attachRemindedAt: row.attach_reminded_at,
    workMs: row.work_ms, loadHold: row.load_hold, loadHoldSince: row.load_hold_since, loadOverride: row.load_override, stuckCardId: row.stuck_card_id,
  };
}

const ATTACHMENT_KINDS: ReadonlySet<string> = new Set(TODO_ATTACHMENT_KINDS);

function isAttachmentKind(value: string): value is TodoAttachmentKind {
  return ATTACHMENT_KINDS.has(value);
}

function toAttachment(row: ReturnType<typeof attachmentRowSchema.decode>): TodoAttachment {
  const attachment: TodoAttachment = {
    id: row.id, todoNumber: row.todo_id, kind: isAttachmentKind(row.kind) ? row.kind : 'doc', target: row.target,
    label: row.label, addedBy: row.added_by, source: row.source, addedAt: row.added_at,
  };
  if (row.machine) attachment.machine = row.machine;
  if (row.note) attachment.note = row.note;
  if (row.added_by_tab) attachment.addedByTab = row.added_by_tab;
  if (row.removed_at !== null) attachment.removedAt = row.removed_at;
  return attachment;
}

function decodeChatRef(json: string | null): TodoActivity['chatRef'] {
  if (!json) return undefined;
  try {
    return decodeBoundary(JSON.parse(json), chatRefSchema);
  } catch {
    return undefined;
  }
}

function toActivity(row: ReturnType<typeof activityRowSchema.decode>): TodoActivity {
  const activity: TodoActivity = {
    id: row.id, todoNumber: row.todo_id, kind: row.kind, authorKind: row.author_kind, authorName: row.author, body: row.body, createdAt: row.created_at,
  };
  const chatRef = decodeChatRef(row.chat_ref);
  if (chatRef) activity.chatRef = chatRef;
  if (row.author_tab) activity.authorTab = row.author_tab;
  if (row.to_tab) activity.toTab = row.to_tab;
  if (row.to_name) activity.toName = row.to_name;
  if (row.delivered_at !== null) activity.deliveredAt = row.delivered_at;
  if (row.reply_to !== null) activity.replyTo = row.reply_to;
  return activity;
}

export interface NewTodo {
  title: string;
  summary?: string;
  doneWhen?: TodoDoneWhenItem[];
  parentNumber?: number | null;
  sessionId?: string | null;
  state?: TodoState;
  requester: TodoRequester;
  projectId?: number | null;
  agent?: string | null;
  createdBy: string;
  now: number;
}

/** Fields a write may change. `updated_at` is always set. */
export interface TodoPatch {
  title?: string;
  summary?: string;
  doneWhen?: TodoDoneWhenItem[];
  state?: TodoState;
  sessionId?: string | null;
  projectId?: number | null;
  agent?: string | null;
  assignee?: TodoRecord['assignee'];
  startedAt?: number | null;
  acceptedAt?: number | null;
  closedAt?: number | null;
  lastProgressAt?: number | null;
  stuckSince?: number | null;
  episodeReminders?: number;
  episodeRestarts?: number;
  stallsToday?: number;
  stallsDay?: string | null;
  attachRemindedAt?: number | null;
  workMs?: number;
  stuckCardId?: string | null;
  loadHold?: TodoRecord['loadHold'];
  loadHoldSince?: number | null;
  loadOverride?: TodoRecord['loadOverride'];
}

const PATCH_COLUMNS = {
  title: 'title', summary: 'summary', state: 'state', sessionId: 'session_id', projectId: 'project', agent: 'agent',
  startedAt: 'started_at', acceptedAt: 'accepted_at', closedAt: 'closed_at', lastProgressAt: 'last_progress_at', stuckSince: 'stuck_since',
  episodeReminders: 'episode_reminders', episodeRestarts: 'episode_restarts', stallsToday: 'stalls_today', stallsDay: 'stalls_day',
  attachRemindedAt: 'attach_reminded_at', workMs: 'work_ms', stuckCardId: 'stuck_card_id', loadHold: 'load_hold',
  loadHoldSince: 'load_hold_since', loadOverride: 'load_override',
} as const satisfies Record<Exclude<keyof TodoPatch, 'assignee' | 'doneWhen'>, string>;

type PatchColumnKey = keyof typeof PATCH_COLUMNS;
const PATCH_KEYS = Object.keys(PATCH_COLUMNS).filter((key): key is PatchColumnKey => key in PATCH_COLUMNS);


export interface NewAttachment {
  todoNumber: number;
  kind: TodoAttachmentKind;
  target: string;
  machine?: string;
  label: string;
  note?: string;
  addedBy: string;
  addedByTab?: string;
  source: TodoAttachmentSource;
  now: number;
}

export interface NewActivity {
  todoNumber: number;
  kind: 'message' | 'event';
  authorKind: TodoAuthorKind;
  authorName: string;
  authorTab?: string;
  body: string;
  chatRef?: TodoActivity['chatRef'];
  toTab?: string;
  toName?: string;
  /** The row this one answers (round 7). */
  replyTo?: number;
  now: number;
}

/** A waiting approval linked to a to-do. */
export interface LinkedApproval {
  id: string;
  todoNumber: number;
  title: string;
  qn?: string;
  createdAt: number;
}

const linkedRowSchema = boundary.object({ id: boundary.string, todo_id: boundary.number, qn: str, item_json: str, created_at: boundary.number });
const itemTitleSchema = boundary.object({ title: boundary.optional(boundary.string) });

function titleOf(itemJson: string | null): string {
  if (!itemJson) return '';
  try {
    return decodeBoundary(JSON.parse(itemJson), itemTitleSchema).title ?? '';
  } catch {
    return '';
  }
}

/**
 * One machine's to-dos in its sessions.db. Plain storage: rules (done, review, routing) live in
 * TodoService, and statuses are worked out by todoStatus.ts.
 */
export class TodoStore {
  constructor(private readonly db: Database.Database) {
    ensureApprovalsSchema(db);
    ensureTodosSchema(db);
  }

  transaction<T>(run: () => T): T {
    return this.db.transaction(run)();
  }

  create(input: NewTodo): TodoRecord {
    const result = this.db.prepare(`INSERT INTO todos (session_id, parent_id, title, summary, done_when, state, requester_kind, requester_session_id,
      requester_panel_id, requester_name, project, agent, created_by, created_at, updated_at)
      VALUES (@session_id, @parent_id, @title, @summary, @done_when, @state, @requester_kind, @requester_session_id, @requester_panel_id,
      @requester_name, @project, @agent, @created_by, @now, @now)`).run({
      session_id: input.sessionId ?? null, parent_id: input.parentNumber ?? null, title: input.title, summary: input.summary ?? '',
      done_when: JSON.stringify(input.doneWhen ?? []), state: input.state ?? 'todo', requester_kind: input.requester.kind,
      requester_session_id: input.requester.sessionId ?? null, requester_panel_id: input.requester.panelId ?? null,
      requester_name: input.requester.name, project: input.projectId ?? null, agent: input.agent ?? null, created_by: input.createdBy, now: input.now,
    });
    const created = this.get(Number(result.lastInsertRowid));
    if (!created) throw new Error('The to-do was written but could not be read back.');
    return created;
  }

  get(number: number): TodoRecord | undefined {
    const row = optionalRow(this.db.prepare('SELECT * FROM todos WHERE number = ?').get(number), todoRowSchema);
    return row ? toRecord(row) : undefined;
  }

  /** Every to-do, open first by number; closed ones closed at or after `closedSince` (all when absent). */
  list(options: { closedSince?: number } = {}): TodoRecord[] {
    const rows = options.closedSince === undefined
      ? this.db.prepare('SELECT * FROM todos ORDER BY number').all()
      : this.db.prepare('SELECT * FROM todos WHERE closed_at IS NULL OR closed_at >= ? ORDER BY number').all(options.closedSince);
    return decodeBoundary(rows, boundary.array(todoRowSchema)).map(toRecord);
  }

  listOpen(): TodoRecord[] {
    return decodeBoundary(this.db.prepare("SELECT * FROM todos WHERE state NOT IN ('done', 'dropped') ORDER BY number").all(), boundary.array(todoRowSchema)).map(toRecord);
  }

  children(parentNumber: number): TodoRecord[] {
    return decodeBoundary(this.db.prepare('SELECT * FROM todos WHERE parent_id = ? ORDER BY number').all(parentNumber), boundary.array(todoRowSchema)).map(toRecord);
  }

  inSession(sessionId: string): TodoRecord[] {
    return decodeBoundary(this.db.prepare('SELECT * FROM todos WHERE session_id = ? ORDER BY number').all(sessionId), boundary.array(todoRowSchema)).map(toRecord);
  }

  /** The top-level to-do that owns `sessionId`, if the Session is a to-do's own. */
  ownerOfSession(sessionId: string): TodoRecord | undefined {
    const row = optionalRow(this.db.prepare('SELECT * FROM todos WHERE session_id = ? AND parent_id IS NULL ORDER BY number LIMIT 1').get(sessionId), todoRowSchema);
    return row ? toRecord(row) : undefined;
  }

  /** Session ids that belong to a top-level to-do: kept out of the sidebar. */
  ownSessionIds(): string[] {
    return decodeBoundary(this.db.prepare('SELECT DISTINCT session_id FROM todos WHERE parent_id IS NULL AND session_id IS NOT NULL').all(), boundary.array(boundary.object({ session_id: boundary.string }))).map(row => row.session_id);
  }

  update(number: number, patch: TodoPatch, now: number): TodoRecord {
    const sets: string[] = ['updated_at = @now'];
    const params = new Map<string, string | number | null>([['number', number], ['now', now]]);
    for (const key of PATCH_KEYS) {
      const column = PATCH_COLUMNS[key];
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${column} = @${column}`);
      params.set(column, value);
    }
    if (patch.doneWhen !== undefined) {
      sets.push('done_when = @done_when');
      params.set('done_when', JSON.stringify(patch.doneWhen));
    }
    if (patch.assignee !== undefined) {
      sets.push('assignee_panel_id = @assignee_panel_id', 'assignee_pane_id = @assignee_pane_id', 'assignee_name = @assignee_name');
      params.set('assignee_panel_id', patch.assignee?.panelId ?? null);
      params.set('assignee_pane_id', patch.assignee?.paneId ?? null);
      params.set('assignee_name', patch.assignee?.name ?? null);
    }
    const result = this.db.prepare(`UPDATE todos SET ${sets.join(', ')} WHERE number = @number`).run(Object.fromEntries(params));
    if (result.changes === 0) throw new Error(`${todoRef(number)} does not exist.`);
    const updated = this.get(number);
    if (!updated) throw new Error(`${todoRef(number)} does not exist.`);
    return updated;
  }

  // ── Attachments ─────────────────────────────────────────────────────────

  attach(input: NewAttachment): TodoAttachment {
    const result = this.db.prepare(`INSERT INTO todo_attachments (todo_id, kind, target, machine, label, note, added_by, added_by_tab, source, added_at)
      VALUES (@todo_id, @kind, @target, @machine, @label, @note, @added_by, @added_by_tab, @source, @added_at)`).run({
      todo_id: input.todoNumber, kind: input.kind, target: input.target, machine: input.machine ?? null, label: input.label, note: input.note ?? null,
      added_by: input.addedBy, added_by_tab: input.addedByTab ?? null, source: input.source, added_at: input.now,
    });
    const row = decodeBoundary(this.db.prepare('SELECT * FROM todo_attachments WHERE id = ?').get(Number(result.lastInsertRowid)), attachmentRowSchema);
    return toAttachment(row);
  }

  /** Detaches without losing the record. False when it was not attached. */
  detach(id: number, now: number): boolean {
    return this.db.prepare('UPDATE todo_attachments SET removed_at = ? WHERE id = ? AND removed_at IS NULL').run(now, id).changes === 1;
  }

  attachment(id: number): TodoAttachment | undefined {
    const row = optionalRow(this.db.prepare('SELECT * FROM todo_attachments WHERE id = ?').get(id), attachmentRowSchema);
    return row ? toAttachment(row) : undefined;
  }

  /** A to-do's own current attachments, oldest first. */
  attachments(todoNumber: number): TodoAttachment[] {
    return decodeBoundary(this.db.prepare('SELECT * FROM todo_attachments WHERE todo_id = ? AND removed_at IS NULL ORDER BY id').all(todoNumber), boundary.array(attachmentRowSchema)).map(toAttachment);
  }

  /** Every file currently attached to a to-do on this machine (URLs left out). */
  attachedFiles(): string[] {
    return decodeBoundary(this.db.prepare("SELECT DISTINCT target FROM todo_attachments WHERE removed_at IS NULL AND machine IS NOT NULL").all(), boundary.array(boundary.object({ target: boundary.string }))).map(row => row.target);
  }

  /** Current attachments per to-do, in one read. */
  attachmentCounts(): Map<number, number> {
    const rows = decodeBoundary(this.db.prepare('SELECT todo_id, COUNT(*) AS count FROM todo_attachments WHERE removed_at IS NULL GROUP BY todo_id').all(), boundary.array(boundary.object({ todo_id: boundary.number, count: boundary.number })));
    return new Map(rows.map(row => [row.todo_id, row.count]));
  }

  /** Whether an attachment with this target is already on the to-do (automatic attaching skips repeats). */
  hasTarget(todoNumber: number, target: string): boolean {
    return this.db.prepare('SELECT 1 FROM todo_attachments WHERE todo_id = ? AND target = ? AND removed_at IS NULL').get(todoNumber, target) !== undefined;
  }

  // ── Activity (the to-do's chat) ─────────────────────────────────────────

  addActivity(input: NewActivity): TodoActivity {
    const result = this.db.prepare(`INSERT INTO todo_activity (todo_id, kind, author_kind, author, author_tab, body, chat_ref, to_tab, to_name, reply_to, created_at)
      VALUES (@todo_id, @kind, @author_kind, @author, @author_tab, @body, @chat_ref, @to_tab, @to_name, @reply_to, @created_at)`).run({
      todo_id: input.todoNumber, kind: input.kind, author_kind: input.authorKind, author: input.authorName, author_tab: input.authorTab ?? null,
      body: input.body, chat_ref: input.chatRef ? JSON.stringify(input.chatRef) : null, to_tab: input.toTab ?? null, to_name: input.toName ?? null,
      reply_to: input.replyTo ?? null, created_at: input.now,
    });
    const row = decodeBoundary(this.db.prepare('SELECT * FROM todo_activity WHERE id = ?').get(Number(result.lastInsertRowid)), activityRowSchema);
    return toActivity(row);
  }

  activityRow(id: number): TodoActivity | null {
    const row = this.db.prepare('SELECT * FROM todo_activity WHERE id = ?').get(id);
    return row === undefined ? null : toActivity(decodeBoundary(row, activityRowSchema));
  }

  /** Your newest reply typed to `tab` on a to-do, while no message answers it yet: an agent's next message there threads under it. */
  openReplyTo(todoNumber: number, tab: string): number | null {
    const row = this.db.prepare(`SELECT id FROM todo_activity r WHERE r.todo_id = ? AND r.author_kind = 'person' AND r.to_tab = ? AND r.id = (
      SELECT MAX(id) FROM todo_activity WHERE todo_id = r.todo_id AND author_kind = 'person' AND to_tab = r.to_tab)
      AND r.reply_to IS NOT NULL AND NOT EXISTS (SELECT 1 FROM todo_activity a WHERE a.todo_id = r.todo_id AND a.reply_to = r.id)`).get(todoNumber, tab);
    return row === undefined ? null : decodeBoundary(row, boundary.object({ id: boundary.number })).id;
  }

  activity(todoNumber: number, limit = 500): TodoActivity[] {
    const rows = this.db.prepare('SELECT * FROM (SELECT * FROM todo_activity WHERE todo_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id').all(todoNumber, limit);
    return decodeBoundary(rows, boundary.array(activityRowSchema)).map(toActivity);
  }

  activityItem(id: number): TodoActivity | undefined {
    const row = optionalRow(this.db.prepare('SELECT * FROM todo_activity WHERE id = ?').get(id), activityRowSchema);
    return row ? toActivity(row) : undefined;
  }

  markDelivered(id: number, now: number): void {
    this.db.prepare('UPDATE todo_activity SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL').run(now, id);
  }

  /** Messages still waiting to be typed into a tab, oldest first. */
  undelivered(): TodoActivity[] {
    return decodeBoundary(this.db.prepare('SELECT * FROM todo_activity WHERE to_tab IS NOT NULL AND delivered_at IS NULL ORDER BY id').all(), boundary.array(activityRowSchema)).map(toActivity);
  }

  /** Agent messages since `since` per to-do: the list's unread count. */
  agentMessagesSince(todoNumber: number, since: number): number {
    return decodeBoundary(this.db.prepare("SELECT COUNT(*) AS count FROM todo_activity WHERE todo_id = ? AND kind = 'message' AND author_kind = 'agent' AND created_at > ?").get(todoNumber, since), boundary.object({ count: boundary.number })).count;
  }

  // ── Approvals linked to to-dos ──────────────────────────────────────────

  linkApproval(approvalId: string, todoNumber: number): void {
    this.db.prepare('UPDATE approvals SET todo_id = ? WHERE id = ?').run(todoNumber, approvalId);
  }

  todoOfApproval(approvalId: string): number | undefined {
    const row = optionalRow(this.db.prepare('SELECT todo_id FROM approvals WHERE id = ?').get(approvalId), boundary.object({ todo_id: num }));
    return row?.todo_id ?? undefined;
  }

  /** Approvals waiting on the person, linked to a to-do, oldest first. */
  waitingApprovals(): LinkedApproval[] {
    const rows = decodeBoundary(this.db.prepare(`SELECT id, todo_id, qn, item_json, created_at FROM approvals
      WHERE todo_id IS NOT NULL AND state IN ('waiting', 'sent') AND item_json IS NOT NULL ORDER BY created_at, rowid`).all(), boundary.array(linkedRowSchema));
    return rows.map(row => {
      const linked: LinkedApproval = { id: row.id, todoNumber: row.todo_id, title: titleOf(row.item_json), createdAt: row.created_at };
      if (row.qn) linked.qn = row.qn;
      return linked;
    });
  }

  /** Every approval linked to these to-dos, any state, oldest first. */
  approvalIds(todoNumbers: number[]): string[] {
    if (todoNumbers.length === 0) return [];
    const marks = todoNumbers.map(() => '?').join(', ');
    return decodeBoundary(this.db.prepare(`SELECT id FROM approvals WHERE todo_id IN (${marks}) AND item_json IS NOT NULL ORDER BY created_at, rowid`).all(...todoNumbers), boundary.array(boundary.object({ id: boundary.string }))).map(row => row.id);
  }

  // ── Retention ───────────────────────────────────────────────────────────

  /** Deletes to-dos closed more than 30 days ago, with their rows. Files they point at are never touched. */
  pruneClosed(now: number): number {
    return this.transaction(() => {
      const cutoff = now - TODO_RETENTION_MS;
      const doomed = decodeBoundary(this.db.prepare('SELECT number FROM todos WHERE closed_at IS NOT NULL AND closed_at < ? AND state IN (\'done\', \'dropped\')').all(cutoff), boundary.array(boundary.object({ number: boundary.number }))).map(row => row.number);
      for (const number of doomed) {
        this.db.prepare('DELETE FROM todo_attachments WHERE todo_id = ?').run(number);
        this.db.prepare('DELETE FROM todo_activity WHERE todo_id = ?').run(number);
        this.db.prepare('UPDATE approvals SET todo_id = NULL WHERE todo_id = ?').run(number);
        this.db.prepare('DELETE FROM todos WHERE number = ?').run(number);
      }
      return doomed.length;
    });
  }
}
