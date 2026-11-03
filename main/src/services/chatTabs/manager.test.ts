import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolPanel } from '../../../../shared/types/panels';
import { applyChatTabEvent, type ChatPanelState, type ChatTabEvent, type ChatTabView } from '../../../../shared/types/chatTab';
import { PaneError } from '../../../../shared/paneError';
import type { PanelAgentStatusEvent } from '../../../../shared/types/agentStatus';
import { ChatTabManager, type ChatTabLauncher, type ChatTabStore } from './manager';

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

function harness(store = new MemoryStore(), env: NodeJS.ProcessEnv = {}, directory = mkdtempSync(path.join(tmpdir(), 'pane-chat-manager-'))) {
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const sent: Array<{ channel: string; payload: ChatTabEvent | ChatTabView | PanelAgentStatusEvent }> = [];
  const launcher: ChatTabLauncher = {
    resolve: async () => ({ command: { executable: process.execPath, args: [AGENT], cwd: directory, env: { ...process.env, SCRIPTED_AGENT_STORE: path.join(directory, 'agent'), PANE_TEST_TOKEN: 'secret-token-value', ...env } } }),
  };
  const manager = new ChatTabManager({ store, launcher, send: (channel, payload) => sent.push({ channel, payload }), spoolDirectory: path.join(directory, 'spool') });
  cleanup.push(() => manager.stopAll());
  // SAFETY: the manager sends a ChatTabView on chat-tab:state and a ChatTabEvent on chat-tab:event.
  const states = () => sent.filter(entry => entry.channel === 'chat-tab:state').map(entry => entry.payload as ChatTabView);
  // SAFETY: as above, chat-tab:event payloads are ChatTabEvents.
  const events = () => sent.filter(entry => entry.channel === 'chat-tab:event').map(entry => entry.payload as ChatTabEvent);
  return { manager, store, directory, sent, states, events, launcher };
}

const replyText = (view: ChatTabView) => view.transcript?.messages.flatMap(message => message.role === 'assistant' ? message.parts.flatMap(part => part.type === 'text' ? [part.text] : []) : []).join('|') ?? '';
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
    expect(busy.notice).toMatch(/stopped when Pane closed/);
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

  it('saves no environment or secret in the tab\'s state', async () => {
    const { manager, store, directory } = harness();
    store.add('p1', { ...newTab(directory), initialInput: 'env PANE_TEST_TOKEN' });
    await manager.ensure('p1');
    await expect.poll(() => manager.receipt('p1', 'initial:p1')?.state).toBe('completed');
    expect(replyText(manager.view('p1'))).toContain('secret-token-value');
    expect(store.saved.get('p1')).not.toContain('secret-token-value');
    expect(Object.keys(store.state('p1')!)).not.toContain('env');
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
