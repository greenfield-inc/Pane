import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { ChatTabRuntime, isAuthRequired } from './runtime';

const AGENT = path.join(__dirname, 'testing', 'scriptedAgent.mjs');
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

function scratch(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'pane-chat-runtime-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function start(store: string, env: NodeJS.ProcessEnv = {}) {
  const updates: SessionUpdate[] = [];
  const exits: string[] = [];
  const runtime = new ChatTabRuntime({
    command: { executable: process.execPath, args: [AGENT], cwd: store, env: { ...process.env, SCRIPTED_AGENT_STORE: store, ...env } },
    generation: 1,
    onUpdate: update => { updates.push(update); },
    onState: () => undefined,
    onExit: exit => { if (!exit.expected) exits.push(exit.message); },
  });
  cleanup.push(() => runtime.stop());
  await runtime.start();
  return { runtime, updates, exits };
}

const text = (updates: SessionUpdate[]) => updates.flatMap(update => update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? [update.content.text] : []).join('');

describe('chat tab runtime against a scripted ACP agent', () => {
  it('streams a reply and reports how the turn ended', async () => {
    const store = scratch();
    const { runtime, updates } = await start(store);
    await runtime.create({ cwd: store, mcpServers: [] });
    const result = await runtime.prompt([{ type: 'text', text: 'hello there' }]);
    expect(result.stopReason).toBe('end_turn');
    expect(text(updates)).toBe('You said: hello there');
    await expect.poll(() => runtime.commands().map(command => command.name)).toEqual(['compact', 'review']);
    expect(runtime.controls().map(control => control.id)).toEqual(['model', 'mode']);
  });

  it('holds an approval until it is answered with one of the offered choices', async () => {
    const store = scratch();
    const { runtime, updates } = await start(store);
    await runtime.create({ cwd: store, mcpServers: [] });
    const turn = runtime.prompt([{ type: 'text', text: 'permission' }]);
    await expect.poll(() => runtime.permissions().length).toBe(1);
    const [permission] = runtime.permissions();
    expect(permission.request.options.map(option => option.name)).toEqual(['Yes', "Yes, and don't ask again for echo commands", 'No']);
    expect(() => runtime.answerPermission(permission.id, 'maybe')).toThrow(expect.objectContaining({ code: 'CHAT_PERMISSION_OPTION_INVALID' }));
    runtime.answerPermission(permission.id, 'allow');
    expect((await turn).stopReason).toBe('end_turn');
    expect(text(updates)).toBe('Permission: allow');
    expect(() => runtime.answerPermission(permission.id, 'allow')).toThrow(expect.objectContaining({ code: 'CHAT_PERMISSION_ALREADY_ANSWERED' }));
  });

  it('declares form questions and returns the answer to the agent', async () => {
    const store = scratch();
    const { runtime, updates } = await start(store);
    await runtime.create({ cwd: store, mcpServers: [] });
    const turn = runtime.prompt([{ type: 'text', text: 'question' }]);
    await expect.poll(() => runtime.questions().length).toBe(1);
    const [question] = runtime.questions();
    expect(question.request.message).toBe('Which colour?');
    runtime.answerQuestion(question.id, { action: 'accept', content: { question_0: 'Blue' } });
    await turn;
    expect(text(updates)).toBe('Answer: {"action":"accept","content":{"question_0":"Blue"}}');
  });

  it('cancels a running turn and withdraws its open approvals', async () => {
    const store = scratch();
    const { runtime } = await start(store);
    await runtime.create({ cwd: store, mcpServers: [] });
    const turn = runtime.prompt([{ type: 'text', text: 'slow' }]);
    await expect.poll(() => runtime.isRunning()).toBe(true);
    await runtime.cancel();
    expect((await turn).stopReason).toBe('cancelled');
    expect(runtime.isRunning()).toBe(false);
  });

  it('reports an unexpected exit once, with the turn ended', async () => {
    const store = scratch();
    const { runtime, exits } = await start(store);
    await runtime.create({ cwd: store, mcpServers: [] });
    await expect(runtime.prompt([{ type: 'text', text: 'crash' }])).rejects.toBeDefined();
    await expect.poll(() => exits).toEqual(['The agent exited with code 3.']);
    expect(runtime.isRunning()).toBe(false);
    expect(runtime.isAlive()).toBe(false);
  });

  it('recognises a signed-out agent', async () => {
    const store = scratch();
    const { runtime } = await start(store, { SCRIPTED_AGENT_SIGNED_OUT: '1' });
    const failure = await runtime.create({ cwd: store, mcpServers: [] }).catch(error => error);
    expect(isAuthRequired(failure)).toBe(true);
  });

  it('reloads a saved conversation in a new process by replaying its history', async () => {
    const store = scratch();
    const first = await start(store);
    const { sessionId } = await first.runtime.create({ cwd: store, mcpServers: [] });
    await first.runtime.prompt([{ type: 'text', text: 'remember me' }]);
    await first.runtime.stop();
    expect(first.exits).toEqual([]);
    const second = await start(store);
    await second.runtime.load({ sessionId, cwd: store, mcpServers: [] });
    expect(text(second.updates)).toBe('You said: remember me');
    expect(second.updates.some(update => update.sessionUpdate === 'user_message_chunk')).toBe(true);
    await second.runtime.prompt([{ type: 'text', text: 'again' }]);
    expect(text(second.updates)).toBe('You said: remember meYou said: again');
  });
});
