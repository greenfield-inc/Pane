import { describe, expect, it } from 'vitest';
import { chatLaunchFromCommand } from './launch';

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
