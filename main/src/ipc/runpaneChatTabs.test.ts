import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolPanel } from '../../../shared/types/panels';
import type { ChatPanelState } from '../../../shared/types/chatTab';
import { ChatTabManager, type ChatTabStore } from '../services/chatTabs/manager';
import { chatTabLastMessage, chatTabNoTerminal, chatTabOutput, chatTabScreen, submitChatTab, waitForChatTab } from './runpaneChatTabs';

const AGENT = path.join(__dirname, '..', 'services', 'chatTabs', 'testing', 'scriptedAgent.mjs');
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), 'pane-runpane-chat-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const panel: ToolPanel = { id: 'chat-1', sessionId: 'pane-1', type: 'chat', title: 'Claude', state: { isActive: true }, metadata: { createdAt: '', lastActiveAt: '', position: 0 } };
  const saved = new Map<string, string>();
  const store: ChatTabStore = {
    panel: id => (id === panel.id ? panel : undefined),
    state: id => (saved.has(id) ? JSON.parse(saved.get(id)!) : undefined),
    commit: (id, state) => saved.set(id, JSON.stringify(state)),
  };
  store.commit(panel.id, { agent: 'claude', launch: { kind: 'agent' }, cwd: directory, status: 'starting' } satisfies ChatPanelState);
  const manager = new ChatTabManager({
    store, send: () => undefined, spoolDirectory: path.join(directory, 'spool'),
    launcher: { resolve: async () => ({ command: { executable: process.execPath, args: [AGENT], cwd: directory, env: { ...process.env, SCRIPTED_AGENT_STORE: path.join(directory, 'agent') } } }) },
  });
  cleanup.push(() => manager.stopAll());
  return { manager, panel };
}

describe('runpane on a chat tab', () => {
  it('submits with an ACP receipt, waits for the turn to end and reads the reply', async () => {
    const { manager, panel } = setup();
    await manager.ensure(panel.id);
    const submitted = await submitChatTab(manager, panel, 'hello', { interrupt: false });
    expect(submitted).toMatchObject({ ok: true, sequenceName: 'acp', enter: 'none', delivery: { state: 'taken', evidence: 'acp-receipt' } });
    const waited = await waitForChatTab(manager, panel, { panelId: panel.id, condition: 'idle', timeoutMs: 10_000 });
    expect(waited).toMatchObject({ ok: true, matched: true, screen: { source: 'acpTranscript' } });
    expect(waited.screen.text).toContain('assistant: You said: hello');
    expect(chatTabLastMessage(manager, panel, 1000)).toMatchObject({ ok: true, agentType: 'claude', text: 'You said: hello' });
    const screen = chatTabScreen(manager, panel, 80);
    expect(screen).toMatchObject({ source: 'acpTranscript', state: { running: true, agentType: 'claude' } });
    expect(screen.text).toContain('user: hello');
    expect(chatTabOutput(manager, panel, 100).outputs[0]).toMatchObject({ type: 'acp-transcript' });
  });

  it('returns at once as blocked while an approval waits, and queues a prompt sent meanwhile', async () => {
    const { manager, panel } = setup();
    await manager.ensure(panel.id);
    await submitChatTab(manager, panel, 'permission', { interrupt: false });
    const waited = await waitForChatTab(manager, panel, { panelId: panel.id, condition: 'idle', timeoutMs: 10_000 });
    expect(waited).toMatchObject({ ok: false, matched: false, blocked: { kind: 'agent-prompt' } });
    const queued = await submitChatTab(manager, panel, 'next one', { interrupt: false });
    expect(queued.delivery).toMatchObject({ state: 'queued', evidence: 'acp-receipt' });
    const [permission] = manager.view(panel.id, 0).permissions;
    manager.answerPermission(panel.id, permission.id, 'allow');
    await expect.poll(async () => (await waitForChatTab(manager, panel, { panelId: panel.id, condition: 'idle', timeoutMs: 200 })).matched, { timeout: 10_000 }).toBe(true);
    expect(chatTabLastMessage(manager, panel, 1000)).toMatchObject({ text: 'You said: next one' });
  });

  it('interrupts a running turn before sending the replacement', async () => {
    const { manager, panel } = setup();
    await manager.ensure(panel.id);
    await submitChatTab(manager, panel, 'slow', { interrupt: false });
    await expect.poll(() => manager.view(panel.id, 0).status).toBe('working');
    const replaced = await submitChatTab(manager, panel, 'instead', { interrupt: true });
    expect(replaced.delivery.state).toBe('taken');
    await waitForChatTab(manager, panel, { panelId: panel.id, condition: 'idle', timeoutMs: 10_000 });
    expect(chatTabLastMessage(manager, panel, 1000)).toMatchObject({ text: 'You said: instead' });
  });

  it('refuses raw terminal input with a clear next step', () => {
    const { panel } = setup();
    const error = chatTabNoTerminal(panel, 'input');
    expect(error).toMatchObject({ code: 'CHAT_TAB_NO_TERMINAL', next: expect.stringContaining('runpane panels submit --panel chat-1') });
  });
});
