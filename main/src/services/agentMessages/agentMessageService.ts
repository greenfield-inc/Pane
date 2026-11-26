import { EventEmitter } from 'events';
import { PaneError } from '../../../../shared/paneError';
import { messageRef, type AgentMessageParty, type AgentMessageRecord } from '../../../../shared/types/agentMessages';
import { AGENT_MESSAGE_RETENTION_MS, messageRecord, type AgentMessageStore, type MessagePointer, type StoredMessage } from './agentMessageStore';
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

/** A message `panels submit` is about to type: its id, the text with the reply line, and its prompt file (a file-pointer send). */
export interface OutgoingMessage {
  number: number;
  ref: string;
  text: string;
  pointer: MessagePointer | null;
}

/** An `--await-reply` send's hold on its replies: the tab that sent it, the replies held for its call, and its grace timer. */
interface Reservation {
  panelId: string | undefined;
  held: number[];
  timer: ReturnType<typeof setTimeout>;
}

/** A call waiting for a reply, and the tab it was made from. */
interface Waiter {
  panelId: string | undefined;
  settle: (reply: StoredMessage) => void;
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
  /** Replies being typed now, by reply number, with the typing's end: a wait for one of them waits for that. */
  private readonly typing = new Map<number, Promise<void>>();
  private readonly resumeFailures = new Map<number, number>();
  /** Calls waiting for a reply to a message, each with the tab that called (undefined outside a tab). */
  private readonly waiters = new Map<number, Set<Waiter>>();
  /**
   * `--await-reply` sends: reserved for the calling tab before the message is typed, so a reply that
   * comes before that tab's wait call is held for the call (`held`), never typed. Released to the
   * reply's route after AWAIT_REPLY_GRACE_MS without a wait call.
   */
  private readonly reservations = new Map<number, Reservation>();
  /**
   * Replies parked for a waiting call because an earlier reply to the same message was being typed:
   * the call answers with the first reply, so a later one waits until that attempt's outcome is known.
   * By original message number. Released to the tab when the last call on that message ends.
   */
  private readonly parked = new Map<number, number[]>();
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
    /** The submit's operation id: a replay of the same request gets the same message and text. */
    operationId?: string;
    /** What the submit asked for (text, file pointer, attachments); a replay must match it. Defaults to `body`. */
    requestKey?: string;
    /** The prompt file a file-pointer send wrote, kept so a replay returns the same paths. */
    pointer?: MessagePointer;
    /** `--await-reply`: hold a reply for the sender's wait call from before the message is typed. */
    awaitReply?: boolean;
  }): OutgoingMessage | undefined {
    if (!input.callerPanelId || !this.isAgentMessage(input)) return undefined;
    const sender = this.host.panel(input.callerPanelId);
    const receiver = this.host.panel(input.receiverPanelId);
    if (!sender?.agent || !receiver) return undefined;
    const requestKey = input.requestKey ?? input.body;
    // Only the same request replays: the same operation id with other content is a new message, which a chat tab refuses (CHAT_OPERATION_CONFLICT).
    const replayed = input.operationId ? this.store.byOperation(input.operationId, input.callerPanelId, input.receiverPanelId, requestKey) : undefined;
    const message = replayed ?? this.store.create({
      kind: 'message', sender: party(sender), receiver: party(receiver), body: input.body, state: 'sending', now: this.now(),
      operationId: input.operationId, requestKey, pointer: input.pointer,
    });
    if (input.awaitReply && !this.reservations.has(message.number) && this.store.replies(message.number).length === 0) this.reserve(message.number, input.callerPanelId);
    if (!replayed) this.changed();
    return { number: message.number, ref: messageRef(message.number), text: withReplyRoute(message.body, message.number, message.sender.name), pointer: message.pointer };
  }

  /**
   * The earlier send a replayed submit repeats: the same operation id, tabs and request. Its body and
   * prompt file are what the replay sends and returns, so no new file is written.
   */
  priorSend(input: { operationId: string | undefined; callerPanelId: string | undefined; receiverPanelId: string; requestKey: string }): { body: string; pointer: MessagePointer | null } | undefined {
    if (!input.operationId || !input.callerPanelId) return undefined;
    const prior = this.store.byOperation(input.operationId, input.callerPanelId, input.receiverPanelId, input.requestKey);
    return prior ? { body: prior.body, pointer: prior.pointer } : undefined;
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

  private reserve(number: number, panelId: string | undefined): void {
    const timer = setTimeout(() => this.release(number), AWAIT_REPLY_GRACE_MS);
    timer.unref?.();
    this.reservations.set(number, { panelId, held: [], timer });
  }

  /** The sender never came to wait (it disconnected): what was held goes to its route. */
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
    // A waiting call takes it only when its tab is the reply's route now (not an orchestrator tab the Session left).
    const route = this.targetOf(reply);
    const waiter = [...this.waiters.get(original.number) ?? []].find(candidate => this.isRoute(candidate.panelId, route));
    if (waiter) {
      // The call prints the first reply: while an earlier one is being typed, this one waits for that outcome.
      if (this.store.replies(original.number).some(earlier => earlier.number < reply.number && this.typing.has(earlier.number))) {
        this.parked.set(original.number, [...this.parked.get(original.number) ?? [], reply.number]);
        this.changed();
        return { reply: this.record(reply.number), delivery: 'queued' };
      }
      this.handToCall(reply);
      waiter.settle(this.mustGet(reply.number));
      return { reply: this.record(reply.number), delivery: 'delivered' };
    }
    const reservation = this.reservations.get(original.number);
    if (reservation && this.isRoute(reservation.panelId, route)) {
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
   * held for this call, or still queued, is handed to it and not typed, but only when the calling
   * tab (`callerPanelId`) is that reply's route now; one already typed, or being typed, is returned
   * once its typing ends.
   */
  async waitForReply(number: number, timeoutMs: number | undefined, signal?: AbortSignal, callerPanelId?: string): Promise<AgentMessageRecord | undefined> {
    if (!this.store.get(number)) {
      throw new PaneError('ERR_MESSAGE_NOT_FOUND', `There is no message ${messageRef(number)} on this computer, so there is no reply to wait for.`, 'See recent messages with `runpane messages list`.');
    }
    // Listen first, then look: the waiter is registered before any scan, and every await is followed by a fresh
    // scan, so a reply can never arrive between "looked" and "listening" (reply() hands new ones to the waiter).
    return new Promise(resolve => {
      const waiting = this.waiters.get(number) ?? new Set<Waiter>();
      this.waiters.set(number, waiting);
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (reply: StoredMessage | undefined) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        waiting.delete(waiter);
        if (waiting.size === 0 && this.waiters.get(number) === waiting) this.waiters.delete(number);
        // Parked replies only the calls still listening may take; the rest go to their tab.
        this.releaseUnclaimable(number);
        resolve(reply ? this.record(reply.number) : undefined);
      };
      const waiter: Waiter = { panelId: callerPanelId, settle: reply => finish(reply) };
      const abort = () => finish(undefined);
      waiting.add(waiter);
      if (signal?.aborted) {
        abort();
        return;
      }
      if (timeoutMs !== undefined) timer = setTimeout(abort, timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      const scan = (): void => {
        if (settled) return;
        // Routes may have changed while this call waited (a Session switched orchestrator): what no listening call can take goes to its tab.
        this.releaseUnclaimable(number);
        const found = this.claimFor(number, callerPanelId);
        if (found && 'reply' in found) finish(found.reply);
        // Only replies being typed are left: wait for that attempt, then look again (still listening meanwhile).
        else if (found) void found.typing.then(scan);
      };
      scan();
    });
  }

  /**
   * One synchronous look for a reply a wait from `callerPanelId` may take now: a held one routed to it,
   * a queued one routed to it (claimed for the call here), or one already typed. `typing` when the only
   * candidates are being typed. Ends the reservation when the caller owns it.
   */
  private claimFor(number: number, callerPanelId: string | undefined): { reply: StoredMessage } | { typing: Promise<void> } | undefined {
    const reservation = this.reservations.get(number);
    if (reservation) {
      // Only the reservation's owner (the tab that sent with --await-reply), or a call outside any tab, ends it.
      // Another tab's wait takes only a held reply whose route it is now (a Session's new orchestrator), and leaves the rest held.
      const owner = callerPanelId === undefined || callerPanelId === reservation.panelId;
      const claimed = reservation.held.find(held => this.isRoute(callerPanelId, this.targetOf(this.mustGet(held))));
      if (claimed !== undefined) reservation.held = reservation.held.filter(held => held !== claimed);
      if (owner) {
        clearTimeout(reservation.timer);
        this.reservations.delete(number);
        if (reservation.held.length > 0) {
          this.outbox.push(...reservation.held);
          void this.flush();
        }
      }
      if (claimed !== undefined) {
        this.handToCall(this.mustGet(claimed));
        return { reply: this.mustGet(claimed) };
      }
    }
    const held = new Set(this.reservations.get(number)?.held ?? []);
    for (const reply of this.store.replies(number)) {
      if (reply.state === 'undelivered' || held.has(reply.number)) continue;
      const attempt = this.typing.get(reply.number);
      // The first reply decides: while it is being typed, nothing later is taken; look again when that attempt ends.
      if (attempt) return { typing: attempt };
      if (reply.state === 'queued') {
        // A call takes a queued reply only from its route.
        if (!this.isRoute(callerPanelId, this.targetOf(reply))) continue;
        this.handToCall(reply);
        return { reply: this.mustGet(reply.number) };
      }
      return { reply };
    }
    return undefined;
  }

  /**
   * Parked replies stay parked only while a listening call can take them: one made from the reply's
   * route as it is now. The rest (no call left, or the route moved to another tab) go to the outbox,
   * so the flush types them into their tab now; claimed and settled ones are dropped.
   */
  private releaseUnclaimable(number: number): void {
    const parked = this.parked.get(number);
    if (!parked) return;
    const listening = [...this.waiters.get(number) ?? []];
    const keep: number[] = [];
    const release: number[] = [];
    for (const replyNumber of parked) {
      const reply = this.store.get(replyNumber);
      if (reply?.state !== 'queued') continue;
      const route = this.targetOf(reply);
      if (listening.some(waiter => this.isRoute(waiter.panelId, route))) keep.push(replyNumber);
      else release.push(replyNumber);
    }
    if (keep.length > 0) this.parked.set(number, keep);
    else this.parked.delete(number);
    if (release.length === 0) return;
    for (const replyNumber of release) if (!this.outbox.includes(replyNumber)) this.outbox.push(replyNumber);
    void this.flush();
  }

  /** A call from `panelId` may take a reply whose route is `route`: the same tab, or a call made outside any tab. */
  private isRoute(panelId: string | undefined, route: string | null): boolean {
    return panelId === undefined || panelId === route;
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
    // Claim it: checked and marked with no await between, so a waiting call can't take it while it is typed.
    if (this.mustGet(reply.number).state !== 'queued' || this.typing.has(reply.number)) return;
    const original = reply.replyTo === null ? undefined : this.store.get(reply.replyTo);
    let finished: () => void = () => undefined;
    this.typing.set(reply.number, new Promise<void>(resolve => { finished = resolve; }));
    try {
      const result = await this.host.typeIntoTab(panelId, replyLine(original?.number ?? reply.number, reply.number, reply.body, reply.sender.name));
      if (result === 'busy') return;
      if (result !== 'delivered') {
        this.settleUndelivered(reply, UNDELIVERED[result]);
        return;
      }
      this.dropFromOutbox(reply.number);
      this.store.setState(reply.number, 'delivered', { via: 'tab', at: this.now() });
      this.changed();
    } finally {
      this.typing.delete(reply.number);
      finished();
    }
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
