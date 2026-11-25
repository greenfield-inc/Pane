import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { ChatPanelState, ChatTabView } from '../../../../shared/types/chatTab';
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

/**
 * The scripted agent keeps conversations in a store folder; a launch of the profile `lab/elsewhere`
 * uses another folder, so it can't load the conversation (as when a profile's home differs).
 */
function harness() {
  const directory = mkdtempSync(path.join(tmpdir(), 'pane-chat-relaunch-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = new MemoryStore();
  const launched: string[] = [];
  const launcher: ChatTabLauncher = {
    resolve: async (_panel, state) => {
      const profile = state.launch.kind === 'profile' ? state.launch.profile : 'agent';
      launched.push(profile);
      const agentStore = path.join(directory, profile === 'lab/elsewhere' ? 'agent-elsewhere' : 'agent');
      return { command: { executable: process.execPath, args: [AGENT], cwd: directory, env: { ...process.env, SCRIPTED_AGENT_STORE: agentStore } } };
    },
  };
  const manager = new ChatTabManager({ store, launcher, send: () => undefined, spoolDirectory: path.join(directory, 'spool') });
  cleanup.push(() => manager.stopAll());
  const folder = path.join(directory, 'session');
  store.add('p1', { agent: 'claude', launch: { kind: 'profile', profile: 'lab/one' }, cwd: directory, status: 'starting', orchestrationSessionId: 's1', sessionFolder: folder });
  return { manager, store, directory, folder, launched };
}

/** The tab's rows in order: `you: …`, `agent: …`, and `--- divider ---`. */
function rows(view: ChatTabView): string[] {
  return (view.transcript?.messages ?? []).flatMap(message => message.parts.flatMap(part => {
    if (part.type === 'text') return [`${message.role === 'user' ? 'you' : 'agent'}: ${part.text}`];
    if (part.type === 'content' && JSON.stringify(part.content).includes('pane_divider')) return [`--- ${JSON.parse(JSON.stringify(part.content)).text} ---`];
    return [];
  }));
}

async function idle(manager: ChatTabManager) {
  await expect.poll(() => manager.relaunchPending('p1') || manager.view('p1').status !== 'idle', { timeout: 15_000 }).toBe(false);
}

describe('chat tab relaunch (T-63 Reload and Switch profile)', () => {
  it('restarts on the new profile after the reply ends, keeps the conversation, and puts the divider back after every replay', { timeout: 40_000 }, async () => {
    const { manager, store, launched } = harness();
    await manager.ensure('p1');
    manager.send('p1', { operationId: 'a', text: 'hello' });
    await expect.poll(() => manager.receipt('p1', 'a')?.state).toBe('completed');
    const conversation = store.state('p1')?.acpSessionId;
    manager.send('p1', { operationId: 'b', text: 'turn 1' });
    await expect.poll(() => manager.view('p1').status).toBe('working');

    manager.relaunch('p1', { launch: { kind: 'profile', profile: 'lab/two' }, divider: 'Switched to Lab two · conversation kept' });
    // The reply in progress finishes first.
    expect(manager.relaunchPending('p1')).toBe(true);
    await expect.poll(() => manager.receipt('p1', 'b')?.state, { timeout: 15_000 }).toBe('completed');
    await idle(manager);

    expect(launched).toEqual(['lab/one', 'lab/two']);
    expect(store.state('p1')).toMatchObject({ launch: { kind: 'profile', profile: 'lab/two' }, acpSessionId: conversation });
    expect(store.state('p1')?.relaunch).toBeUndefined();
    expect(store.state('p1')?.loadFallback).toBeUndefined();
    const expected = ['you: hello', 'agent: You said: hello', 'you: turn 1', 'agent: .', 'agent: Done.', '--- Switched to Lab two · conversation kept ---'];
    expect(rows(manager.view('p1'))).toEqual(expected);

    // A message after it lands below the divider, and a later restart replays it in the same place.
    manager.send('p1', { operationId: 'c', text: 'after' });
    await expect.poll(() => manager.receipt('p1', 'c')?.state).toBe('completed');
    await manager.restart('p1');
    expect(rows(manager.view('p1'))).toEqual([...expected, 'you: after', 'agent: You said: after']);
  });

  it('starts a new conversation given the old transcript when the switch can\'t keep it', { timeout: 30_000 }, async () => {
    const { manager, store, folder } = harness();
    await manager.ensure('p1');
    manager.send('p1', { operationId: 'a', text: 'remember PERSIMMON' });
    await expect.poll(() => manager.receipt('p1', 'a')?.state).toBe('completed');
    const old = store.state('p1')?.acpSessionId;

    manager.relaunch('p1', { launch: { kind: 'profile', profile: 'lab/two' }, divider: 'Switched to Lab two · new Codex conversation, given the transcript', newConversation: { reason: 'Codex keeps each profile\'s conversations apart.' } });
    await expect.poll(() => store.state('p1')?.receipts?.some(receipt => receipt.operationId.startsWith('transcript:') && receipt.state === 'completed'), { timeout: 15_000 }).toBe(true);

    const state = store.state('p1');
    expect(state?.acpSessionId).toBeTruthy();
    expect(state?.acpSessionId).not.toBe(old);
    const file = path.join(folder, 'transcripts', `${old}.md`);
    expect(readFileSync(file, 'utf8')).toContain('remember PERSIMMON');
    const shown = rows(manager.view('p1'));
    expect(shown[0]).toBe('--- Switched to Lab two · new Codex conversation, given the transcript ---');
    expect(shown[1]).toBe(`you: Codex keeps each profile's conversations apart. The earlier conversation in this Session is saved in ${file}. Read it first, then carry on from where it left off.`);
    // The divider stays at the start of the new conversation after a restart.
    await manager.restart('p1');
    expect(rows(manager.view('p1'))[0]).toBe(shown[0]);
  });

  it('falls back to a new conversation given the transcript when the agent can\'t load it on its new profile', { timeout: 30_000 }, async () => {
    const { manager, store, folder } = harness();
    await manager.ensure('p1');
    manager.send('p1', { operationId: 'a', text: 'remember KUMQUAT' });
    await expect.poll(() => manager.receipt('p1', 'a')?.state).toBe('completed');
    const old = store.state('p1')?.acpSessionId;

    manager.relaunch('p1', { launch: { kind: 'profile', profile: 'lab/elsewhere' }, divider: 'Switched to Lab elsewhere · conversation kept' });
    await expect.poll(() => store.state('p1')?.receipts?.some(receipt => receipt.operationId.startsWith('transcript:') && receipt.state === 'completed'), { timeout: 15_000 }).toBe(true);

    const state = store.state('p1');
    expect(state?.status).toBe('idle');
    expect(state?.acpSessionId).not.toBe(old);
    expect(state?.loadFallback).toBeUndefined();
    const file = path.join(folder, 'transcripts', `${old}.md`);
    expect(existsSync(file)).toBe(true);
    const shown = rows(manager.view('p1'));
    expect(shown[0]).toBe('--- Couldn\'t continue the conversation · new conversation, given the transcript ---');
    expect(shown[1]).toContain(`saved in ${file}`);
  });

  it('a stopped tab takes the new launch at once', { timeout: 20_000 }, async () => {
    const { manager, store, launched } = harness();
    await manager.ensure('p1');
    await manager.stop('p1', { message: 'Stopped for the test.', next: 'Nothing.' });
    manager.relaunch('p1', { launch: { kind: 'profile', profile: 'lab/two' }, divider: 'Reloaded Lab two · conversation kept' });
    await idle(manager);
    expect(store.state('p1')?.status).toBe('idle');
    expect(launched.at(-1)).toBe('lab/two');
  });
});
