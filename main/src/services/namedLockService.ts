import type { PaneEventArgument, PaneEventSink } from '../core/eventSink';
import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import type {
  RunpaneLockAcquireResult,
  RunpaneLockOwner,
  RunpaneLockRecord,
  RunpaneLockReleaseResult,
} from '../../../shared/types/runpaneOrchestration';
import {
  MAX_NAMED_LOCKS,
  MAX_NAMED_LOCK_TEXT_LENGTH,
  NAMED_LOCK_NAME_PATTERN,
  namedLockKey,
  type NamedLockStore,
} from './namedLockStore';

/** Longest TTL a lock may ask for; renew before it runs out to hold a lock longer. */
const MAX_NAMED_LOCK_TTL_MS = 24 * 60 * 60 * 1000;
/** Longest single timer delay Node accepts without overflowing. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const terminalExitEventSchema = boundary.object({
  type: boundary.string,
  source: boundary.object({ panelId: boundary.string }),
});
const paneGoneEventSchema = boundary.object({ id: boundary.string });

export interface NamedLockAcquireInput {
  name: string;
  ttlMs: number;
  waitMs?: number;
  note?: string;
  owner: RunpaneLockOwner;
  /** The owner's Session; undefined puts the lock in the global scope. */
  sessionId?: string;
}

export interface NamedLockReleaseInput {
  name: string;
  owner: RunpaneLockOwner;
  sessionId?: string;
  force?: boolean;
}

export interface NamedLockListFilter {
  sessionId: string;
  /** Panes that belong to the Session; their locks are listed whatever their scope. */
  paneIds: readonly string[];
}

interface NamedLockServiceOptions {
  now?: () => number;
  /** Called once when the store loads; Pane-owned locks whose owner is gone are dropped. */
  isOwnerLive?: (owner: RunpaneLockOwner) => boolean;
  log?: (message: string, error: Error) => void;
}

interface LockWaiter {
  input: NamedLockAcquireInput;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: RunpaneLockAcquireResult) => void;
  reject: (error: Error) => void;
}

/**
 * Named locks for resources shared between agents, such as one test account.
 *
 * The daemon owns every lock: an acquire succeeds when the lock is free,
 * expired, or already held by the same owner (which renews its TTL). A waiting
 * acquire parks here and is granted, oldest first, the moment the lock is
 * released, expires, or its owner's panel exits or Pane is archived. Locks are
 * saved to `<paneDir>/locks.json` so they survive a daemon restart.
 */
export class NamedLockService implements PaneEventSink {
  private locks = new Map<string, RunpaneLockRecord>();
  private loaded = false;
  private autoReleaseSuspended = false;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly waiters = new Map<string, LockWaiter[]>();
  private readonly now: () => number;

  constructor(
    private readonly store: NamedLockStore,
    private readonly options: NamedLockServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  acquire(input: NamedLockAcquireInput): Promise<RunpaneLockAcquireResult> {
    validateAcquireInput(input);
    this.ensureLoaded();
    const startedAt = this.now();
    this.pruneExpired(startedAt);
    const key = namedLockKey(input.name, input.sessionId);
    const held = this.locks.get(key);
    if (!held || sameOwner(held.owner, input.owner)) {
      return Promise.resolve(this.grant(input, startedAt, held));
    }
    const waitMs = Math.max(0, input.waitMs ?? 0);
    if (waitMs === 0) return Promise.resolve(contendedResult(held, 0, false));
    return new Promise((resolve, reject) => {
      const waiter: LockWaiter = {
        input,
        startedAt,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeWaiter(key, waiter);
          try {
            // The lock may have expired without the expiry timer having run yet;
            // a free lock is granted, not refused.
            this.pruneExpired(this.now());
            const holder = this.locks.get(key);
            resolve(holder && !sameOwner(holder.owner, input.owner)
              ? contendedResult(holder, this.now() - startedAt, true)
              : this.grant(input, startedAt, holder));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        }, Math.min(waitMs, MAX_TIMER_DELAY_MS)),
      };
      const queue = this.waiters.get(key) ?? [];
      queue.push(waiter);
      this.waiters.set(key, queue);
    });
  }

  release(input: NamedLockReleaseInput): RunpaneLockReleaseResult {
    this.ensureLoaded();
    this.pruneExpired(this.now());
    const scopedKey = namedLockKey(input.name, input.sessionId);
    const scoped = this.locks.get(scopedKey);
    // A lock taken before its Pane joined a Session keeps its original scope;
    // let the owner release it without naming that scope.
    const ownedElsewhere = scoped || input.force
      ? undefined
      : [...this.locks.entries()].find(([, lock]) => lock.name === input.name && sameOwner(lock.owner, input.owner));
    const [key, lock] = scoped ? [scopedKey, scoped] : ownedElsewhere ?? [scopedKey, undefined];
    if (!lock) return { ok: true, released: false, forced: false };
    const owned = sameOwner(lock.owner, input.owner);
    if (!owned && !input.force) {
      return { ok: false, released: false, reason: 'not-owner', heldBy: cloneOwner(lock.owner), expiresAt: lock.expiresAt, lock: cloneLock(lock) };
    }
    this.removeLocks([key]);
    return { ok: true, released: true, forced: !owned, lock: cloneLock(lock) };
  }

  /** Every live lock, or a Session's locks: those scoped to it plus those its Panes hold. */
  list(filter?: NamedLockListFilter): RunpaneLockRecord[] {
    this.ensureLoaded();
    this.pruneExpired(this.now());
    const paneIds = new Set(filter?.paneIds ?? []);
    return [...this.locks.values()]
      .filter(lock => !filter
        || lock.sessionId === filter.sessionId
        || (lock.owner.kind === 'pane' && lock.owner.paneId !== undefined && paneIds.has(lock.owner.paneId)))
      .sort((left, right) => left.name.localeCompare(right.name) || (left.sessionId ?? '').localeCompare(right.sessionId ?? ''))
      .map(cloneLock);
  }

  /** Release the locks a panel holds; called when its terminal exits or is closed. */
  releaseOwnedByPanel(panelId: string): RunpaneLockRecord[] {
    this.cancelWaiters(owner => owner.kind === 'pane' && owner.panelId === panelId);
    return this.releaseWhere(lock => lock.owner.kind === 'pane' && lock.owner.panelId === panelId);
  }

  /** Release the locks a Pane or any of its panels holds; called when the Pane is archived or deleted. */
  releaseOwnedByPane(paneId: string): RunpaneLockRecord[] {
    this.cancelWaiters(owner => owner.kind === 'pane' && owner.paneId === paneId);
    return this.releaseWhere(lock => lock.owner.kind === 'pane' && lock.owner.paneId === paneId);
  }

  send(channel: string, ...args: PaneEventArgument[]): void {
    if (this.autoReleaseSuspended) return;
    try {
      if (channel === 'panel:event') {
        const payload = decodeOptionalBoundary(args[0], terminalExitEventSchema);
        if (payload?.type === 'terminal:exit') this.releaseOwnedByPanel(payload.source.panelId);
        return;
      }
      if (channel === 'session:deleted') {
        const payload = decodeOptionalBoundary(args[0], paneGoneEventSchema);
        if (payload) this.releaseOwnedByPane(payload.id);
      }
    } catch (error) {
      this.options.log?.('[NamedLocks] Failed to release locks after an owner event', error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Stop releasing locks on panel exit. Pane quits by ending every terminal;
   * those exits are not the owners giving their locks up, and the resumed
   * agents still expect to hold them after the restart.
   */
  suspendAutoRelease(): void {
    this.autoReleaseSuspended = true;
  }

  dispose(): void {
    this.suspendAutoRelease();
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    const now = this.now();
    for (const [key, queue] of this.waiters) {
      const holder = this.locks.get(key);
      for (const waiter of queue) {
        clearTimeout(waiter.timer);
        if (holder) waiter.resolve(contendedResult(holder, now - waiter.startedAt, true));
        else waiter.reject(new Error('Pane is shutting down; retry the lock after it restarts.'));
      }
    }
    this.waiters.clear();
  }

  private grant(input: NamedLockAcquireInput, startedAt: number, held: RunpaneLockRecord | undefined): RunpaneLockAcquireResult {
    const now = this.now();
    const key = namedLockKey(input.name, input.sessionId);
    if (!held && !this.locks.has(key) && this.locks.size >= MAX_NAMED_LOCKS) {
      throw new Error(`Pane holds ${MAX_NAMED_LOCKS} named locks already; release some before acquiring more.`);
    }
    const lock: RunpaneLockRecord = {
      name: input.name,
      scope: input.sessionId ? 'session' : 'global',
      sessionId: input.sessionId,
      owner: cloneOwner(input.owner),
      note: input.note ?? held?.note,
      acquiredAt: held?.acquiredAt ?? new Date(now).toISOString(),
      expiresAt: new Date(now + input.ttlMs).toISOString(),
      ttlMs: input.ttlMs,
    };
    if (lock.sessionId === undefined) delete lock.sessionId;
    if (lock.note === undefined) delete lock.note;
    const next = new Map(this.locks);
    next.set(key, lock);
    this.commit(next);
    return { ok: true, acquired: true, renewed: held !== undefined, waitedMs: now - startedAt, lock: cloneLock(lock) };
  }

  private cancelWaiters(matches: (owner: RunpaneLockOwner) => boolean): void {
    for (const [key, queue] of this.waiters) {
      for (const waiter of queue) {
        if (!matches(waiter.input.owner)) continue;
        clearTimeout(waiter.timer);
        this.removeWaiter(key, waiter);
        waiter.reject(new Error('Lock wait cancelled because its owner exited or was archived.'));
      }
    }
  }

  private releaseWhere(predicate: (lock: RunpaneLockRecord) => boolean): RunpaneLockRecord[] {
    this.ensureLoaded();
    const released = [...this.locks.entries()].filter(([, lock]) => predicate(lock));
    if (released.length > 0) this.removeLocks(released.map(([key]) => key));
    return released.map(([, lock]) => cloneLock(lock));
  }

  /** Drop locks, save, then hand each freed lock to its oldest waiter. */
  private removeLocks(keys: readonly string[]): void {
    const next = new Map(this.locks);
    for (const key of keys) next.delete(key);
    this.commit(next);
    for (const key of keys) this.grantNextWaiter(key);
  }

  private grantNextWaiter(key: string): void {
    const queue = this.waiters.get(key);
    const waiter = queue?.shift();
    if (queue?.length === 0) this.waiters.delete(key);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    try {
      waiter.resolve(this.grant(waiter.input, waiter.startedAt, undefined));
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.options.log?.('[NamedLocks] Failed to grant a waiting lock', failure);
      waiter.reject(failure);
    }
  }

  private removeWaiter(key: string, waiter: LockWaiter): void {
    const queue = this.waiters.get(key)?.filter(entry => entry !== waiter) ?? [];
    if (queue.length > 0) this.waiters.set(key, queue);
    else this.waiters.delete(key);
  }

  private pruneExpired(now: number): void {
    const expired = [...this.locks.entries()]
      .filter(([, lock]) => Date.parse(lock.expiresAt) <= now)
      .map(([key]) => key);
    if (expired.length > 0) this.removeLocks(expired);
  }

  /** Publish a new lock map: save first, so memory never runs ahead of disk. */
  private commit(next: Map<string, RunpaneLockRecord>): void {
    this.store.write([...next.values()]);
    this.locks = next;
    this.scheduleExpiry();
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    if (this.locks.size === 0) return;
    const nextExpiry = Math.min(...[...this.locks.values()].map(lock => Date.parse(lock.expiresAt)));
    const delay = Math.min(Math.max(0, nextExpiry - this.now()), MAX_TIMER_DELAY_MS);
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined;
      try {
        this.pruneExpired(this.now());
      } catch (error) {
        this.options.log?.('[NamedLocks] Failed to expire locks', error instanceof Error ? error : new Error(String(error)));
      }
      if (!this.expiryTimer) this.scheduleExpiry();
    }, delay);
    this.expiryTimer.unref?.();
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    const now = this.now();
    const saved = this.store.read();
    const live = saved.filter(lock => Date.parse(lock.expiresAt) > now
      && (lock.owner.kind !== 'pane' || (this.options.isOwnerLive?.(lock.owner) ?? true)));
    this.locks = new Map(live.map(lock => [namedLockKey(lock.name, lock.sessionId), lock]));
    this.loaded = true;
    if (live.length !== saved.length) this.commit(this.locks);
    else this.scheduleExpiry();
  }
}

function validateAcquireInput(input: NamedLockAcquireInput): void {
  if (!NAMED_LOCK_NAME_PATTERN.test(input.name)) {
    throw new Error('Lock names are 1-128 characters of letters, digits, ".", "_", or "-".');
  }
  if (!Number.isInteger(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > MAX_NAMED_LOCK_TTL_MS) {
    throw new Error('Lock TTL must be a whole number of milliseconds between 1 and 86400000 (24h).');
  }
  if (input.waitMs !== undefined && (!Number.isFinite(input.waitMs) || input.waitMs < 0)) {
    throw new Error('Lock wait must be a non-negative number of milliseconds.');
  }
  if (input.note !== undefined && input.note.length > MAX_NAMED_LOCK_TEXT_LENGTH) {
    throw new Error(`Lock notes are at most ${MAX_NAMED_LOCK_TEXT_LENGTH} characters.`);
  }
}

function sameOwner(left: RunpaneLockOwner, right: RunpaneLockOwner): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'external') return left.label === right.label;
  return left.paneId === right.paneId && (left.panelId ?? null) === (right.panelId ?? null);
}

function contendedResult(holder: RunpaneLockRecord, waitedMs: number, timedOut: boolean): RunpaneLockAcquireResult {
  return {
    ok: false,
    acquired: false,
    timedOut,
    waitedMs,
    heldBy: cloneOwner(holder.owner),
    expiresAt: holder.expiresAt,
    lock: cloneLock(holder),
  };
}

function cloneOwner(owner: RunpaneLockOwner): RunpaneLockOwner {
  return { ...owner };
}

function cloneLock(lock: RunpaneLockRecord): RunpaneLockRecord {
  return { ...lock, owner: cloneOwner(lock.owner) };
}
