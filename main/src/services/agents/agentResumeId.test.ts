import { describe, expect, it } from 'vitest';
import { agentConfig, agentResumeIdPattern, isAgentResumeId } from '../../../../shared/agents';

const UUID = '0b6f2a8e-3d6c-4f0a-9a43-6c2a3f0e9d11';

describe('agent resume id shapes', () => {
  it('reads a session flag\'s idPattern first, then resumeIdPattern', () => {
    expect(agentResumeIdPattern('opencode')).toBe(agentConfig('opencode')?.terminal.session?.idPattern);
    expect(agentResumeIdPattern('pi')).toBe(agentConfig('pi')?.terminal.session?.idPattern);
    expect(agentResumeIdPattern('claude')).toBe(agentConfig('claude')?.terminal.resumeIdPattern);
    expect(agentResumeIdPattern('codex')).toBe(agentConfig('codex')?.terminal.resumeIdPattern);
    expect(agentResumeIdPattern('not-an-agent')).toBeUndefined();
    expect(agentResumeIdPattern(undefined)).toBeUndefined();
  });

  it.each(['claude', 'codex'])('accepts only a UUID for %s', agent => {
    expect(isAgentResumeId(agent, UUID)).toBe(true);
    expect(isAgentResumeId(agent, UUID.toUpperCase())).toBe(true);
    expect(isAgentResumeId(agent, '019a0000-0000-7000-8000-000000000000')).toBe(true);
    for (const id of ['', 'thread-1', `${UUID} `, `${UUID}\n`, `${UUID}$(x)`, `x$(Remove-Item ~)`, '`id`', `'${UUID}'`, `"${UUID}"`, null, undefined]) {
      expect(isAgentResumeId(agent, id)).toBe(false);
    }
  });

  it('accepts only ses_ ids for OpenCode', () => {
    expect(isAgentResumeId('opencode', 'ses_abc123')).toBe(true);
    expect(isAgentResumeId('opencode', UUID)).toBe(false);
    expect(isAgentResumeId('opencode', 'ses_$(x)')).toBe(false);
  });
});
