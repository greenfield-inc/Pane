import { describe, expect, it } from 'vitest';
import { agentFarmProfileOf, movedLine, onlyWatching } from './rules';
import { buildPathMap } from './pathMap';

describe('a tab only waiting in runpane watch counts as idle', () => {
  const table = [
    { pid: 10, ppid: 1, command: 'claude --resume abc' },
    { pid: 11, ppid: 10, command: '/bin/zsh -c runpane watch --session s --until-event --json' },
    { pid: 12, ppid: 11, command: 'node /usr/local/bin/runpane watch --session s --until-event --json' },
    { pid: 20, ppid: 1, command: 'codex' },
    { pid: 21, ppid: 20, command: 'pnpm test' },
  ];

  it('is idle when the agent is running runpane watch', () => {
    expect(onlyWatching(10, table)).toBe(true);
  });

  it('is working when the agent runs anything else', () => {
    expect(onlyWatching(20, table)).toBe(false);
  });
});

describe('agentFarmProfileOf', () => {
  it('reads the profile an Agent Farm tab launches, without its variant', () => {
    expect(agentFarmProfileOf('agent-farm run greenfield/implementer:opus --arg parent=/x')).toBe('greenfield/implementer');
    expect(agentFarmProfileOf('claude --dangerously-skip-permissions')).toBeNull();
  });
});

describe('movedLine', () => {
  it('names both machines and the path map, and asks to restart watches and servers', () => {
    const map = buildPathMap({ sourceHome: '/Users/alice', targetHome: '/Users/robert-b', entries: [] });
    const line = movedLine('studio-a', 'studio-b', map);
    expect(line).toContain('from studio-a to studio-b');
    expect(line).toContain('/Users/alice → /Users/robert-b');
    expect(line).toMatch(/re-arm your runpane watch/);
    expect(line).toMatch(/moved\.json/);
  });
});
