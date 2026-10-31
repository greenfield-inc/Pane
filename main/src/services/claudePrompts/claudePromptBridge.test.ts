import { appendFileSync, mkdtempSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_NOTIFY_SETTINGS, type NotifyItem } from '../../../../shared/types/notify';
import { boundary, decodeBoundary, type JsonObject } from '../../../../shared/validation/boundaryDecoder';
import { NotifyQueue } from '../notify/notifyQueue';
import { ANSWERED_IN_TERMINAL, ClaudePromptBridge } from './claudePromptBridge';

const source = { paneId: 'pane-1', panelId: 'panel-1', name: 'auth-refactor', agent: 'Claude' };
const input = { command: 'pnpm vitest run src/http', description: 'Run the http tests' };

/** The PermissionRequest hook Pane registers for a launch. */
const releaseHooksSchema = boundary.object({
  hooks: boundary.object({ Stop: boundary.array(boundary.object({ hooks: boundary.array(boundary.object({ url: boundary.string })) })) }),
});
const launchHooksSchema = boundary.object({
  hooks: boundary.object({
    PermissionRequest: boundary.array(boundary.object({
      hooks: boundary.array(boundary.object({ url: boundary.string, timeout: boundary.number, headers: boundary.object({ 'X-Pane-Hook-Token': boundary.string }) })),
    })),
  }),
});

/** The bridge, a real Notify queue, and the hook Claude would call. */
async function setup() {
  let enabled = true;
  const queue = new NotifyQueue({ settings: () => DEFAULT_NOTIFY_SETTINGS, showOutsideSupported: true, shortcutRegistered: () => true, instructionFiles: () => [] });
  const bridge = new ClaudePromptBridge({ queue, tab: () => ({ source, project: 'acme-web' }), enabled: () => enabled, hookTimeoutSeconds: 600 });
  await bridge.start();
  const hook = decodeBoundary(bridge.hookSettings('panel-1'), launchHooksSchema).hooks.PermissionRequest[0].hooks[0];
  /** POSTs one hook event as Claude does, to the URL Pane registered for it; resolves with the response. */
  const releaseUrl = decodeBoundary(bridge.hookSettings('panel-1'), releaseHooksSchema).hooks.Stop[0].hooks[0].url;
  const call = (event: JsonObject, init: { token?: string; signal?: AbortSignal } = {}) => fetch(event.hook_event_name === 'PermissionRequest' ? hook.url : releaseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init.token === undefined ? hook.headers : { 'X-Pane-Hook-Token': init.token }) },
    body: JSON.stringify({ session_id: 's-1', cwd: '/work/acme-web', ...event }),
    signal: init.signal,
  });
  const waiting = () => new Promise<NotifyItem>((resolve) => {
    const check = () => {
      const item = queue.snapshot().items.find(candidate => candidate.state === 'waiting');
      if (item) resolve(item); else setTimeout(check, 5);
    };
    check();
  });
  return { queue, bridge, hook, call, waiting, turnOff: () => { enabled = false; } };
}

describe('ClaudePromptBridge', () => {
  let bridge: ClaudePromptBridge | undefined;
  beforeEach(() => { bridge = undefined; });
  afterEach(async () => { await bridge?.stop(); vi.useRealTimers(); });

  it("holds Claude's prompt as a Notify question and sends back the chosen answer", async () => {
    const ctx = await setup();
    bridge = ctx.bridge;
    expect(ctx.hook.timeout).toBe(600);
    const response = ctx.call({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: input });

    const item = await ctx.waiting();
    expect(item).toMatchObject({ title: 'Run pnpm vitest run src/http?', source, agentPrompt: { yes: 'Yes' } });
    ctx.queue.runRemote({ type: 'answer', id: item.id, answer: { choice: 'No', note: 'Only unit tests' } }, 'iPhone');

    // After Notify's 3-second Undo hold.
    expect(await (await response).json()).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'The user said no. The user answered this prompt in Pane and wrote: Only unit tests' } },
    });
    expect(ctx.queue.snapshot().items[0]).toMatchObject({ state: 'answered', answerSummary: 'No', answeredOn: 'iPhone' });
  });

  it("names the tab's project in a don't-ask-again choice, where Claude keeps the rule", async () => {
    const ctx = await setup();
    bridge = ctx.bridge;
    const rule = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'pnpm vitest *' }], behavior: 'allow', destination: 'localSettings' };
    void ctx.call({ hook_event_name: 'PermissionRequest', cwd: '/work/acme-web/worktrees/rate-limit-retries', tool_name: 'Bash', tool_input: input, permission_suggestions: [rule] });

    expect((await ctx.waiting()).choices?.map(choice => choice.label)).toContain("Yes, and don't ask again for pnpm vitest commands in acme-web");
  });

  it('closes the question as answered in the terminal when the tool runs first, and lets the hook go', async () => {
    const ctx = await setup();
    bridge = ctx.bridge;
    const response = ctx.call({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: input });
    await ctx.waiting();

    // A different call finishing in the same turn leaves the prompt open.
    await ctx.call({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(ctx.queue.snapshot().queue).toHaveLength(1);
    await ctx.call({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: input });

    expect(await (await response).json()).toEqual({});
    expect(ctx.queue.snapshot().items[0]).toMatchObject({ state: 'answered', answerSummary: ANSWERED_IN_TERMINAL });
  });

  it('closes the question as soon as the tab stops showing the dialog, before a long command ends', async () => {
    const ctx = await setup();
    bridge = ctx.bridge;
    const response = ctx.call({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: input });
    await ctx.waiting();

    // Working before the dialog is drawn says nothing about the answer.
    ctx.bridge.panelStatus('panel-1', 'working');
    expect(ctx.queue.snapshot().queue).toHaveLength(1);
    ctx.bridge.panelStatus('panel-1', 'blocked');
    ctx.bridge.panelStatus('panel-1', 'working');

    expect(await (await response).json()).toEqual({});
    expect(ctx.queue.snapshot().items[0]).toMatchObject({ state: 'answered', answerSummary: ANSWERED_IN_TERMINAL });
  });

  it("lets a terminal answer win over a Notify answer still in its Undo hold", async () => {
    const ctx = await setup();
    bridge = ctx.bridge;
    const response = ctx.call({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: input });
    const item = await ctx.waiting();

    ctx.queue.runRemote({ type: 'answer', id: item.id, answer: { choice: 'Yes' } }, 'iPhone');
    await ctx.call({ hook_event_name: 'Stop' });

    expect(await (await response).json()).toEqual({});
    expect(ctx.queue.snapshot().items[0]).toMatchObject({ state: 'answered', answerSummary: ANSWERED_IN_TERMINAL });
    expect(ctx.queue.snapshot().items[0].answeredOn).toBeUndefined();
  });

  it('lets every open prompt go with no decision when the setting turns off', async () => {
    const ctx = await setup();
    bridge = ctx.bridge;
    const response = ctx.call({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: input });
    await ctx.waiting();

    ctx.bridge.releaseAll();

    expect(await (await response).json()).toEqual({});
    expect(ctx.queue.snapshot().queue).toEqual([]);
  });

  it("notices No or Esc in the terminal from Claude's transcript", async () => {
    const ctx = await setup();
    bridge = ctx.bridge;
    const transcript = path.join(mkdtempSync(path.join(os.tmpdir(), 'pane-claude-prompts-')), 's-1.jsonl');
    const toolUse = (id: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input }] } });
    const toolResult = (id: string) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: "The user doesn't want to proceed with this tool use." }] } });
    // The same command ran earlier in the session.
    writeFileSync(transcript, `${toolUse('toolu_old')}\n${toolResult('toolu_old')}\n${toolUse('toolu_new')}\n`);
    const response = ctx.call({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: input, transcript_path: transcript });
    await ctx.waiting();
    await new Promise(resolve => setTimeout(resolve, 1_200));
    expect(ctx.queue.snapshot().queue).toHaveLength(1);

    appendFileSync(transcript, `${toolResult('toolu_new')}\n`);
    expect(await (await response).json()).toEqual({});
    expect(ctx.queue.snapshot().items[0]).toMatchObject({ state: 'answered', answerSummary: ANSWERED_IN_TERMINAL });
  });

  it('keeps the question, without answers, when Claude stops waiting on the hook; the terminal still settles it', async () => {
    const ctx = await setup();
    bridge = ctx.bridge;
    const timeout = new AbortController();
    const response = ctx.call({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: input }, { signal: timeout.signal }).catch(() => 'cancelled');
    const item = await ctx.waiting();

    timeout.abort();
    expect(await response).toBe('cancelled');
    await vi.waitFor(() => expect(ctx.queue.snapshot().items[0].agentPrompt?.inTerminal).toBe(true));
    expect(ctx.queue.snapshot().queue).toEqual([item.id]);
    expect(() => ctx.queue.runRemote({ type: 'answer', id: item.id, answer: { choice: 'Yes' } }, 'iPhone')).toThrow(/asking in its terminal/);

    await ctx.call({ hook_event_name: 'Stop' });
    expect(ctx.queue.snapshot().items[0]).toMatchObject({ state: 'answered', answerSummary: ANSWERED_IN_TERMINAL });
  });

  it('drops a Notify answer still in its Undo hold when Claude stops waiting on the hook, and leaves the question to the terminal', async () => {
    const ctx = await setup();
    bridge = ctx.bridge;
    const timeout = new AbortController();
    const response = ctx.call({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: input }, { signal: timeout.signal }).catch(() => 'cancelled');
    const item = await ctx.waiting();

    ctx.queue.runRemote({ type: 'answer', id: item.id, answer: { choice: 'Yes' } }, 'iPhone');
    expect(ctx.queue.snapshot().items[0].state).toBe('sent');
    timeout.abort();
    expect(await response).toBe('cancelled');

    await vi.waitFor(() => expect(ctx.queue.snapshot().items[0]).toMatchObject({ state: 'waiting', agentPrompt: { inTerminal: true } }));
    const handedOver = ctx.queue.snapshot().items[0];
    expect(handedOver.answerSummary).toBeUndefined();
    expect(handedOver.answeredOn).toBeUndefined();
    expect(ctx.queue.snapshot().queue).toEqual([item.id]);
    // Undo has nothing left to restore, and the hold never delivers.
    expect(() => ctx.queue.runRemote({ type: 'undo', id: item.id }, 'iPhone')).toThrow();
    await new Promise(resolve => setTimeout(resolve, 3_300));
    expect(ctx.queue.snapshot().items[0]).toMatchObject({ state: 'waiting', agentPrompt: { inTerminal: true } });

    await ctx.call({ hook_event_name: 'Stop' });
    expect(ctx.queue.snapshot().items[0]).toMatchObject({ state: 'answered', answerSummary: ANSWERED_IN_TERMINAL });
  });

  it('refuses a request without a live tab token, and asks nothing while the setting is off', async () => {
    const ctx = await setup();
    bridge = ctx.bridge;
    ctx.turnOff();
    expect(ctx.bridge.hookSettings('panel-2')).toBeUndefined();
    expect((await ctx.call({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: input }, { token: 'guess' })).status).toBe(403);
    expect(await (await ctx.call({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: input })).json()).toEqual({});
    expect(ctx.queue.snapshot().items).toEqual([]);

    ctx.bridge.forgetPanel('panel-1');
    expect((await ctx.call({ hook_event_name: 'Stop' })).status).toBe(403);
  });
});
