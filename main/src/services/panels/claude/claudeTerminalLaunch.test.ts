import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';
import type { ConfigManager } from '../../configManager';
import type { SessionManager } from '../../sessionManager';
import type { AppConfig } from '../../../types/config';
import type { Project } from '../../../database/models';
import { ClaudeCodeManager } from './claudeCodeManager';
import { CommandRunner } from '../../../utils/commandRunner';
import { PathResolver } from '../../../utils/pathResolver';
import { escapeForBash } from '../../../utils/wslUtils';

let fixtureDirectory: string;

beforeEach(() => {
  fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-claude-terminal-'));
  vi.spyOn(os, 'homedir').mockReturnValue(fixtureDirectory);
  vi.stubEnv('PANE_DIR', path.join(fixtureDirectory, '.pane'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(fixtureDirectory, { recursive: true, force: true });
});

function manager(configOverrides: Partial<AppConfig> = {}, projectOverrides: Partial<Project> = {}, permissionMode: 'approve' | 'ignore' = 'approve') {
  const project: Project = {
    id: 12, name: 'Fixture', path: fixtureDirectory, active: true,
    created_at: '', updated_at: '', system_prompt: 'Project instructions', ...projectOverrides,
  };
  const config = { claudeExecutablePath: '/custom path/claude', systemPromptAppend: 'Global instructions', ...configOverrides };
  // SAFETY: Preparation only reads these session/project lookup methods.
  const sessionManager = {
    getDbSession: () => ({ id: 'session', project_id: project.id, permission_mode: permissionMode }),
    getProjectById: () => project,
    getProjectContext: () => ({ project, pathResolver: new PathResolver(project), commandRunner: new CommandRunner(project) }),
  } as SessionManager;
  // SAFETY: Preparation only reads configuration and the global system prompt.
  const configManager = {
    getConfig: () => config,
    getSystemPromptAppend: () => config.systemPromptAppend,
  } as ConfigManager;
  return new ClaudeCodeManager(sessionManager, undefined, configManager, '/pane/permissions.sock');
}

describe('Claude native terminal launch preparation', () => {
  it('preserves custom executable, instructions and base-project MCP without forcing permissions or auto model', async () => {
    const mcpPath = path.join(fixtureDirectory, '.mcp.json');
    fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: { fixture: { command: 'fixture-tool' } } }));
    const launch = await manager({ verbose: true }).prepareTerminalLaunch({
      sessionId: 'session', prompt: 'Implement it', isResume: false, model: 'auto',
    });
    expect(launch).toEqual({
      executable: '/custom path/claude',
      args: ['--mcp-config', mcpPath],
      environment: { MCP_SOCKET_PATH: '/pane/permissions.sock', MCP_DEBUG: '1' },
      prompt: 'Implement it\n\nGlobal instructions\n\nProject instructions',
    });
  });

  it('preserves selected model and explicit permission override without appending initial instructions on resume', async () => {
    const launch = await manager().prepareTerminalLaunch({
      sessionId: 'session', prompt: 'Next step', isResume: true, model: 'sonnet', permissionMode: 'ignore',
    });
    expect(launch.args).toEqual(['--model', 'sonnet', '--dangerously-skip-permissions']);
    expect(launch.prompt).toBe('Next step');
  });

  it('inherits per-project and global MCP servers from the user config when the worktree has no config file', async () => {
    fs.writeFileSync(path.join(fixtureDirectory, '.claude.json'), JSON.stringify({
      projects: { [fixtureDirectory]: { mcpServers: { projectTool: { command: 'project-tool' } } } },
      mcpServers: { globalTool: { command: 'global-tool' } },
    }));
    const launch = await manager().prepareTerminalLaunch({ sessionId: 'session', prompt: '', isResume: true });
    expect(launch.args[0]).toBe('--mcp-config');
    const mcpPath = launch.args[1];
    expect(JSON.parse(fs.readFileSync(mcpPath, 'utf8'))).toEqual({ mcpServers: {
      projectTool: { command: 'project-tool' }, globalTool: { command: 'global-tool' },
    } });
    fs.rmSync(mcpPath);
  });

  it('resolves the default executable in the WSL distro rather than the host PATH', async () => {
    const launch = await manager({ claudeExecutablePath: undefined }, { wsl_enabled: true }).prepareTerminalLaunch({
      sessionId: 'session', prompt: '', isResume: true,
    });
    expect(launch.executable).toBe('claude');
    expect(launch.args).toEqual([]);
  });

  it('passes a WSL base-project MCP config using its Linux path', async () => {
    const projectPath = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo';
    const existsSync = fs.existsSync;
    vi.spyOn(fs, 'existsSync').mockImplementation(file => String(file).startsWith(projectPath) || existsSync(file));
    const launch = await manager({}, { path: projectPath, wsl_enabled: true, wsl_distribution: 'Ubuntu' })
      .prepareTerminalLaunch({ sessionId: 'session', prompt: '', isResume: true });
    expect(launch.args).toEqual(['--mcp-config', '/home/dev/repo/.mcp.json']);
  });

  it('converts generated host MCP files with the project WSL command runner', async () => {
    fs.writeFileSync(path.join(fixtureDirectory, '.claude.json'), JSON.stringify({
      mcpServers: { globalTool: { command: 'global-tool' } },
    }));
    const paneDirectory = "C:\\Users\\O'Neil\\.pane";
    vi.stubEnv('PANE_DIR', paneDirectory);
    const existsSync = fs.existsSync;
    vi.spyOn(fs, 'existsSync').mockImplementation(file => String(file).startsWith(paneDirectory) || existsSync(file));
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    vi.spyOn(fs, 'chmodSync').mockImplementation(() => {});
    const execAsync = vi.spyOn(CommandRunner.prototype, 'execAsync').mockResolvedValue({
      stdout: "/mnt/c/Users/O'Neil/.pane/pane-base-mcp-session.json\n", stderr: '',
    });
    const launch = await manager({}, { path: '/home/dev/repo', wsl_enabled: true, wsl_distribution: 'Ubuntu' })
      .prepareTerminalLaunch({ sessionId: 'session', prompt: '', isResume: true });
    expect(execAsync).toHaveBeenCalledWith(
      `wslpath -u ${escapeForBash(path.join(paneDirectory, 'pane-base-mcp-session.json'))}`,
      '/home/dev/repo', { timeout: 5000 },
    );
    expect(launch.args).toEqual(['--mcp-config', "/mnt/c/Users/O'Neil/.pane/pane-base-mcp-session.json"]);
  });
});
