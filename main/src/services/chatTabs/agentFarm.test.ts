import { mkdtempSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { ChatPanelState, ChatTabView } from '../../../../shared/types/chatTab';
import { PaneError } from '../../../../shared/paneError';
import { AgentFarmProfiles, printedCli } from './agentFarm';
import { ChatTabManager, type ChatTabStore } from './manager';

const FAKE = path.join(__dirname, 'testing', 'fakeAgentFarm.mjs');
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

function scratch(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'pane-agent-farm-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
const inherited = (): Record<string, string> => Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]));

/** Pane's bundled Agent Farm, played by the fake CLI on this Node. */
const bundled = async (args: string[], _cwd: string, env: Record<string, string>) => ({ executable: process.execPath, args: [FAKE, ...args], env });

describe('Agent Farm profiles in chat tabs', () => {
  it('starts a profile with its printed settings, selects its mode and keeps env out of saved state', async () => {
    const directory = scratch();
    const profiles = new AgentFarmProfiles({ bundled, adapter: async () => '/adapters/claude/dist/index.js', checkCli: async () => undefined });
    const saved = new Map<string, string>();
    const panel: ToolPanel = { id: 'p1', sessionId: 'pane', type: 'chat', title: 'implementer', state: { isActive: true }, metadata: { createdAt: '', lastActiveAt: '', position: 0 } };
    const store: ChatTabStore = {
      panel: () => panel,
      state: () => (saved.has('p1') ? JSON.parse(saved.get('p1')!) : undefined),
      commit: (_id, state) => saved.set('p1', JSON.stringify(state)),
    };
    store.commit('p1', { agent: 'claude', launch: { kind: 'profile', profile: 'greenfield/implementer:opus', args: { task: 'demo' } }, cwd: directory, status: 'starting' } satisfies ChatPanelState);
    const manager = new ChatTabManager({
      store, spoolDirectory: path.join(directory, 'spool'), send: () => undefined,
      launcher: { resolve: (target, state) => profiles.resolve(target, state, { ...inherited(), SCRIPTED_AGENT_STORE: path.join(directory, 'agent'), PANE_PANEL_ID: 'p1' }) },
    });
    cleanup.push(() => manager.stopAll());
    await manager.ensure('p1');
    manager.send('p1', { operationId: 'a', text: 'caps' });
    await expect.poll(() => manager.receipt('p1', 'a')?.state).toBe('completed');
    const reply = (manager.view('p1').transcript?.messages ?? []).flatMap(message => message.role === 'assistant' ? message.parts.flatMap(part => part.type === 'text' ? [part.text] : []) : []).join('');
    expect(reply).toContain('"mode":"bypassPermissions"');
    expect(reply).toContain('LAUNCH CONTEXT\\nheadless: false\\ntask: demo');
    manager.send('p1', { operationId: 'b', text: 'env AGENT_FARM_PROFILE PANE_PANEL_ID' });
    await expect.poll(() => manager.receipt('p1', 'b')?.state).toBe('completed');
    const view: ChatTabView = manager.view('p1');
    expect(JSON.stringify(view.transcript?.messages)).toContain('{\\"AGENT_FARM_PROFILE\\":\\"greenfield/implementer:opus\\",\\"PANE_PANEL_ID\\":\\"p1\\"}');
    expect(saved.get('p1')).not.toContain('ANTHROPIC_MODEL');
    // After a restart the mode is selected again on the loaded conversation.
    await manager.restart('p1');
    manager.send('p1', { operationId: 'c', text: 'caps' });
    await expect.poll(() => manager.receipt('p1', 'c')?.state).toBe('completed');
  });

  // F-20: a project's wrapper or version manager answers only in its folder and environment.
  it('checks the CLI of the harness Agent Farm printed, in the printed folder and environment', async () => {
    const directory = realpathSync(scratch());
    const checks: Array<{ agent: string; cwd?: string; profile?: string; path?: string }> = [];
    const profiles = new AgentFarmProfiles({ bundled, adapter: async () => '/adapter.js', checkCli: async (agent, context) => { checks.push({ agent, cwd: context.cwd, profile: context.env?.AGENT_FARM_PROFILE, path: context.env?.PATH }); } });
    // The caller guessed claude; Agent Farm says this profile runs Codex, so Codex is what gets checked.
    const printed = await profiles.print('team/codex', {}, 'claude', directory, { PATH: process.env.PATH ?? '', FAKE_AGENT_FARM_HARNESS: 'codex' });
    expect(printed.harness).toBe('codex');
    expect(checks).toEqual([{ agent: 'codex', cwd: directory, profile: 'team/codex', path: process.env.PATH ?? '' }]);
  });

  it('stops a profile whose CLI is too old, with that error', async () => {
    const directory = scratch();
    const profiles = new AgentFarmProfiles({ bundled, adapter: async () => '/adapter.js', checkCli: async () => { throw new PaneError('CHAT_AGENT_OUTDATED', 'Claude Code 2.0.1 is older than 2.1.316.', 'Update it.'); } });
    await expect(profiles.print('team/claude', {}, 'claude', directory, { PATH: process.env.PATH ?? '' })).rejects.toMatchObject({ code: 'CHAT_AGENT_OUTDATED' });
  });

  it('checks the CLI the printed launch selects, or the one on PATH when it selects none or a script', () => {
    const lookup = (name: string) => `/usr/local/bin/${name}`;
    expect(printedCli('codex', { CODEX_PATH: '/project/bin/codex' }, lookup)).toBe('/project/bin/codex');
    expect(printedCli('claude', { CLAUDE_CODE_EXECUTABLE: '/opt/claude' }, lookup)).toBe('/opt/claude');
    expect(printedCli('claude', { CLAUDE_CODE_EXECUTABLE: 'C:/npm/node_modules/@anthropic-ai/claude-code/cli.js' }, lookup)).toBe('/usr/local/bin/claude');
    expect(printedCli('codex', {}, lookup)).toBe('/usr/local/bin/codex');
  });

  it('names the profile and the next step when Agent Farm refuses it', async () => {
    const directory = scratch();
    const profiles = new AgentFarmProfiles({ bundled, adapter: async () => '/adapter.js', checkCli: async () => undefined });
    await expect(profiles.print('missing/profile', {}, 'claude', directory, { PATH: process.env.PATH ?? '' })).rejects.toMatchObject({ code: 'CHAT_PROFILE_FAILED', message: expect.stringContaining('Unknown profile: missing/profile') });
    await expect(profiles.print('old/agent-farm', {}, 'claude', directory, { PATH: process.env.PATH ?? '' })).rejects.toMatchObject({ code: 'CHAT_PROFILE_FAILED', next: expect.stringContaining('Update Agent Farm') });
    const unbundled = new AgentFarmProfiles({ bundled: async () => undefined, adapter: async () => '/adapter.js', checkCli: async () => undefined });
    await expect(unbundled.print('x', {}, 'claude', directory, {})).rejects.toMatchObject({ code: 'CHAT_AGENT_NOT_INSTALLED', next: expect.stringContaining('Reinstall Pane') });
  });

  it('runs Pane\'s bundled Agent Farm, and starts the printed adapter on its runtime as Node', async () => {
    const directory = scratch();
    const calls: string[][] = [];
    const recording = async (args: string[], cwd: string, env: Record<string, string>) => { calls.push(args); return bundled(args, cwd, env); };
    const profiles = new AgentFarmProfiles({ bundled: recording, adapter: async () => '/adapter.js', checkCli: async () => undefined });
    const { ELECTRON_RUN_AS_NODE: _unset, ...env } = inherited();
    const printed = await profiles.print('greenfield/implementer:opus', {}, 'claude', directory, env);
    expect(printed.harness).toBe('claude');
    // It printed the runtime it ran on as the adapter's Node: in a packaged Pane that is Electron,
    // which runs the adapter only as Node.
    expect(printed.launch.command).toMatchObject({ executable: process.execPath, env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }) });
    expect(calls).toEqual([['run', 'greenfield/implementer:opus', '--print-acp', '--acp-adapter', '/adapter.js']]);
  });
});
