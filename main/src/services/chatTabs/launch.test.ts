import { describe, expect, it } from 'vitest';
import { chatLaunchFromCommand, sessionChatLaunch } from './launch';
import { AGENT_FARM_RESUME } from '../../../../shared/types/customCommandResume';

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
    expect(reason({ agent: 'cursor' })).toContain('Claude and Codex');
  });
});
