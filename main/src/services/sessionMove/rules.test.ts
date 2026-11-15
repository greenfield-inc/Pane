import { describe, expect, it } from 'vitest';
import { agentFarmProfileOf, movedLine } from './rules';
import { buildPathMap } from './pathMap';

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
