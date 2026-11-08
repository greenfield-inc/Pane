import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import type { IpcMain } from 'electron';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { resetPaneRuntimeForTests, setPaneRuntime, type PaneRuntime } from '../core/runtime';
import type { ConfigManager } from '../services/configManager';
import type { SessionManager } from '../services/sessionManager';
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
  let bin: string;

  beforeEach(() => {
    // A stand-in claude on PATH, so the launch gets as far as choosing the key.
    bin = mkdtempSync(path.join(os.tmpdir(), 'pane-switch-bin-'));
    writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho 2.1.400\n');
    chmodSync(path.join(bin, 'claude'), 0o755);
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
    clearShellPathCache();
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    clearShellPathCache();
    rmSync(bin, { recursive: true, force: true });
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
    await expect(registry.invoke('chat-tab:switch', [terminalId])).rejects.toMatchObject({ code: 'CHAT_SWITCH_FAILED' });

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
