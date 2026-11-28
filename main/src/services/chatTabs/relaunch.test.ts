import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
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

interface HarnessOptions {
  /** Extra environment for the scripted agent, such as a slow shutdown. */
  env?: Record<string, string>;
  profilesOn?: () => boolean;
  stopTimeoutMs?: number;
}

/**
 * The scripted agent keeps conversations in a store folder; a launch of the profile `lab/elsewhere`
 * uses another folder, so it can't load the conversation (as when a profile's home differs).
 */
function harness(options: HarnessOptions = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'pane-chat-relaunch-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const store = new MemoryStore();
  const launched: string[] = [];
  const launcher: ChatTabLauncher = {
    resolve: async (_panel, state) => {
      const profile = state.launch.kind === 'profile' ? state.launch.profile : 'agent';
      launched.push(profile);
      const agentStore = path.join(directory, profile === 'lab/elsewhere' ? 'agent-elsewhere' : 'agent');
      return { command: { executable: process.execPath, args: [AGENT], cwd: directory, env: { ...process.env, ...options.env, SCRIPTED_AGENT_STORE: agentStore } } };
    },
  };
  const spool = path.join(directory, 'spool');
  const create = () => {
    const manager = new ChatTabManager({ store, launcher, send: () => undefined, spoolDirectory: spool, profilesOn: options.profilesOn ?? (() => true), stopTimeoutMs: options.stopTimeoutMs });
    cleanup.push(() => manager.stopAll());
    return manager;
  };
  const manager = create();
  const folder = path.join(directory, 'session');
  mkdirSync(folder);
  store.add('p1', { agent: 'claude', launch: { kind: 'profile', profile: 'lab/one' }, cwd: directory, status: 'starting', orchestrationSessionId: 's1', sessionFolder: folder });
  return { manager, store, directory, folder, launched, spool, create };
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

/** Files left in Pane's private chat-tabs folder for the tab (the fallback transcript among them). */
function privateFiles(spool: string): string[] {
  const directory = path.join(spool, 'p1');
  return existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith('.md')) : [];
}

const transcriptSent = (store: MemoryStore) => store.state('p1')?.receipts?.some(receipt => receipt.operationId.startsWith('transcript:') && receipt.state === 'completed');

describe('chat tab relaunch (T-63 Reload and Switch profile)', () => {
  it('restarts on the new profile after the reply ends, keeps the conversation, and puts the divider back after every replay', { timeout: 40_000 }, async () => {
    const { manager, store, launched, folder, spool } = harness();
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
    // Review F-7: the unused fallback was private, and is gone; nothing was written to the Session folder.
    expect(existsSync(path.join(folder, 'transcripts'))).toBe(false);
    expect(privateFiles(spool)).toEqual([]);
    const expected = ['you: hello', 'agent: You said: hello', 'you: turn 1', 'agent: .', 'agent: Done.', '--- Switched to Lab two · conversation kept ---'];
    expect(rows(manager.view('p1'))).toEqual(expected);

    // A message after it lands below the divider, and a later restart replays it in the same place.
    manager.send('p1', { operationId: 'c', text: 'after' });
    await expect.poll(() => manager.receipt('p1', 'c')?.state).toBe('completed');
    await manager.restart('p1');
    expect(rows(manager.view('p1'))).toEqual([...expected, 'you: after', 'agent: You said: after']);
  });

  it('starts a new conversation given the outgoing transcript when the switch can\'t keep it', { timeout: 30_000 }, async () => {
    const { manager, store, folder } = harness();
    await manager.ensure('p1');
    manager.send('p1', { operationId: 'a', text: 'remember PERSIMMON' });
    await expect.poll(() => manager.receipt('p1', 'a')?.state).toBe('completed');
    const old = store.state('p1')?.acpSessionId;

    const { transcript } = manager.exportConversation('p1');
    const file = path.join(folder, 'transcripts', `${old}.md`);
    expect(transcript).toBe(file);
    manager.relaunch('p1', { launch: { kind: 'profile', profile: 'lab/two' }, divider: 'Switched to Lab two · new Codex conversation, given the transcript', newConversation: { transcript, reason: 'Codex keeps each profile\'s conversations apart.' } });
    await expect.poll(() => transcriptSent(store), { timeout: 15_000 }).toBe(true);

    const state = store.state('p1');
    expect(state?.acpSessionId).toBeTruthy();
    expect(state?.acpSessionId).not.toBe(old);
    expect(readFileSync(file, 'utf8')).toContain('remember PERSIMMON');
    const shown = rows(manager.view('p1'));
    expect(shown[0]).toBe('--- Switched to Lab two · new Codex conversation, given the transcript ---');
    expect(shown[1]).toBe(`you: Codex keeps each profile's conversations apart. The earlier conversation in this Session is saved in ${file}. Read it first, then carry on from where it left off.`);
    // The divider stays at the start of the new conversation after a restart.
    await manager.restart('p1');
    expect(rows(manager.view('p1'))[0]).toBe(shown[0]);
  });

  // Review F-3: the destination never reads its own earlier conversation in place of the outgoing one.
  it('starts an empty outgoing conversation\'s replacement with no transcript, never the tab\'s own earlier one', { timeout: 30_000 }, async () => {
    const { manager, store, folder } = harness();
    await manager.ensure('p1');
    manager.send('p1', { operationId: 'a', text: 'an old Claude conversation' });
    await expect.poll(() => manager.receipt('p1', 'a')?.state).toBe('completed');
    const old = store.state('p1')?.acpSessionId;

    manager.relaunch('p1', { launch: { kind: 'profile', profile: 'lab/two' }, divider: 'Switched to Claude · new Claude conversation', newConversation: { reason: 'Claude can\'t continue a Codex conversation.' } });
    await idle(manager);
    expect(store.state('p1')?.acpSessionId).not.toBe(old);
    expect(store.state('p1')?.receipts?.some(receipt => receipt.operationId.startsWith('transcript:'))).toBe(false);
    expect(existsSync(path.join(folder, 'transcripts'))).toBe(false);
    expect(rows(manager.view('p1'))).toEqual(['--- Switched to Claude · new Claude conversation ---']);
  });

  it('refuses to export a conversation that hasn\'t been loaded since Pane started, and exports nothing for an empty one', { timeout: 20_000 }, async () => {
    const { manager, store, create } = harness();
    expect(manager.exportConversation('p1')).toEqual({});
    await manager.ensure('p1');
    manager.send('p1', { operationId: 'a', text: 'hello' });
    await expect.poll(() => manager.receipt('p1', 'a')?.state).toBe('completed');
    await manager.stop('p1', { message: 'Stopped for the test.', next: 'Nothing.' });
    // Stopped in this run: its conversation is still at hand.
    expect(manager.exportConversation('p1').transcript).toBeTruthy();
    // After Pane restarts, the stopped tab's conversation was never replayed.
    await manager.stopAll();
    const restarted = create();
    expect(store.state('p1')?.acpSessionId).toBeTruthy();
    expect(() => restarted.exportConversation('p1')).toThrow(expect.objectContaining({ code: 'CHAT_TRANSCRIPT_UNAVAILABLE' }));
  });

  // Review F-4: the new launch and its handoff are saved before the old agent finishes stopping.
  it('saves the handoff with the new launch before a slow shutdown ends, and delivers it before a message sent meanwhile', { timeout: 30_000 }, async () => {
    const { manager, store, folder } = harness({ env: { SCRIPTED_AGENT_SLOW_CLOSE_MS: '1500' } });
    await manager.ensure('p1');
    manager.send('p1', { operationId: 'a', text: 'remember FIG' });
    await expect.poll(() => manager.receipt('p1', 'a')?.state).toBe('completed');
    const { transcript } = manager.exportConversation('p1');

    manager.relaunch('p1', { launch: { kind: 'profile', profile: 'lab/two' }, divider: 'Switched · new conversation, given the transcript', newConversation: { transcript, reason: 'A new conversation.' } });
    // What a quit now would leave: the new launch, and the handoff first in its queue.
    const saved = store.state('p1');
    expect(manager.relaunchPending('p1')).toBe(true);
    expect(saved).toMatchObject({ launch: { kind: 'profile', profile: 'lab/two' }, status: 'starting' });
    expect(saved?.acpSessionId).toBeUndefined();
    expect(saved?.queue?.[0]?.operationId).toMatch(/^transcript:/);
    // A message sent while the old agent stops reaches the new one, after the handoff.
    manager.send('p1', { operationId: 'during', text: 'sent during the stop' });
    await expect.poll(() => manager.receipt('p1', 'during')?.state, { timeout: 20_000 }).toBe('completed');
    const shown = rows(manager.view('p1'));
    expect(shown[1]).toContain(`saved in ${path.join(folder, 'transcripts')}`);
    expect(shown.indexOf('you: sent during the stop')).toBeGreaterThan(1);
    expect(shown).not.toContain('you: remember FIG');
  });

  it('falls back to a new conversation given the transcript when the agent can\'t load it on its new profile', { timeout: 30_000 }, async () => {
    const { manager, store, folder, spool } = harness();
    await manager.ensure('p1');
    manager.send('p1', { operationId: 'a', text: 'remember KUMQUAT' });
    await expect.poll(() => manager.receipt('p1', 'a')?.state).toBe('completed');
    const old = store.state('p1')?.acpSessionId;

    manager.relaunch('p1', { launch: { kind: 'profile', profile: 'lab/elsewhere' }, divider: 'Switched to Lab elsewhere · conversation kept' });
    await expect.poll(() => transcriptSent(store), { timeout: 15_000 }).toBe(true);

    const state = store.state('p1');
    expect(state?.status).toBe('idle');
    expect(state?.acpSessionId).not.toBe(old);
    expect(state?.loadFallback).toBeUndefined();
    // Published to the Session folder only now that it hands over (review F-7), and the private copy is gone.
    const file = path.join(folder, 'transcripts', `${old}.md`);
    expect(readFileSync(file, 'utf8')).toContain('remember KUMQUAT');
    expect(privateFiles(spool)).toEqual([]);
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

  // Review F-6: a Switch back while the tab is still stopping from the Switch away.
  it('starts a Switch back only after the stop it follows, which then leaves the new agent running', { timeout: 30_000 }, async () => {
    const { manager, store, launched } = harness({ env: { SCRIPTED_AGENT_SLOW_CLOSE_MS: '1500' }, stopTimeoutMs: 300 });
    await manager.ensure('p1');
    manager.send('p1', { operationId: 'a', text: 'hello' });
    await expect.poll(() => manager.receipt('p1', 'a')?.state).toBe('completed');
    // The Switch away stops the tab; the stop times out before the slow agent has ended.
    const stopping = manager.stop('p1', { message: 'The Session now runs Codex, in its Codex tab.', next: 'Switch back to use this tab.' });
    manager.relaunch('p1', { launch: { kind: 'profile', profile: 'lab/two' }, divider: 'Switched to Lab two · conversation kept' });
    await stopping;
    await idle(manager);
    expect(launched).toEqual(['lab/one', 'lab/two']);
    // Long after the timed-out stop would have finished, the new agent still runs and answers.
    await new Promise(resolve => setTimeout(resolve, 2000));
    expect(store.state('p1')).toMatchObject({ status: 'idle', launch: { profile: 'lab/two' } });
    expect(store.state('p1')?.problem).toBeUndefined();
    manager.send('p1', { operationId: 'b', text: 'still here' });
    await expect.poll(() => manager.receipt('p1', 'b')?.state, { timeout: 10_000 }).toBe('completed');
  });

  // Review F-5: Profiles turned off while a Reload or Switch waited for the reply.
  it('drops a waiting relaunch once Profiles is off, keeping the tab on its launch', { timeout: 30_000 }, async () => {
    let on = true;
    const { manager, store, launched } = harness({ profilesOn: () => on });
    await manager.ensure('p1');
    manager.send('p1', { operationId: 'b', text: 'turn 1' });
    await expect.poll(() => manager.view('p1').status).toBe('working');
    manager.relaunch('p1', { launch: { kind: 'profile', profile: 'lab/two', fromSession: true }, divider: 'Switched to Lab two · conversation kept' });
    on = false;
    await expect.poll(() => manager.receipt('p1', 'b')?.state, { timeout: 15_000 }).toBe('completed');
    await idle(manager);
    expect(launched).toEqual(['lab/one']);
    expect(store.state('p1')?.relaunch).toBeUndefined();
    expect(store.state('p1')?.launch).toEqual({ kind: 'profile', profile: 'lab/one' });
  });
});
