import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { ChatPanelState } from '../../../../shared/types/chatTab';
import { resetPaneRuntimeForTests, setPaneRuntime } from '../../core/runtime';
import { ConfigManager } from '../configManager';

import { PaneMcpEndpoint, setPaneMcpEndpoint } from '../paneMcpEndpoint';
import { TabListener } from '../tabListener';
import type { JsonObject } from '../../../../shared/validation/boundaryDecoder';
import { AgentChatLauncher } from './launch';

const bin = mkdtempSync(path.join(tmpdir(), 'pane-chat-launch-bin-'));

afterAll(() => rmSync(bin, { recursive: true, force: true }));
beforeEach(() => setPaneRuntime({ eventSink: { send: () => undefined }, getConfigManager: () => new ConfigManager(), getPtyHostRuntime: () => null, getWebviewContextMap: () => new Map() }));
afterEach(() => resetPaneRuntimeForTests());

for (const [name, version] of [['claude', '2.1.400 (Claude Code)'], ['cursor-agent', '2026.11.01-abc1234'], ['opencode', '1.18.20']]) {
  // Any other launch records its arguments in ARGV_OUT (the chat adapter starting `claude`) and waits on stdin.
  writeFileSync(path.join(bin, name), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\nif [ "$1" = "auth" ]; then echo '{}'; exit 0; fi\n[ -n "$ARGV_OUT" ] && printf '%s\\n' "$@" >> "$ARGV_OUT"\nexec cat >/dev/null\n`, { mode: 0o700 });
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

  it("gives Claude Pane's tools over HTTP with the tab's token only in its environment, never on claude's command line (D-32)", async () => {
    const listener = new TabListener();
    await listener.start();
    const endpoint = new PaneMcpEndpoint({ load: () => import('../../../../packages/runpane/src/mcpHttp'), cli: () => undefined, settings: () => ({ enabled: true }), listener });
    endpoint.attach();
    setPaneMcpEndpoint(endpoint);
    const argvFile = path.join(bin, 'claude-argv.txt');
    let adapter: ChildProcess | undefined;
    try {
      const claude = await resolve('claude', { kind: 'agent' });
      const token = claude.command.env.PANE_MCP_TOKEN;
      expect(token).toMatch(/^\S{40,}$/);
      expect(claude.command.env.PANE_MCP_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      expect(claude.mcpServers).toEqual([{ type: 'http', name: 'pane', url: '${PANE_MCP_URL}', headers: [{ name: 'Authorization', value: 'Bearer ${PANE_MCP_TOKEN}' }] }]);
      // The Claude plugin's own `pane` server is hidden, so the chat sees one Pane server.
      expect(claude.meta).toEqual({ claudeCode: { options: { settings: { deniedMcpServers: [{ serverName: 'plugin:pane:pane' }] } } } });

      // Pane's bundled adapter hands MCP servers to `claude` as a command-line argument, which any local user can read.
      adapter = spawn(claude.command.executable, claude.command.args, { cwd: bin, env: { ...claude.command.env, ARGV_OUT: argvFile }, stdio: ['pipe', 'ignore', 'ignore'] });
      const send = (id: number, method: string, params: JsonObject) => adapter?.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      send(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
      send(2, 'session/new', { cwd: bin, mcpServers: claude.mcpServers, _meta: claude.meta ?? {} });
      const deadline = Date.now() + 20_000;
      while (!(existsSync(argvFile) && readFileSync(argvFile, 'utf8').includes('--mcp-config'))) {
        if (Date.now() > deadline) throw new Error('the adapter never started claude');
        await new Promise(resolveWait => setTimeout(resolveWait, 100));
      }
      const argv = readFileSync(argvFile, 'utf8');
      expect(argv).toContain('Bearer ${PANE_MCP_TOKEN}');
      expect(argv).not.toContain(token);
      expect(argv).toContain('plugin:pane:pane');

      expect((await resolve('cursor', { kind: 'agent' })).mcpServers).toBeUndefined();
    } finally {
      adapter?.kill();
      setPaneMcpEndpoint(undefined);
      endpoint.detachAll();
      await listener.stop();
    }
  });

  it('refuses an agent the host has neither configured nor installed, saying where to install agents', async () => {
    await expect(resolve('gemini', { kind: 'agent' })).rejects.toMatchObject({ code: 'CHAT_AGENT_NOT_INSTALLED', next: expect.stringContaining('Settings > Agents') });
  });
});
