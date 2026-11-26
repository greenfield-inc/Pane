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
  typeIntoTab(panelId: string, text: string): Promise<MessageTypeResult> {
    if (this.typeResult === 'delivered') this.typed.push({ panelId, text });
    return Promise.resolve(this.typeResult);
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
});
