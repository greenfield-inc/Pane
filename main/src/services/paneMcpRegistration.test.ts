import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  syncMcpRegistration,
  type McpRegistrationTarget,
  type PaneMcpServerEntry,
} from './paneMcpRegistration';

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-mcp-registration-'));
  tempDirs.push(dir);
  return dir;
}

const server: PaneMcpServerEntry = {
  command: '/Applications/Pane.app/Contents/MacOS/Pane',
  args: ['/Users/me/.pane/mcp/runpane/dist/cli.js', 'mcp'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
};

const userCodexConfig = [
  'model = "gpt-5"',
  '',
  '[mcp_servers.docs]',
  'url = "https://example.test/mcp"',
  '',
  '[projects."/work/app"]',
  'trust_level = "trusted"',
  '',
].join('\n');

/** Stands in for `claude mcp add|remove --scope user`, which edits ~/.claude.json. */
function fakeClaudeCli(configPath: string) {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    const config = JSON.parse(await fs.readFile(configPath, 'utf8').catch(() => '{}'));
    config.mcpServers ??= {};
    const [, action, name] = args;
    if (action === 'remove') {
      delete config.mcpServers[name];
    } else {
      const separator = args.indexOf('--');
      const env = Object.fromEntries(args.slice(0, separator).flatMap((arg, index) =>
        args[index - 1] === '-e' ? [arg.split('=')] : []));
      const [command, ...rest] = args.slice(separator + 1);
      config.mcpServers[name] = { type: 'stdio', command, args: rest, env };
    }
    await fs.writeFile(configPath, JSON.stringify(config));
  };
  return { calls, run };
}

describe('syncMcpRegistration', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('adds a Codex entry once, keeps the rest of config.toml, and removes it cleanly', async () => {
    const configPath = path.join(await tempDir(), 'config.toml');
    await fs.writeFile(configPath, userCodexConfig);
    const target: McpRegistrationTarget = { label: 'test', server, codex: { configPath } };

    expect(await syncMcpRegistration(target, true)).toEqual([{ client: 'Codex', action: 'added' }]);
    const registered = await fs.readFile(configPath, 'utf8');
    expect(await syncMcpRegistration(target, true)).toEqual([{ client: 'Codex', action: 'unchanged' }]);

    expect(registered.startsWith(userCodexConfig)).toBe(true);
    expect(registered.match(/^\[mcp_servers\.pane\]$/gm)).toHaveLength(1);
    expect(registered).toContain('command = "/Applications/Pane.app/Contents/MacOS/Pane"');
    expect(registered).toContain('args = ["/Users/me/.pane/mcp/runpane/dist/cli.js", "mcp"]');
    expect(registered).toContain('env = { ELECTRON_RUN_AS_NODE = "1" }');
    expect(await fs.readFile(configPath, 'utf8')).toBe(registered);

    expect(await syncMcpRegistration(target, false)).toEqual([{ client: 'Codex', action: 'removed' }]);
    expect(await fs.readFile(configPath, 'utf8')).toBe(userCodexConfig);
  });

  it('repairs a stale Codex entry in place, including its env subtable', async () => {
    const configPath = path.join(await tempDir(), 'config.toml');
    await fs.writeFile(configPath, [
      '[mcp_servers.pane]',
      'command = "/Volumes/Old/Pane.app/Contents/MacOS/Pane"',
      'args = ["/old/cli.js", "mcp"]',
      '',
      '[mcp_servers.pane.env]',
      'ELECTRON_RUN_AS_NODE = "1"',
      '',
      '[mcp_servers.docs]',
      'url = "https://example.test/mcp"',
      '',
    ].join('\n'));

    const outcomes = await syncMcpRegistration({ label: 'test', server, codex: { configPath } }, true);

    expect(outcomes).toEqual([{ client: 'Codex', action: 'updated' }]);
    const text = await fs.readFile(configPath, 'utf8');
    expect(text).not.toContain('/Volumes/Old');
    expect(text).not.toContain('[mcp_servers.pane.env]');
    expect(text.match(/^\[mcp_servers\.pane\]$/gm)).toHaveLength(1);
    expect(text).toContain('[mcp_servers.docs]\nurl = "https://example.test/mcp"');
  });

  it('leaves a pane server the user wrote as an inline table alone', async () => {
    const configPath = path.join(await tempDir(), 'config.toml');
    const userWritten = '[mcp_servers]\npane = { command = "npx", args = ["runpane", "mcp"] }\n';
    await fs.writeFile(configPath, userWritten);

    const [outcome] = await syncMcpRegistration({ label: 'test', server, codex: { configPath } }, true);

    expect(outcome.action).toBe('skipped');
    expect(await fs.readFile(configPath, 'utf8')).toBe(userWritten);
  });

  it('registers with Claude Code once, repairs a moved app, and unregisters', async () => {
    const configPath = path.join(await tempDir(), '.claude.json');
    const other = { type: 'http', url: 'https://example.test/mcp' };
    await fs.writeFile(configPath, JSON.stringify({ numStartups: 3, mcpServers: { docs: other } }));
    const claude = fakeClaudeCli(configPath);
    const target: McpRegistrationTarget = { label: 'test', server, claude: { configPath, run: claude.run } };
    const readConfig = async () => JSON.parse(await fs.readFile(configPath, 'utf8'));

    expect(await syncMcpRegistration(target, true)).toEqual([{ client: 'Claude Code', action: 'added' }]);
    const callsAfterAdd = claude.calls.length;
    expect(await syncMcpRegistration(target, true)).toEqual([{ client: 'Claude Code', action: 'unchanged' }]);
    expect(claude.calls.length).toBe(callsAfterAdd);
    expect((await readConfig()).mcpServers).toEqual({ docs: other, pane: { type: 'stdio', ...server } });

    const moved = { ...target, server: { ...server, command: '/Users/me/Applications/Pane.app/Contents/MacOS/Pane' } };
    expect(await syncMcpRegistration(moved, true)).toEqual([{ client: 'Claude Code', action: 'updated' }]);
    expect((await readConfig()).mcpServers.pane.command).toBe('/Users/me/Applications/Pane.app/Contents/MacOS/Pane');

    expect(await syncMcpRegistration(moved, false)).toEqual([{ client: 'Claude Code', action: 'removed' }]);
    expect(await readConfig()).toEqual({ numStartups: 3, mcpServers: { docs: other } });
  });

  it('reports a failing client without blocking the other', async () => {
    const dir = await tempDir();
    const target: McpRegistrationTarget = {
      label: 'test',
      server,
      claude: { configPath: path.join(dir, '.claude.json'), run: async () => { throw new Error('claude: command failed'); } },
      codex: { configPath: path.join(dir, 'codex', 'config.toml') },
    };

    const outcomes = await syncMcpRegistration(target, true);

    expect(outcomes).toEqual([
      { client: 'Claude Code', action: 'skipped', detail: 'claude: command failed' },
      { client: 'Codex', action: 'added' },
    ]);
  });
});
