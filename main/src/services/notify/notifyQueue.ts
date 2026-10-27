import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type {
  NotifyAnswer,
  NotifyInstructionsFile,
  NotifyItem,
  NotifyQuestion,
  NotifyRemindAfter,
  NotifyRemoteCommand,
  NotifyResult,
  NotifySettings,
  NotifySharedState,
  NotifySnapshot,
  NotifySource,
  NotifyStripView,
} from '../../../../shared/types/notify';
import { PaneError } from '../../../../shared/paneError';

/** Pane holds an answer this long so Undo can take it back. */
const NOTIFY_UNDO_MS = 3_000;
/** The "stopped waiting" card shows this long before it hides. */
const NOTIFY_EXPIRED_SHOW_MS = 3_000;
/** A client on the resume loop must call again within this long, or it stopped waiting. */
const NOTIFY_RESUME_GRACE_MS = 30_000;
/** A client on the resume loop gets `unavailable` after this long without an answer (D-2). */
const NOTIFY_RESUME_CAP_MS = 15 * 60_000;
/** An agent whose panel sits idle this long while its call is open has stopped waiting. */
const NOTIFY_IDLE_BACKSTOP_MS = 10_000;
/** Earlier today and updates keep at most this many entries. */
const HISTORY_LIMIT = 100;

const REMIND_AFTER_MS = { '10m': 10 * 60_000, '1h': 60 * 60_000 } satisfies Record<Exclude<NotifyRemindAfter, 'pane'>, number>;
const ASK_IN_TERMINAL = 'Ask in the terminal instead.';

type Timer = ReturnType<typeof setTimeout>;

interface Waiter {
  resolve: (result: NotifyResult) => void;
  detach: () => void;
}

interface Entry {
  item: NotifyItem;
  waiter?: Waiter;
  /** An answer reached while a resume-loop client was between calls; the next resume takes it. */
  pending?: NotifyResult;
  /** The client returned `waiting` at least once. */
  resumeLoop: boolean;
  holdTimer?: Timer;
  graceTimer?: Timer;
  remindTimer?: Timer;
  idleTimer?: Timer;
  remindOnPaneFocus?: boolean;
}

export interface NotifyQueueEnvironment {
  settings: () => NotifySettings;
  showOutsideSupported: boolean;
  shortcutRegistered: () => boolean;
  instructionFiles: () => NotifyInstructionsFile[];
  /** This machine's name, as connected screens and phones show it. */
  machine?: string;
}

/** A connected host's questions, shown beside this machine's own. */
interface RemoteQueue {
  machine: string;
  online: boolean;
  items: Map<string, NotifyItem>;
  queue: string[];
  hidden: Set<string>;
}

/**
 * The one place that holds every question and update, decides what shows where, and resolves
 * each waiting call. Events: `change` after any state change, `chime` when a question arrives
 * that should make a sound.
 */
export class NotifyQueue extends EventEmitter {
  private readonly entries = new Map<string, Entry>();
  /** Waiting question ids, oldest first. */
  private queue: string[] = [];
  private readonly hidden = new Set<string>();
  private transient: { view: NotifyStripView; timer?: Timer } | null = null;
  private paneFocused = false;
  private roundOpen = false;
  private pausedUntil: number | null = null;
  private pauseTimer?: Timer;
  private dockedItemId: string | null = null;
  /** The first question ever on a strip carries the "Click to answer" hint for as long as it shows. */
  private hintItemId: string | undefined;
  private midnightTimer?: Timer;
  private remote: RemoteQueue | null = null;
  /** The host's questions this screen answered: they read "Sent to", not "Answered on". */
  private readonly answeredHere = new Set<string>();
  /** The host's questions reminded "when I switch to Pane": hidden on this screen only. */
  private readonly remindedHere = new Set<string>();

  constructor(private readonly env: NotifyQueueEnvironment) {
    super();
  }

  /** Handles one notify call. Resolves when the person answers, the call must return, or the caller leaves. */
  ask(request: { question?: NotifyQuestion; resume?: string; returnAfterMs?: number; source: NotifySource }, signal?: AbortSignal): Promise<NotifyResult> {
    if (!this.env.settings().enabled) {
      return Promise.resolve(unavailable('Notify is off in Pane.'));
    }
    if (request.resume) return this.resume(request.resume, request.returnAfterMs, signal);
    const question = request.question;
    if (!question) return Promise.resolve(unavailable('The call named no question.'));

    const item: NotifyItem = {
      ...question,
      id: randomUUID(),
      source: request.source,
      state: question.ui === 'info' ? 'info' : 'waiting',
      createdAt: Date.now(),
    };
    const entry: Entry = { item, resumeLoop: false };
    this.entries.set(item.id, entry);

    if (question.ui === 'info') {
      // An update never covers a question, a confirmation or an expiry; those send it to the inbox.
      const current = this.strip();
      const delivered = this.canShowStrip() && (current === null || current.kind === 'info') ? 'screen' : 'inbox';
      if (delivered === 'screen') this.showInfo(item.id);
      this.trimHistory();
      this.changed();
      return Promise.resolve({ delivered });
    }

    this.queue.push(item.id);
    // A question never waits behind an update; the update stays under For your information.
    if (this.transient?.view.kind === 'info') this.clearTransient();
    this.armMidnight();
    if (this.env.settings().sound && !this.isPaused()) this.emit('chime');
    const result = this.wait(entry, request.returnAfterMs, signal);
    this.changed();
    return result;
  }

  run(command: { type: 'answer'; id: string; answer: NotifyAnswer }
    | { type: 'undo' | 'dismiss' | 'skip'; id: string }
    | { type: 'remind'; id: string; after: NotifyRemindAfter }
    | { type: 'hover-info'; id: string; hovering: boolean }
    | { type: 'pause'; minutes: number }
    | { type: 'resume' }
    | { type: 'dock'; id: string | null }): void {
    switch (command.type) {
      case 'answer': this.answer(command.id, command.answer); break;
      case 'undo': this.undo(command.id); break;
      case 'dismiss': this.hide(command.id); break;
      case 'remind': this.remind(command.id, command.after); break;
      case 'skip': this.skip(command.id); break;
      case 'hover-info': this.hoverInfo(command.id, command.hovering); break;
      case 'pause': this.pause(command.minutes); break;
      case 'resume': this.unpause(); break;
      case 'dock': this.dockedItemId = command.id; this.changed(); break;
    }
  }

  /**
   * A command from another screen or a phone (`notify:remote-command`). `device` is the server's
   * name for the sender. Refuses a command for a question no longer in the state it needs.
   */
  runRemote(command: NotifyRemoteCommand, device: string): void {
    const entry = this.entries.get(command.id);
    if (!entry) {
      throw new PaneError('ERR_NOTIFY_GONE', `That question is no longer on ${this.machine()}: it finished earlier, or Pane restarted there. Nothing was sent.`, 'Nothing to do: the agent is no longer waiting on it.');
    }
    const needs = command.type === 'answer' ? 'waiting' : command.type === 'undo' ? 'sent' : 'queued';
    const state = entry.item.state;
    if ((needs === 'queued' && !this.queue.includes(command.id)) || (needs !== 'queued' && state !== needs)) {
      if (state === 'expired') {
        throw new PaneError('ERR_NOTIFY_EXPIRED', `${entry.item.source.agent} stopped waiting on this question. Nothing was sent.`, 'Nothing to do: the agent moved on.');
      }
      if (state === 'answered' || state === 'sent') {
        throw new PaneError('ERR_NOTIFY_ANSWERED', `Already answered on ${entry.item.answeredOn ?? this.machine()}. Nothing was sent.`, 'Nothing to do: the agent has its answer.');
      }
      throw new PaneError('ERR_NOTIFY_NOT_SENT', `That question is waiting again (it was undone). Nothing was changed.`, 'Answer it again if you meant to.');
    }
    if (command.type === 'answer') {
      try {
        this.answer(command.id, command.answer, device);
      } catch (error) {
        throw new PaneError('ERR_NOTIFY_INVALID', `${error instanceof Error ? error.message : String(error)} Nothing was sent.`, 'Answer with one of the question\'s choices, or the kind of answer it asks for.');
      }
      return;
    }
    this.run(command);
  }

  /** What every connected screen and phone shares: the questions, their order and who answered. */
  sharedState(): NotifySharedState {
    this.pruneBeforeToday();
    const machine = this.machine();
    return {
      machine,
      enabled: this.env.settings().enabled,
      items: [...this.entries.values()].map(({ item }) => (
        item.state === 'sent' || item.state === 'answered' ? { ...item, answeredOn: item.answeredOn ?? machine } : { ...item }
      )),
      queue: [...this.queue],
      hidden: [...this.hidden],
    };
  }

  /** Is this one of the connected host's questions? Its commands go to the host. */
  isRemote(id: string): boolean {
    return this.remote?.items.has(id) ?? false;
  }

  /** This screen is sending (or failed to send) an answer for the host's question; its card reads "Sent to". */
  noteAnsweredHere(id: string, answered: boolean): void {
    if (answered) this.answeredHere.add(id);
    else this.answeredHere.delete(id);
  }

  /** "When I switch to Pane" for the host's question: hidden here until this Pane comes to the front. */
  remindHere(id: string): void {
    if (!this.remote?.queue.includes(id)) return;
    this.remindedHere.add(id);
    this.changed();
  }

  /**
   * The connected host's shared state (null: not connected). `online: false` keeps its questions
   * showing but unanswerable. Each change plays out here as it does for this machine's own
   * questions: a chime, an update on the strip, a "Sent to" or "Answered on" hold, an expiry.
   */
  setRemote(next: { machine: string; online: boolean; state?: NotifySharedState } | null): void {
    const previous = this.remote;
    if (!next) {
      if (!previous) return;
      if (this.transient && previous.items.has(this.transient.view.itemId)) this.clearTransient();
      this.remote = null;
      this.answeredHere.clear();
      this.remindedHere.clear();
      this.changed();
      return;
    }
    if (!next.state) {
      if (!previous) return;
      this.remote = { ...previous, machine: next.machine, online: next.online };
      this.changed();
      return;
    }
    const state = next.state;
    const items = new Map(state.items.map(item => [item.id, item]));
    const stripId = this.strip()?.itemId;
    this.remote = { machine: next.machine, online: next.online, items, queue: [...state.queue], hidden: new Set(state.hidden) };
    // The first state after connecting shows what is already there, without a chime per question.
    const announce = previous !== null;
    for (const item of state.items) {
      const before = previous?.items.get(item.id);
      if (!before) {
        if (!announce) continue;
        if (item.state === 'waiting') {
          if (this.transient?.view.kind === 'info') this.clearTransient();
          if (this.env.settings().sound && !this.isPaused()) this.emit('chime');
        } else if (item.state === 'info') {
          const current = this.strip();
          if (this.canShowStrip() && (current === null || current.kind === 'info')) this.showInfo(item.id);
        }
        continue;
      }
      if (before.state === 'waiting' && item.state === 'sent' && (this.answeredHere.has(item.id) || stripId === item.id)) {
        this.setTransient({ kind: 'sent', itemId: item.id }, NOTIFY_UNDO_MS);
      } else if (before.state === 'sent' && item.state === 'waiting') {
        this.answeredHere.delete(item.id);
        if (this.transient?.view.itemId === item.id) this.clearTransient();
      } else if (isOpen(before) && item.state === 'expired') {
        if (stripId === item.id) this.setTransient({ kind: 'expired', itemId: item.id }, NOTIFY_EXPIRED_SHOW_MS);
        else if (this.transient?.view.itemId === item.id) this.clearTransient();
      }
    }
    for (const id of [...this.answeredHere]) if (!items.has(id) || !isOpen(items.get(id)!)) this.answeredHere.delete(id);
    for (const id of [...this.remindedHere]) if (!state.queue.includes(id)) this.remindedHere.delete(id);
    if (this.transient && previous?.items.has(this.transient.view.itemId) && !items.has(this.transient.view.itemId)) this.clearTransient();
    if (state.queue.length > 0) this.armMidnight();
    this.changed();
  }

  setPaneFocused(focused: boolean): void {
    if (this.paneFocused === focused) return;
    this.paneFocused = focused;
    if (focused) {
      this.remindedHere.clear();
      for (const entry of this.entries.values()) {
        if (!entry.remindOnPaneFocus) continue;
        entry.remindOnPaneFocus = false;
        this.hidden.delete(entry.item.id);
      }
    }
    this.changed();
  }

  setRoundOpen(open: boolean): void {
    if (this.roundOpen === open) return;
    this.roundOpen = open;
    this.changed();
  }

  /** The panel's agent went idle at its prompt (or back to work) while it may have a call open. */
  panelStatus(panelId: string, idle: boolean): void {
    for (const entry of this.entries.values()) {
      if (entry.item.source.panelId !== panelId || !isOpen(entry.item)) continue;
      clearTimeout(entry.idleTimer);
      entry.idleTimer = idle ? setTimeout(() => this.expire(entry.item.id), NOTIFY_IDLE_BACKSTOP_MS) : undefined;
    }
  }

  /** Notify was turned off: every waiting agent gets `unavailable` and every surface clears. */
  turnOff(): void {
    for (const entry of [...this.entries.values()]) {
      if (isOpen(entry.item)) this.expire(entry.item.id, unavailable('Notify was turned off in Pane.'), false);
    }
    this.clearTransient();
    this.changed();
  }

  /** Pane is quitting: release every open call. */
  dispose(): void {
    for (const entry of this.entries.values()) {
      if (isOpen(entry.item)) entry.waiter?.resolve(unavailable('Pane quit.'));
      clearEntryTimers(entry);
    }
    clearTimeout(this.pauseTimer);
    clearTimeout(this.midnightTimer);
    this.clearTransient();
  }

  hasWaiting(): boolean {
    return this.allQueued().length > 0;
  }

  waitingItems(): NotifyItem[] {
    return this.allQueued().flatMap(id => this.find(id) ?? []);
  }

  snapshot(): NotifySnapshot {
    this.pruneBeforeToday();
    const strip = this.strip();
    const remote = this.remote;
    const local = [...this.entries.values()].map(entry => entry.item);
    return {
      settings: this.env.settings(),
      items: remote
        ? [
          ...local.map(item => ({ ...item, machine: this.machine() })),
          ...[...remote.items.values()].map(item => ({
            ...item,
            machine: remote.machine,
            answeredOn: this.answeredHere.has(item.id) ? undefined : item.answeredOn,
          })),
        ]
        : local,
      queue: this.allQueued(),
      hidden: [...this.allHidden()],
      strip,
      stripSurface: this.stripSurface(strip),
      dockedItemId: this.dockedItemId && this.find(this.dockedItemId)?.state === 'waiting' ? this.dockedItemId : null,
      pausedUntil: this.isPaused() ? this.pausedUntil : null,
      shortcutRegistered: this.env.shortcutRegistered(),
      showOutsideSupported: this.env.showOutsideSupported,
      instructionFiles: this.env.instructionFiles(),
      firstRun: strip?.kind === 'question' && (this.hintItemId === undefined || this.hintItemId === strip.itemId),
      remote: remote ? { machine: remote.machine, online: remote.online } : null,
    };
  }

  /** A strip is on screen; the first question shown keeps the first-run hint. */
  noteStripShown(): void {
    const strip = this.strip();
    if (this.hintItemId === undefined && strip?.kind === 'question') this.hintItemId = strip.itemId;
  }

  private resume(id: string, returnAfterMs: number | undefined, signal?: AbortSignal): Promise<NotifyResult> {
    const entry = this.entries.get(id);
    if (entry?.pending) {
      const result = entry.pending;
      entry.pending = undefined;
      clearTimeout(entry.graceTimer);
      return Promise.resolve(result);
    }
    if (!entry || !isOpen(entry.item)) {
      return Promise.resolve(unavailable('That question is no longer waiting: it expired, or Pane restarted.'));
    }
    clearTimeout(entry.graceTimer);
    return this.wait(entry, returnAfterMs, signal);
  }

  private wait(entry: Entry, returnAfterMs: number | undefined, signal?: AbortSignal): Promise<NotifyResult> {
    // One call waits per question: an overlapping resume takes over, and the older call returns.
    entry.waiter?.resolve(unavailable('Another notify call is now waiting on this question.'));
    return new Promise((resolve) => {
      let returnTimer: Timer | undefined;
      const onAbort = () => {
        if (entry.waiter === waiter) this.expire(entry.item.id);
      };
      const waiter: Waiter = {
        resolve: (result) => {
          waiter.detach();
          resolve(result);
        },
        detach: () => {
          clearTimeout(returnTimer);
          signal?.removeEventListener('abort', onAbort);
          if (entry.waiter === waiter) entry.waiter = undefined;
        },
      };
      entry.waiter = waiter;
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      if (returnAfterMs !== undefined && returnAfterMs > 0) {
        const remaining = entry.item.createdAt + NOTIFY_RESUME_CAP_MS - Date.now();
        returnTimer = setTimeout(() => {
          if (remaining <= returnAfterMs) {
            // An answer in its Undo hold reaches this call when the hold ends.
            if (entry.item.state === 'sent') return;
            this.expire(entry.item.id, unavailable('Nobody answered within 15 minutes.'));
            return;
          }
          entry.resumeLoop = true;
          waiter.resolve({
            waiting: true,
            id: entry.item.id,
            next: `Call \`runpane notify --resume ${entry.item.id}\` now to keep waiting for the answer.`,
          });
          entry.graceTimer = setTimeout(() => this.expire(entry.item.id), NOTIFY_RESUME_GRACE_MS);
        }, Math.min(returnAfterMs, Math.max(remaining, 0)));
      }
    });
  }

  private answer(id: string, answer: NotifyAnswer, device?: string): void {
    const entry = this.entries.get(id);
    if (!entry || entry.item.state !== 'waiting') return;
    const result = toResult(entry.item, answer);
    entry.item.state = 'sent';
    entry.item.answerSummary = summarize(entry.item, result);
    entry.item.answeredOn = device;
    this.queue = this.queue.filter(other => other !== id);
    this.hidden.delete(id);
    clearTimeout(entry.remindTimer);
    entry.remindOnPaneFocus = false;
    entry.holdTimer = setTimeout(() => this.deliver(entry, result), NOTIFY_UNDO_MS);
    this.setTransient({ kind: 'sent', itemId: id }, NOTIFY_UNDO_MS);
    this.changed();
  }

  private deliver(entry: Entry, result: NotifyResult): void {
    entry.holdTimer = undefined;
    entry.item.state = 'answered';
    entry.item.resolvedAt = Date.now();
    clearTimeout(entry.idleTimer);
    if (entry.waiter) entry.waiter.resolve(result);
    else entry.pending = result;
    this.trimHistory();
    this.changed();
  }

  private undo(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || entry.item.state !== 'sent') return;
    clearTimeout(entry.holdTimer);
    entry.holdTimer = undefined;
    entry.item.state = 'waiting';
    entry.item.answerSummary = undefined;
    entry.item.answeredOn = undefined;
    this.queue = [id, ...this.queue];
    if (this.transient?.view.itemId === id) this.clearTransient();
    this.changed();
  }

  /** The caller stopped waiting: the card says so, then moves to Earlier today as Expired. */
  private expire(id: string, result?: NotifyResult, announce = true): void {
    const entry = this.entries.get(id);
    if (!entry || !isOpen(entry.item)) return;
    const wasOnStrip = this.strip()?.itemId === id;
    clearEntryTimers(entry);
    entry.item.state = 'expired';
    entry.item.resolvedAt = Date.now();
    entry.item.answerSummary = undefined;
    this.queue = this.queue.filter(other => other !== id);
    this.hidden.delete(id);
    if (entry.waiter) entry.waiter.resolve(result ?? unavailable('The question expired.'));
    if (announce && wasOnStrip) this.setTransient({ kind: 'expired', itemId: id }, NOTIFY_EXPIRED_SHOW_MS);
    else if (this.transient?.view.itemId === id) this.clearTransient();
    this.trimHistory();
    this.changed();
  }

  private hide(id: string): void {
    if (!this.queue.includes(id)) {
      if (this.transient?.view.itemId === id) {
        this.clearTransient();
        this.changed();
      }
      return;
    }
    this.hidden.add(id);
    this.changed();
  }

  private remind(id: string, after: NotifyRemindAfter): void {
    const entry = this.entries.get(id);
    if (!entry || !this.queue.includes(id)) return;
    this.hidden.add(id);
    clearTimeout(entry.remindTimer);
    entry.remindOnPaneFocus = after === 'pane';
    if (after !== 'pane') {
      entry.remindTimer = setTimeout(() => {
        this.hidden.delete(id);
        this.changed();
      }, REMIND_AFTER_MS[after]);
    }
    this.changed();
  }

  private skip(id: string): void {
    if (!this.queue.includes(id)) return;
    this.queue = [...this.queue.filter(other => other !== id), id];
    this.changed();
  }

  private showInfo(id: string): void {
    const hideAfterMs = this.env.settings().updatesHideAfterSeconds * 1000;
    this.setTransient({ kind: 'info', itemId: id, hideAt: Date.now() + hideAfterMs }, hideAfterMs);
  }

  private hoverInfo(id: string, hovering: boolean): void {
    const view = this.transient?.view;
    if (view?.kind !== 'info' || view.itemId !== id) return;
    if (hovering) this.setTransient({ kind: 'info', itemId: id, hideAt: null });
    else this.showInfo(id);
    this.changed();
  }

  private pause(minutes: number): void {
    clearTimeout(this.pauseTimer);
    this.pausedUntil = Date.now() + minutes * 60_000;
    this.pauseTimer = setTimeout(() => this.unpause(), minutes * 60_000);
    this.changed();
  }

  private unpause(): void {
    clearTimeout(this.pauseTimer);
    this.pausedUntil = null;
    this.changed();
  }

  private isPaused(): boolean {
    return this.pausedUntil !== null && this.pausedUntil > Date.now();
  }

  private setTransient(view: NotifyStripView, ms?: number): void {
    clearTimeout(this.transient?.timer);
    const timer = ms === undefined ? undefined : setTimeout(() => {
      if (this.transient?.view !== view) return;
      this.transient = null;
      this.changed();
    }, ms);
    this.transient = { view, timer };
  }

  private clearTransient(): void {
    clearTimeout(this.transient?.timer);
    this.transient = null;
  }

  /** What the strip shows: a confirmation, expiry or update first, else the oldest visible question. */
  private strip(): NotifyStripView | null {
    if (this.transient) return this.transient.view;
    const hidden = this.allHidden();
    const id = this.allQueued().find(other => !hidden.has(other));
    return id ? { kind: 'question', itemId: id } : null;
  }

  private find(id: string): NotifyItem | undefined {
    return this.entries.get(id)?.item ?? this.remote?.items.get(id);
  }

  /** This machine's waiting questions and the connected host's, oldest first; each keeps its own order. */
  private allQueued(): string[] {
    const remote = this.remote;
    if (!remote || remote.queue.length === 0) return [...this.queue];
    const merged: string[] = [];
    let local = 0;
    let other = 0;
    while (local < this.queue.length || other < remote.queue.length) {
      const localAt = this.entries.get(this.queue[local])?.item.createdAt ?? Infinity;
      const otherAt = remote.items.get(remote.queue[other])?.createdAt ?? Infinity;
      if (other >= remote.queue.length || (local < this.queue.length && localAt <= otherAt)) merged.push(this.queue[local++]);
      else merged.push(remote.queue[other++]);
    }
    return merged;
  }

  private allHidden(): Set<string> {
    if (!this.remote) return this.hidden;
    return new Set([...this.hidden, ...this.remote.hidden, ...this.remindedHere]);
  }

  private machine(): string {
    return this.env.machine ?? 'this computer';
  }

  private canShowStrip(): boolean {
    const settings = this.env.settings();
    if (!settings.enabled || this.isPaused() || this.roundOpen) return false;
    return this.paneFocused || (settings.showOutsidePane && this.env.showOutsideSupported);
  }

  private stripSurface(strip: NotifyStripView | null): NotifySnapshot['stripSurface'] {
    if (!strip || !this.canShowStrip()) return null;
    return this.paneFocused ? 'pane' : 'window';
  }

  private trimHistory(): void {
    const done = [...this.entries.values()].filter(entry => !isOpen(entry.item));
    for (const entry of done.slice(0, Math.max(0, done.length - HISTORY_LIMIT))) this.entries.delete(entry.item.id);
  }

  /** Earlier today and For your information hold only today's items, by the local clock. */
  private pruneBeforeToday(): void {
    const midnight = startOfLocalDay(Date.now());
    for (const entry of [...this.entries.values()]) {
      const at = entry.item.resolvedAt ?? entry.item.createdAt;
      if (!isOpen(entry.item) && at < midnight && this.transient?.view.itemId !== entry.item.id) this.entries.delete(entry.item.id);
    }
  }

  private armMidnight(): void {
    if (this.midnightTimer) return;
    const now = Date.now();
    const next = startOfNextLocalDay(now);
    this.midnightTimer = setTimeout(() => {
      this.midnightTimer = undefined;
      this.changed();
      if (this.entries.size > 0) this.armMidnight();
    }, next - now + 1_000);
  }

  private changed(): void {
    this.armMidnight();
    this.emit('change');
  }
}

function isOpen(item: NotifyItem): boolean {
  return item.state === 'waiting' || item.state === 'sent';
}

function clearEntryTimers(entry: Entry): void {
  clearTimeout(entry.holdTimer);
  clearTimeout(entry.graceTimer);
  clearTimeout(entry.remindTimer);
  clearTimeout(entry.idleTimer);
  entry.remindOnPaneFocus = false;
}

function unavailable(reason: string): NotifyResult {
  return { unavailable: reason, next: ASK_IN_TERMINAL };
}

function startOfLocalDay(at: number): number {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** By calendar day, so a daylight-saving change still lands on midnight. */
function startOfNextLocalDay(at: number): number {
  const day = new Date(at);
  day.setDate(day.getDate() + 1);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

function toResult(item: NotifyItem, answer: NotifyAnswer): NotifyResult {
  const note = 'note' in answer && answer.note?.trim() ? answer.note.trim() : undefined;
  if (item.ui === 'approve' && 'approved' in answer) return note ? { approved: answer.approved, note } : { approved: answer.approved };
  if (item.ui === 'options' && 'choice' in answer && item.choices?.some(choice => choice.label === answer.choice)) {
    return note ? { answer: answer.choice, note } : { answer: answer.choice };
  }
  if (item.ui === 'ask' && 'text' in answer && answer.text.trim()) return { answer: answer.text.trim() };
  throw new Error(`That answer doesn't fit this ${item.ui} question.`);
}

function summarize(item: NotifyItem, result: NotifyResult): string {
  if ('approved' in result) return result.approved ? 'Approved' : 'Denied';
  if ('answer' in result) return result.answer;
  return item.title;
}
