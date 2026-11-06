import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { ChatPanelState, ChatTabView } from '../../../../shared/types/chatTab';
import { PaneError } from '../../../../shared/paneError';
import { AgentFarmProfiles, agentFarmCommand, printedCli } from './agentFarm';
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

/** The CLI as npm installs it: a shell script, or on Windows a .cmd shim, which Node cannot exec directly. */
function fakeCli(directory: string): string {
  if (process.platform === 'win32') {
    const shim = path.join(directory, 'agent-farm.cmd');
    writeFileSync(shim, `@ECHO off\r\n"${process.execPath}" "${FAKE}" %*\r\n`);
    return shim;
  }
  const shim = path.join(directory, 'agent-farm');
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(shim, 0o755);
  return shim;
}

describe('the agent-farm command', () => {
  it('runs a Windows npm shim through cmd with its arguments passed literally', () => {
    expect(agentFarmCommand('C:\\npm\\agent-farm.cmd', ['run', 'greenfield/implementer', '--arg', 'docs=grain'], 'win32')).toEqual({
      executable: 'cmd.exe', args: ['/d', '/s', '/c', '""C:\\npm\\agent-farm.cmd" "run" "greenfield/implementer" "--arg" "docs=grain""'], windowsVerbatimArguments: true,
    });
    expect(agentFarmCommand('/usr/local/bin/agent-farm', ['run', 'p'], 'darwin')).toEqual({ executable: '/usr/local/bin/agent-farm', args: ['run', 'p'] });
  });
});

describe('Agent Farm profiles in chat tabs', () => {
  it('starts a profile with its printed settings, selects its mode and keeps env out of saved state', async () => {
    const directory = scratch();
    const cli = fakeCli(directory);
    const profiles = new AgentFarmProfiles({ executable: () => cli, adapter: async () => '/adapters/claude/dist/index.js', checkCli: async () => undefined });
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
    const profiles = new AgentFarmProfiles({ executable: () => fakeCli(directory), adapter: async () => '/adapter.js', checkCli: async (agent, context) => { checks.push({ agent, cwd: context.cwd, profile: context.env?.AGENT_FARM_PROFILE, path: context.env?.PATH }); } });
    // The caller guessed claude; Agent Farm says this profile runs Codex, so Codex is what gets checked.
    const printed = await profiles.print('team/codex', {}, 'claude', directory, { PATH: process.env.PATH ?? '', FAKE_AGENT_FARM_HARNESS: 'codex' });
    expect(printed.harness).toBe('codex');
    expect(checks).toEqual([{ agent: 'codex', cwd: directory, profile: 'team/codex', path: process.env.PATH ?? '' }]);
  });

  it('stops a profile whose CLI is too old, with that error', async () => {
    const directory = scratch();
    const profiles = new AgentFarmProfiles({ executable: () => fakeCli(directory), adapter: async () => '/adapter.js', checkCli: async () => { throw new PaneError('CHAT_AGENT_OUTDATED', 'Claude Code 2.0.1 is older than 2.1.316.', 'Update it.'); } });
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
    const profiles = new AgentFarmProfiles({ executable: () => fakeCli(directory), adapter: async () => '/adapter.js', checkCli: async () => undefined });
    await expect(profiles.print('missing/profile', {}, 'claude', directory, { PATH: process.env.PATH ?? '' })).rejects.toMatchObject({ code: 'CHAT_PROFILE_FAILED', message: expect.stringContaining('Unknown profile: missing/profile') });
    await expect(profiles.print('old/agent-farm', {}, 'claude', directory, { PATH: process.env.PATH ?? '' })).rejects.toMatchObject({ code: 'CHAT_PROFILE_FAILED', next: expect.stringContaining('Update Agent Farm') });
    const absent = new AgentFarmProfiles({ executable: () => undefined, adapter: async () => '/adapter.js', checkCli: async () => undefined });
    await expect(absent.print('x', {}, 'claude', directory, {})).rejects.toMatchObject({ code: 'CHAT_AGENT_NOT_INSTALLED' });
  });
});
