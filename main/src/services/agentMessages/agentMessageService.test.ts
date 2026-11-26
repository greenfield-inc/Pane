import Database from 'better-sqlite3-multiple-ciphers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentMessageService, type AgentMessageHost, type MessagePanelInfo, type MessageTypeResult } from './agentMessageService';
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
  /** When set, the composer-draft check waits for this (a slow readiness check). */
  draftGate: Promise<void> | undefined;
  async hasUnsentText(): Promise<boolean> {
    if (this.draftGate) await this.draftGate;
    return false;
  }
  /** Every typing attempt, delivered or not. */
  attempts = 0;
  /** Tabs that turn out closed when typed into. */
  goneOnType = new Set<string>();
  async typeIntoTab(panelId: string, text: string): Promise<MessageTypeResult> {
    this.attempts += 1;
    const result = this.goneOnType.has(panelId) ? 'gone' : this.typeResult;
    if (result === 'delivered') this.typed.push({ panelId, text });
    if (this.typingGate) await this.typingGate;
    return result;
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
    expect(host.typed).toEqual([{ panelId: 'a', text: 'reply: M-1 → "Yes, until Friday." (from the "Billing" Session orchestrator) [M-2; answer it with runpane reply M-2 "…"] — if a waiting command already returned this reply, act on it once.' }]);
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

  // T-109: --await-reply and messages wait only watch. Every reply is typed into the sender's tab once,
  // through the outbox, and the wait returns the first reply record as soon as it exists.
  describe('waiting for a reply (read-only)', () => {
    const typedReplies = () => host.typed.filter(entry => entry.text.startsWith('reply: '));

    it('returns a reply that is already there, and it is still typed into the tab once', async () => {
      service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
      await service.reply({ to: 1, body: 'A', callerPanelId: 'b' });
      await expect(service.waitForReply(1, 10)).resolves.toMatchObject({ ref: 'M-2', text: 'A', deliveredVia: 'tab' });
      expect(typedReplies()).toEqual([{ panelId: 'a', text: expect.stringContaining('reply: M-1 → "A"') }]);
    });

    it('returns a reply that arrives while it waits, and it is still typed into the tab once', async () => {
      service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
      const waiting = service.waitForReply(1, 1000, undefined);
      await service.reply({ to: 1, body: 'A', callerPanelId: 'b' });
      await expect(waiting).resolves.toMatchObject({ ref: 'M-2', text: 'A' });
      expect(typedReplies()).toHaveLength(1);
    });

    it('returns a reply that arrived between the send and the wait while the tab was busy, and types it once the tab is free', async () => {
      service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
      host.busy.add('a');
      await service.reply({ to: 1, body: 'A', callerPanelId: 'b' });
      await expect(service.waitForReply(1, 10)).resolves.toMatchObject({ ref: 'M-2', state: 'queued' });
      expect(host.typed).toEqual([]);
      host.busy.delete('a');
      await service.flush();
      expect(typedReplies()).toHaveLength(1);
      expect(service.show(1).replies[0]).toMatchObject({ state: 'delivered', deliveredVia: 'tab' });
    });

    it('answers as soon as the reply is recorded, before its typing ends', async () => {
      service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
      let open: () => void = () => undefined;
      host.typingGate = new Promise<void>(resolve => { open = resolve; });
      const waiting = service.waitForReply(1, 1000);
      const replying = service.reply({ to: 1, body: 'A', callerPanelId: 'b' });
      await expect(waiting).resolves.toMatchObject({ ref: 'M-2' });
      open();
      await replying;
      expect(typedReplies()).toHaveLength(1);
    });

    it('times out with nothing, and a later reply is typed into the tab once', async () => {
      service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
      await expect(service.waitForReply(1, 5)).resolves.toBeUndefined();
      await service.reply({ to: 1, body: 'A', callerPanelId: 'b' });
      expect(typedReplies()).toHaveLength(1);
      expect(service.listenerCount('changed')).toBe(0);
    });

    it('returns nothing when aborted, before or during the wait, and leaves no listener', async () => {
      service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
      const early = new AbortController();
      early.abort();
      await expect(service.waitForReply(1, 1000, early.signal)).resolves.toBeUndefined();
      const later = new AbortController();
      const waiting = service.waitForReply(1, 1000, later.signal);
      later.abort();
      await expect(waiting).resolves.toBeUndefined();
      expect(service.listenerCount('changed')).toBe(0);
      await service.reply({ to: 1, body: 'A', callerPanelId: 'b' });
      expect(typedReplies()).toHaveLength(1);
    });

    it('returns the first of two replies, and types each into the tab once, in order', async () => {
      service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
      host.add('c', 'Worker C');
      let open: () => void = () => undefined;
      host.typingGate = new Promise<void>(resolve => { open = resolve; });
      const waiting = service.waitForReply(1, 1000);
      const first = service.reply({ to: 1, body: 'A1', callerPanelId: 'b' });
      const second = service.reply({ to: 1, body: 'A2', callerPanelId: 'c' });
      await expect(waiting).resolves.toMatchObject({ ref: 'M-2', text: 'A1' });
      open();
      host.typingGate = undefined;
      await Promise.all([first, second]);
      await service.flush();
      expect(typedReplies().map(entry => entry.text)).toEqual([expect.stringContaining('"A1"'), expect.stringContaining('"A2"')]);
      await expect(service.waitForReply(1, 10)).resolves.toMatchObject({ text: 'A1' });
    });

    it("types the reply into the Session's new orchestrator once when the Session switches during a wait, and the wait still returns it", async () => {
      service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
      const waiting = service.waitForReply(1, 1000, undefined);
      host.add('a2', 'the "Omni Chat" Session orchestrator', { sessionId: 's1', orchestrator: true });
      host.orchestrators.set('s1', 'a2');
      await service.reply({ to: 1, body: 'A', callerPanelId: 'b' });
      await expect(waiting).resolves.toMatchObject({ ref: 'M-2', text: 'A' });
      expect(typedReplies()).toEqual([{ panelId: 'a2', text: expect.stringContaining('reply: M-1 → "A"') }]);
    });

    it('tells the receiver it may already have the reply from a waiting command', async () => {
      service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
      await service.reply({ to: 1, body: 'A', callerPanelId: 'b' });
      expect(typedReplies()[0]?.text).toMatch(/if a waiting command already returned this reply, act on it once\.$/u);
    });

    it('refuses to wait on a message that does not exist', async () => {
      await expect(service.waitForReply(99, 10)).rejects.toMatchObject({ code: 'ERR_MESSAGE_NOT_FOUND' });
    });
  });
  // Review 8, Must-Fix 1: the route is read again at the delivery boundary, after every await before typing.
  describe('a Session handoff during delivery', () => {
    const replyLines = () => host.typed.filter(entry => entry.text.startsWith('reply: '));
    const handOff = () => {
      host.add('a2', 'the "Omni Chat" Session orchestrator', { sessionId: 's1', orchestrator: true });
      host.orchestrators.set('s1', 'a2');
    };

    it("types the reply into the new orchestrator when the Session switches during the old tab's readiness check", async () => {
      host.orchestrators.set('s1', 'a');
      service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
      let open: () => void = () => undefined;
      host.draftGate = new Promise<void>(resolve => { open = resolve; });
      const replying = service.reply({ to: 1, body: 'A', callerPanelId: 'b' });
      await Promise.resolve();
      handOff();
      open();
      host.draftGate = undefined;
      await replying;
      await service.flush();
      expect(replyLines()).toEqual([{ panelId: 'a2', text: expect.stringContaining('reply: M-1 → "A"') }]);
      expect(service.show(1).replies[0]).toMatchObject({ state: 'delivered', deliveredVia: 'tab' });
    });

    it('does not settle the reply undelivered when the old tab closes during the check and the Session has a new orchestrator', async () => {
      host.orchestrators.set('s1', 'a');
      service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
      let open: () => void = () => undefined;
      host.draftGate = new Promise<void>(resolve => { open = resolve; });
      const replying = service.reply({ to: 1, body: 'A', callerPanelId: 'b' });
      await Promise.resolve();
      handOff();
      host.panels.delete('a');
      open();
      host.draftGate = undefined;
      await replying;
      await service.flush();
      expect(replyLines().map(entry => entry.panelId)).toEqual(['a2']);
      expect(service.show(1).replies[0]).toMatchObject({ state: 'delivered' });
    });

    it('tries the new orchestrator when the old tab turns out gone while being typed into', async () => {
      host.orchestrators.set('s1', 'a');
      service.beginMessage({ callerPanelId: 'a', receiverPanelId: 'b', body: 'Q' });
      let open: () => void = () => undefined;
      host.typingGate = new Promise<void>(resolve => { open = resolve; });
      host.goneOnType.add('a');
      const replying = service.reply({ to: 1, body: 'A', callerPanelId: 'b' });
      await Promise.resolve();
      handOff();
      host.panels.delete('a');
      host.typingGate = undefined;
      open();
      await replying;
      await service.flush();
      expect(replyLines().map(entry => entry.panelId)).toEqual(['a2']);
      expect(service.show(1).replies[0]).toMatchObject({ state: 'delivered' });
    });
  });

  // Review 8, Must-Fix 3: a reply an earlier preview build handed to a waiting call (delivered_via 'call') still reads.
  it("reads a preview build's reply recorded as delivered to a call, as not typed (deliveredVia null)", async () => {
    const legacy = new Database(':memory:');
    try {
      legacy.prepare(`CREATE TABLE agent_messages (
        number INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, reply_to INTEGER,
        sender_panel_id TEXT, sender_pane_id TEXT, sender_session_id TEXT, sender_name TEXT NOT NULL, sender_orchestrator INTEGER NOT NULL DEFAULT 0,
        receiver_panel_id TEXT, receiver_pane_id TEXT, receiver_session_id TEXT, receiver_name TEXT NOT NULL, receiver_orchestrator INTEGER NOT NULL DEFAULT 0,
        body TEXT NOT NULL, state TEXT NOT NULL,
        delivered_via TEXT CHECK (delivered_via IS NULL OR delivered_via IN ('tab', 'call')),
        undelivered_reason TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER, answered_at INTEGER)`).run();
      const insert = legacy.prepare(`INSERT INTO agent_messages (kind, reply_to, sender_panel_id, sender_name, receiver_panel_id, receiver_name, body, state, delivered_via, created_at, delivered_at, answered_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1000, ?, ?)`);
      insert.run('message', null, 'a', 'A', 'b', 'B', 'Q', 'answered', 'tab', 1000, 2000);
      insert.run('reply', 1, 'b', 'B', 'a', 'A', 'Yes', 'delivered', 'call', 2000, null);
      const upgraded = new AgentMessageService(new AgentMessageStore(legacy), host, () => clock);
      expect(upgraded.show(1).replies[0]).toMatchObject({ ref: 'M-2', text: 'Yes', state: 'delivered', deliveredVia: null });
      expect(upgraded.list().map(record => [record.ref, record.deliveredVia])).toEqual([['M-2', null], ['M-1', 'tab']]);
      await expect(upgraded.waitForReply(1, 10)).resolves.toMatchObject({ ref: 'M-2', deliveredVia: null });
    } finally {
      legacy.close();
    }
  });
});
