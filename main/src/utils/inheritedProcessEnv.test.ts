import { describe, expect, it } from 'vitest';
import { inheritedProcessEnv } from './inheritedProcessEnv';

describe('inheritedProcessEnv', () => {
  it('drops parent Claude Code session markers and undefined values', () => {
    const env = inheritedProcessEnv({
      PATH: '/usr/bin',
      CLAUDECODE: '1',
      CLAUDE_PID: '1234',
      CLAUDE_CODE_SESSION_ID: 'parent-session',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_MESSAGING_SOCKET: '\\\\.\\pipe\\LOCAL\\cc-msg',
      CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
      UNSET: undefined,
    });
    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it('keeps user Claude Code configuration and color preferences', () => {
    const env = inheritedProcessEnv({
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe',
      NO_COLOR: '1',
    });
    expect(env).toEqual({
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe',
      NO_COLOR: '1',
    });
  });
});
