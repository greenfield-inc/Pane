import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { ChatPanelState } from '../../../../shared/types/chatTab';
import { resetPaneRuntimeForTests, setPaneRuntime } from '../../core/runtime';
import { ConfigManager } from '../configManager';

import { AgentChatLauncher } from './launch';

const bin = mkdtempSync(path.join(tmpdir(), 'pane-chat-launch-bin-'));

afterAll(() => rmSync(bin, { recursive: true, force: true }));
beforeEach(() => setPaneRuntime({ eventSink: { send: () => undefined }, getConfigManager: () => new ConfigManager(), getPtyHostRuntime: () => null, getWebviewContextMap: () => new Map() }));
afterEach(() => resetPaneRuntimeForTests());

for (const [name, version] of [['claude', '2.1.400 (Claude Code)'], ['cursor-agent', '2026.11.01-abc1234'], ['opencode', '1.18.20']]) {
  writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${version}"\n`, { mode: 0o700 });
}

const panel: ToolPanel = { id: 'p-1', sessionId: 's-1', type: 'chat', title: 'Chat', state: { isActive: true }, metadata: { createdAt: '', lastActiveAt: '', position: 0 } };
const launcher = new AgentChatLauncher({
  secrets: { apiKey: () => undefined }, context: { unsupportedHost: () => undefined, projectEnv: async () => ({ env: {}, warnings: [] }) },
  findExecutable: name => (['claude', 'cursor-agent', 'opencode'].includes(name) ? path.join(bin, name) : null),
});
const resolve = (agent: string, launch: ChatPanelState['launch']) => launcher.resolve(panel, { agent, launch, cwd: bin, status: 'starting' });

describe.skipIf(process.platform === 'win32')('how a chat tab starts each kind of agent (D-13, D-16)', () => {
  it('runs an agent with ACP built in as its own CLI, with its full-access flag before the ACP command', async () => {
    const plain = await resolve('cursor', { kind: 'agent' });
    expect([plain.command.executable, ...plain.command.args]).toEqual([path.join(bin, 'cursor-agent'), 'acp']);
    expect(plain.command.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    const full = await resolve('cursor', { kind: 'agent', fullAccess: true });
    expect(full.command.args).toEqual(['--force', 'acp']);
    expect(full).not.toHaveProperty('approveOnce');
  });

  it('has Pane answer approvals for an agent with no full-access switch of its own', async () => {
    const full = await resolve('opencode', { kind: 'agent', fullAccess: true });
    expect(full.command.args).toEqual(['acp']);
    expect(full.approveOnce).toBe(true);
    expect(await resolve('opencode', { kind: 'agent' })).not.toHaveProperty('approveOnce');
  });

  it('runs an adapter agent through Pane\'s bundled adapter, pointed at the person\'s CLI, with full access as its mode', async () => {
    const full = await resolve('claude', { kind: 'agent', fullAccess: true });
    expect(full.command.executable).toBe(process.execPath);
    expect(full.command.args[0]).toMatch(/claude-agent-acp[/\\]dist[/\\]index\.js$/);
    expect(full.command.env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1', CLAUDE_CODE_EXECUTABLE: path.join(bin, 'claude') });
    expect(full.mode).toBe('bypassPermissions');
  });

  it('refuses an agent the host has neither configured nor installed, saying where to install agents', async () => {
    await expect(resolve('gemini', { kind: 'agent' })).rejects.toMatchObject({ code: 'CHAT_AGENT_NOT_INSTALLED', next: expect.stringContaining('Settings > Agents') });
  });
});
