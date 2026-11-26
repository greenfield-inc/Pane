import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AWAIT_REPLY_GRACE_MS, AgentMessageService, type AgentMessageHost, type MessagePanelInfo, type MessageTypeResult } from './agentMessageService';
import { AgentMessageStore } from './agentMessageStore';

/** A fake Pane: tabs by id, what was typed into each, and which are down or busy. */
class FakeHost implements AgentMessageHost {
  panels = new Map<string, MessagePanelInfo>();
  typed: Array<{ panelId: string; text: string }> = [];
  down = new Set<string>();
  busy = new Set<string>();
  orchestrators = new Map<string, string>();
  resumes: string[] = [];
  resumeError: Error | undefined;
  typeResult: MessageTypeResult = 'delivered';
  /** When set, typing waits for this before it finishes (a slow agent prompt). */
  typingGate: Promise<void> | undefined;

  add(panelId: string, name: string, extra: Partial<MessagePanelInfo> = {}): void {
    this.panels.set(panelId, { panelId, paneId: `pane-${panelId}`, sessionId: null, name, orchestrator: false, agent: true, ...extra });
  }
  panel(panelId: string): MessagePanelInfo | null { return this.panels.get(panelId) ?? null; }
  orchestratorPanel(sessionId: string): string | null { return this.orchestrators.get(sessionId) ?? null; }
  isPanelDown(panelId: string): Promise<boolean> { return Promise.resolve(this.down.has(panelId)); }
  resumePanel(panelId: string): Promise<boolean> {
    this.resumes.push(panelId);
    if (this.resumeError) return Promise.reject(this.resumeError);
    this.down.delete(panelId);
    return Promise.resolve(true);
  }
  isMidTurn(panelId: string): boolean { return this.busy.has(panelId); }
  hasUnsentText(): Promise<boolean> { return Promise.resolve(false); }
  /** Every typing attempt, delivered or not. */
  attempts = 0;
  async typeIntoTab(panelId: string, text: string): Promise<MessageTypeResult> {
    this.attempts += 1;
    if (this.typeResult === 'delivered') this.typed.push({ panelId, text });
    if (this.typingGate) await this.typingGate;
    return this.typeResult;
  }
  log(): void { /* quiet */ }
}

describe('AgentMessageService', () => {
  let db: Database.Database;
  let host: FakeHost;
  let service: AgentMessageService;
  let clock = 1_000;
  beforeEach(() => {
    db = new Database(':memory:');
    host = new FakeHost();
    clock = 1_000;
    service = new AgentMessageService(new AgentMessageStore(db), host, () => clock);
    host.add('a', 'the "Omni Chat" Session orchestrator', { sessionId: 's1', orchestrator: true });
    host.add('b', 'the "Billing" Session orchestrator', { sessionId: 's2', orchestrator: true });
  });
  afterEach(() => db.close());

  it("gives an agent's message an id and ends it with the reply line", () => {
    const sent = service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Is the API frozen?' });
    expect(sent?.ref).toBe('M-1');
    expect(sent?.text).toBe('Is the API frozen?\n\nReply with runpane reply M-1 "…": it reaches the "Omni Chat" Session orchestrator, who never sees your own chat.');
    service.finishMessage(1, { ok: true });
    expect(service.show(1).message).toMatchObject({ state: 'delivered', sender: { panelId: 'a' }, receiver: { panelId: 'b' }, text: 'Is the API frozen?' });
  });

  it('leaves what the person sends untouched: the app, --source user, a shell tab, and a tab writing to itself', () => {
    host.add('shell', 'Terminal', { agent: false });
    expect(service.beginMessage({ callerPanelId: undefined, receiverPanelId: 'b', body: 'hi' })).toBeUndefined();
    expect(service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'hi', source: 'user' })).toBeUndefined();
    expect(service.beginMessage({ callerPanelId: 'shell', receiverPanelId: 'b', body: 'hi' })).toBeUndefined();
    expect(service.beginMessage({ callerPanelId: 'b', receiverPanelId: 'b', body: 'hi' })).toBeUndefined();
    expect(service.list()).toEqual([]);
  });

  it("types the reply into the sender's tab, naming the original, and marks the original answered", async () => {
    service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Is the API frozen?' });
    service.finishMessage(1, { ok: true });
    const result = await service.reply({ to: 1, body: 'Yes, until Friday.', callerPanelId: 'b' });
    expect(result.delivery).toBe('delivered');
    expect(host.typed).toEqual([{ panelId: 'a', text: 'reply: M-1 → "Yes, until Friday." (from the "Billing" Session orchestrator) [M-2; answer it with runpane reply M-2 "…"]' }]);
    const shown = service.show(1);
    expect(shown.message).toMatchObject({ state: 'answered', replies: ['M-2'] });
    expect(shown.replies[0]).toMatchObject({ ref: 'M-2', kind: 'reply', replyTo: 'M-1', state: 'delivered', deliveredVia: 'tab' });
  });

  it("waits while the sender's tab is mid-turn, then types it when it is at its prompt", async () => {
    service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
    host.busy.add('a');
    expect((await service.reply({ to: 1, body: 'A', callerPanelId: 'b' })).delivery).toBe('queued');
    expect(service.queuedFor('a').map(reply => reply.ref)).toEqual(['M-2']);
    host.busy.delete('a');
    await service.flush();
    expect(host.typed).toHaveLength(1);
    expect(service.queuedFor('a')).toEqual([]);
  });

  it("resumes a sender's tab that is down, then delivers", async () => {
    service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
    host.down.add('a');
    await service.reply({ to: 1, body: 'A', callerPanelId: 'b' });
    expect(host.resumes).toEqual(['a']);
    await service.flush();
    expect(host.typed.map(entry => entry.panelId)).toEqual(['a']);
  });

  it("follows an orchestrator's Session to its current tab after the tab was replaced", async () => {
    service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
    host.panels.delete('a');
    host.add('a2', 'the "Omni Chat" Session orchestrator', { sessionId: 's1', orchestrator: true });
    host.orchestrators.set('s1', 'a2');
    await service.reply({ to: 1, body: 'A', callerPanelId: 'b' });
    expect(host.typed.map(entry => entry.panelId)).toEqual(['a2']);
  });

  it("says a reply is undelivered when the sender's tab is gone for good", async () => {
    host.add('w', 'Worker');
    service.beginMessage({ callerPanelId: 'w', receiverPanelId: 'b', body: 'Q' });
    host.panels.delete('w');
    const result = await service.reply({ to: 1, body: 'A', callerPanelId: 'b' });
    expect(result.delivery).toBe('undelivered');
    expect(result.reply.undeliveredReason).toBe('its tab closed');
  });

  it('keeps queued replies across a restart', async () => {
    service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
    host.busy.add('a');
    await service.reply({ to: 1, body: 'A', callerPanelId: 'b' });
    const restarted = new AgentMessageService(new AgentMessageStore(db), host, () => clock);
    host.busy.delete('a');
    restarted.start();
    await restarted.flush();
    expect(host.typed.map(entry => entry.text)).toEqual([expect.stringContaining('reply: M-1 → "A"')]);
  });

  it('hands the reply to a waiting --await-reply call instead of typing it', async () => {
    service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
    const waiting = service.waitForReply(1, 10_000);
    const result = await service.reply({ to: 1, body: 'A', callerPanelId: 'b' });
    expect(result.delivery).toBe('delivered');
    await expect(waiting).resolves.toMatchObject({ ref: 'M-2', text: 'A', deliveredVia: 'call' });
    expect(host.typed).toEqual([]);
  });

  it('a wait that starts after the reply was queued takes it, and it is not typed as well', async () => {
    service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
    host.busy.add('a');
    await service.reply({ to: 1, body: 'A', callerPanelId: 'b' });
    await expect(service.waitForReply(1, 10)).resolves.toMatchObject({ ref: 'M-2', deliveredVia: 'call' });
    host.busy.delete('a');
    await service.flush();
    expect(host.typed).toEqual([]);
  });

  it('a wait times out with nothing', async () => {
    service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
    await expect(service.waitForReply(1, 5)).resolves.toBeUndefined();
  });

  it('refuses a reply to a message that does not exist, and an empty reply', async () => {
    await expect(service.reply({ to: 9, body: 'A', callerPanelId: 'b' })).rejects.toMatchObject({ code: 'ERR_MESSAGE_NOT_FOUND' });
    service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
    await expect(service.reply({ to: 1, body: '  ', callerPanelId: 'b' })).rejects.toMatchObject({ code: 'ERR_RUNPANE_INVALID_ARGUMENT' });
  });

  it("lists a tab's messages, sent and received, newest first", async () => {
    service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
    await service.reply({ to: 1, body: 'A', callerPanelId: 'b' });
    expect(service.list({ panelId: 'a' }).map(message => message.ref)).toEqual(['M-2', 'M-1']);
  });

  it('records a failed submit as undelivered', () => {
    service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
    service.finishMessage(1, { ok: false, reason: 'the composer was not found' });
    expect(service.show(1).message).toMatchObject({ state: 'undelivered', undeliveredReason: 'the composer was not found' });
  });
  // Codex review of #1736, Must-Fix 1: the person's words relayed by Autopilot keep the person's origin.
  it("sends the person's words an agent passes on as the person's: --for-person, or Autopilot's relay prefix", () => {
    expect(service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Ship it', personWords: true })).toBeUndefined();
    expect(service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: '[From the person, via Autopilot] Ship it' })).toBeUndefined();
    expect(service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: '[From Autopilot] Where does T-3 stand?' })?.ref).toBe('M-1');
  });

  // Must-Fix 2: a reply that beats the sender's wait call is held for it, never typed, and never lost.
  it('holds a reply that comes before the --await-reply wait call, and hands it to that call', async () => {
    service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q', awaitReply: true });
    expect((await service.reply({ to: 1, body: 'A', callerPanelId: 'b' })).delivery).toBe('queued');
    await service.flush();
    expect(host.typed).toEqual([]);
    await expect(service.waitForReply(1, 10)).resolves.toMatchObject({ ref: 'M-2', deliveredVia: 'call' });
    expect(host.typed).toEqual([]);
  });

  it('types a held reply into the tab when the sender never comes to wait', async () => {
    vi.useFakeTimers();
    try {
      service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q', awaitReply: true });
      await service.reply({ to: 1, body: 'A', callerPanelId: 'b' });
      await vi.advanceTimersByTimeAsync(AWAIT_REPLY_GRACE_MS + 1);
      await service.flush();
      expect(host.typed.map(entry => entry.panelId)).toEqual(['a']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('types a reply into the tab when it comes after the wait timed out', async () => {
    service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q', awaitReply: true });
    await expect(service.waitForReply(1, 5)).resolves.toBeUndefined();
    await service.reply({ to: 1, body: 'A', callerPanelId: 'b' });
    expect(host.typed.map(entry => entry.panelId)).toEqual(['a']);
  });

  it('a wait returns a reply that was already typed instead of timing out', async () => {
    service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
    await service.reply({ to: 1, body: 'A', callerPanelId: 'b' });
    await expect(service.waitForReply(1, 5)).resolves.toMatchObject({ ref: 'M-2', deliveredVia: 'tab' });
  });

  // Must-Fix 3: the Session's current orchestrator tab wins, even while the old tab still exists.
  it("sends a reply to the Session's current orchestrator tab while the old one still exists", async () => {
    service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
    host.add('a2', 'the "Omni Chat" Session orchestrator', { sessionId: 's1', orchestrator: true });
    host.orchestrators.set('s1', 'a2');
    await service.reply({ to: 1, body: 'A', callerPanelId: 'b' });
    expect(host.typed.map(entry => entry.panelId)).toEqual(['a2']);
  });

  // Must-Fix 4: a resume that throws is a failed resume; after the tries, the reply says why.
  it('counts a resume that throws as failed, and gives up with a saved reason', async () => {
    host.add('w', 'Worker');
    service.beginMessage({ callerPanelId: 'w', receiverPanelId: 'b', body: 'Q' });
    host.down.add('w');
    host.resumeError = new Error('the launch command is missing');
    await service.reply({ to: 1, body: 'A', callerPanelId: 'b' });
    await service.flush();
    await service.flush();
    await service.flush();
    expect(host.resumes).toEqual(['w', 'w', 'w']);
    expect(service.show(1).replies[0]).toMatchObject({ state: 'undelivered', undeliveredReason: 'it would not restart: the launch command is missing' });
    const restarted = new AgentMessageService(new AgentMessageStore(db), host, () => clock);
    restarted.start();
    await restarted.flush();
    expect(host.resumes).toHaveLength(3);
  });

  // Must-Fix 5: a replayed submit (same operation id) is the same message with the same text.
  it('gives a replayed submit the same message id and text', () => {
    const first = service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q', operationId: 'op-1' });
    service.finishMessage(1, { ok: true });
    const again = service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q', operationId: 'op-1' });
    expect(again).toEqual(first);
    expect(service.list().map(message => message.ref)).toEqual(['M-1']);
    expect(service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q', operationId: 'op-2' })?.ref).toBe('M-2');
  });
  it("pages a tab's messages back with before, newest first", async () => {
    for (let index = 0; index < 5; index++) service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: `Q${index}` });
    expect(service.list({ panelId: 'a', limit: 2 }).map(message => message.ref)).toEqual(['M-5', 'M-4']);
    expect(service.list({ panelId: 'a', limit: 2, before: 4 }).map(message => message.ref)).toEqual(['M-3', 'M-2']);
    expect(service.list({ panelId: 'a', limit: 2, before: 2 }).map(message => message.ref)).toEqual(['M-1']);
    expect(service.list({ panelId: 'a', before: 1 })).toEqual([]);
  });
  // Review 2, Must-Fix 3: a call from the tab the Session left doesn't take the reply; the current orchestrator gets it.
  it("types a reply into the Session's current orchestrator even while the old tab's --await-reply wait is active", async () => {
    service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q', awaitReply: true });
    const oldWait = service.waitForReply(1, 20, undefined, 'a');
    host.add('a2', 'the "Omni Chat" Session orchestrator', { sessionId: 's1', orchestrator: true });
    host.orchestrators.set('s1', 'a2');
    const result = await service.reply({ to: 1, body: 'A', callerPanelId: 'b' });
    expect(result.reply).toMatchObject({ state: 'delivered', deliveredVia: 'tab' });
    expect(host.typed.map(entry => entry.panelId)).toEqual(['a2']);
    // The old tab's call gets nothing: the answer went to the conversation the Session moved to.
    await expect(oldWait).resolves.toBeUndefined();
  });

  it("doesn't hold a reply for the old tab's --await-reply call once the Session has a new orchestrator", async () => {
    service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q', awaitReply: true });
    host.add('a2', 'the "Omni Chat" Session orchestrator', { sessionId: 's1', orchestrator: true });
    host.orchestrators.set('s1', 'a2');
    expect((await service.reply({ to: 1, body: 'A', callerPanelId: 'b' })).delivery).toBe('delivered');
    expect(host.typed.map(entry => entry.panelId)).toEqual(['a2']);
    expect(service.show(1).replies[0]).toMatchObject({ deliveredVia: 'tab' });
  });

  it('hands a held reply only to a call from its current route', async () => {
    service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q', awaitReply: true });
    await service.reply({ to: 1, body: 'A', callerPanelId: 'b' });
    host.add('a2', 'the "Omni Chat" Session orchestrator', { sessionId: 's1', orchestrator: true });
    host.orchestrators.set('s1', 'a2');
    await expect(service.waitForReply(1, 10, undefined, 'a')).resolves.toBeUndefined();
    await service.flush();
    expect(host.typed.map(entry => entry.panelId)).toEqual(['a2']);
  });

  // Review 2, Must-Fix 4: a reply is claimed once: typed, or handed to a call, never both.
  it('never types a reply twice when a wait claims it while another reply to the same tab is being typed', async () => {
    let open: () => void = () => undefined;
    host.typingGate = new Promise<void>(resolve => { open = resolve; });
    service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q1' });
    service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q2' });
    const first = service.reply({ to: 1, body: 'A1', callerPanelId: 'b' });
    await vi.waitFor(() => expect(host.typed).toHaveLength(1));
    // M-4 answers M-2 while M-3, the reply to M-1, is still being typed into the same tab.
    const second = service.reply({ to: 2, body: 'A2', callerPanelId: 'b' });
    await vi.waitFor(() => expect(service.show(2).replies).toHaveLength(1));
    await expect(service.waitForReply(2, 10, undefined, 'a')).resolves.toMatchObject({ text: 'A2', deliveredVia: 'call' });
    // A wait for the reply being typed waits for that typing, and gets it as typed.
    const typedOne = service.waitForReply(1, 1_000, undefined, 'a');
    open();
    await first;
    await second;
    await expect(typedOne).resolves.toMatchObject({ text: 'A1', deliveredVia: 'tab' });
    host.typingGate = undefined;
    await service.flush();
    await service.flush();
    expect(host.typed.map(entry => entry.text)).toEqual([expect.stringContaining('"A1"')]);
  });
  // Review 3, Must-Fix 2: another tab's wait never ends the owner's reservation.
  it("keeps the --await-reply reservation when another tab waits on the message during the early-reply gap", async () => {
    host.add('x', 'Other agent');
    service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q', awaitReply: true });
    await expect(service.waitForReply(1, 5, undefined, 'x')).resolves.toBeUndefined();
    expect((await service.reply({ to: 1, body: 'A', callerPanelId: 'b' })).delivery).toBe('queued');
    await expect(service.waitForReply(1, 5, undefined, 'x')).resolves.toBeUndefined();
    await service.flush();
    expect(host.typed).toEqual([]);
    await expect(service.waitForReply(1, 5, undefined, 'a')).resolves.toMatchObject({ ref: 'M-2', deliveredVia: 'call' });
    await service.flush();
    expect(host.typed).toEqual([]);
  });

  // Review 3, Must-Fix 3: a typing attempt that comes back busy leaves the reply queued, and the wait re-reads it.
  it('after a busy typing attempt, hands the still-queued reply to a wait from its route, and it is never typed as well', async () => {
    let open: () => void = () => undefined;
    host.typingGate = new Promise<void>(resolve => { open = resolve; });
    host.typeResult = 'busy';
    service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
    const replied = service.reply({ to: 1, body: 'A', callerPanelId: 'b' });
    await vi.waitFor(() => expect(host.attempts).toBe(1));
    const waited = service.waitForReply(1, 1_000, undefined, 'a');
    open();
    await replied;
    await expect(waited).resolves.toMatchObject({ ref: 'M-2', state: 'delivered', deliveredVia: 'call' });
    host.typingGate = undefined;
    host.typeResult = 'delivered';
    await service.flush();
    expect(host.typed).toEqual([]);
  });

  it('after a busy typing attempt, leaves the reply for the tab when the wait is not from its route', async () => {
    let open: () => void = () => undefined;
    host.typingGate = new Promise<void>(resolve => { open = resolve; });
    host.typeResult = 'busy';
    host.add('x', 'Other agent');
    service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
    const replied = service.reply({ to: 1, body: 'A', callerPanelId: 'b' });
    await vi.waitFor(() => expect(host.attempts).toBe(1));
    const waited = service.waitForReply(1, 50, undefined, 'x');
    open();
    await replied;
    await expect(waited).resolves.toBeUndefined();
    host.typingGate = undefined;
    host.typeResult = 'delivered';
    await service.flush();
    expect(host.typed.map(entry => entry.panelId)).toEqual(['a']);
  });

  it('gives up a wait on a reply being typed when its time runs out', async () => {
    host.typingGate = new Promise<void>(() => undefined);
    service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
    void service.reply({ to: 1, body: 'A', callerPanelId: 'b' });
    await vi.waitFor(() => expect(host.attempts).toBe(1));
    const started = Date.now();
    await expect(service.waitForReply(1, 30, undefined, 'a')).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
  // Review 4: listen, then look. A reply that arrives while the wait sits on another reply's typing attempt is still its answer.
  it('gives a wait the second reply that arrived while the first was being typed and then failed', async () => {
    let open: () => void = () => undefined;
    host.typingGate = new Promise<void>(resolve => { open = resolve; });
    host.typeResult = 'unsupported';
    service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
    const first = service.reply({ to: 1, body: 'A1', callerPanelId: 'b' });
    await vi.waitFor(() => expect(host.attempts).toBe(1));
    const waited = service.waitForReply(1, 500, undefined, 'a');
    // M-3 arrives during M-2's attempt; then that attempt fails (the tab takes no typed messages).
    const second = service.reply({ to: 1, body: 'A2', callerPanelId: 'b' });
    open();
    await first;
    await second;
    await expect(waited).resolves.toMatchObject({ ref: 'M-3', text: 'A2', deliveredVia: 'call' });
    expect(service.show(1).replies.map(reply => [reply.ref, reply.state])).toEqual([['M-2', 'undelivered'], ['M-3', 'delivered']]);
    host.typingGate = undefined;
    host.typeResult = 'delivered';
    await service.flush();
    expect(host.typed).toEqual([]);
  });

  it('a wait that is already listening takes a reply that comes after its first look', async () => {
    service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
    const waited = service.waitForReply(1, 500, undefined, 'a');
    await service.reply({ to: 1, body: 'A', callerPanelId: 'b' });
    await expect(waited).resolves.toMatchObject({ ref: 'M-2', deliveredVia: 'call' });
    expect(host.typed).toEqual([]);
  });

  it('a wait that is aborted before it starts returns nothing and leaves no listener', async () => {
    service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
    const controller = new AbortController();
    controller.abort();
    await expect(service.waitForReply(1, 500, controller.signal, 'a')).resolves.toBeUndefined();
    await service.reply({ to: 1, body: 'A', callerPanelId: 'b' });
    expect(host.typed.map(entry => entry.panelId)).toEqual(['a']);
  });
  // Review 5: the call prints the first reply. A later reply that comes while the first is typed waits for that outcome.
  it('returns the first reply when it is typed while a later one arrives, and types the later one once', async () => {
    let open: () => void = () => undefined;
    host.typingGate = new Promise<void>(resolve => { open = resolve; });
    service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
    const first = service.reply({ to: 1, body: 'A1', callerPanelId: 'b' });
    await vi.waitFor(() => expect(host.attempts).toBe(1));
    const waited = service.waitForReply(1, 500, undefined, 'a');
    expect((await service.reply({ to: 1, body: 'A2', callerPanelId: 'b' })).delivery).toBe('queued');
    open();
    await first;
    await expect(waited).resolves.toMatchObject({ ref: 'M-2', text: 'A1', deliveredVia: 'tab' });
    host.typingGate = undefined;
    await service.flush();
    expect(host.typed.map(entry => entry.text)).toEqual([expect.stringContaining('"A1"'), expect.stringContaining('"A2"')]);
    expect(service.show(1).replies.map(reply => [reply.ref, reply.state, reply.deliveredVia])).toEqual([['M-2', 'delivered', 'tab'], ['M-3', 'delivered', 'tab']]);
  });

  it('types a reply parked behind an earlier one when the wait ends without taking it', async () => {
    let open: () => void = () => undefined;
    host.typingGate = new Promise<void>(resolve => { open = resolve; });
    service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
    const first = service.reply({ to: 1, body: 'A1', callerPanelId: 'b' });
    await vi.waitFor(() => expect(host.attempts).toBe(1));
    const waited = service.waitForReply(1, 20, undefined, 'a');
    await service.reply({ to: 1, body: 'A2', callerPanelId: 'b' });
    await expect(waited).resolves.toBeUndefined();
    open();
    await first;
    host.typingGate = undefined;
    await service.flush();
    expect(host.typed.map(entry => entry.text)).toEqual([expect.stringContaining('"A1"'), expect.stringContaining('"A2"')]);
  });
  // Review 6: a parked reply that no listening call can take any more (the Session moved) goes to its tab at once.
  it("sends a parked reply to the Session's new orchestrator when the old tab's wait can no longer take it", async () => {
    let open: () => void = () => undefined;
    host.typingGate = new Promise<void>(resolve => { open = resolve; });
    host.typeResult = 'unsupported';
    service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
    const first = service.reply({ to: 1, body: 'A1', callerPanelId: 'b' });
    await vi.waitFor(() => expect(host.attempts).toBe(1));
    const waited = service.waitForReply(1, 1_000, undefined, 'a');
    expect((await service.reply({ to: 1, body: 'A2', callerPanelId: 'b' })).delivery).toBe('queued');
    host.add('a2', 'the "Omni Chat" Session orchestrator', { sessionId: 's1', orchestrator: true });
    host.orchestrators.set('s1', 'a2');
    open();
    await first;
    host.typingGate = undefined;
    host.typeResult = 'delivered';
    await service.flush();
    // Typed into a2 now, while the old tab's call is still waiting.
    expect(host.typed).toEqual([{ panelId: 'a2', text: expect.stringContaining('"A2"') }]);
    expect(service.show(1).replies.map(reply => [reply.ref, reply.state])).toEqual([['M-2', 'undelivered'], ['M-3', 'delivered']]);
    await expect(waited).resolves.toBeUndefined();
  });

  it("doesn't leave a parked reply with a call from another tab, which can never take it", async () => {
    let open: () => void = () => undefined;
    host.typingGate = new Promise<void>(resolve => { open = resolve; });
    host.typeResult = 'unsupported';
    host.add('x', 'Other agent');
    service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
    const first = service.reply({ to: 1, body: 'A1', callerPanelId: 'b' });
    await vi.waitFor(() => expect(host.attempts).toBe(1));
    const fromRoute = service.waitForReply(1, 30, undefined, 'a');
    const fromOther = service.waitForReply(1, 1_000, undefined, 'x');
    expect((await service.reply({ to: 1, body: 'A2', callerPanelId: 'b' })).delivery).toBe('queued');
    // The route's call leaves while A1 is still being typed; A1 then fails. Only the other tab's call is left, and it can't take A2.
    await expect(fromRoute).resolves.toBeUndefined();
    open();
    await first;
    host.typingGate = undefined;
    host.typeResult = 'delivered';
    await service.flush();
    expect(host.typed).toEqual([{ panelId: 'a', text: expect.stringContaining('"A2"') }]);
    // That call was never A2's route, so it ends with no reply of its own.
    await expect(fromOther).resolves.toBeUndefined();
  });
});
