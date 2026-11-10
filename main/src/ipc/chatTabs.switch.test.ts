import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import type { IpcMain } from 'electron';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { resetPaneRuntimeForTests, setPaneRuntime, type PaneRuntime } from '../core/runtime';
import type { ConfigManager } from '../services/configManager';
import type { SessionManager } from '../services/sessionManager';
import type { OrchestrationSessionManager } from '../services/orchestrationSessionManager';
import type { SessionChatSwitchPreview } from '../../../shared/types/chatTab';
import type { AppConfig } from '../types/config';
import type { Session } from '../types/session';
import type { AppServices } from './types';
import type { ToolPanel } from '../../../shared/types/panels';
import type { ChatPanelState } from '../../../shared/types/chatTab';
import type { ChatAgentEnv } from '../services/chatTabs/launch';
import { AgentChatLauncher } from '../services/chatTabs/launch';
import { databaseService } from '../services/database';
import { clearShellPathCache } from '../utils/shellPath';
import { registerPanelHandlers } from './panels';
import { registerChatTabHandlers } from './chatTabs';

function partial<Contract>(value: Partial<Contract>): Contract {
  // SAFETY: Each fixture supplies every member the switch and launch read.
  return value as Contract;
}

// F-37: a terminal a teammate opened stays the teammate's after Switch to chat,
// so its chat starts without the owner's key or secret project variables.
describe.skipIf(process.platform === 'win32')('switching a teammate\'s terminal to chat', () => {
  const originalPath = process.env.PATH;
  const originalClaudeConfig = process.env.CLAUDE_CONFIG_DIR;
  let bin: string;
  let claudeConfig: string;

  beforeEach(() => {
    // A stand-in claude on PATH, so the launch gets as far as choosing the key.
    bin = mkdtempSync(path.join(os.tmpdir(), 'pane-switch-bin-'));
    writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho 2.1.400\n');
    chmodSync(path.join(bin, 'claude'), 0o755);
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
    clearShellPathCache();
    // Claude has saved the conversation, so the switch tries to reopen it.
    claudeConfig = mkdtempSync(path.join(os.tmpdir(), 'pane-switch-claude-'));
    mkdirSync(path.join(claudeConfig, 'projects', '-tmp-pane-switch'), { recursive: true });
    writeFileSync(path.join(claudeConfig, 'projects', '-tmp-pane-switch', 'conv-1.jsonl'), '');
    process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    clearShellPathCache();
    rmSync(bin, { recursive: true, force: true });
    rmSync(claudeConfig, { recursive: true, force: true });
    if (originalClaudeConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfig;
    resetPaneRuntimeForTests();
  });

  it('opens a chat tagged with the teammate, whose agent gets no owner key', async () => {
    const created: ToolPanel[] = [];
    const send = vi.fn((channel: string, panel: ToolPanel) => { if (channel === 'panel:created') created.push(panel); });
    setPaneRuntime(partial<PaneRuntime>({ eventSink: { send }, getConfigManager: () => partial<ConfigManager>({ getConfig: () => partial<AppConfig>({ chatTabsEnabled: true }) }) }));
    const sessionId = `pane-${Math.random().toString(36).slice(2)}`;
    databaseService.createSession({ id: sessionId, name: sessionId, initial_prompt: '', worktree_name: sessionId, worktree_path: '/tmp/pane-switch', project_id: null, tool_type: 'none' });
    const projectEnvFor: Array<string | null> = [];
    const sessionManager = partial<SessionManager>({
      getSession: () => partial<Session>({ worktreePath: '/tmp/pane-switch' }),
      getProjectContext: () => null,
      // Stops the chat before its agent runs; the switch then fails cleanly.
      resolveProjectEnv: async (_paneId, teammate) => { projectEnvFor.push(teammate); throw new Error('stop here'); },
    });
    const registry = new PaneCommandRegistry();
    const services = partial<AppServices>({ sessionManager });
    registerPanelHandlers(partial<IpcMain>({ handle: vi.fn() }), services, registry);
    registerChatTabHandlers(partial<IpcMain>({ handle: vi.fn() }), services, registry);

    const opened = await registry.invokeRemote('panels:create', [{ sessionId, type: 'terminal', title: 'Claude', activate: false, initialState: { customState: { agentType: 'claude', agentSessionId: 'conv-1', launchCommand: 'claude' } } }], { teammate: 'bob' });
    // SAFETY: panels:create answers { success, data: ToolPanel }.
    const terminalId = (opened as { data: ToolPanel }).data.id;
    // The terminal never ran, so Pane is not sure of its conversation: the chat fails and the terminal stays stopped.
    await expect(registry.invoke('chat-tab:switch', [terminalId])).rejects.toMatchObject({ code: 'CHAT_SWITCH_NOT_STARTED' });

    const chat = created.find(panel => panel.type === 'chat');
    expect(chat?.metadata.teammate).toBe('bob');
    expect(projectEnvFor).toEqual(['bob']);

    if (!chat) return;
    const launched: ChatAgentEnv[] = [];
    const launcher = new AgentChatLauncher({
      secrets: { apiKey: () => 'sk-owner' },
      context: { unsupportedHost: () => undefined, projectEnv: async () => ({ env: {}, warnings: [] }) },
      profiles: { resolve: async (_panel, _state, env) => { launched.push(env); return { command: { executable: 'agent-farm', args: [], cwd: '/tmp/pane-switch', env } }; } },
    });
    const state: ChatPanelState = { agent: 'claude', launch: { kind: 'profile', profile: 'greenfield/orchestrator' }, cwd: '/tmp/pane-switch', status: 'starting' };
    await launcher.resolve(chat, state);
    await launcher.resolve({ ...chat, metadata: { ...chat.metadata, teammate: undefined } }, state);
    expect(launched.map(env => env.ANTHROPIC_API_KEY)).toEqual([undefined, 'sk-owner']);
  });
});

// Review F-1 on #1274: a Session that links only some tabs of a Pane switches only those tabs.
describe('which tabs a Session switch to chat covers', () => {
  afterEach(() => resetPaneRuntimeForTests());

  it('takes its own Pane\'s tabs, every tab of a whole-Pane link, and only the linked tabs of a selective one', async () => {
    setPaneRuntime(partial<PaneRuntime>({ eventSink: { send: vi.fn() }, getConfigManager: () => partial<ConfigManager>({ getConfig: () => partial<AppConfig>({ chatTabsEnabled: true }) }) }));
    const id = (name: string) => `${name}-${Math.random().toString(36).slice(2)}`;
    const own = id('own'), selective = id('selective'), whole = id('whole');
    for (const paneId of [own, selective, whole]) {
      databaseService.createSession({ id: paneId, name: paneId, initial_prompt: '', worktree_name: paneId, worktree_path: '/tmp/pane-switch', project_id: null, tool_type: 'none' });
    }
    const sessionManager = partial<SessionManager>({ getSession: paneId => partial<Session>({ name: paneId, worktreePath: '/tmp/pane-switch', archived: false }), getProjectContext: () => null });
    let membership: ReturnType<OrchestrationSessionManager['workspaceMembership']>;
    const orchestrationSessionManager = partial<OrchestrationSessionManager>({ workspaceMembership: sessionId => (sessionId === 's-1' ? membership : undefined) });
    const registry = new PaneCommandRegistry();
    const services = partial<AppServices>({ sessionManager, orchestrationSessionManager });
    registerPanelHandlers(partial<IpcMain>({ handle: vi.fn() }), services, registry);
    registerChatTabHandlers(partial<IpcMain>({ handle: vi.fn() }), services, registry);
    const tab = async (paneId: string, title: string) => {
      const opened = await registry.invoke('panels:create', [{ sessionId: paneId, type: 'terminal', title, activate: false, initialState: { customState: { agentType: 'claude', launchCommand: 'claude' } } }]);
      // SAFETY: panels:create answers { success, data: ToolPanel }.
      return (opened as { data: ToolPanel }).data.id;
    };
    const orchestrator = await tab(own, 'orchestrator');
    const linked = await tab(selective, 'A');
    await tab(selective, 'B');
    const c = await tab(whole, 'C');
    const d = await tab(whole, 'D');
    membership = { panes: new Map([[selective, [linked]], [whole, []]]), ownPaneIds: new Set([own]), ownPanelIds: new Set([orchestrator]) };

    // SAFETY: chat-tab:preview-session-switch answers a SessionChatSwitchPreview.
    const preview = await registry.invoke('chat-tab:preview-session-switch', ['s-1']) as SessionChatSwitchPreview;
    expect(preview.items.map(item => item.panelId)).toEqual([orchestrator, linked, c, d]);
    await expect(registry.invoke('chat-tab:preview-session-switch', ['gone'])).rejects.toMatchObject({ code: 'CHAT_SESSION_MISSING' });
  });
});
