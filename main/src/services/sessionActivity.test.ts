import { describe, expect, it } from 'vitest';
import { SessionActivityRollup, type SessionActivityMembers } from './sessionActivity';

const session = (overrides: Partial<SessionActivityMembers> = {}): SessionActivityMembers => ({
  sessionId: 's1',
  orchestratorPanelIds: ['orch'],
  panes: [{ paneId: 'pane-a', panelIds: ['a1', 'a2'] }, { paneId: 'pane-b', panelIds: ['b1'] }],
  ...overrides,
});

/** Drive the rollup every 500 ms, as the host's tick does, from `from` to `to` inclusive. */
function run(rollup: SessionActivityRollup, members: SessionActivityMembers[], midTurn: Set<string>, from: number, to: number) {
  const changes: Array<{ at: number; sessionId: string; state: string; workingPanes: number }> = [];
  for (let now = from; now <= to; now += 500) {
    for (const change of rollup.update(members, panelId => midTurn.has(panelId), now)) changes.push({ at: now, ...change });
  }
  return changes;
}

describe('SessionActivityRollup', () => {
  it('never spins for a turn shorter than 10 s', () => {
    const rollup = new SessionActivityRollup();
    const members = [session()];
    expect(run(rollup, members, new Set(['orch']), 0, 4_000)).toEqual([]);
    expect(run(rollup, members, new Set(), 4_500, 30_000)).toEqual([]);
    expect(rollup.snapshot()).toEqual([{ sessionId: 's1', state: 'idle', workingPanes: 0 }]);
  });

  it('turns working 10 s into a turn and idle 10 s after it ends, with exactly two changes', () => {
    const rollup = new SessionActivityRollup();
    const members = [session()];
    const during = run(rollup, members, new Set(['orch']), 0, 40_000);
    const after = run(rollup, members, new Set(), 40_500, 70_000);
    expect([...during, ...after]).toEqual([
      { at: 10_000, sessionId: 's1', state: 'working', workingPanes: 0 },
      { at: 50_000, sessionId: 's1', state: 'idle', workingPanes: 0 },
    ]);
  });

  it('needs 10 s without a break: back-to-back short turns never spin', () => {
    const rollup = new SessionActivityRollup();
    const members = [session()];
    const changes = [];
    for (let start = 0; start < 60_000; start += 6_000) {
      changes.push(...run(rollup, members, new Set(['a1']), start, start + 4_000));
      changes.push(...run(rollup, members, new Set(), start + 4_500, start + 5_500));
    }
    expect(changes).toEqual([]);
  });

  it('stays working through short gaps once working', () => {
    const rollup = new SessionActivityRollup();
    const members = [session()];
    run(rollup, members, new Set(['a1']), 0, 12_000);
    expect(run(rollup, members, new Set(), 12_500, 20_000)).toEqual([]);
    expect(run(rollup, members, new Set(['a1']), 20_500, 25_000)).toEqual([]);
    expect(rollup.snapshot()[0]).toMatchObject({ state: 'working', workingPanes: 1 });
  });

  it('counts the Panes with a working tab, not the tabs, for the "N working" label', () => {
    const rollup = new SessionActivityRollup();
    const changes = run(rollup, [session()], new Set(['a1', 'a2', 'b1']), 0, 10_000);
    expect(changes).toEqual([{ at: 10_000, sessionId: 's1', state: 'working', workingPanes: 2 }]);
  });

  it('reports a change when only the working count changes', () => {
    const rollup = new SessionActivityRollup();
    const members = [session()];
    run(rollup, members, new Set(['a1']), 0, 10_000);
    const changes = run(rollup, members, new Set(['a1', 'b1']), 10_500, 25_000);
    expect(changes).toEqual([{ at: 20_500, sessionId: 's1', state: 'working', workingPanes: 2 }]);
  });

  it('counts only its own members: another Session\'s worker never spins it', () => {
    const rollup = new SessionActivityRollup();
    const a = session({ sessionId: 'A', orchestratorPanelIds: ['orch-a'], panes: [] });
    const b = session({ sessionId: 'B', orchestratorPanelIds: ['orch-b'], panes: [{ paneId: 'pane-b', panelIds: ['b1'] }] });
    const changes = run(rollup, [a, b], new Set(['b1']), 0, 60_000);
    expect(changes).toEqual([{ at: 10_000, sessionId: 'B', state: 'working', workingPanes: 1 }]);
  });

  it('goes idle at once when a working Pane leaves the Session (archived, closed or detached), and never spins for it again', () => {
    const rollup = new SessionActivityRollup();
    run(rollup, [session()], new Set(['a1']), 0, 15_000);
    const without = [session({ panes: [{ paneId: 'pane-b', panelIds: ['b1'] }] })];
    expect(run(rollup, without, new Set(['a1']), 15_500, 60_000)).toEqual([
      { at: 15_500, sessionId: 's1', state: 'idle', workingPanes: 0 },
    ]);
  });

  it('stops counting a closed tab at once', () => {
    const rollup = new SessionActivityRollup();
    run(rollup, [session()], new Set(['a1']), 0, 15_000);
    const closed = [session({ panes: [{ paneId: 'pane-a', panelIds: ['a2'] }, { paneId: 'pane-b', panelIds: ['b1'] }] })];
    expect(run(rollup, closed, new Set(), 15_500, 30_000)).toEqual([
      { at: 15_500, sessionId: 's1', state: 'idle', workingPanes: 0 },
    ]);
  });

  it('needs one tab mid-turn for 10 s: two tabs taking turns never add up to a spin', () => {
    const rollup = new SessionActivityRollup();
    const members = [session()];
    const changes = [
      ...run(rollup, members, new Set(['a1']), 0, 6_000),
      ...run(rollup, members, new Set(['a2']), 6_500, 12_500),
      ...run(rollup, members, new Set(['a1']), 13_000, 19_000),
    ];
    expect(changes).toEqual([]);
  });

  it('reports a Session that is gone as idle once, and then forgets it', () => {
    const rollup = new SessionActivityRollup();
    run(rollup, [session()], new Set(['orch']), 0, 10_000);
    expect(rollup.update([], () => true, 10_500)).toEqual([{ sessionId: 's1', state: 'idle', workingPanes: 0 }]);
    expect(rollup.snapshot()).toEqual([]);
  });

  it('lists every Session it knows in its baseline, idle ones included', () => {
    const rollup = new SessionActivityRollup();
    rollup.update([session({ sessionId: 'x' }), session({ sessionId: 'y' })], () => false, 0);
    expect(rollup.snapshot().map(item => item.sessionId).sort()).toEqual(['x', 'y']);
  });
});
