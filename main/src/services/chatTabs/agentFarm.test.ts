import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { ChatPanelState, ChatTabView } from '../../../../shared/types/chatTab';
import { PaneError } from '../../../../shared/paneError';
import { AgentFarmProfiles, agentFarmCommand, printedCli, type AgentFarmOptions } from './agentFarm';
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

/** With Profiles on (T-63), only the bundled copy runs; the person's own is never looked up. */
const PROFILES_ON = { profilesOn: () => true, executable: () => { throw new Error('looked up agent-farm on PATH with Profiles on'); } } satisfies Pick<AgentFarmOptions, 'profilesOn' | 'executable'>;

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
    const profiles = new AgentFarmProfiles({ ...PROFILES_ON, sessionProfile: async () => undefined, bundled, adapter: async () => '/adapters/claude/dist/index.js', checkCli: async () => undefined });
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
    const profiles = new AgentFarmProfiles({ ...PROFILES_ON, sessionProfile: async () => undefined, bundled, adapter: async () => '/adapter.js', checkCli: async (agent, context) => { checks.push({ agent, cwd: context.cwd, profile: context.env?.AGENT_FARM_PROFILE, path: context.env?.PATH }); } });
    // The caller guessed claude; Agent Farm says this profile runs Codex, so Codex is what gets checked.
    const printed = await profiles.print('team/codex', {}, 'claude', directory, { PATH: process.env.PATH ?? '', FAKE_AGENT_FARM_HARNESS: 'codex' });
    expect(printed.harness).toBe('codex');
    expect(checks).toEqual([{ agent: 'codex', cwd: directory, profile: 'team/codex', path: process.env.PATH ?? '' }]);
  });

  it('stops a profile whose CLI is too old, with that error', async () => {
    const directory = scratch();
    const profiles = new AgentFarmProfiles({ ...PROFILES_ON, sessionProfile: async () => undefined, bundled, adapter: async () => '/adapter.js', checkCli: async () => { throw new PaneError('CHAT_AGENT_OUTDATED', 'Claude Code 2.0.1 is older than 2.1.316.', 'Update it.'); } });
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
    const profiles = new AgentFarmProfiles({ ...PROFILES_ON, sessionProfile: async () => undefined, bundled, adapter: async () => '/adapter.js', checkCli: async () => undefined });
    await expect(profiles.print('missing/profile', {}, 'claude', directory, { PATH: process.env.PATH ?? '' })).rejects.toMatchObject({ code: 'CHAT_PROFILE_FAILED', message: expect.stringContaining('Unknown profile: missing/profile') });
    await expect(profiles.print('old/agent-farm', {}, 'claude', directory, { PATH: process.env.PATH ?? '' })).rejects.toMatchObject({ code: 'CHAT_PROFILE_FAILED', next: expect.stringContaining('Update Agent Farm') });
    const unbundled = new AgentFarmProfiles({ ...PROFILES_ON, sessionProfile: async () => undefined, bundled: async () => undefined, adapter: async () => '/adapter.js', checkCli: async () => undefined });
    await expect(unbundled.print('x', {}, 'claude', directory, {})).rejects.toMatchObject({ code: 'CHAT_AGENT_NOT_INSTALLED', next: expect.stringContaining('Reinstall Pane') });
  });

  it('runs Pane\'s bundled Agent Farm, and starts the printed adapter on its runtime as Node', async () => {
    const directory = scratch();
    const calls: string[][] = [];
    const recording = async (args: string[], cwd: string, env: Record<string, string>) => { calls.push(args); return bundled(args, cwd, env); };
    const profiles = new AgentFarmProfiles({ ...PROFILES_ON, sessionProfile: async () => undefined, bundled: recording, adapter: async () => '/adapter.js', checkCli: async () => undefined });
    const { ELECTRON_RUN_AS_NODE: _unset, ...env } = inherited();
    const printed = await profiles.print('greenfield/implementer:opus', {}, 'claude', directory, env);
    expect(printed.harness).toBe('claude');
    // It printed the runtime it ran on as the adapter's Node: in a packaged Pane that is Electron,
    // which runs the adapter only as Node.
    expect(printed.launch.command).toMatchObject({ executable: process.execPath, env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }) });
    expect(calls).toEqual([['run', 'greenfield/implementer:opus', '--print-acp', '--acp-adapter', '/adapter.js']]);
  });

  // T-83 P3: a linked agent's tab passes its parent token at every start.
  it('passes a launch link\'s parent as --parent with Profiles on, and refuses to start it with Profiles off (review F-5)', async () => {
    const directory = scratch();
    const calls: string[][] = [];
    const recording = async (args: string[], cwd: string, env: Record<string, string>) => { calls.push(args); return bundled(args, cwd, env); };
    const { ELECTRON_RUN_AS_NODE: _unset, ...env } = inherited();
    const on = new AgentFarmProfiles({ ...PROFILES_ON, sessionProfile: async () => undefined, bundled: recording, adapter: async () => '/adapter.js', checkCli: async () => undefined });
    await on.print('greenfield/planner', { docs: 'grain' }, 'claude', directory, env, 'greenfield/orchestrator:claude@af-1');
    const off = new AgentFarmProfiles({ profilesOn: () => false, sessionProfile: async () => undefined, executable: () => undefined, bundled: recording, adapter: async () => '/adapter.js', checkCli: async () => undefined });
    await expect(off.print('greenfield/planner', {}, 'claude', directory, env, 'greenfield/orchestrator:claude@af-1')).rejects.toMatchObject({ code: 'CHAT_PROFILE_PARENT_OFF' });
    await off.print('greenfield/planner', {}, 'claude', directory, env);
    expect(calls).toEqual([
      ['run', 'greenfield/planner', '--print-acp', '--acp-adapter', '/adapter.js', '--arg', 'docs=grain', '--parent', 'greenfield/orchestrator:claude@af-1'],
      ['run', 'greenfield/planner', '--print-acp', '--acp-adapter', '/adapter.js'],
    ]);
  });
});

// As main runs profiles (T-63's flag off): the person's own agent-farm first, the bundled copy without one.
describe('Agent Farm profiles in chat tabs with Profiles off', () => {
  it('runs the person\'s own Agent Farm when one is on PATH, and the bundled one when none is', async () => {
    const directory = scratch();
    const calls: string[][] = [];
    const recording = async (args: string[], cwd: string, env: Record<string, string>) => { calls.push(args); return bundled(args, cwd, env); };
    const { ELECTRON_RUN_AS_NODE: _unset, ...env } = inherited();
    const withoutOwn = new AgentFarmProfiles({ profilesOn: () => false, sessionProfile: async () => undefined, executable: () => undefined, bundled: recording, adapter: async () => '/adapter.js', checkCli: async () => undefined });
    const printed = await withoutOwn.print('greenfield/implementer:opus', {}, 'claude', directory, env);
    expect(printed.launch.command.env?.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(calls).toHaveLength(1);
    const withOwn = new AgentFarmProfiles({ profilesOn: () => false, sessionProfile: async () => undefined, executable: () => fakeCli(directory), bundled: recording, adapter: async () => '/adapter.js', checkCli: async () => undefined });
    const own = await withOwn.print('greenfield/implementer:opus', {}, 'claude', directory, env);
    expect(calls).toHaveLength(1);
    expect(own.launch.command.env?.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('says to install agent-farm or reinstall Pane when neither is there', async () => {
    const absent = new AgentFarmProfiles({ profilesOn: () => false, sessionProfile: async () => undefined, executable: () => undefined, bundled: async () => undefined, adapter: async () => '/adapter.js', checkCli: async () => undefined });
    await expect(absent.print('x', {}, 'claude', scratch(), {})).rejects.toMatchObject({ code: 'CHAT_AGENT_NOT_INSTALLED', next: expect.stringContaining('Install the agent-farm CLI') });
  });
});

describe('a Session\'s orchestrator through Agent Farm (T-63)', () => {
  const panel: ToolPanel = { id: 'orch', sessionId: 'internal', type: 'chat', title: 'Session', state: { isActive: true }, metadata: { createdAt: '', lastActiveAt: '', position: 0 } };
  function session(profile: string, agent: 'claude' | 'codex', extra: Partial<ChatPanelState['launch']> = {}, on = true) {
    const folder = scratch();
    const written: Array<{ folder: string; profile: string; instructions: string }> = [];
    const grants: string[] = [];
    const profiles = new AgentFarmProfiles({
      ...(on ? PROFILES_ON : { profilesOn: () => false, executable: () => undefined }), bundled, adapter: async () => '/adapter.js', checkCli: async () => undefined,
      sessionProfile: async (target, name, instructions) => { written.push({ folder: target, profile: name, instructions }); },
      grantPaneMcp: tab => { grants.push(tab.panelId); return { PANE_MCP_URL: 'http://127.0.0.1:1/mcp', PANE_MCP_TOKEN: 'token' }; },
    });
    // SAFETY: test states only ever widen the profile launch with fullAccess.
    const launch = { kind: 'profile', profile, ...extra } as ChatPanelState['launch'];
    const state: ChatPanelState = { agent, launch, cwd: folder, status: 'starting', orchestrationSessionId: 'session-1', sessionFolder: folder };
    const env = { PATH: process.env.PATH ?? '', FAKE_AGENT_FARM_HARNESS: agent };
    return { folder, written, grants, resolve: () => profiles.resolve(panel, state, env) };
  }

  it('moves Claude\'s profile instructions into the Session folder and keeps the person\'s MCP servers beside Pane\'s', async () => {
    const { folder, written, grants, resolve } = session('greenfield/orchestrator', 'claude');
    const launch = await resolve();
    expect(written).toEqual([{ folder, profile: 'greenfield/orchestrator', instructions: 'Profile greenfield/orchestrator\n\nLAUNCH CONTEXT\nheadless: false' }]);
    expect(launch.meta?.systemPrompt).toBeUndefined();
    expect(launch.meta?.claudeCode).toEqual({ options: {
      model: 'claude-opus-5-5', plugins: [{ type: 'local', path: '/bundle/main' }],
      mcpServers: { profile_server: { type: 'stdio', command: 'x', args: [], env: {} } },
      strictMcpConfig: false,
      settings: { deniedMcpServers: [{ serverName: 'plugin:pane:pane' }] },
    } });
    expect(grants).toEqual(['orch']);
    expect(launch.mcpServers).toEqual([expect.objectContaining({ type: 'http', name: 'pane' })]);
    expect(launch.command.env).toMatchObject({ PANE_MCP_TOKEN: 'token' });
    // A real profile keeps the permission mode Agent Farm gives it.
    expect(launch.mode).toBe('bypassPermissions');
  });

  // Profiles off (T-63's flag): no PROFILE.md and no MCP or permission rewrites; the launch runs as printed, as on main.
  it('leaves a Session\'s profile launch as Agent Farm printed it with Profiles off', async () => {
    const { written, grants, resolve } = session('greenfield/orchestrator', 'claude', {}, false);
    const launch = await resolve();
    expect(written).toEqual([]);
    expect(grants).toEqual([]);
    expect(launch.meta?.systemPrompt).toEqual({ append: expect.stringContaining('LAUNCH CONTEXT') });
    expect(launch.mcpServers).toBeUndefined();
    expect(launch.mode).toBe('bypassPermissions');
    const plain = await session('pane/claude', 'claude', {}, false).resolve();
    expect(plain.mode).toBe('bypassPermissions');
  });

  it('runs plain Claude with the permissions it had before Agent Farm, and full access only when the Session asked', async () => {
    expect((await session('pane/claude', 'claude').resolve()).mode).toBeUndefined();
    expect((await session('pane/claude', 'claude', { fullAccess: true }).resolve()).mode).toBe('bypassPermissions');
  });

  it('moves Codex\'s developer_instructions into the Session folder and keeps the rest of its config', async () => {
    const { written, grants, resolve } = session('pane/codex', 'codex');
    const launch = await resolve();
    expect(written[0]?.instructions).toBe('Profile pane/codex\n\nLAUNCH CONTEXT\nheadless: false');
    expect(JSON.parse(launch.command.env.CODEX_CONFIG ?? '{}')).toEqual({ model: 'gpt-6-astra', mcp_servers: {} });
    // Plain Codex asks as before; Codex reaches Pane through its own config, so no HTTP grant.
    expect(launch.command.env.INITIAL_AGENT_MODE).toBeUndefined();
    expect(launch.mode).toBeUndefined();
    expect(grants).toEqual([]);
  });

  it('leaves a profile chat tab outside a Session as Agent Farm printed it', async () => {
    const written: string[] = [];
    const profiles = new AgentFarmProfiles({ ...PROFILES_ON, bundled, adapter: async () => '/adapter.js', checkCli: async () => undefined, sessionProfile: async (_folder, profile) => { written.push(profile); } });
    const state: ChatPanelState = { agent: 'claude', launch: { kind: 'profile', profile: 'greenfield/implementer' }, cwd: scratch(), status: 'starting' };
    const launch = await profiles.resolve(panel, state, { PATH: process.env.PATH ?? '' });
    expect(written).toEqual([]);
    expect(launch.meta?.systemPrompt).toEqual({ append: expect.stringContaining('LAUNCH CONTEXT') });
    expect(launch.mcpServers).toBeUndefined();
  });
});
