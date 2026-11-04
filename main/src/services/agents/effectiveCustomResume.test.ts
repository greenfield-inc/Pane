import { describe, expect, it } from 'vitest';
import {
  AGENT_FARM_RESUME,
  effectiveCustomResume,
  isAgentFarmLaunchCommand,
  type CustomCommandResume,
} from '../../../../shared/types/customCommandResume';

describe('isAgentFarmLaunchCommand', () => {
  it.each([
    'agent-farm run greenfield/implementer',
    'agent-farm agent greenfield/implementer:opus',
    'agent-farm run implementer --message "Read and follow /tmp/prompt.md"',
    "agent-farm run implementer --message 'a && b; c | d'",
    'AGENT_FARM_ARTIFACT_BUNDLE=/tmp/b FOO="x y" agent-farm run implementer',
    '/Users/me/.local/bin/agent-farm run implementer',
    '  agent-farm run implementer --directory ~/repos/app  ',
    'agent-farm run implementer --message "say --resume later"',
  ])('recognizes %s', command => {
    expect(isAgentFarmLaunchCommand(command)).toBe(true);
  });

  it.each([
    undefined,
    '',
    'agent-farm',
    'agent-farm profiles list',
    'agent-farm ui',
    'agent-farm run implementer --resume abc',
    'agent-farm run implementer --resume=abc',
    'agent-farm run implementer && echo done',
    'agent-farm run implementer; echo done',
    'agent-farm run implementer | tee log',
    'agent-farm run implementer > log',
    'agent-farm run implementer &',
    'agent-farm run implementer\necho done',
    'agent-farm run implementer -- exec resume THREAD',
    'agent-farm run implementer --message $(cat prompt.md)',
    'agent-farm run implementer --message "$(cat prompt.md)"',
    'agent-farm run implementer --message `cat prompt.md`',
    'agent-farm run implementer --message "unterminated',
    'npx agent-farm run implementer',
    'pnpm dlx agent-farm run implementer',
    'my-agent-farm run implementer',
    'claude',
    'codex --yolo',
    'echo agent-farm run implementer',
  ])('does not recognize %s', command => {
    expect(isAgentFarmLaunchCommand(command)).toBe(false);
  });
});

describe('effectiveCustomResume', () => {
  const explicit: CustomCommandResume = {
    mode: 'generated',
    initialTemplate: '{command} --session-id {sessionId}',
    resumeTemplate: '{command} --continue {sessionId}',
  };

  it('keeps an explicit config for any command', () => {
    expect(effectiveCustomResume({ initialCommand: 'agent-farm run implementer', customResume: explicit }))
      .toEqual({ config: explicit, source: 'explicit' });
    expect(effectiveCustomResume({ initialCommand: 'my-wrapper', customResume: explicit }))
      .toEqual({ config: explicit, source: 'explicit' });
  });

  it('applies the Agent Farm contract to a recognized command with no config', () => {
    expect(AGENT_FARM_RESUME).toEqual({
      mode: 'reported',
      initialTemplate: '{command}',
      resumeTemplate: '{command} --resume {sessionId}',
    });
    expect(effectiveCustomResume({ initialCommand: 'agent-farm run implementer' }))
      .toEqual({ config: AGENT_FARM_RESUME, source: 'agent-farm' });
    expect(effectiveCustomResume({ initialCommand: 'agent-farm run implementer', customResume: null }))
      .toEqual({ config: AGENT_FARM_RESUME, source: 'agent-farm' });
  });

  it('returns nothing for other commands with no config', () => {
    expect(effectiveCustomResume({ initialCommand: 'my-wrapper run x' })).toBeUndefined();
    expect(effectiveCustomResume({ initialCommand: 'agent-farm run implementer --resume abc' })).toBeUndefined();
    expect(effectiveCustomResume({})).toBeUndefined();
  });
});
