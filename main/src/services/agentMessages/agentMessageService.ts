import { EventEmitter } from 'events';
import { PaneError } from '../../../../shared/paneError';
import { messageRef, type AgentMessageParty, type AgentMessageRecord } from '../../../../shared/types/agentMessages';
import { AGENT_MESSAGE_RETENTION_MS, messageRecord, type AgentMessageStore, type StoredMessage } from './agentMessageStore';
import { replyLine, withReplyRoute } from './agentMessageText';

export type MessageTypeResult = 'delivered' | 'busy' | 'gone' | 'unsupported' | 'outdated';

/** A tab as messages see it: who it is, and whether an agent runs in it (a shell tab is the person). */
export interface MessagePanelInfo extends AgentMessageParty {
  panelId: string;
  agent: boolean;
}

/** What the service needs from the running Pane; tests pass a fake. */
export interface AgentMessageHost {
  panel(panelId: string): MessagePanelInfo | null;
  /** A Session's orchestrator tab now (it changes when the Session switches agent or to chat). */
  orchestratorPanel(sessionId: string): string | null;
  isPanelDown(panelId: string): Promise<boolean>;
  resumePanel(panelId: string): Promise<boolean>;
  isMidTurn(panelId: string): boolean;
  hasUnsentText(panelId: string): Promise<boolean>;
  /** Types into a tab only at a live agent's prompt (typeIntoLocalTab). */
  typeIntoTab(panelId: string, text: string): Promise<MessageTypeResult>;
  log(message: string, error?: Error | string): void;
}

/** One message and its replies, as `runpane messages show` reads them. */
export interface MessageThread {
  message: AgentMessageRecord;
  replies: AgentMessageRecord[];
}

/** A message `panels submit` is about to type: its id and the text with the reply line. */
export interface OutgoingMessage {
  number: number;
  ref: string;
  text: string;
}

const RESUME_TRIES = 3;
/** How long a reply held for `--await-reply` waits for the sender's wait call before Pane types it into the tab instead. */
export const AWAIT_REPLY_GRACE_MS = 60_000;
/** The prefix Autopilot's relay of the person's own words starts with: those words are the person's, not Autopilot's. */
const PERSON_RELAY_PREFIX = '[From the person, via Autopilot]';
const MAX_REPLY_CHARS = 8000;
const PERSON: AgentMessageParty = { panelId: null, paneId: null, sessionId: null, name: 'the person', orchestrator: false };

const UNDELIVERED = {
  gone: 'its tab closed',
  unsupported: 'its tab takes no typed messages here',
  outdated: 'its Pane is too old to take it',
} as const satisfies Record<Exclude<MessageTypeResult, 'delivered' | 'busy'>, string>;

function party(info: MessagePanelInfo): AgentMessageParty {
  return { panelId: info.panelId, paneId: info.paneId, sessionId: info.sessionId, name: info.name, orchestrator: info.orchestrator };
}

/**
 * Agent-to-agent messages (T-104). `panels submit` from one agent's tab to another records the
 * message (M-n) and ends it with a reply line; `runpane reply M-n` records the answer and types it
 * into the sender's tab, the way to-do messages reach theirs: only at a live agent's prompt,
 * resuming a tab that is down, and following a Session's orchestrator to its current tab. A sender
 * waiting in `--await-reply` gets the reply as its call's result instead. Emits `changed`.
 */
export class AgentMessageService extends EventEmitter {
  private readonly outbox: number[] = [];
  private readonly typing = new Set<string>();
  private readonly resumeFailures = new Map<number, number>();
  private readonly waiters = new Map<number, Set<(reply: StoredMessage) => void>>();
  /**
   * `--await-reply` sends: reserved before the message is typed, so a reply that comes before the
   * sender's wait call is held for that call (`held`), never typed. Released to the tab after
   * AWAIT_REPLY_GRACE_MS without a wait call.
   */
  private readonly reservations = new Map<number, { held: number[]; timer: ReturnType<typeof setTimeout> }>();
  private flushing: Promise<void> | null = null;

  constructor(private readonly store: AgentMessageStore, private readonly host: AgentMessageHost, private readonly now: () => number = Date.now) {
    super();
  }

  /** Queues replies a restart left waiting, and drops messages past their keep time. */
  start(): void {
    this.store.prune(this.now() - AGENT_MESSAGE_RETENTION_MS);
    for (const reply of this.store.queued()) if (!this.outbox.includes(reply.number)) this.outbox.push(reply.number);
    void this.flush();
  }

  /**
   * Called by `panels submit` before it types. An agent's tab writing to another tab gets an id and
   * a reply line; the person (the app, a phone, a shell tab, `--source user`) and a tab writing to
   * itself get nothing, and their text goes as typed.
   */
  beginMessage(input: {
    callerPanelId: string | undefined; receiverPanelId: string; body: string; source?: 'user' | 'agent';
    /** The text is the person's own words an agent passes on (Autopilot's relay, `--for-person`). */
    personWords?: boolean;
    /** The submit's operation id: a replay of it gets the same message and text. */
    operationId?: string;
    /** `--await-reply`: hold a reply for the sender's wait call from before the message is typed. */
    awaitReply?: boolean;
  }): OutgoingMessage | undefined {
    if (!input.callerPanelId || !this.isAgentMessage(input)) return undefined;
    const sender = this.host.panel(input.callerPanelId);
    const receiver = this.host.panel(input.receiverPanelId);
    if (!sender?.agent || !receiver) return undefined;
    const replayed = input.operationId ? this.store.byOperation(input.operationId, input.callerPanelId, input.receiverPanelId) : undefined;
    const message = replayed ?? this.store.create({
      kind: 'message', sender: party(sender), receiver: party(receiver), body: input.body, state: 'sending', now: this.now(), operationId: input.operationId,
    });
    if (input.awaitReply && !this.reservations.has(message.number) && this.store.replies(message.number).length === 0) this.reserve(message.number);
    if (!replayed) this.changed();
    return { number: message.number, ref: messageRef(message.number), text: withReplyRoute(message.body, message.number, message.sender.name) };
  }

  /**
   * Whether `panels submit` would send this as an agent's message (beginMessage's rule), before
   * anything is recorded: a file-pointer send writes its prompt file first, then sends its line.
   */
  isAgentMessage(input: { callerPanelId: string | undefined; receiverPanelId: string; body: string; source?: 'user' | 'agent'; personWords?: boolean }): boolean {
    if (!input.callerPanelId || input.source === 'user' || input.callerPanelId === input.receiverPanelId || !input.body.trim()) return false;
    if (input.personWords || input.body.trimStart().startsWith(PERSON_RELAY_PREFIX)) return false;
    return this.host.panel(input.callerPanelId)?.agent === true && this.host.panel(input.receiverPanelId) !== null;
  }

  private reserve(number: number): void {
    const timer = setTimeout(() => this.release(number), AWAIT_REPLY_GRACE_MS);
    timer.unref?.();
    this.reservations.set(number, { held: [], timer });
  }

  /** The sender never came to wait (it disconnected): what was held goes to its tab. */
  private release(number: number): void {
    const reservation = this.reservations.get(number);
    if (!reservation) return;
    clearTimeout(reservation.timer);
    this.reservations.delete(number);
    if (reservation.held.length === 0) return;
    this.outbox.push(...reservation.held);
    void this.flush();
  }

  /** After `panels submit`: the message reached the tab, or it didn't and why. */
  finishMessage(number: number, outcome: { ok: true } | { ok: false; reason: string }): void {
    const message = this.store.get(number);
    // A replayed submit (same operation id) may succeed after its first try failed.
    if (!message || (message.state !== 'sending' && !(outcome.ok && message.state === 'undelivered'))) return;
    if (outcome.ok) this.store.markDelivered(number, this.now());
    else this.store.setState(number, 'undelivered', { reason: outcome.reason, at: this.now() });
    this.changed();
  }

  /** `runpane reply M-n "…"`: records the reply, marks the original answered, and sends it to the original's sender. */
  async reply(input: { to: number; body: string; callerPanelId: string | undefined }): Promise<{ reply: AgentMessageRecord; delivery: 'delivered' | 'queued' | 'undelivered' }> {
    const original = this.store.get(input.to);
    if (!original) {
      throw new PaneError('ERR_MESSAGE_NOT_FOUND', `There is no message ${messageRef(input.to)} on this computer, so nothing was sent.`, 'See recent messages with `runpane messages list`, then reply to one of those.');
    }
    const body = input.body.trim();
    if (!body) throw new PaneError('ERR_RUNPANE_INVALID_ARGUMENT', 'The reply is empty, so nothing was sent.', `Pass the reply in quotes: runpane reply ${messageRef(input.to)} "…".`);
    if (body.length > MAX_REPLY_CHARS) {
      throw new PaneError('ERR_RUNPANE_INVALID_ARGUMENT', `The reply is ${body.length} characters, over the ${MAX_REPLY_CHARS} a reply takes, so nothing was sent.`, 'Put the detail in a file, and reply with a short summary and its path.');
    }
    const caller = input.callerPanelId ? this.host.panel(input.callerPanelId) : null;
    // The reply goes back to whoever sent the original; its sender is whoever answers it (the person when no tab ran the command).
    const replier = caller ? party(caller) : input.callerPanelId ? original.receiver : PERSON;
    const reply = this.store.create({ kind: 'reply', replyTo: original.number, sender: replier, receiver: original.sender, body, state: 'queued', now: this.now() });
    this.store.setState(original.number, 'answered', { at: this.now() });
    const waiting = this.waiters.get(original.number);
    if (waiting && waiting.size > 0) {
      this.handToCall(reply);
      for (const resolve of [...waiting]) resolve(this.mustGet(reply.number));
      this.waiters.delete(original.number);
      return { reply: this.record(reply.number), delivery: 'delivered' };
    }
    const reservation = this.reservations.get(original.number);
    if (reservation) {
      // The sender's --await-reply call is on its way: it takes this reply, so nothing is typed.
      reservation.held.push(reply.number);
      this.changed();
      return { reply: this.record(reply.number), delivery: 'queued' };
    }
    this.outbox.push(reply.number);
    this.changed();
    await this.flush();
    const state = this.mustGet(reply.number).state;
    return { reply: this.record(reply.number), delivery: state === 'delivered' ? 'delivered' : state === 'undelivered' ? 'undelivered' : 'queued' };
  }

  /**
   * `--await-reply` and `messages wait`: resolves with the first reply to `number`, or undefined
   * after `timeoutMs` or when `signal` aborts (a later reply is then typed into the tab). A reply
   * held for this call, or still queued, is handed to it and not typed; one already typed (or being
   * typed) is returned too.
   */
  waitForReply(number: number, timeoutMs: number | undefined, signal?: AbortSignal): Promise<AgentMessageRecord | undefined> {
    if (!this.store.get(number)) {
      return Promise.reject(new PaneError('ERR_MESSAGE_NOT_FOUND', `There is no message ${messageRef(number)} on this computer, so there is no reply to wait for.`, 'See recent messages with `runpane messages list`.'));
    }
    const reservation = this.reservations.get(number);
    if (reservation) {
      clearTimeout(reservation.timer);
      this.reservations.delete(number);
      const [first, ...rest] = reservation.held;
      if (rest.length > 0) {
        this.outbox.push(...rest);
        void this.flush();
      }
      if (first !== undefined) {
        this.handToCall(this.mustGet(first));
        return Promise.resolve(this.record(first));
      }
    }
    const earlier = this.store.replies(number).find(reply => reply.state !== 'undelivered');
    if (earlier) {
      if (earlier.state === 'queued' && !this.typing.has(this.targetOf(earlier) ?? '')) this.handToCall(earlier);
      return Promise.resolve(this.record(earlier.number));
    }
    return new Promise(resolve => {
      const waiting = this.waiters.get(number) ?? new Set();
      this.waiters.set(number, waiting);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (reply: StoredMessage | undefined) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        waiting.delete(settle);
        if (waiting.size === 0 && this.waiters.get(number) === waiting) this.waiters.delete(number);
        resolve(reply ? this.record(reply.number) : undefined);
      };
      const settle = (reply: StoredMessage) => done(reply);
      const abort = () => done(undefined);
      waiting.add(settle);
      if (timeoutMs !== undefined) timer = setTimeout(abort, timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  /** Newest first; `before` (a message number) pages further back, older than that message. */
  list(filter: { panelId?: string; limit?: number; before?: number } = {}): AgentMessageRecord[] {
    return this.store.list(filter).map(message => messageRecord(message, this.store.replyNumbers(message.number)));
  }

  show(number: number): MessageThread {
    const message = this.store.get(number);
    if (!message) throw new PaneError('ERR_MESSAGE_NOT_FOUND', `There is no message ${messageRef(number)} on this computer.`, 'See recent messages with `runpane messages list`.');
    return { message: this.record(number), replies: this.store.replies(number).map(reply => this.record(reply.number)) };
  }

  /** Replies waiting on a tab, for tests and the page. */
  queuedFor(panelId: string): AgentMessageRecord[] {
    return this.outbox.map(number => this.mustGet(number)).filter(reply => this.targetOf(reply) === panelId).map(reply => this.record(reply.number));
  }

  /** Types each queued reply into its tab at its prompt. Called on reply, when a tab goes idle, and by a timer. */
  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushOnce().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async flushOnce(): Promise<void> {
    const tried = new Set<string>();
    for (const number of [...this.outbox]) {
      const reply = this.store.get(number);
      if (!reply || reply.state !== 'queued') {
        this.dropFromOutbox(number);
        continue;
      }
      const target = this.targetOf(reply);
      if (!target) {
        this.settleUndelivered(reply, 'its tab closed');
        continue;
      }
      if (tried.has(target)) continue;
      tried.add(target);
      try {
        await this.deliver(reply, target);
      } catch (error) {
        this.host.log(`[Messages] delivery of ${messageRef(number)} to ${target} failed`, error instanceof Error ? error : String(error));
      }
    }
  }

  private async deliver(reply: StoredMessage, panelId: string): Promise<void> {
    if (await this.host.isPanelDown(panelId)) {
      // Resume before delivery: the sender's tab is down after a restart. A resume that throws failed too.
      let why = 'it would not restart';
      let resumed = false;
      try {
        resumed = await this.host.resumePanel(panelId);
      } catch (error) {
        why = `it would not restart: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (resumed) this.resumeFailures.delete(reply.number);
      else this.resumeFailed(reply, why);
      return;
    }
    if (this.host.isMidTurn(panelId) || await this.host.hasUnsentText(panelId)) return;
    const original = reply.replyTo === null ? undefined : this.store.get(reply.replyTo);
    this.typing.add(panelId);
    let result: MessageTypeResult;
    try {
      // A waiting call may have taken it while this tab got ready.
      if (this.mustGet(reply.number).state !== 'queued') return;
      result = await this.host.typeIntoTab(panelId, replyLine(original?.number ?? reply.number, reply.number, reply.body, reply.sender.name));
    } finally {
      this.typing.delete(panelId);
    }
    if (result === 'busy') return;
    if (result !== 'delivered') {
      this.settleUndelivered(reply, UNDELIVERED[result]);
      return;
    }
    this.dropFromOutbox(reply.number);
    this.store.setState(reply.number, 'delivered', { via: 'tab', at: this.now() });
    this.changed();
  }

  /**
   * Where a reply goes now. A message sent as a Session's orchestrator goes to the Session's
   * orchestrator tab now, even when the tab that sent it still exists (the Session switched agent);
   * any other goes to the tab that sent it.
   */
  private targetOf(reply: StoredMessage): string | null {
    const to = reply.receiver;
    if (to.orchestrator && to.sessionId) {
      const current = this.host.orchestratorPanel(to.sessionId);
      if (current && this.host.panel(current)) return current;
    }
    if (to.panelId && this.host.panel(to.panelId)) return to.panelId;
    return null;
  }

  private handToCall(reply: StoredMessage): void {
    this.dropFromOutbox(reply.number);
    this.store.setState(reply.number, 'delivered', { via: 'call', at: this.now() });
    this.changed();
  }

  private resumeFailed(reply: StoredMessage, why: string): void {
    const failures = (this.resumeFailures.get(reply.number) ?? 0) + 1;
    this.resumeFailures.set(reply.number, failures);
    if (failures < RESUME_TRIES) return;
    this.resumeFailures.delete(reply.number);
    this.settleUndelivered(reply, why);
  }

  private settleUndelivered(reply: StoredMessage, why: string): void {
    this.dropFromOutbox(reply.number);
    this.store.setState(reply.number, 'undelivered', { reason: why, at: this.now() });
    this.host.log(`[Messages] ${messageRef(reply.number)} can't reach ${reply.receiver.name}: ${why}`);
    this.changed();
  }

  private dropFromOutbox(number: number): void {
    const index = this.outbox.indexOf(number);
    if (index >= 0) this.outbox.splice(index, 1);
  }

  private mustGet(number: number): StoredMessage {
    const message = this.store.get(number);
    if (!message) throw new Error(`Message ${messageRef(number)} was written but could not be read back.`);
    return message;
  }

  private record(number: number): AgentMessageRecord {
    return messageRecord(this.mustGet(number), this.store.replyNumbers(number));
  }

  private changed(): void {
    this.emit('changed');
  }
}
