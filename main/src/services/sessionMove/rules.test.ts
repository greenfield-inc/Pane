import { describe, expect, it } from 'vitest';
import { agentFarmProfileOf, movedLine, heldBackChecks } from './rules';
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

describe('heldBackChecks', () => {
  const tab = (queued: number, running: boolean) => ({ panelId: 'p1', title: 'Chat', running, queued });

  it('blocks a Session with open approvals, which the target\'s Notify would not show (F-9)', () => {
    expect(heldBackChecks(2, [], false)).toEqual([expect.objectContaining({ id: 'approvals', level: 'block', title: '2 open approvals in this Session' })]);
  });

  it('blocks queued chat messages that would not send before the tab stops (F-5)', () => {
    expect(heldBackChecks(0, [tab(1, true)], false)).toEqual([]);
    expect(heldBackChecks(0, [tab(1, false)], false)).toEqual([expect.objectContaining({ id: 'queue:p1', level: 'block' })]);
    // Once every tab stopped (Stop now), even a running tab's queue stays behind.
    expect(heldBackChecks(0, [tab(3, true)], true)).toEqual([expect.objectContaining({ title: '3 messages waiting in Chat' })]);
    expect(heldBackChecks(0, [tab(0, false)], true)).toEqual([]);
  });
});
