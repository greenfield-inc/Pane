import { afterEach, describe, expect, it } from 'vitest';
import path from 'path';
import { chatLaunchForTerminal, chatLaunchFromCommand, chatTabEnv, sessionChatLaunch, sessionFolderMeta } from './launch';
import { resetPaneRuntimeForTests, setPaneRuntime } from '../../core/runtime';
import { ConfigManager } from '../configManager';
import { getAppDirectory } from '../../utils/appDirectory';
import type { ToolPanel } from '../../../../shared/types/panels';
import { AGENT_FARM_RESUME } from '../../../../shared/types/customCommandResume';
import { withSessionFolderAccess } from '../agents/sessionFolderAccess';
import { agentTerminalCommand } from '../../../../shared/agents';
import { readProfilesSwitchFrom } from '../agentFarm/profilesFeature';

describe('which terminal launches a chat tab can run', () => {
  it('runs the plain agent, keeping its skip-approvals flag as the session mode', () => {
    expect(chatLaunchFromCommand(undefined, 'claude')).toEqual({ kind: 'agent' });
    expect(chatLaunchFromCommand('claude --dangerously-skip-permissions', 'claude')).toEqual({ kind: 'agent', mode: 'bypassPermissions' });
    expect(chatLaunchFromCommand('codex --yolo', 'codex')).toEqual({ kind: 'agent', mode: 'agent-full-access' });
  });
  it('runs an Agent Farm profile with its launch arguments', () => {
    expect(chatLaunchFromCommand('agent-farm run greenfield/orchestrator --arg docs=grain --arg "note=a b"', 'claude')).toEqual({ kind: 'profile', profile: 'greenfield/orchestrator', args: { docs: 'grain', note: 'a b' } });
  });
  it('leaves wrappers and unknown flags in their terminal', () => {
    expect(chatLaunchFromCommand('claude --model opus', 'claude')).toBeUndefined();
    expect(chatLaunchFromCommand('my-wrapper claude', 'claude')).toBeUndefined();
    expect(chatLaunchFromCommand('agent-farm run greenfield/x --model opus', 'claude')).toBeUndefined();
    expect(chatLaunchFromCommand('codex --yolo', 'claude')).toBeUndefined();
  });

  // T-83 P3: a launch link's command as Agent Farm prints it, run by Pane's bundled copy.
  describe('a launch link\'s command', () => {
    afterEach(() => readProfilesSwitchFrom(() => undefined));
    const root = () => path.join(getAppDirectory(), 'agent-farm');
    const shim = () => path.join(getAppDirectory(), 'bin', 'agent-farm');

    it('runs the shim\'s path, Pane\'s own --config-root and --parent with Profiles on', () => {
      readProfilesSwitchFrom(() => ({ sessionProfilesEnabled: true }));
      expect(chatLaunchFromCommand(`${shim()} run greenfield/planner --config-root ${root()} --parent greenfield/orchestrator:claude@af-1 --arg docs=grain`, 'claude'))
        .toEqual({ kind: 'profile', profile: 'greenfield/planner', args: { docs: 'grain' }, parent: 'greenfield/orchestrator:claude@af-1' });
      expect(chatLaunchFromCommand('agent-farm run greenfield/reviewer:codex --parent=greenfield/orchestrator@af-2', 'codex'))
        .toEqual({ kind: 'profile', profile: 'greenfield/reviewer:codex', parent: 'greenfield/orchestrator@af-2' });
      expect(chatLaunchForTerminal(`${shim()} run greenfield/planner --config-root /elsewhere --parent p@1`, 'claude')).toEqual({ unsupported: '--config-root' });
      expect(chatLaunchFromCommand('agent-farm run greenfield/planner --parent', 'claude')).toBeUndefined();
    });

    // T-110: Agent Farm 0.3.1 prints --snapshot in each link line, so the tab keeps its parent's files.
    it('carries a link line\'s --snapshot with Profiles on, and keeps the terminal with it off', () => {
      readProfilesSwitchFrom(() => ({ sessionProfilesEnabled: true }));
      expect(chatLaunchFromCommand(`${shim()} run greenfield/planner --config-root ${root()} --parent greenfield/orchestrator@af-1 --snapshot '/Users/me/.pane/sessions/s 1/.agent-farm/snapshots/d1'`, 'claude'))
        .toEqual({ kind: 'profile', profile: 'greenfield/planner', parent: 'greenfield/orchestrator@af-1', snapshot: '/Users/me/.pane/sessions/s 1/.agent-farm/snapshots/d1' });
      expect(chatLaunchFromCommand('agent-farm run greenfield/planner --snapshot', 'claude')).toBeUndefined();
      readProfilesSwitchFrom(() => undefined);
      expect(chatLaunchForTerminal('agent-farm run greenfield/planner --snapshot /s/d1', 'claude')).toEqual({ unsupported: '--snapshot' });
    });

    it('keeps the terminal with Profiles off, as on main', () => {
      expect(chatLaunchFromCommand(`${shim()} run greenfield/planner`, 'claude')).toBeUndefined();
      expect(chatLaunchFromCommand('agent-farm run greenfield/planner --parent greenfield/orchestrator@af-1', 'claude')).toBeUndefined();
      expect(chatLaunchForTerminal('agent-farm run greenfield/planner --parent greenfield/orchestrator@af-1', 'claude')).toEqual({ unsupported: '--parent' });
    });
  });
});

// D-185: what the new-Session dialog saves for every Agent Farm Session.
describe('which Sessions can run as a chat', () => {
  const profile = 'agent-farm run greenfield/orchestrator';

  it('runs an Agent Farm Session as a chat with the resume template the dialog saves', () => {
    const saved = { mode: 'reported', initialTemplate: '{command}', resumeTemplate: '{command} --resume {sessionId}' } as const;
    expect(sessionChatLaunch({ agent: 'claude', launchCommand: profile, customResume: saved })).toEqual({ launch: { kind: 'profile', profile: 'greenfield/orchestrator' } });
    expect(sessionChatLaunch({ agent: 'codex', launchCommand: profile, customResume: AGENT_FARM_RESUME })).toEqual({ launch: { kind: 'profile', profile: 'greenfield/orchestrator' } });
    expect(sessionChatLaunch({ agent: 'claude', launchCommand: 'claude', customResume: saved })).toEqual({ launch: { kind: 'agent' } });
    expect(sessionChatLaunch({ agent: 'claude', launchCommand: profile })).toEqual({ launch: { kind: 'profile', profile: 'greenfield/orchestrator' } });
  });

  it('keeps a terminal, and says why, for a launch a chat cannot run the same way', () => {
    const reason = (input: Parameters<typeof sessionChatLaunch>[0]) => {
      const result = sessionChatLaunch(input);
      return 'terminalReason' in result ? result.terminalReason : undefined;
    };
    expect(reason({ agent: 'claude', launchCommand: profile, customResume: { mode: 'reported', initialTemplate: '{command}', resumeTemplate: 'my-resume {sessionId}' } })).toContain('custom resume command');
    expect(reason({ agent: 'claude', launchCommand: profile, customResume: { mode: 'generated', initialTemplate: '{command} --id {sessionId}', resumeTemplate: '{command} --resume {sessionId}' } })).toContain('custom resume command');
    expect(reason({ agent: 'claude', launchCommand: 'my-wrapper claude' })).toContain('my-wrapper claude');
    expect(reason({ agent: 'claude', launchCommand: 'claude --model opus' })).toContain('claude --model opus');
    expect(reason({ agent: 'claude', launchCommand: 'claude', runtime: 'wsl' })).toContain('WSL');
    expect(reason({ agent: 'claude', launchCommand: 'claude', resume: 'abc' })).toContain('terminal conversation');
    expect(reason({ agent: 'claude', launchCommand: 'claude', promoted: true })).toContain('terminal conversation');
    expect(reason({ agent: 'aider' })).toContain("don't run aider");
    expect(sessionChatLaunch({ agent: 'cursor', launchCommand: 'cursor-agent --force --trust' })).toEqual({ launch: { kind: 'agent', fullAccess: true } });
  });
});

describe('the chat launch for a terminal agent tab being switched to chat', () => {
  it('keeps the agent, its skip-approvals mode, or its Agent Farm profile', () => {
    expect(chatLaunchForTerminal('claude --dangerously-skip-permissions', 'claude')).toEqual({ launch: { kind: 'agent', mode: 'bypassPermissions' } });
    expect(chatLaunchForTerminal('agent-farm run greenfield/orchestrator --arg docs=grain', 'claude')).toEqual({ launch: { kind: 'profile', profile: 'greenfield/orchestrator', args: { docs: 'grain' } } });
  });
  it('carries a --model flag over as the chat\'s model setting', () => {
    expect(chatLaunchForTerminal('claude --model opus --dangerously-skip-permissions', 'claude')).toEqual({ launch: { kind: 'agent', mode: 'bypassPermissions' }, settings: { model: 'opus' } });
    expect(chatLaunchForTerminal('codex --model=gpt-5.5', 'codex')).toEqual({ launch: { kind: 'agent' }, settings: { model: 'gpt-5.5' } });
  });
  it('runs the plain agent when the terminal saved no launch command', () => {
    expect(chatLaunchForTerminal(undefined, 'codex')).toEqual({ launch: { kind: 'agent' } });
  });
  it('names what a chat tab cannot run, instead of switching to a different launch', () => {
    expect(chatLaunchForTerminal('claude --dangerously-skip-permissions --verbose', 'claude')).toEqual({ unsupported: '--verbose' });
    expect(chatLaunchForTerminal('agent-farm run greenfield/orchestrator --reasoning high --arg docs=grain', 'claude')).toEqual({ unsupported: '--reasoning' });
    expect(chatLaunchForTerminal('my-wrapper claude', 'claude')).toEqual({ unsupported: 'my-wrapper' });
  });
});

describe('Session folder access in a switched Session Pane chat (D-161)', () => {
  const folder = '/Users/me/.pane/sessions/s-1';
  const sessionPaneCommand = withSessionFolderAccess({ title: 'Claude Code', command: agentTerminalCommand('claude'), agent: 'claude' }, folder, 'darwin').command;

  it.skipIf(process.platform === 'win32')('switches the launch Pane gives Claude in a Session\'s Pane, dropping only its own Session folder settings', () => {
    expect(sessionPaneCommand).toContain('--settings');
    expect(chatLaunchForTerminal(sessionPaneCommand, 'claude', { sessionFolder: folder })).toEqual({ launch: { kind: 'agent', mode: 'bypassPermissions' } });
  });

  it.skipIf(process.platform === 'win32')('still refuses --settings that are not Pane\'s own for that folder', () => {
    expect(chatLaunchForTerminal(sessionPaneCommand, 'claude', { sessionFolder: '/somewhere/else' })).toEqual({ unsupported: '--settings' });
    expect(chatLaunchForTerminal('claude --settings \'{"model":"opus"}\'', 'claude', { sessionFolder: folder })).toEqual({ unsupported: '--settings' });
  });

  it('gives the chat the same read-only Session folder access the terminal had', () => {
    expect(sessionFolderMeta({ agent: 'claude', cwd: '/work/pane', sessionFolder: folder }, 'darwin')).toEqual({
      claudeCode: { options: { settings: { permissions: { additionalDirectories: [folder], deny: [`Edit(/${folder}/**)`] } } } },
    });
  });

  it('adds none for a Session orchestrator, which works in its own folder, for Codex, or on Windows', () => {
    expect(sessionFolderMeta({ agent: 'claude', cwd: folder, sessionFolder: folder }, 'darwin')).toBeUndefined();
    expect(sessionFolderMeta({ agent: 'codex', cwd: '/work/pane', sessionFolder: folder }, 'darwin')).toBeUndefined();
    expect(sessionFolderMeta({ agent: 'claude', cwd: '/work/pane', sessionFolder: folder }, 'win32')).toBeUndefined();
    expect(sessionFolderMeta({ agent: 'claude', cwd: '/work/pane' }, 'darwin')).toBeUndefined();
  });
});

describe('the environment a chat tab agent starts with', () => {
  const panel: ToolPanel = { id: 'p-1', sessionId: 's-1', type: 'chat', title: 'Claude', state: { isActive: true }, metadata: { createdAt: '', lastActiveAt: '', position: 0 } };
  const runtime = () => setPaneRuntime({ eventSink: { send: () => undefined }, getConfigManager: () => new ConfigManager(), getPtyHostRuntime: () => null, getWebviewContextMap: () => new Map() });
  afterEach(() => resetPaneRuntimeForTests());

  it('carries the project\'s variables, with Pane\'s own winning', () => {
    runtime();
    const env = chatTabEnv(panel, { agent: 'claude', launch: { kind: 'agent' }, cwd: '/work/tree', status: 'starting' }, { API_BASE: 'https://staging.example', PANE_SESSION_ID: 'from-project' });
    expect(env.API_BASE).toBe('https://staging.example');
    expect(env.PANE_SESSION_ID).toBe('s-1');
  });

  it('keeps git from finding a repository above a Session orchestrator\'s folder', () => {
    runtime();
    const folder = path.join(getAppDirectory(), 'sessions', 'o-1');
    const env = chatTabEnv(panel, { agent: 'claude', launch: { kind: 'agent' }, cwd: folder, status: 'starting', orchestrationSessionId: 'o-1' });
    expect(env.GIT_CEILING_DIRECTORIES).toBe(path.dirname(folder));
    expect(env.PANE_ORCHESTRATION_SESSION_ID).toBe('o-1');
  });
  // T-110 (D-4): an agent-farm command the agent runs reads the Session's snapshot; a lead's follows its launch's after a Reload.
  it('exports the tab\'s Agent Farm snapshot with Profiles on, the launch\'s first', () => {
    runtime();
    try {
      readProfilesSwitchFrom(() => ({ sessionProfilesEnabled: true }));
      expect(chatTabEnv(panel, { agent: 'claude', launch: { kind: 'agent' }, cwd: '/w', status: 'starting', agentFarmSnapshot: '/s/.agent-farm/snapshots/d1' }).AGENT_FARM_SNAPSHOT).toBe('/s/.agent-farm/snapshots/d1');
      expect(chatTabEnv(panel, { agent: 'claude', launch: { kind: 'profile', profile: 'greenfield/orchestrator', snapshot: '/s/.agent-farm/snapshots/d2' }, cwd: '/w', status: 'starting', agentFarmSnapshot: '/s/.agent-farm/snapshots/d1' }).AGENT_FARM_SNAPSHOT).toBe('/s/.agent-farm/snapshots/d2');
      readProfilesSwitchFrom(() => undefined);
      expect(chatTabEnv(panel, { agent: 'claude', launch: { kind: 'agent' }, cwd: '/w', status: 'starting', agentFarmSnapshot: '/s/.agent-farm/snapshots/d1' }).AGENT_FARM_SNAPSHOT).toBe(process.env.AGENT_FARM_SNAPSHOT);
    } finally { readProfilesSwitchFrom(() => undefined); }
  });
});
