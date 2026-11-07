import os from 'os';
import type Database from 'better-sqlite3-multiple-ciphers';
import type { NotifyConnected, NotifyItem, NotifyOriginKind } from '../../../../shared/types/notify';
import type { RunpaneInboxItem } from '../../../../shared/types/runpaneOrchestration';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import { ensureApprovalsSchema } from '../../database/approvalsSchema';

/**
 * One machine's approvals: one row per item, from any origin, in that machine's sessions.db
 * (D-159). The queue's `item` and the inbox's `report` share a row, so a worker's blocked question
 * is one thing to the person and to its orchestrator. Rows are pruned 7 days after they end.
 */

/** A closed or answered item stays in the record this long. */
export const APPROVAL_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** The states a queue item can leave only once, in one conditional write (first answer or close wins). */
const CLAIMABLE = 'waiting';

const itemRowSchema = boundary.object({ item_json: boundary.nullable(boundary.string) });
const reportRowSchema = boundary.object({ report_json: boundary.string });

/** The link no row can be saved without (D-168), for an item that has no Session of its own. */
export function connectedOf(item: NotifyItem, machine: string): NotifyConnected {
  if (item.connected) return item.connected;
  const { source } = item;
  if (source.session) return { kind: 'session', id: source.session.id, name: source.session.name, paneId: source.session.paneId };
  if (source.autopilot) return { kind: 'autopilot', id: 'autopilot', name: 'Autopilot' };
  if (source.paneId) return { kind: 'pane', id: source.paneId, name: source.name };
  return { kind: 'machine', id: machine, name: source.name };
}

export function originOf(item: NotifyItem): NotifyOriginKind {
  if (item.originKind) return item.originKind;
  if (item.source.autopilot) return 'autopilot';
  if (item.agentPrompt) return 'claude-prompt';
  if (item.source.session?.orchestrator) return 'orchestrator';
  if (!item.source.paneId && item.source.agent === 'Pane') return 'pane';
  return 'agent';
}

/** This machine's name on its rows, and as phones and other screens show it: never `tylers-mbp.lan`. */
export function thisMachineName(): string {
  return os.hostname().trim().split('.')[0].slice(0, 80) || 'this computer';
}

export class ApprovalStore {
  private readonly saveItemStatement: Database.Statement;
  private readonly claimStatement: Database.Statement;
  private readonly saveReportStatement: Database.Statement;
  private readonly ackStatement: Database.Statement;

  constructor(private readonly db: Database.Database, private readonly machine: string) {
    ensureApprovalsSchema(db);
    this.saveItemStatement = db.prepare(`
      INSERT INTO approvals (id, machine, connected_kind, connected_id, connected_name, origin_kind, session_id, pane_id, panel_id, addressee, qn, state, item_json,
        answered_by, closed_by, closed_reason, stale_since, rewritten_from, rewritten_as, delivered_via, delivered_at, decision, created_at, ended_at)
      VALUES (@id, @machine, @connected_kind, @connected_id, @connected_name, @origin_kind, @session_id, @pane_id, @panel_id, 'person', @qn, @state, @item_json,
        @answered_by, @closed_by, @closed_reason, @stale_since, @rewritten_from, @rewritten_as, @delivered_via, @delivered_at, @decision, @created_at, @ended_at)
      ON CONFLICT(id) DO UPDATE SET
        machine = excluded.machine, connected_kind = excluded.connected_kind, connected_id = excluded.connected_id, connected_name = excluded.connected_name,
        origin_kind = excluded.origin_kind, session_id = excluded.session_id, pane_id = excluded.pane_id, panel_id = excluded.panel_id,
        addressee = 'person', qn = excluded.qn, state = excluded.state, item_json = excluded.item_json,
        answered_by = excluded.answered_by, closed_by = excluded.closed_by, closed_reason = excluded.closed_reason, stale_since = excluded.stale_since,
        rewritten_from = excluded.rewritten_from, rewritten_as = excluded.rewritten_as, delivered_via = excluded.delivered_via, delivered_at = excluded.delivered_at,
        decision = excluded.decision, ended_at = excluded.ended_at`);
    this.claimStatement = db.prepare(`UPDATE approvals SET state = @state, item_json = @item_json, answered_by = @answered_by, closed_by = @closed_by, closed_reason = @closed_reason,
      delivered_via = @delivered_via, delivered_at = @delivered_at, rewritten_as = @rewritten_as, ended_at = @ended_at WHERE id = @id AND state = '${CLAIMABLE}'`);
    this.saveReportStatement = db.prepare(`
      INSERT INTO approvals (id, machine, connected_kind, connected_id, connected_name, origin_kind, session_id, pane_id, panel_id, addressee, state, report_json, inbox_session_id, created_at, ended_at)
      VALUES (@id, @machine, 'session', @session_id, @session_name, 'worker', @session_id, @pane_id, @panel_id, 'orchestrator', 'report', @report_json, @session_id, @created_at, NULL)
      ON CONFLICT(id) DO UPDATE SET report_json = excluded.report_json, inbox_session_id = excluded.inbox_session_id, connected_name = excluded.connected_name`);
    this.ackStatement = db.prepare(`UPDATE approvals SET acked_at = @at, ended_at = CASE WHEN item_json IS NULL THEN @at ELSE ended_at END, decision = COALESCE(@decision, decision) WHERE id = @id`);
  }

  /** Saves the person's card; it throws when the card has no connected link. */
  saveItem(item: NotifyItem): void {
    this.saveItemStatement.run(this.itemParams(item));
  }

  /** Saves a change to a card that must still be waiting. False: someone else got there first, and nothing changed. */
  claim(item: NotifyItem): boolean {
    const params = this.itemParams(item);
    return this.claimStatement.run({
      id: params.id, state: params.state, item_json: params.item_json, answered_by: params.answered_by, closed_by: params.closed_by, closed_reason: params.closed_reason,
      delivered_via: params.delivered_via, delivered_at: params.delivered_at, rewritten_as: params.rewritten_as, ended_at: params.ended_at,
    }).changes === 1;
  }

  /** Who holds a card now, read from the row. */
  readItem(id: string): NotifyItem | undefined {
    const row = decodeOptionalBoundary(this.db.prepare('SELECT item_json FROM approvals WHERE id = ?').get(id), itemRowSchema);
    return row?.item_json ? parseItem(row.item_json)[0] : undefined;
  }

  /** Waiting and held cards, oldest first. */
  openItems(): NotifyItem[] {
    return this.items(`state IN ('waiting', 'sent') AND item_json IS NOT NULL`, []);
  }

  /** Cards that ended, or updates posted, at or after `since`, oldest first. */
  recentItems(since: number): NotifyItem[] {
    return this.items(`state NOT IN ('waiting', 'sent', 'report') AND item_json IS NOT NULL AND COALESCE(ended_at, created_at) >= ?`, [since]);
  }

  /** Answers on `sessionId`'s workers' questions with no D-n recorded yet, oldest first. */
  unrecordedAnswers(sessionId: string): NotifyItem[] {
    return this.items(`connected_id = ? AND origin_kind = 'worker' AND state = 'answered' AND decision IS NULL AND item_json IS NOT NULL`, [sessionId]);
  }

  /** Answered items on `sessionId`, the record `runpane inbox` keeps for 7 days, oldest first. */
  answeredRecord(sessionId: string): NotifyItem[] {
    return this.items(`connected_id = ? AND state = 'answered' AND item_json IS NOT NULL`, [sessionId]);
  }

  saveInboxItem(item: RunpaneInboxItem, sessionName: string): void {
    this.saveReportStatement.run({
      id: item.id, machine: this.machine, session_id: item.sessionId, session_name: sessionName, pane_id: item.paneId, panel_id: item.panelId,
      report_json: JSON.stringify(item), created_at: timeOf(item.at),
    });
  }

  ackInboxItem(id: string, at: number, decision?: string): void {
    this.ackStatement.run({ id, at, decision: decision ?? null });
  }

  /** A report the inbox no longer holds because the worker moved on, or for space. */
  dropInboxItem(id: string, at: number): void {
    this.ackStatement.run({ id, at, decision: null });
  }

  /** Records a D-n on an item, however long ago it was acknowledged. */
  recordDecision(id: string, decision: string): boolean {
    const row = this.readItem(id);
    if (!row) return false;
    this.saveItem({ ...row, decision });
    return true;
  }

  unackedInboxItems(): RunpaneInboxItem[] {
    const rows = decodeBoundary(this.db.prepare(`SELECT report_json FROM approvals WHERE report_json IS NOT NULL AND acked_at IS NULL ORDER BY created_at, rowid`).all(), boundary.array(reportRowSchema));
    return rows.flatMap(row => {
      try {
        // SAFETY: this column is only ever written by this store, from a typed inbox item.
        return [JSON.parse(row.report_json) as RunpaneInboxItem];
      } catch (error) {
        console.warn('[Approvals] Skipping a report that could not be read:', error);
        return [];
      }
    });
  }

  meta(key: string): string | undefined {
    return decodeOptionalBoundary(this.db.prepare('SELECT value FROM approvals_meta WHERE key = ?').get(key), boundary.object({ value: boundary.string }))?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO approvals_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** Drops what ended more than 7 days ago. Returns how many rows went. */
  prune(now: number): number {
    return this.db.prepare('DELETE FROM approvals WHERE ended_at IS NOT NULL AND ended_at < ?').run(now - APPROVAL_RETENTION_MS).changes;
  }

  /** Runs several writes as one. */
  transaction(writes: () => void): void {
    this.db.transaction(writes)();
  }

  /** Every row, for the import's counts and checks. */
  count(): number {
    return decodeBoundary(this.db.prepare('SELECT COUNT(*) AS count FROM approvals').get(), boundary.object({ count: boundary.number })).count;
  }

  private items(where: string, params: Array<string | number>): NotifyItem[] {
    const rows = decodeBoundary(this.db.prepare(`SELECT item_json FROM approvals WHERE ${where} ORDER BY created_at, rowid`).all(...params), boundary.array(itemRowSchema));
    return rows.flatMap(row => (row.item_json ? parseItem(row.item_json) : []));
  }

  private itemParams(item: NotifyItem) {
    const connected = connectedOf(item, this.machine);
    // The row carries what the store itself knows, so a reader of the record never has to guess.
    const stored: NotifyItem = { ...item, connected, originKind: originOf(item) };
    const ended = item.state === 'answered' || item.state === 'expired' ? item.resolvedAt ?? Date.now() : item.state === 'info' ? item.createdAt : null;
    return {
      id: item.id,
      machine: this.machine,
      connected_kind: connected.kind,
      connected_id: connected.id,
      connected_name: connected.name,
      origin_kind: originOf(item),
      session_id: connected.kind === 'session' ? connected.id : null,
      pane_id: item.source.paneId ?? null,
      panel_id: item.source.panelId ?? null,
      qn: leadingQnOf(item.title),
      state: item.state,
      item_json: JSON.stringify(stored),
      answered_by: item.answeredBy?.by ?? null,
      closed_by: item.closed?.by ?? null,
      closed_reason: item.closed?.reason ?? null,
      stale_since: item.staleSince ?? null,
      rewritten_from: item.rewrittenFrom?.id ?? null,
      rewritten_as: item.rewrittenAs?.id ?? null,
      delivered_via: item.delivered?.via ?? null,
      delivered_at: item.delivered?.at ?? null,
      decision: item.decision ?? null,
      created_at: item.createdAt,
      ended_at: ended,
    };
  }
}

/** A row holds what `saveItem` wrote from a typed item. An unreadable one is skipped, not fatal to a start. */
function parseItem(json: string): NotifyItem[] {
  try {
    // SAFETY: this column is only ever written by this store, from a typed NotifyItem.
    return [JSON.parse(json) as NotifyItem];
  } catch (error) {
    console.warn('[Approvals] Skipping a row that could not be read:', error);
    return [];
  }
}

function timeOf(at: string): number {
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function leadingQnOf(title: string): string | null {
  return /^\s*(Q-\d+)/.exec(title)?.[1] ?? null;
}
