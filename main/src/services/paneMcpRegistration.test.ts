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

  it('repairs a stale Pane entry in place and keeps the comment that introduces the next table', async () => {
    const configPath = path.join(await tempDir(), 'config.toml');
    await fs.writeFile(configPath, [
      '[mcp_servers.pane]',
      '# Managed by Pane (Settings > AI & Agents). Pane rewrites this table on launch.',
      'command = "/Volumes/Old/Pane.app/Contents/MacOS/Pane"',
      'args = ["/Users/me/.pane/mcp/runpane/dist/cli.js", "mcp"]',
      'env = { ELECTRON_RUN_AS_NODE = "1" }',
      'tool_timeout_sec = 600',
      '',
      '# Docs server for the team',
      '[mcp_servers.docs]',
      'url = "https://example.test/mcp"',
      '',
    ].join('\n'));
    const target: McpRegistrationTarget = { label: 'test', server, codex: { configPath } };

    expect(await syncMcpRegistration(target, true)).toEqual([{ client: 'Codex', action: 'updated' }]);
    const text = await fs.readFile(configPath, 'utf8');
    expect(text).not.toContain('/Volumes/Old');
    expect(text.match(/^\[mcp_servers\.pane\]$/gm)).toHaveLength(1);
    expect(text).toContain('\n\n# Docs server for the team\n[mcp_servers.docs]\nurl = "https://example.test/mcp"\n');

    expect(await syncMcpRegistration(target, false)).toEqual([{ client: 'Codex', action: 'removed' }]);
    expect(await fs.readFile(configPath, 'utf8')).toBe('# Docs server for the team\n[mcp_servers.docs]\nurl = "https://example.test/mcp"\n');
  });

  it('keeps blank lines inside a multi-line string when adding and removing its entry', async () => {
    const configPath = path.join(await tempDir(), 'config.toml');
    const original = 'developer_instructions = """first\n\n\n\nlast"""\n';
    await fs.writeFile(configPath, original);
    const target: McpRegistrationTarget = { label: 'test', server, codex: { configPath } };

    await syncMcpRegistration(target, true);
    expect(await fs.readFile(configPath, 'utf8')).toContain('"""first\n\n\n\nlast"""');
    await syncMcpRegistration(target, false);

    expect(await fs.readFile(configPath, 'utf8')).toBe(original);
  });

  it.each([
    ['a hand-written table', '[mcp_servers.pane]\ncommand = "npx"\nargs = ["--yes", "runpane@latest", "mcp"]\n'],
    ['an inline table under [mcp_servers]', '[mcp_servers]\npane = { command = "npx", args = ["runpane", "mcp"] }\n'],
    ['a top-level inline table', 'mcp_servers = { pane = { command = "npx", args = ["runpane", "mcp"] } }\n'],
    ['a quoted table header', "[mcp_servers.'pane']\ncommand = \"npx\"\n"],
    ['a table split around another table', '[mcp_servers.pane]\ncommand = "npx"\n\n[model_providers.x]\nname = "x"\n\n[mcp_servers.pane.env]\nA = "1"\n'],
  ])('leaves %s alone when enabling and disabling', async (_form, userWritten) => {
    const configPath = path.join(await tempDir(), 'config.toml');
    await fs.writeFile(configPath, userWritten);
    const target: McpRegistrationTarget = { label: 'test', server, codex: { configPath } };

    const [enabled] = await syncMcpRegistration(target, true);
    const [disabled] = await syncMcpRegistration(target, false);

    expect(enabled.action).toBe('skipped');
    expect(disabled.action).toBe('skipped');
    expect(await fs.readFile(configPath, 'utf8')).toBe(userWritten);
  });

  it('refuses to edit a config.toml that does not parse', async () => {
    const configPath = path.join(await tempDir(), 'config.toml');
    const broken = 'model = "gpt-5\n';
    await fs.writeFile(configPath, broken);

    const [outcome] = await syncMcpRegistration({ label: 'test', server, codex: { configPath } }, true);

    expect(outcome.action).toBe('skipped');
    expect(await fs.readFile(configPath, 'utf8')).toBe(broken);
  });

  it('writes through a symlinked config.toml', async () => {
    const dir = await tempDir();
    const realPath = path.join(dir, 'dotfiles-config.toml');
    const configPath = path.join(dir, 'config.toml');
    await fs.writeFile(realPath, userCodexConfig);
    await fs.symlink(realPath, configPath);

    await syncMcpRegistration({ label: 'test', server, codex: { configPath } }, true);

    expect((await fs.lstat(configPath)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(realPath, 'utf8')).toContain('[mcp_servers.pane]');
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

  it('leaves a pane server the user added to Claude Code by hand alone', async () => {
    const configPath = path.join(await tempDir(), '.claude.json');
    const handAdded = { type: 'stdio', command: 'npx', args: ['--yes', 'runpane@latest', 'mcp'], env: {} };
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: { pane: handAdded } }));
    const claude = fakeClaudeCli(configPath);
    const target: McpRegistrationTarget = { label: 'test', server, claude: { configPath, run: claude.run } };

    expect((await syncMcpRegistration(target, true))[0].action).toBe('skipped');
    expect((await syncMcpRegistration(target, false))[0].action).toBe('skipped');
    expect(claude.calls).toEqual([]);
    expect(JSON.parse(await fs.readFile(configPath, 'utf8')).mcpServers.pane).toEqual(handAdded);
  });

  it('restores the previous Claude Code entry when re-adding fails', async () => {
    const configPath = path.join(await tempDir(), '.claude.json');
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: { pane: { type: 'stdio', ...server } } }));
    const claude = fakeClaudeCli(configPath);
    const moved = { ...server, command: '/Users/me/Applications/Pane.app/Contents/MacOS/Pane' };
    const run = async (args: string[]) => {
      if (args[1] === 'add' && args.includes(moved.command)) throw new Error('claude: add failed');
      await claude.run(args);
    };

    const [outcome] = await syncMcpRegistration({ label: 'test', server: moved, claude: { configPath, run } }, true);

    expect(outcome).toEqual({ client: 'Claude Code', action: 'skipped', detail: 'claude: add failed' });
    expect(JSON.parse(await fs.readFile(configPath, 'utf8')).mcpServers.pane).toEqual({ type: 'stdio', ...server });
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
