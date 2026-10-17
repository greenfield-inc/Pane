import fs from 'fs';
import path from 'path';
import { randomBytes, randomUUID } from 'crypto';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import type { WorkspaceJournal } from './workspaceJournal';
import type {
  RunpaneInboxItem,
  RunpaneInboxItemKind,
  RunpaneWorkspaceEntry,
  RunpaneWorkspaceEntryKind,
} from '../../../shared/types/runpaneOrchestration';

/**
 * Session inbox: per Session, the worker reports, missing reports, and on-screen questions its
 * orchestrator has not acknowledged. It is fed from the workspace journal, so it holds what a dead
 * or never-armed watcher would have missed, and it survives restarts in `session-inbox.json`.
 */

/** A Session keeps at most this many items; the oldest go first. */
export const MAX_INBOX_ITEMS_PER_SESSION = 200;

/** The inbox item a journal entry becomes, if any. */
function inboxKindFor(kind: RunpaneWorkspaceEntryKind): RunpaneInboxItemKind | undefined {
  if (kind === 'agent.report') return 'report';
  if (kind === 'agent.report.missing') return 'report.missing';
  if (kind === 'agent.blocked') return 'blocked';
  return undefined;
}
/** Entries that mean a panel is no longer waiting on the question its `blocked` item describes. */
const UNBLOCKING_KINDS: readonly RunpaneWorkspaceEntryKind[] = [
  'agent.busy',
  'agent.ready',
  'agent.idle',
  'agent.report',
  'panel.exited',
];
/** A new item replaces the panel's older items of these kinds. */
const SUPERSEDES = {
  report: ['report', 'report.missing'],
  'report.missing': ['report.missing'],
  blocked: ['blocked'],
} satisfies Record<RunpaneInboxItemKind, readonly RunpaneInboxItemKind[]>;

const reportSchema = boundary.object({
  state: boundary.enumeration('ready', 'blocked', 'failed', 'done'),
  pr: boundary.optional(boundary.number),
  head: boundary.optional(boundary.string),
  summary: boundary.optional(boundary.string),
  summaryTruncated: boundary.optional(boundary.literal(true)),
  summaryPath: boundary.optional(boundary.string),
  question: boundary.optional(boundary.string),
  reportedAt: boundary.string,
});
const itemSchema = boundary.object({
  id: boundary.nonEmptyString,
  sessionId: boundary.nonEmptyString,
  kind: boundary.enumeration('report', 'report.missing', 'blocked'),
  at: boundary.string,
  paneId: boundary.string,
  paneName: boundary.string,
  panelId: boundary.string,
  panelTitle: boundary.optional(boundary.string),
  agentType: boundary.optional(boundary.string),
  report: boundary.optional(reportSchema),
  lastOutput: boundary.optional(boundary.string),
  lastOutputSource: boundary.optional(boundary.enumeration('transcript', 'screen')),
  reason: boundary.optional(boundary.string),
  screenLines: boundary.optional(boundary.array(boundary.string)),
});
const inboxFileSchema = boundary.object({
  version: boundary.literal(1),
  items: boundary.array(boundary.json),
});

/** Which ids an acknowledgement cleared, and which matched no item. */
export interface SessionInboxAckOutcome {
  acknowledged: string[];
  unknown: string[];
}

export interface SessionInboxOptions {
  /** The Sessions a Pane (and panel) belongs to, never counting a Session's own orchestrator. */
  sessionIdsFor(paneId: string, panelId: string): string[];
  now?: () => number;
}

export class SessionInbox {
  private loaded = false;
  private items: RunpaneInboxItem[] = [];
  private readonly now: () => number;
  private unsubscribe?: () => void;

  constructor(
    private readonly filePath: string,
    private readonly options: SessionInboxOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  /** Starts feeding the inbox from `journal`. */
  attach(journal: WorkspaceJournal): void {
    this.unsubscribe?.();
    this.unsubscribe = journal.subscribe(entry => this.observe(entry));
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** The Session's unacknowledged items, oldest first. */
  list(sessionId: string): RunpaneInboxItem[] {
    this.ensureLoaded();
    return this.items.filter(item => item.sessionId === sessionId).map(item => structuredClone(item));
  }

  /** Clears the items with these ids, limited to one Session when `sessionId` is given. */
  ack(ids: readonly string[], sessionId?: string): SessionInboxAckOutcome {
    this.ensureLoaded();
    const wanted = new Set(ids);
    const acknowledged = this.items
      .filter(item => wanted.has(item.id) && (sessionId === undefined || item.sessionId === sessionId))
      .map(item => item.id);
    const cleared = new Set(acknowledged);
    if (cleared.size > 0) this.replace(this.items.filter(item => !cleared.has(item.id)));
    return { acknowledged, unknown: [...wanted].filter(id => !cleared.has(id)) };
  }

  /** Clears every item of a Session. */
  ackAll(sessionId: string): string[] {
    return this.ack(this.list(sessionId).map(item => item.id), sessionId).acknowledged;
  }

  private observe(entry: RunpaneWorkspaceEntry): void {
    const panelId = entry.panelId;
    if (!panelId || entry.replay || entry.baseline) return;
    this.ensureLoaded();
    let next = this.items;
    if (UNBLOCKING_KINDS.includes(entry.kind)) {
      next = next.filter(item => !(item.kind === 'blocked' && item.panelId === panelId));
    }
    const kind = inboxKindFor(entry.kind);
    if (kind) {
      for (const sessionId of this.options.sessionIdsFor(entry.paneId, panelId)) {
        const superseded: readonly RunpaneInboxItemKind[] = SUPERSEDES[kind];
        next = next.filter(item =>
          !(item.sessionId === sessionId && item.panelId === panelId && superseded.includes(item.kind)));
        next = [...next, this.itemFor(entry, panelId, sessionId, kind)];
        next = trimSession(next, sessionId);
      }
    }
    if (next !== this.items) this.replace(next);
  }

  private itemFor(
    entry: RunpaneWorkspaceEntry,
    panelId: string,
    sessionId: string,
    kind: RunpaneInboxItemKind,
  ): RunpaneInboxItem {
    const item: RunpaneInboxItem = {
      id: `in-${randomBytes(4).toString('hex')}`,
      sessionId,
      kind,
      at: new Date(this.now()).toISOString(),
      paneId: entry.paneId,
      paneName: entry.paneName,
      panelId,
    };
    if (entry.panelTitle) item.panelTitle = entry.panelTitle;
    if (entry.agentType) item.agentType = entry.agentType;
    if (entry.report) item.report = { ...entry.report };
    if (entry.lastOutput) item.lastOutput = entry.lastOutput;
    if (entry.lastOutputSource) item.lastOutputSource = entry.lastOutputSource;
    if (entry.reason) item.reason = entry.reason;
    if (entry.screenLines?.length) item.screenLines = [...entry.screenLines];
    return item;
  }

  private replace(items: RunpaneInboxItem[]): void {
    this.items = items;
    try {
      this.persist();
    } catch (error) {
      console.warn('[SessionInbox] Could not save the inbox; it stays in memory:', error);
    }
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = decodeBoundary(JSON.parse(fs.readFileSync(this.filePath, 'utf8')), inboxFileSchema);
      this.items = parsed.items.flatMap(value => {
        const item: RunpaneInboxItem | undefined = decodeOptionalBoundary(value, itemSchema);
        return item ? [item] : [];
      });
    } catch (error) {
      const details = decodeOptionalBoundary(error, boundary.object({ code: boundary.optional(boundary.string) }));
      if (details?.code !== 'ENOENT') console.warn('[SessionInbox] Ignoring an unreadable inbox file:', error);
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify({ version: 1, items: this.items }, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, this.filePath);
    } finally {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
  }
}

function trimSession(items: RunpaneInboxItem[], sessionId: string): RunpaneInboxItem[] {
  const count = items.filter(item => item.sessionId === sessionId).length;
  let excess = count - MAX_INBOX_ITEMS_PER_SESSION;
  if (excess <= 0) return items;
  return items.filter(item => {
    if (excess > 0 && item.sessionId === sessionId) {
      excess -= 1;
      return false;
    }
    return true;
  });
}
