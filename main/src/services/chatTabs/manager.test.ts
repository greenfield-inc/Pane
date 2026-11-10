import { createHash } from 'crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolPanel } from '../../../../shared/types/panels';
import { applyChatTabEvent, type ChatPanelState, type ChatTabEvent, type ChatTabView } from '../../../../shared/types/chatTab';
import { PaneError } from '../../../../shared/paneError';
import type { PanelAgentStatusEvent } from '../../../../shared/types/agentStatus';
import { ChatTabManager, type ChatTabLauncher, type ChatTabManagerOptions, type ChatTabStore } from './manager';
import { ChatTabNotifyBridge } from './notifyBridge';

const AGENT = path.join(__dirname, 'testing', 'scriptedAgent.mjs');
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

class MemoryStore implements ChatTabStore {
  readonly saved = new Map<string, string>();
  readonly panels = new Map<string, ToolPanel>();
  add(panelId: string, state: ChatPanelState): void {
    this.panels.set(panelId, { id: panelId, sessionId: 'pane-1', type: 'chat', title: 'Claude', state: { isActive: true }, metadata: { createdAt: '', lastActiveAt: '', position: 0 } });
    this.commit(panelId, state);
  }
  panel(panelId: string) { return this.panels.get(panelId); }
  state(panelId: string): ChatPanelState | undefined { const json = this.saved.get(panelId); return json ? JSON.parse(json) : undefined; }
  commit(panelId: string, state: ChatPanelState): void { this.saved.set(panelId, JSON.stringify(state)); }
}

/** Refuses a write over the panel state row's ceiling, as panelManager.commitChatTab does. */
class CeilingStore extends MemoryStore {
  refuseQueue = false;
  override commit(panelId: string, state: ChatPanelState): void {
    const json = JSON.stringify(state);
    if (Buffer.byteLength(json) > 256 * 1024 || (this.refuseQueue && state.queue?.length)) throw new PaneError('CHAT_STATE_NOT_SAVED', 'The chat tab\'s state could not be saved.', 'Check free disk space, then press Restart in the tab.');
    super.commit(panelId, state);
  }
}

function harness(store = new MemoryStore(), env: NodeJS.ProcessEnv = {}, directory = mkdtempSync(path.join(tmpdir(), 'pane-chat-manager-')), options: Partial<ChatTabManagerOptions> = {}) {
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const sent: Array<{ channel: string; payload: ChatTabEvent | ChatTabView | PanelAgentStatusEvent }> = [];
  const launcher: ChatTabLauncher = {
    resolve: async () => ({ command: { executable: process.execPath, args: [AGENT], cwd: directory, env: { ...process.env, SCRIPTED_AGENT_STORE: path.join(directory, 'agent'), PANE_TEST_TOKEN: 'secret-token-value', ...env } } }),
  };
  const manager = new ChatTabManager({ store, launcher, send: (channel, payload) => sent.push({ channel, payload }), spoolDirectory: path.join(directory, 'spool'), ...options });
  cleanup.push(() => manager.stopAll());
  // SAFETY: the manager sends a ChatTabView on chat-tab:state and a ChatTabEvent on chat-tab:event.
  const states = () => sent.filter(entry => entry.channel === 'chat-tab:state').map(entry => entry.payload as ChatTabView);
  // SAFETY: as above, chat-tab:event payloads are ChatTabEvents.
  const events = () => sent.filter(entry => entry.channel === 'chat-tab:event').map(entry => entry.payload as ChatTabEvent);
  return { manager, store, directory, sent, states, events, launcher };
}

const replyText = (view: ChatTabView) => view.transcript?.messages.flatMap(message => message.role === 'assistant' ? message.parts.flatMap(part => part.type === 'text' ? [part.text] : []) : []).join('|') ?? '';
const userTexts = (view: ChatTabView) => view.transcript?.messages.flatMap(message => message.role === 'user' ? message.parts.flatMap(part => part.type === 'text' ? [part.text] : []) : []) ?? [];
const turnEnds = (view: ChatTabView) => view.transcript?.messages.flatMap(message => message.parts.flatMap(part => part.type === 'content' && JSON.stringify(part.content).includes('pane_turn') ? [JSON.parse(JSON.stringify(part.content)).stopReason] : [])) ?? [];
const newTab = (cwd: string): ChatPanelState => ({ agent: 'claude', launch: { kind: 'agent' }, cwd, status: 'starting' });

describe('chat tab manager', () => {
  it('starts on first view, sends a message and ends idle, with viewers able to follow by events alone', async () => {
    const { manager, store, directory, events } = harness();
    store.add('p1', newTab(directory));
    const first = manager.view('p1');
    expect(first.status).toBe('starting');
    await manager.ensure('p1');
    const viewer = manager.view('p1').transcript!;
    const receipt = manager.send('p1', { operationId: 'op-1', text: 'hello' });
    expect(receipt.state).toBe('accepted');
    await expect.poll(() => manager.receipt('p1', 'op-1')?.state).toBe('completed');
    const view = manager.view('p1');
    expect(view.status).toBe('idle');
    expect(replyText(view)).toBe('You said: hello');
    const followed = events().filter(event => event.generation === viewer.generation).reduce((current, event) => applyChatTabEvent(current, event).transcript, viewer);
    expect(followed.messages).toEqual(view.transcript!.messages);
  });

  it('tells viewers when it has finished starting, so they fetch the replayed history', async () => {
    const { manager, store, directory, states } = harness();
    store.add('p1', newTab(directory));
    expect(manager.view('p1').transcript).toBeUndefined();
    await manager.ensure('p1');
    expect(states().at(-1)?.status).toBe('idle');
  });

  it('queues a message sent while the agent works and sends it next', async () => {
    const { manager, store, directory } = harness();
    store.add('p1', newTab(directory));
    await manager.ensure('p1');
    manager.send('p1', { operationId: 'op-1', text: 'permission' });
    await expect.poll(() => manager.view('p1').permissions.length).toBe(1);
    manager.send('p1', { operationId: 'op-2', text: 'second' });
    expect(manager.view('p1').queue.map(item => item.text)).toEqual(['second']);
    expect(manager.view('p1').status).toBe('blocked');
    const [permission] = manager.view('p1').permissions;
    manager.answerPermission('p1', permission.id, 'allow');
    await expect.poll(() => manager.receipt('p1', 'op-2')?.state).toBe('completed');
    expect(replyText(manager.view('p1'))).toBe('Permission: allow|You said: second');
    expect(manager.view('p1').queue).toEqual([]);
  });

  it('keeps a message sent during the agent\'s own turn below everything that turn did (D-193)', async () => {
    const { manager, store, directory } = harness();
    store.add('p1', newTab(directory));
    await manager.ensure('p1');
    manager.send('p1', { operationId: 'op-1', text: 'background' });
    await expect.poll(() => manager.receipt('p1', 'op-1')?.state).toBe('completed');
    // The prompt has ended, but the agent is still at work on its own.
    await expect.poll(() => manager.view('p1').transcript?.messages.some(message => message.parts.some(part => part.type === 'tool' && part.title === 'Own step 1'))).toBe(true);
    expect(manager.view('p1').status).toBe('working');
    manager.send('p1', { operationId: 'op-2', text: 'second' });
    expect(manager.view('p1').queue.map(item => item.text)).toEqual(['second']);
    await expect.poll(() => manager.receipt('p1', 'op-2')?.state, { timeout: 5000 }).toBe('completed');
    const order = manager.view('p1').transcript!.messages.flatMap(message => message.parts.flatMap(part => part.type === 'tool' ? [part.title] : message.role === 'user' && part.type === 'text' ? [part.text] : []));
    expect(order).toEqual(['background', 'Own step 1', 'Own step 2', 'Own step 3', 'second', 'Read README.md']);
    // The rows are not unknown updates, and the agent's turn is timed like any other.
    const contents = manager.view('p1').transcript!.messages.flatMap(message => message.parts.flatMap(part => part.type === 'content' ? [part.content] : []));
    expect(contents.filter(content => JSON.stringify(content).includes('async_task'))).toEqual([]);
    expect(contents.filter(content => JSON.stringify(content).includes('pane_turn'))).toHaveLength(3);
  });

  it('Stop ends the agent\'s own turn and then sends what waited for it', async () => {
    const { manager, store, directory } = harness();
    store.add('p1', newTab(directory));
    await manager.ensure('p1');
    manager.send('p1', { operationId: 'op-1', text: 'background' });
    await expect.poll(() => manager.view('p1').transcript?.messages.some(message => message.parts.some(part => part.type === 'tool' && part.title === 'Own step 1'))).toBe(true);
    await expect.poll(() => manager.receipt('p1', 'op-1')?.state).toBe('completed');
    manager.send('p1', { operationId: 'op-2', text: 'second' });
    await manager.cancel('p1');
    await expect.poll(() => manager.receipt('p1', 'op-2')?.state, { timeout: 5000 }).toBe('completed');
    expect(replyText(manager.view('p1'))).toContain('You said: second');
    const turnEnds = manager.view('p1').transcript!.messages.flatMap(message => message.parts.flatMap(part => part.type === 'content' && JSON.stringify(part.content).includes('pane_turn') ? [JSON.parse(JSON.stringify(part.content)).stopReason] : []));
    expect(turnEnds).toEqual(['end_turn', 'cancelled', 'end_turn']);
  });

  it('comes back after Pane quits with its history, marks the interrupted turn and continues the same conversation', async () => {
    const store = new MemoryStore();
    const directory = mkdtempSync(path.join(tmpdir(), 'pane-chat-manager-'));
    const before = harness(store, {}, directory);
    store.add('idle', newTab(directory));
    store.add('busy', newTab(directory));
    await before.manager.ensure('idle');
    await before.manager.ensure('busy');
    before.manager.send('idle', { operationId: 'a', text: 'first' });
    await expect.poll(() => before.manager.receipt('idle', 'a')?.state).toBe('completed');
    before.manager.send('busy', { operationId: 'b', text: 'slow' });
    await expect.poll(() => before.manager.view('busy').status).toBe('working');
    const busySession = store.state('busy')?.acpSessionId;
    expect(busySession).toBeTruthy();
    await before.manager.stopAll();

    const after = harness(store, {}, directory);
    expect(after.manager.view('idle').status).not.toBe('stopped');
    await after.manager.ensure('idle');
    await after.manager.ensure('busy');
    expect(replyText(after.manager.view('idle'))).toBe('You said: first');
    const busy = after.manager.view('busy');
    expect(busy.status).toBe('idle');
    expect(busy.problem).toBeUndefined();
    const busyEnds = busy.transcript!.messages.flatMap(message => message.parts.flatMap(part => part.type === 'content' && JSON.stringify(part.content).includes('pane_turn') ? [JSON.parse(JSON.stringify(part.content)).stopReason] : []));
    expect(busyEnds.at(-1)).toBe('interrupted');
    expect(busy.notice).toBeUndefined();
    expect(after.manager.receipt('busy', 'b')?.state).toBe('failed');
    after.manager.send('busy', { operationId: 'c', text: 'next' });
    await expect.poll(() => after.manager.receipt('busy', 'c')?.state).toBe('completed');
    expect(store.state('busy')?.acpSessionId).toBe(busySession);
    expect(replyText(after.manager.view('busy'))).toContain('You said: next');
  });

  it('shows a stopped state with Restart when the agent dies, and Restart resumes the conversation', async () => {
    const { manager, store, directory } = harness();
    store.add('p1', newTab(directory));
    await manager.ensure('p1');
    manager.send('p1', { operationId: 'a', text: 'hello' });
    await expect.poll(() => manager.receipt('p1', 'a')?.state).toBe('completed');
    const sessionId = store.state('p1')?.acpSessionId;
    manager.send('p1', { operationId: 'b', text: 'crash' });
    await expect.poll(() => manager.view('p1').status).toBe('stopped');
    expect(manager.view('p1').problem).toMatchObject({ code: 'exited', action: 'restart' });
    // A stopped tab never restarts itself, however often it is viewed.
    manager.view('p1'); manager.view('p1');
    expect(manager.isRunning('p1')).toBe(false);
    expect(() => manager.send('p1', { operationId: 'c', text: 'hi' })).toThrow(expect.objectContaining({ code: 'CHAT_STOPPED' }));
    await manager.restart('p1');
    expect(manager.view('p1').status).toBe('idle');
    expect(store.state('p1')?.acpSessionId).toBe(sessionId);
    expect(replyText(manager.view('p1'))).toContain('You said: hello');
  });

  it('explains a signed-out agent and does not retry by itself', async () => {
    const { manager, store, directory } = harness(new MemoryStore(), { SCRIPTED_AGENT_SIGNED_OUT: '1' });
    store.add('p1', newTab(directory));
    await expect(manager.ensure('p1')).rejects.toBeDefined();
    const view = manager.view('p1');
    expect(view.status).toBe('stopped');
    expect(view.problem).toMatchObject({ code: 'signed-out', action: 'sign-in' });
    expect(view.problem?.next).toMatch(/claude auth login/);
    expect(manager.isRunning('p1')).toBe(false);
  });

  it('turns a missing agent into the not-installed state', async () => {
    const store = new MemoryStore();
    const directory = mkdtempSync(path.join(tmpdir(), 'pane-chat-manager-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const manager = new ChatTabManager({
      store, send: () => undefined, spoolDirectory: directory,
      launcher: { resolve: async () => { throw new PaneError('CHAT_AGENT_NOT_INSTALLED', 'Claude Code is not installed on this machine.', 'Install Claude Code, then press Restart.'); } },
    });
    store.add('p1', newTab(directory));
    await expect(manager.ensure('p1')).rejects.toBeDefined();
    expect(manager.view('p1').problem).toMatchObject({ code: 'not-installed', action: 'install' });
  });

  // #1236 checks the installed CLI against the bundled adapter instead of downloading one.
  it.each([
    ['CHAT_AGENT_OUTDATED', 'Claude Code 2.0.1 at /usr/local/bin/claude is older than 2.1.316, the oldest version chat supports.', { code: 'not-installed', action: 'install' }],
    ['CHAT_ADAPTER_MISSING', 'This Pane build is missing its bundled Claude Code chat adapter.', { code: 'adapter-setup' }],
  ])('turns %s into a stopped state with its next step', async (code, message, problem) => {
    const store = new MemoryStore();
    const directory = mkdtempSync(path.join(tmpdir(), 'pane-chat-manager-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const manager = new ChatTabManager({
      store, send: () => undefined, spoolDirectory: directory,
      launcher: { resolve: async () => { throw new PaneError(code, message, 'The next step.'); } },
    });
    store.add('p1', newTab(directory));
    await expect(manager.ensure('p1')).rejects.toBeDefined();
    expect(manager.view('p1').problem).toMatchObject({ ...problem, message, next: 'The next step.' });
  });

  it('saves no environment or secret in the tab\'s state', async () => {
    const { manager, store, directory } = harness();
    store.add('p1', { ...newTab(directory), initialInput: 'env PANE_TEST_TOKEN' });
    await manager.ensure('p1');
    await expect.poll(() => manager.receipt('p1', 'initial:p1')?.state).toBe('completed');
    expect(replyText(manager.view('p1'))).toContain('secret-token-value');
    expect(store.saved.get('p1')).not.toContain('secret-token-value');
    expect(Object.keys(store.state('p1')!)).not.toContain('env');
  });

  it('keeps a signed-out state visible to viewers when sign-in expires mid-conversation', async () => {
    const { manager, store, directory, states } = harness();
    store.add('p1', newTab(directory));
    await manager.ensure('p1');
    const generation = manager.view('p1').generation;
    manager.send('p1', { operationId: 'op-1', text: 'signout' });
    await expect.poll(() => states().at(-1)?.problem?.code).toBe('signed-out');
    // A viewer drops any state older than the newest it saw; the stopped state must not look older.
    expect(states().at(-1)).toMatchObject({ status: 'stopped', generation });
    expect(manager.view('p1').generation).toBe(generation);
    await manager.restart('p1');
    expect(manager.view('p1').generation).toBeGreaterThan(generation);
  });

  it('sends a large opening message and only then marks it sent', async () => {
    const { manager, store, directory } = harness(new CeilingStore());
    const opening = `hello ${'x'.repeat(150 * 1024)}`;
    store.add('p1', { ...newTab(directory), initialInput: opening });
    await manager.ensure('p1');
    expect(manager.receipt('p1', 'initial:p1')?.state).toBeDefined();
    expect(store.state('p1')?.initialInputSentAt).toBeDefined();
    // Delivered from the saved copy: the agent got the whole message, not the queue's preview.
    await expect.poll(() => manager.view('p1').transcript?.messages.find(message => message.role === 'user')?.parts[0]).toEqual({ type: 'text', text: opening });
    await manager.cancel('p1').catch(() => undefined);
  });

  it('shows an opening message that could not be queued and sends it on Restart', async () => {
    const store = new CeilingStore();
    const { manager, directory } = harness(store);
    store.add('p1', { ...newTab(directory), initialInput: 'hello there' });
    store.refuseQueue = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await manager.ensure('p1');
    warn.mockRestore();
    expect(store.state('p1')?.initialInputSentAt).toBeUndefined();
    expect(manager.view('p1').notice).toMatch(/opening message was not sent/);
    store.refuseQueue = false;
    await manager.restart('p1');
    await expect.poll(() => manager.receipt('p1', 'initial:p1')?.state).toBe('completed');
  });

  it('queues an image larger than a panel state row holds', async () => {
    const { manager, store, directory } = harness(new CeilingStore());
    store.add('p1', newTab(directory));
    await manager.ensure('p1');
    manager.send('p1', { operationId: 'op-1', text: 'permission' });
    await expect.poll(() => manager.view('p1').permissions.length).toBe(1);
    const data = Buffer.alloc(1024 * 1024, 7).toString('base64');
    expect(manager.send('p1', { operationId: 'op-2', text: 'look', images: [{ mimeType: 'image/png', data }] }).state).toBe('accepted');
    expect(manager.view('p1').queue).toEqual([expect.objectContaining({ operationId: 'op-2', text: 'look', imageCount: 1, stored: true })]);
    const [permission] = manager.view('p1').permissions;
    manager.answerPermission('p1', permission.id, permission.options[0].optionId);
    await expect.poll(() => manager.receipt('p1', 'op-2')?.state).toBe('completed');
  });

  // A read-only queue folder makes deleting a sent prompt's file fail with EACCES.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('delivers queued prompts even when their saved copies cannot be deleted', async () => {
    const { manager, store, directory } = harness();
    store.add('p1', newTab(directory));
    await manager.ensure('p1');
    manager.send('p1', { operationId: 'op-1', text: 'permission' });
    await expect.poll(() => manager.view('p1').permissions.length).toBe(1);
    manager.send('p1', { operationId: 'op-2', text: 'second' });
    manager.send('p1', { operationId: 'op-3', text: 'third' });
    const queue = path.join(directory, 'spool', createHash('sha256').update('p1').digest('hex').slice(0, 32), 'queue');
    chmodSync(queue, 0o500);
    cleanup.push(() => chmodSync(queue, 0o700));
    const [permission] = manager.view('p1').permissions;
    manager.answerPermission('p1', permission.id, 'allow');
    await expect.poll(() => manager.receipt('p1', 'op-3')?.state).toBe('completed');
    expect(manager.receipt('p1', 'op-2')?.state).toBe('completed');
    expect(replyText(manager.view('p1'))).toBe('Permission: allow|You said: second|You said: third');
    expect(manager.view('p1').queue).toEqual([]);
  });

  it('shows a saved notice once, when the tab finishes starting', async () => {
    const { manager, store, directory } = harness();
    store.add('p1', { ...newTab(directory), notice: 'Switched from a terminal tab.' });
    await manager.ensure('p1');
    expect(manager.view('p1').notice).toBe('Switched from a terminal tab.');
    expect(store.state('p1')?.notice).toBeUndefined();
    await manager.restart('p1');
    expect(manager.view('p1').notice).toBeUndefined();
  });

  it('closes a tab whose agent never answers the load, without waiting for it (review F-10)', async () => {
    const { manager, store, directory } = harness(new MemoryStore(), { SCRIPTED_AGENT_HANG_LOAD: '1' });
    store.add('p1', { ...newTab(directory), acpSessionId: 'never-answers' });
    const starting = manager.ensure('p1').catch(error => error);
    await expect.poll(() => manager.processId('p1')).toBeTruthy();
    const pid = manager.processId('p1')!;
    const started = Date.now();
    await manager.close('p1');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(manager.isRunning('p1')).toBe(false);
    await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }).toBe(false);
    await starting;
    expect(manager.isRunning('p1')).toBe(false);
  });

  it('quits without waiting for a tab whose agent never answers the load (review F-28)', async () => {
    const { manager, store, directory } = harness(new MemoryStore(), { SCRIPTED_AGENT_HANG_LOAD: '1' });
    store.add('p1', { ...newTab(directory), acpSessionId: 'never-answers' });
    const starting = manager.ensure('p1').catch(error => error);
    await expect.poll(() => manager.processId('p1')).toBeTruthy();
    const pid = manager.processId('p1')!;
    const started = Date.now();
    await manager.stopAll();
    expect(Date.now() - started).toBeLessThan(5000);
    await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }).toBe(false);
    await starting;
    expect(manager.isRunning('p1')).toBe(false);
  });

  it('closes a tab whose launch never resolves, after a capped wait', async () => {
    const store = new MemoryStore();
    const directory = mkdtempSync(path.join(tmpdir(), 'pane-chat-manager-'));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const manager = new ChatTabManager({ store, send: () => undefined, spoolDirectory: directory, stopTimeoutMs: 100, launcher: { resolve: () => new Promise(() => undefined) } });
    store.add('p1', newTab(directory));
    void manager.ensure('p1');
    const started = Date.now();
    await manager.close('p1');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('closes the tab\'s approval in Notify when the tab is closed (review F-29)', async () => {
    const settled: Array<[string, string]> = [];
    const bridge = new ChatTabNotifyBridge({
      queue: { ask: () => new Promise(() => undefined), settle: (id, summary) => settled.push([id, summary]) },
      enabled: () => true, source: () => ({ name: 'pane', agent: 'Claude' }), answerPermission: () => undefined, answerQuestion: () => undefined,
    });
    const { manager, store, directory } = harness(new MemoryStore(), {}, undefined, { onView: view => bridge.observe(view), onClosed: panelId => bridge.forget(panelId) });
    store.add('p1', newTab(directory));
    await manager.ensure('p1');
    manager.send('p1', { operationId: 'op-1', text: 'permission' });
    await expect.poll(() => manager.view('p1').permissions.length).toBe(1);
    const [permission] = manager.view('p1').permissions;
    await manager.close('p1');
    expect(settled).toEqual([[`chat:p1:${permission.id}`, 'The chat tab closed']]);
  });

  it('stops with Restart when its chat-tabs folder cannot be created (review F-33)', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'pane-chat-manager-'));
    // A file where the folder should be: creating anything under it fails.
    writeFileSync(path.join(directory, 'spool'), '');
    const { manager, store } = harness(new MemoryStore(), {}, directory);
    store.add('p1', newTab(directory));
    await expect(manager.ensure('p1')).rejects.toBeDefined();
    expect(manager.view('p1')).toMatchObject({ status: 'stopped', problem: { action: 'restart' } });
  });

  it('closes a tab whose transcript spool cannot be deleted (review F-33)', async () => {
    const { manager, store, directory } = harness();
    store.add('p1', newTab(directory));
    await manager.ensure('p1');
    // A folder in the spool file's place cannot be removed as a file, as a file another process holds open on Windows cannot.
    mkdirSync(path.join(directory, 'spool', createHash('sha256').update('p1').digest('hex').slice(0, 32), 'transcript.jsonl'), { recursive: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(manager.close('p1')).resolves.toBeUndefined();
    warn.mockRestore();
    expect(manager.isRunning('p1')).toBe(false);
  });

  it('Send now interrupts the running turn and delivers that message before older queued ones', async () => {
    const { manager, store, directory } = harness();
    store.add('p1', newTab(directory));
    await manager.ensure('p1');
    manager.send('p1', { operationId: 'op-1', text: 'slow' });
    await expect.poll(() => manager.view('p1').status).toBe('working');
    manager.send('p1', { operationId: 'op-2', text: 'second' });
    manager.send('p1', { operationId: 'op-3', text: 'urgent', now: true });
    await expect.poll(() => manager.receipt('p1', 'op-2')?.state, { timeout: 5000 }).toBe('completed');
    expect(manager.receipt('p1', 'op-3')?.state).toBe('completed');
    expect(userTexts(manager.view('p1'))).toEqual(['slow', 'urgent', 'second']);
    expect(turnEnds(manager.view('p1'))).toEqual(['cancelled', 'end_turn', 'end_turn']);
  });

  it('Send now ends a turn blocked on an approval, withdrawing it', async () => {
    const { manager, store, directory } = harness();
    store.add('p1', newTab(directory));
    await manager.ensure('p1');
    manager.send('p1', { operationId: 'op-1', text: 'permission' });
    await expect.poll(() => manager.view('p1').permissions.length).toBe(1);
    manager.send('p1', { operationId: 'op-2', text: 'urgent', now: true });
    await expect.poll(() => manager.receipt('p1', 'op-2')?.state, { timeout: 5000 }).toBe('completed');
    expect(manager.view('p1').permissions).toEqual([]);
    expect(replyText(manager.view('p1'))).toBe('You said: urgent');
  });

  it('Send now on an idle tab sends at once, and its flag is not part of the message', async () => {
    const { manager, store, directory } = harness();
    store.add('p1', newTab(directory));
    await manager.ensure('p1');
    const first = manager.send('p1', { operationId: 'op-1', text: 'hello', now: true });
    expect(manager.send('p1', { operationId: 'op-1', text: 'hello' })).toEqual(first);
    await expect.poll(() => manager.receipt('p1', 'op-1')?.state).toBe('completed');
  });

  it('sendNow moves a queued message to the front and interrupts the turn', async () => {
    const { manager, store, directory } = harness();
    store.add('p1', newTab(directory));
    await manager.ensure('p1');
    manager.send('p1', { operationId: 'op-1', text: 'slow' });
    await expect.poll(() => manager.view('p1').status).toBe('working');
    manager.send('p1', { operationId: 'op-2', text: 'second' });
    manager.send('p1', { operationId: 'op-3', text: 'third' });
    manager.sendNow('p1', 'op-3');
    expect(manager.view('p1').queue.map(item => item.operationId)).toEqual(['op-3', 'op-2']);
    await expect.poll(() => manager.receipt('p1', 'op-2')?.state, { timeout: 5000 }).toBe('completed');
    expect(userTexts(manager.view('p1'))).toEqual(['slow', 'third', 'second']);
    expect(() => manager.sendNow('p1', 'op-3')).toThrow(expect.objectContaining({ code: 'CHAT_NOT_QUEUED' }));
  });

  it('editQueued changes what is delivered and keeps the message\'s images', async () => {
    const { manager, store, directory } = harness();
    store.add('p1', newTab(directory));
    await manager.ensure('p1');
    manager.send('p1', { operationId: 'op-1', text: 'permission' });
    await expect.poll(() => manager.view('p1').permissions.length).toBe(1);
    const data = Buffer.from('png').toString('base64');
    manager.send('p1', { operationId: 'op-2', text: 'before', images: [{ mimeType: 'image/png', data }] });
    manager.editQueued('p1', 'op-2', 'after');
    expect(manager.view('p1').queue).toEqual([expect.objectContaining({ operationId: 'op-2', text: 'after', imageCount: 1 })]);
    expect(() => manager.editQueued('p1', 'op-2', '  ')).not.toThrow();
    manager.editQueued('p1', 'op-2', 'after');
    // The original send, retried, still finds its receipt.
    expect(manager.send('p1', { operationId: 'op-2', text: 'before', images: [{ mimeType: 'image/png', data }] }).state).toBe('accepted');
    const [permission] = manager.view('p1').permissions;
    manager.answerPermission('p1', permission.id, 'allow');
    await expect.poll(() => manager.receipt('p1', 'op-2')?.state).toBe('completed');
    const delivered = manager.view('p1').transcript!.messages.filter(message => message.role === 'user').at(-1)!;
    expect(delivered.parts[0]).toEqual({ type: 'text', text: 'after' });
    expect(JSON.stringify(delivered.parts[1])).toContain(data);
    expect(replyText(manager.view('p1'))).toContain('You said: after');
    expect(() => manager.editQueued('p1', 'op-2', 'late')).toThrow(expect.objectContaining({ code: 'CHAT_NOT_QUEUED' }));
  });

  it('editQueued keeps the original message when the queue state cannot be saved (review F-1)', async () => {
    const store = new CeilingStore();
    const { manager, directory } = harness(store);
    store.add('p1', newTab(directory));
    await manager.ensure('p1');
    manager.send('p1', { operationId: 'op-1', text: 'permission' });
    await expect.poll(() => manager.view('p1').permissions.length).toBe(1);
    // Long enough to be stored as a body file, as a real queued message with images or a long text is.
    const original = `Run only the unit tests ${'.'.repeat(600)}`;
    manager.send('p1', { operationId: 'op-2', text: original });
    store.refuseQueue = true;
    expect(() => manager.editQueued('p1', 'op-2', 'Run the integration suite too')).toThrow(expect.objectContaining({ code: 'CHAT_STATE_NOT_SAVED' }));
    store.refuseQueue = false;
    expect(manager.view('p1').queue.map(item => item.text.slice(0, 23))).toEqual(['Run only the unit tests']);
    const [permission] = manager.view('p1').permissions;
    manager.answerPermission('p1', permission.id, 'allow');
    await expect.poll(() => manager.receipt('p1', 'op-2')?.state).toBe('completed');
    expect(userTexts(manager.view('p1')).at(-1)).toBe(original);
  });

  it('editQueued refuses to empty a text-only message', async () => {
    const { manager, store, directory } = harness();
    store.add('p1', newTab(directory));
    await manager.ensure('p1');
    manager.send('p1', { operationId: 'op-1', text: 'permission' });
    await expect.poll(() => manager.view('p1').permissions.length).toBe(1);
    manager.send('p1', { operationId: 'op-2', text: 'second' });
    expect(() => manager.editQueued('p1', 'op-2', ' ')).toThrow(expect.objectContaining({ code: 'CHAT_PROMPT_EMPTY' }));
    expect(manager.view('p1').queue.map(item => item.text)).toEqual(['second']);
    await manager.cancel('p1');
  });

  it('clear starts a fresh conversation with the same settings, fails the cut-off turn and keeps the queue', async () => {
    const { manager, store, directory, states } = harness();
    store.add('p1', { ...newTab(directory), initialInput: 'opening' });
    await manager.ensure('p1');
    await expect.poll(() => manager.receipt('p1', 'initial:p1')?.state).toBe('completed');
    await manager.configure('p1', 'model', 'fast');
    const before = store.state('p1')!.acpSessionId;
    manager.send('p1', { operationId: 'op-1', text: 'slow' });
    await expect.poll(() => manager.view('p1').status).toBe('working');
    manager.send('p1', { operationId: 'op-2', text: 'waiting' });
    await manager.clear('p1');
    const after = store.state('p1')!;
    expect(after.acpSessionId).toBeTruthy();
    expect(after.acpSessionId).not.toBe(before);
    expect(after.clearedAt).toBeTruthy();
    expect(manager.receipt('p1', 'op-1')).toMatchObject({ state: 'failed', error: 'Cleared before the turn finished.' });
    await expect.poll(() => manager.receipt('p1', 'op-2')?.state).toBe('completed');
    const view = manager.view('p1');
    expect(view.clearedAt).toBe(after.clearedAt);
    expect(states().at(-1)?.clearedAt).toBe(after.clearedAt);
    // Nothing of the old conversation is shown or sent again.
    expect(userTexts(view)).toEqual(['waiting']);
    expect(replyText(view)).toBe('You said: waiting');
    expect(view.controls.find(control => control.id === 'model')?.currentValue).toBe('fast');
    // The new session was created, not loaded: the agent never saw the old messages in it.
    const saved = JSON.parse(readFileSync(path.join(directory, 'agent', `${after.acpSessionId}.json`), 'utf8'));
    expect(JSON.stringify(saved.updates)).not.toContain('opening');
  });

  it('refuses to clear a stopped tab', async () => {
    const { manager, store, directory } = harness();
    store.add('p1', newTab(directory));
    await manager.ensure('p1');
    await manager.stop('p1', { message: 'Autopilot is off.', next: 'Turn Autopilot on.' });
    await expect(manager.clear('p1')).rejects.toMatchObject({ code: 'CHAT_STOPPED' });
    expect(manager.isRunning('p1')).toBe(false);
  });

  it('shows the context usage the agent reports, and none after clear', async () => {
    const { manager, store, directory, states } = harness();
    store.add('p1', newTab(directory));
    await manager.ensure('p1');
    expect(manager.view('p1').context).toBeUndefined();
    manager.send('p1', { operationId: 'op-1', text: 'usage' });
    await expect.poll(() => manager.receipt('p1', 'op-1')?.state).toBe('completed');
    expect(manager.view('p1').context).toEqual({ used: 1234, size: 200000 });
    expect(states().at(-1)?.context).toEqual({ used: 1234, size: 200000 });
    await manager.clear('p1');
    expect(manager.view('p1').context).toBeUndefined();
  });

  it('lists background tasks until they end, and stops one on request', async () => {
    const { manager, store, directory } = harness();
    store.add('p1', newTab(directory));
    await manager.ensure('p1');
    manager.send('p1', { operationId: 'op-1', text: 'task' });
    await expect.poll(() => manager.view('p1').tasks?.length).toBe(1);
    const [task] = manager.view('p1').tasks!;
    expect(task).toMatchObject({ kind: 'bash', title: 'npm run watch' });
    expect(task.canStop).toBeUndefined();
    await expect.poll(() => manager.receipt('p1', 'op-1')?.state).toBe('completed');
    // A background task is not a turn: the tab is free for the next message.
    expect(manager.view('p1').status).toBe('idle');
    await manager.stopTask('p1', task.id);
    await expect.poll(() => manager.view('p1').tasks).toBeUndefined();
    await expect(manager.stopTask('p1', task.id)).rejects.toMatchObject({ code: 'CHAT_TASK_NOT_RUNNING' });
    manager.send('p1', { operationId: 'op-2', text: 'task quick' });
    await expect.poll(() => manager.view('p1').tasks?.length).toBe(1);
    await expect.poll(() => manager.view('p1').tasks).toBeUndefined();
  });

  it('keeps chosen settings across a restart', async () => {
    const { manager, store, directory } = harness();
    store.add('p1', newTab(directory));
    await manager.ensure('p1');
    await manager.configure('p1', 'model', 'fast');
    await manager.restart('p1');
    expect(manager.view('p1').controls.find(control => control.id === 'model')?.currentValue).toBe('fast');
  });
});
