import type {
  RunpaneWorkspaceEntry,
  RunpaneWorkspaceEntryKind,
} from '../../../shared/types/runpaneOrchestration';
import { isQuietPanelEntry, type WorkspaceJournalFilter } from './workspaceJournal';

export interface WatchCadenceOptions {
  settleMs: number;
  blockedSettleMs: number;
  minIntervalMs: number;
  emitKinds?: readonly RunpaneWorkspaceEntryKind[];
  quietPanelIds?: readonly string[];
  /** Identity of the whole request shape; a different key means a fresh instance. */
  key: string;
}

interface PendingEntry {
  entry: RunpaneWorkspaceEntry;
  matureAt: number;
}

/** Kinds that end a settle window for the same panel (the state moved on). */
const SETTLE_CANCELLING_KINDS: readonly RunpaneWorkspaceEntryKind[] = [
  'agent.busy',
  'agent.blocked',
  'agent.unknown',
  'agent.ready',
  'panel.exited',
];

/** Kinds the cadence must observe for cancellation even when the consumer did not ask for them. */
const OBSERVED_KINDS: readonly RunpaneWorkspaceEntryKind[] = [...SETTLE_CANCELLING_KINDS, 'pane.gone'];

/**
 * Per-consumer shaping of workspace entries: READY/BLOCKED settle windows that a
 * state change cancels silently, and a minimum flush interval that batches
 * non-urgent lines. BLOCKED bypasses the interval once its settle matures, and so do a
 * conflicting PR, failed PR checks, and a worker's report.
 */
export class WatchCadence {
  /** Journal position this instance has read up to; the durable cursor may trail it. */
  readCursor: number | undefined;
  private readonly pending = new Map<string, PendingEntry>();
  private held: RunpaneWorkspaceEntry[] = [];
  private lastFlushAt = 0;

  constructor(readonly options: WatchCadenceOptions) {}

  /** Widen the consumer's filter so state changes it did not ask for still reach `ingest`. */
  static observeFilter(filter: WorkspaceJournalFilter): WorkspaceJournalFilter {
    return { ...filter, quietPanelIds: undefined,
      kinds: filter.kinds ? [...new Set([...filter.kinds, ...OBSERVED_KINDS])] : undefined };
  }

  /**
   * Lowest journal generation still pending or held. The durable cursor must stay
   * below it so a consumer that dies (or a discarded cadence) re-reads the entry.
   * IDLE entries carry a synthetic generation and are excluded.
   */
  lowestUnflushedGen(): number | undefined {
    let lowest: number | undefined;
    const consider = (entry: RunpaneWorkspaceEntry) => {
      if (entry.kind === 'agent.idle') return;
      if (lowest === undefined || entry.gen < lowest) lowest = entry.gen;
    };
    for (const pending of this.pending.values()) consider(pending.entry);
    for (const entry of this.held) consider(entry);
    return lowest;
  }

  ingest(entries: readonly RunpaneWorkspaceEntry[], nowMs: number): void {
    for (const entry of entries) {
      if (entry.kind === 'pane.gone') {
        for (const [panelId, pending] of this.pending) {
          if (pending.entry.paneId === entry.paneId) this.pending.delete(panelId);
        }
      } else if (entry.panelId && SETTLE_CANCELLING_KINDS.includes(entry.kind)) {
        this.pending.delete(entry.panelId);
      }

      const settleMs = entry.kind === 'agent.ready'
        ? this.options.settleMs
        : entry.kind === 'agent.blocked' ? this.options.blockedSettleMs : 0;
      if (settleMs > 0 && entry.panelId) {
        if (this.emits(entry)) {
          this.pending.set(entry.panelId, { entry, matureAt: entryTimeMs(entry, nowMs) + settleMs });
        }
        continue;
      }
      this.hold(entry);
    }
  }

  flush(nowMs: number): RunpaneWorkspaceEntry[] {
    for (const [panelId, pending] of [...this.pending]) {
      if (pending.matureAt > nowMs) continue;
      this.pending.delete(panelId);
      this.held.push({ ...pending.entry, settledMs: Math.max(0, nowMs - entryTimeMs(pending.entry, nowMs)) });
    }
    if (this.held.length === 0) return [];
    if (!this.hasUrgentHeld() && nowMs < this.lastFlushAt + this.options.minIntervalMs) return [];
    const flushed = this.held;
    this.held = [];
    this.lastFlushAt = nowMs;
    return flushed;
  }

  nextDeadline(nowMs: number): number | undefined {
    const deadlines: number[] = [];
    for (const pending of this.pending.values()) deadlines.push(pending.matureAt);
    if (this.held.length > 0) {
      deadlines.push(this.hasUrgentHeld() ? nowMs : this.lastFlushAt + this.options.minIntervalMs);
    }
    return deadlines.length > 0 ? Math.min(...deadlines) : undefined;
  }

  private hasUrgentHeld(): boolean {
    return this.held.some(isUrgentEntry);
  }

  private hold(entry: RunpaneWorkspaceEntry): void {
    if (this.emits(entry)) this.held.push(entry);
  }

  private emits(entry: RunpaneWorkspaceEntry): boolean {
    return (!this.options.emitKinds || this.options.emitKinds.includes(entry.kind))
      && !isQuietPanelEntry(entry, this.options.quietPanelIds);
  }
}

/** Entries that need action now, so they flush without waiting for the minimum interval. */
function isUrgentEntry(entry: RunpaneWorkspaceEntry): boolean {
  return entry.kind === 'agent.blocked' || entry.kind === 'agent.report'
    || entry.kind === 'pr.conflicted'
    || (entry.kind === 'pr.checks' && entry.checks === 'failed');
}

function entryTimeMs(entry: RunpaneWorkspaceEntry, fallback: number): number {
  const parsed = Date.parse(entry.at);
  return Number.isFinite(parsed) ? parsed : fallback;
}
