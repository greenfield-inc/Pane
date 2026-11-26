import type Database from 'better-sqlite3-multiple-ciphers';
import {
  AGENT_MESSAGE_KINDS, AGENT_MESSAGE_STATES, messageRef,
  type AgentMessageKind, type AgentMessageParty, type AgentMessageRecord, type AgentMessageState,
} from '../../../../shared/types/agentMessages';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';
import { ensureAgentMessagesSchema } from '../../database/agentMessagesSchema';

const str = boundary.nullable(boundary.string);
const num = boundary.nullable(boundary.number);

const rowSchema = boundary.object({
  number: boundary.number, kind: boundary.enumeration(...AGENT_MESSAGE_KINDS), reply_to: num,
  sender_panel_id: str, sender_pane_id: str, sender_session_id: str, sender_name: boundary.string, sender_orchestrator: boundary.number,
  receiver_panel_id: str, receiver_pane_id: str, receiver_session_id: str, receiver_name: boundary.string, receiver_orchestrator: boundary.number,
  body: boundary.string, state: boundary.enumeration(...AGENT_MESSAGE_STATES), delivered_via: boundary.nullable(boundary.enumeration('tab', 'call')),
  undelivered_reason: str, created_at: boundary.number, delivered_at: num, answered_at: num,
  operation_id: boundary.optional(str),
  request_key: boundary.optional(str),
  prompt_file: boundary.optional(str),
  prompt_attachments: boundary.optional(str),
});

/** The prompt file a file-pointer message was sent as, and its attachment copies. */
export interface MessagePointer {
  promptFile: string;
  attachments: string[];
}

const attachmentsSchema = boundary.array(boundary.string);

function pointerOf(row: MessageRow): MessagePointer | null {
  if (!row.prompt_file) return null;
  const attachments = row.prompt_attachments ? decodeBoundary(JSON.parse(row.prompt_attachments), attachmentsSchema) : [];
  return { promptFile: row.prompt_file, attachments };
}
type MessageRow = ReturnType<typeof rowSchema.decode>;

/** One message as the service reads it: times in ms, replies by number. */
export interface StoredMessage {
  number: number;
  kind: AgentMessageKind;
  replyTo: number | null;
  sender: AgentMessageParty;
  receiver: AgentMessageParty;
  body: string;
  state: AgentMessageState;
  deliveredVia: 'tab' | 'call' | null;
  undeliveredReason: string | null;
  createdAt: number;
  deliveredAt: number | null;
  answeredAt: number | null;
  pointer: MessagePointer | null;
}

export interface NewMessage {
  kind: AgentMessageKind;
  replyTo?: number;
  sender: AgentMessageParty;
  receiver: AgentMessageParty;
  body: string;
  state: AgentMessageState;
  now: number;
  /** The submit's operation id, so a replay of it finds this message. */
  operationId?: string;
  /** What the submit asked for; a replay must ask the same. */
  requestKey?: string;
  pointer?: MessagePointer | null;
}

function party(row: MessageRow, side: 'sender' | 'receiver'): AgentMessageParty {
  return {
    panelId: row[`${side}_panel_id`], paneId: row[`${side}_pane_id`], sessionId: row[`${side}_session_id`],
    name: row[`${side}_name`], orchestrator: row[`${side}_orchestrator`] === 1,
  };
}

function toStored(row: MessageRow): StoredMessage {
  return {
    number: row.number, kind: row.kind, replyTo: row.reply_to, sender: party(row, 'sender'), receiver: party(row, 'receiver'),
    body: row.body, state: row.state, deliveredVia: row.delivered_via, undeliveredReason: row.undelivered_reason,
    createdAt: row.created_at, deliveredAt: row.delivered_at, answeredAt: row.answered_at, pointer: pointerOf(row),
  };
}

const iso = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

/** The record `runpane messages` and the app read. */
export function messageRecord(message: StoredMessage, replies: readonly number[]): AgentMessageRecord {
  return {
    ref: messageRef(message.number), number: message.number, kind: message.kind,
    replyTo: message.replyTo === null ? null : messageRef(message.replyTo),
    sender: message.sender, receiver: message.receiver, text: message.body, state: message.state,
    deliveredVia: message.deliveredVia, undeliveredReason: message.undeliveredReason,
    replies: replies.map(messageRef),
    createdAt: new Date(message.createdAt).toISOString(), deliveredAt: iso(message.deliveredAt), answeredAt: iso(message.answeredAt),
  };
}

/** Messages kept this long; older ones go at start-up. */
export const AGENT_MESSAGE_RETENTION_MS = 30 * 24 * 60 * 60_000;

export class AgentMessageStore {
  constructor(private readonly db: Database.Database) {
    ensureAgentMessagesSchema(db);
  }

  create(input: NewMessage): StoredMessage {
    const result = this.db.prepare(`INSERT INTO agent_messages (kind, reply_to,
      sender_panel_id, sender_pane_id, sender_session_id, sender_name, sender_orchestrator,
      receiver_panel_id, receiver_pane_id, receiver_session_id, receiver_name, receiver_orchestrator,
      body, state, created_at, operation_id, request_key, prompt_file, prompt_attachments)
      VALUES (@kind, @reply_to, @sp, @spane, @ss, @sn, @so, @rp, @rpane, @rs, @rn, @ro, @body, @state, @now, @operation_id, @request_key, @prompt_file, @prompt_attachments)`).run({
      kind: input.kind, reply_to: input.replyTo ?? null,
      sp: input.sender.panelId, spane: input.sender.paneId, ss: input.sender.sessionId, sn: input.sender.name, so: input.sender.orchestrator ? 1 : 0,
      rp: input.receiver.panelId, rpane: input.receiver.paneId, rs: input.receiver.sessionId, rn: input.receiver.name, ro: input.receiver.orchestrator ? 1 : 0,
      body: input.body, state: input.state, now: input.now, operation_id: input.operationId ?? null,
      request_key: input.requestKey ?? null, prompt_file: input.pointer?.promptFile ?? null,
      prompt_attachments: input.pointer ? JSON.stringify(input.pointer.attachments) : null,
    });
    const created = this.get(Number(result.lastInsertRowid));
    if (!created) throw new Error('The message was written but could not be read back.');
    return created;
  }

  get(number: number): StoredMessage | undefined {
    const row: unknown = this.db.prepare('SELECT * FROM agent_messages WHERE number = ?').get(number);
    return row === undefined ? undefined : toStored(decodeBoundary(row, rowSchema));
  }

  /** The message a submit with this operation id, from this tab to that one, already recorded. */
  byOperation(operationId: string, senderPanelId: string, receiverPanelId: string, requestKey: string): StoredMessage | undefined {
    const row: unknown = this.db.prepare("SELECT * FROM agent_messages WHERE operation_id = ? AND sender_panel_id = ? AND receiver_panel_id = ? AND request_key = ? AND kind = 'message' ORDER BY number DESC LIMIT 1")
      .get(operationId, senderPanelId, receiverPanelId, requestKey);
    return row === undefined ? undefined : toStored(decodeBoundary(row, rowSchema));
  }

  /** Newest first: every message, or those a tab sent or received. */
  list(filter: { panelId?: string; limit?: number; before?: number } = {}): StoredMessage[] {
    const limit = filter.limit ?? 50;
    // `before`: a page further back, older than message number `before` (exclusive).
    const before = filter.before ?? Number.MAX_SAFE_INTEGER;
    const rows: unknown[] = filter.panelId
      // Two reads, each bounded to the page by its own index (sender_panel_id, receiver_panel_id; number is the rowid), then merged.
      ? this.db.prepare(`SELECT * FROM (SELECT * FROM agent_messages WHERE sender_panel_id = @panel AND number < @before ORDER BY number DESC LIMIT @limit)
          UNION SELECT * FROM (SELECT * FROM agent_messages WHERE receiver_panel_id = @panel AND number < @before ORDER BY number DESC LIMIT @limit)
          ORDER BY number DESC LIMIT @limit`).all({ panel: filter.panelId, before, limit })
      : this.db.prepare('SELECT * FROM agent_messages WHERE number < ? ORDER BY number DESC LIMIT ?').all(before, limit);
    return rows.map(row => toStored(decodeBoundary(row, rowSchema)));
  }

  replies(number: number): StoredMessage[] {
    const rows: unknown[] = this.db.prepare('SELECT * FROM agent_messages WHERE reply_to = ? ORDER BY number').all(number);
    return rows.map(row => toStored(decodeBoundary(row, rowSchema)));
  }

  replyNumbers(number: number): number[] {
    return this.replies(number).map(reply => reply.number);
  }

  /** Replies still waiting for their sender's tab, oldest first: a restart queues them again. */
  queued(): StoredMessage[] {
    const rows: unknown[] = this.db.prepare("SELECT * FROM agent_messages WHERE state = 'queued' ORDER BY number").all();
    return rows.map(row => toStored(decodeBoundary(row, rowSchema)));
  }

  setState(number: number, state: AgentMessageState, fields: { via?: 'tab' | 'call'; reason?: string; at: number }): void {
    if (state === 'delivered') {
      this.db.prepare('UPDATE agent_messages SET state = ?, delivered_via = ?, delivered_at = ?, undelivered_reason = NULL WHERE number = ?').run(state, fields.via ?? 'tab', fields.at, number);
    } else if (state === 'undelivered') {
      this.db.prepare('UPDATE agent_messages SET state = ?, undelivered_reason = ? WHERE number = ?').run(state, fields.reason ?? null, number);
    } else if (state === 'answered') {
      this.db.prepare('UPDATE agent_messages SET state = ?, answered_at = COALESCE(answered_at, ?) WHERE number = ?').run(state, fields.at, number);
    } else {
      this.db.prepare('UPDATE agent_messages SET state = ? WHERE number = ?').run(state, number);
    }
  }

  /** A message typed in: delivered, unless a reply already answered it. */
  markDelivered(number: number, at: number): void {
    this.db.prepare("UPDATE agent_messages SET state = CASE WHEN state = 'answered' THEN state ELSE 'delivered' END, delivered_via = 'tab', delivered_at = ? WHERE number = ?").run(at, number);
  }

  prune(before: number): void {
    this.db.prepare('DELETE FROM agent_messages WHERE created_at < ?').run(before);
  }
}
