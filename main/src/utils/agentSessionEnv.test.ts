import { describe, it, expect } from 'vitest';
import { stripInheritedAgentSession } from './agentSessionEnv';

/**
 * Guards the resume path. If a parent agent's session markers reach a spawned
 * terminal, Claude Code stops writing its transcript, and the next app start
 * fails with "No conversation found with session ID".
 */
describe('stripInheritedAgentSession', () => {
  it('removes the markers that disable transcript persistence', () => {
    const spawned = stripInheritedAgentSession({
      PATH: '/usr/bin',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'abc-123',
    });

    expect(spawned).not.toHaveProperty('CLAUDE_CODE_CHILD_SESSION');
    expect(spawned).not.toHaveProperty('CLAUDE_CODE_SESSION_ID');
    expect(spawned.PATH).toBe('/usr/bin');
  });

  it('keeps everything the agent legitimately needs', () => {
    const parent = {
      PATH: '/usr/bin',
      HOME: '/home/dev',
      SHELL: '/bin/bash',
      LANG: 'en_US.UTF-8',
      CLAUDE_CODE_EXECPATH: '/usr/local/bin/claude',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      PANE_SESSION_ID: 'pane-1',
    };

    expect(stripInheritedAgentSession(parent)).toEqual(parent);
  });

  it('drops undefined values, which the pty host cannot carry', () => {
    expect(stripInheritedAgentSession({ SET: 'yes', UNSET: undefined })).toEqual({ SET: 'yes' });
  });

  it('is a copy, leaving the source environment untouched', () => {
    const parent = { PATH: '/usr/bin', CLAUDE_CODE_CHILD_SESSION: '1' };
    stripInheritedAgentSession(parent);
    expect(parent.CLAUDE_CODE_CHILD_SESSION).toBe('1');
  });

  it('removes each inherited session marker independently', () => {
    for (const marker of ['CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID']) {
      expect(stripInheritedAgentSession({ [marker]: 'set' })).not.toHaveProperty(marker);
    }
  });
});
