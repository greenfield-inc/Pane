import { PaneError, reasonOf } from '../../../shared/paneError';
import { createHash } from 'crypto';
import { boundary, decodeBoundary, decodeOptionalBoundary, type JsonValue } from '../../../shared/validation/boundaryDecoder';
import type { WorkspaceJournal } from './workspaceJournal';
import type { ApprovalStore } from './approvals/approvalStore';
import type {
  RunpaneInboxItem,
  RunpaneInboxItemKind,
  RunpaneWorkspaceEntry,
  RunpaneWorkspaceEntryKind,
} from '../../../shared/types/runpaneOrchestration';

/**
 * Session inbox: per Session, the worker reports, missing reports, and on-screen questions its
 * orchestrator has not acknowledged. It is fed from the workspace journal, so it holds what a dead
 * or never-armed watcher would have missed, and it survives restarts in the approvals table: a
 * blocked report shares its row with the question's card.
 */

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
/** The session-inbox.json that older builds kept, read once by the import. */
const inboxFileSchema = boundary.object({
  version: boundary.literal(1),
  items: boundary.array(boundary.json),
  epoch: boundary.optional(boundary.string),
  generation: boundary.optional(boundary.number),
});

/** Which ids an acknowledgement cleared, and which matched no item. */
export interface SessionInboxAckOutcome {
  acknowledged: string[];
  unknown: string[];
}

/** How an item left the inbox, for the card it may share a row with. */
export interface SessionInboxEnded {
  id: string;
  /** `acked`: its orchestrator dealt with it. `moved-on`: the worker reported again. */
  how: 'acked' | 'moved-on';
  /** The D-n the orchestrator recorded, with `inbox ack --decision`. */
  decision?: string;
}

/** What the inbox keeps in the table: its rows and its place in the journal. */
export type SessionInboxStore = Pick<ApprovalStore, 'unackedInboxItems' | 'saveInboxItem' | 'ackInboxItem' | 'dropInboxItem' | 'meta' | 'setMeta' | 'recordDecision' | 'transaction'>;

/** One-time import of session-inbox.json (see importJsonStoreOnce): writes its rows and its place in the journal. */
export function importSessionInboxFile(parsed: JsonValue, store: Pick<SessionInboxStore, 'saveInboxItem' | 'setMeta'>, sessionName: (sessionId: string) => string): number {
  const file = decodeBoundary(parsed, inboxFileSchema);
  let count = 0;
  for (const value of file.items) {
    const item: RunpaneInboxItem | undefined = decodeOptionalBoundary(value, itemSchema);
    if (!item) continue;
    store.saveInboxItem(item, sessionName(item.sessionId));
    count += 1;
  }
  if (file.epoch) store.setMeta(EPOCH_KEY, file.epoch);
  if (file.generation !== undefined) store.setMeta(GENERATION_KEY, String(file.generation));
  return count;
}

const EPOCH_KEY = 'inbox.epoch';
const GENERATION_KEY = 'inbox.generation';

export interface SessionInboxOptions {
  /** The Sessions a Pane (and panel) belongs to, never counting a Session's own orchestrator. */
  sessionIdsFor(paneId: string, panelId: string): string[];
  /** How many items a Session keeps; the oldest go first. */
  itemsPerSession(): number;
  /** The name a Session's rows carry. */
  sessionName?(sessionId: string): string;
}

export class SessionInbox {
  private loaded = false;
  private items: RunpaneInboxItem[] = [];
  private epoch?: string;
  private generation = 0;
  private unsubscribe?: () => void;
  private readonly listeners = new Set<() => void>();
  private readonly endedListeners = new Set<(ended: SessionInboxEnded) => void>();

  constructor(
    private readonly store: SessionInboxStore,
    private readonly options: SessionInboxOptions,
  ) {}

  /** Starts feeding the inbox from `journal`. */
  attach(journal: WorkspaceJournal): void {
    this.unsubscribe?.();
    this.ensureLoaded();
    if (this.epoch && this.epoch !== journal.epoch) {
      console.warn('[SessionInbox] Journal was replaced; inbox history before the new epoch cannot be recovered.');
      this.generation = 0;
    }
    this.epoch = journal.epoch;
    const recovered = journal.readAfter(this.generation, {
      kinds: ['agent.report', 'agent.report.missing', 'agent.blocked', ...UNBLOCKING_KINDS],
    }, Number.MAX_SAFE_INTEGER);
    if (recovered.dropped) console.warn(`[SessionInbox] ${recovered.dropped} journal entries expired before inbox recovery; older unprojected outcomes cannot be recovered.`);
    for (const entry of recovered.entries) this.observe(entry);
    this.generation = recovered.generation;
    this.replace(this.items);
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

  /** Every Session's unacknowledged items, oldest first (Approvals' fallback reads them). */
  all(): RunpaneInboxItem[] {
    this.ensureLoaded();
    return this.items.map(item => structuredClone(item));
  }

  /** Hears every change to the items: a new item, an ack, or a panel that stopped waiting. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Hears each item that left: its card, if it has one, follows. */
  subscribeEnded(listener: (ended: SessionInboxEnded) => void): () => void {
    this.endedListeners.add(listener);
    return () => { this.endedListeners.delete(listener); };
  }

  /**
   * Clears the items with these ids, limited to one Session when `sessionId` is given. A `decision`
   * is recorded on each, including one already cleared whose answer came back later (J8, J9).
   */
  ack(ids: readonly string[], sessionId?: string, decision?: string): SessionInboxAckOutcome {
    this.ensureLoaded();
    const wanted = new Set(ids);
    const matched = this.items.filter(item => wanted.has(item.id) && (sessionId === undefined || item.sessionId === sessionId));
    const acknowledged = matched.map(item => item.id);
    const cleared = new Set(acknowledged);
    if (cleared.size > 0) this.replace(this.items.filter(item => !cleared.has(item.id)), { requireDurable: true, how: 'acked', decision });
    const recorded = decision ? [...wanted].filter(id => !cleared.has(id) && this.store.recordDecision(id, decision)) : [];
    for (const id of recorded) this.emitEnded({ id, how: 'acked', decision });
    return { acknowledged: [...acknowledged, ...recorded], unknown: [...wanted].filter(id => !cleared.has(id) && !recorded.includes(id)) };
  }

  /** Clears every item of a Session. */
  ackAll(sessionId: string): string[] {
    return this.ack(this.list(sessionId).map(item => item.id), sessionId).acknowledged;
  }

  private observe(entry: RunpaneWorkspaceEntry): void {
    this.ensureLoaded();
    this.generation = entry.gen;
    const panelId = entry.panelId;
    if (!panelId || entry.replay || entry.baseline) return;
    let next = this.items;
    const movedOn = new Set<string>();
    if (UNBLOCKING_KINDS.includes(entry.kind)) {
      next = next.filter(item => !(item.kind === 'blocked' && item.panelId === panelId));
    }
    const kind = inboxKindFor(entry.kind);
    if (kind) {
      for (const sessionId of this.options.sessionIdsFor(entry.paneId, panelId)) {
        const superseded: readonly RunpaneInboxItemKind[] = SUPERSEDES[kind];
        next = next.filter(item => {
          const replaced = item.sessionId === sessionId && item.panelId === panelId && superseded.includes(item.kind);
          if (replaced) movedOn.add(item.id);
          return !replaced;
        });
        next = [...next, this.itemFor(entry, panelId, sessionId, kind)];
        next = trimSession(next, sessionId, this.options.itemsPerSession());
      }
    }
    if (next !== this.items) this.replace(next, { how: 'moved-on', ended: movedOn });
  }

  private itemFor(
    entry: RunpaneWorkspaceEntry,
    panelId: string,
    sessionId: string,
    kind: RunpaneInboxItemKind,
  ): RunpaneInboxItem {
    const item: RunpaneInboxItem = {
      id: `in-${createHash('sha256').update(`${this.epoch}:${entry.gen}:${sessionId}`).digest('hex').slice(0, 24)}`,
      sessionId,
      kind,
      at: entry.at,
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

  private replace(items: RunpaneInboxItem[], options: { requireDurable?: boolean; how?: SessionInboxEnded['how']; ended?: Set<string>; decision?: string } = {}): void {
    const previous = this.items;
    this.items = items;
    try {
      this.persist(previous, items, options.decision, options.how === 'acked');
    } catch (error) {
      if (options.requireDurable) {
        this.items = previous;
        throw new PaneError('ERR_RUNPANE_INBOX_ACK_WRITE',
          `Pane could not save the acknowledgement (${reasonOf(error)}); the inbox items remain unacknowledged.`,
          'Check permissions and available space in PANE_DIR, then retry the acknowledgement.');
      }
      console.warn('[SessionInbox] Could not save the inbox; it stays in memory:', error);
    }
    if (items === previous) return;
    if (options.how) {
      const kept = new Set(items.map(item => item.id));
      for (const item of previous) {
        if (kept.has(item.id)) continue;
        // Trimmed for space is not a worker moving on: its card stays until its asker is gone.
        if (options.how === 'acked' || options.ended?.has(item.id)) this.emitEnded({ id: item.id, how: options.how, decision: options.decision });
      }
    }
    for (const listener of [...this.listeners]) listener();
  }

  private emitEnded(ended: SessionInboxEnded): void {
    for (const listener of [...this.endedListeners]) listener(ended);
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.epoch = this.store.meta(EPOCH_KEY);
      this.generation = Number(this.store.meta(GENERATION_KEY) ?? 0) || 0;
      this.items = this.store.unackedInboxItems();
    } catch (error) {
      console.warn('[SessionInbox] Could not read the inbox; it starts empty:', error);
    }
  }

  /** Writes what changed, with the journal watermark, in one transaction. */
  private persist(previous: RunpaneInboxItem[], next: RunpaneInboxItem[], decision: string | undefined, acked: boolean): void {
    const now = Date.now();
    this.store.transaction(() => {
      const before = new Map(previous.map(item => [item.id, item]));
      const after = new Set(next.map(item => item.id));
      for (const item of previous) {
        if (after.has(item.id)) continue;
        if (acked) this.store.ackInboxItem(item.id, now, decision);
        else this.store.dropInboxItem(item.id, now);
      }
      for (const item of next) {
        if (before.get(item.id) !== item) this.store.saveInboxItem(item, this.options.sessionName?.(item.sessionId) ?? item.sessionId);
      }
      if (this.epoch) this.store.setMeta(EPOCH_KEY, this.epoch);
      this.store.setMeta(GENERATION_KEY, String(this.generation));
    });
  }
}

function trimSession(items: RunpaneInboxItem[], sessionId: string, limit: number): RunpaneInboxItem[] {
  const count = items.filter(item => item.sessionId === sessionId).length;
  let excess = count - limit;
  if (excess <= 0) return items;
  return items.filter(item => {
    if (excess > 0 && item.sessionId === sessionId) {
      excess -= 1;
      return false;
    }
    return true;
  });
}
