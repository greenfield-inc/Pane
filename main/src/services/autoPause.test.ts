import { describe, expect, it } from 'vitest';
import type { ToolPanel, TerminalPausedMark } from '../../../shared/types/panels';
import type { AgentState } from '../../../shared/types/agentStatus';
import { AutoPauser, type AutoPauseDependencies, type AutoPausePane } from './autoPause';

const HOUR = 60 * 60 * 1000;
const START = Date.parse('2026-11-01T00:00:00.000Z');

function tab(id: string, lastActivityTime: string, paused?: TerminalPausedMark): ToolPanel {
  return {
    id,
    sessionId: id.split(':')[0],
    type: 'terminal',
    title: id,
    state: { isActive: false, customState: { lastActivityTime, paused } },
    metadata: { createdAt: '2026-11-01T00:00:00.000Z', lastActiveAt: '2026-11-01T00:00:00.000Z', position: 0 },
  };
}

function world(overrides: Partial<AutoPauseDependencies> = {}) {
  const started = new Date(START).toISOString();
  const panes: AutoPausePane[] = ['idle', 'focused', 'blocked', 'notify', 'archived', 'session-chat', 'updating', 'typed-recently']
    .map(id => ({ id, createdAt: new Date(START), archived: id === 'archived' }));
  const panels = new Map(panes.map(pane => [pane.id, [tab(`${pane.id}:1`, started)]]));
  const pausedCalls: Array<{ paneId: string; mark: TerminalPausedMark }> = [];
  let now = START;
  const deps: AutoPauseDependencies = {
    now: () => now,
    settings: () => ({ enabled: true, hours: 48 }),
    panes: () => panes,
    panels: paneId => panels.get(paneId) ?? [],
    liveActivity: panelId => panelId === 'typed-recently:1' ? new Date(START + 47 * HOUR) : undefined,
    agentState: (panelId): AgentState | undefined => panelId === 'blocked:1' ? 'blocked' : 'idle',
    hasOpenNotify: panelIds => panelIds.includes('notify:1'),
    focusedPaneId: () => 'focused',
    heldByUpdate: panel => panel.id === 'updating:1',
    pause: async (paneId, mark) => { pausedCalls.push({ paneId, mark }); return { paused: [`${paneId}:1`], failed: [] }; },
    ...overrides,
  };
  return { deps, pausedCalls, panels, advance: (ms: number) => { now += ms; } };
}

describe('auto-pause', () => {
  it('pauses only Panes nobody used for the threshold, skipping focused, waiting, archived and update-held ones', async () => {
    const { deps, pausedCalls, advance } = world();
    const pauser = new AutoPauser(deps);

    advance(47 * HOUR);
    expect(await pauser.sweep()).toEqual([]);

    advance(2 * HOUR);
    expect(await pauser.sweep()).toEqual(['idle', 'session-chat']);
    expect(pausedCalls).toEqual([
      { paneId: 'idle', mark: { at: '2026-11-03T01:00:00.000Z', by: 'auto', idleHours: 48 } },
      { paneId: 'session-chat', mark: { at: '2026-11-03T01:00:00.000Z', by: 'auto', idleHours: 48 } },
    ]);
  });

  it('counts input or output in a running tab as use', async () => {
    const { deps, advance } = world();
    advance(96 * HOUR);
    expect(await new AutoPauser(deps).sweep()).toContain('typed-recently');
    const fresh = world();
    fresh.advance(49 * HOUR);
    expect(await new AutoPauser(fresh.deps).sweep()).not.toContain('typed-recently');
  });

  it('leaves already paused Panes alone and pauses nothing when turned off', async () => {
    const mark: TerminalPausedMark = { at: '2026-11-01T01:00:00.000Z', by: 'manual' };
    const { deps, panels, pausedCalls, advance } = world();
    panels.set('idle', [tab('idle:1', new Date(START).toISOString(), mark)]);
    advance(72 * HOUR);
    expect(await new AutoPauser(deps).sweep()).toEqual(['session-chat']);
    expect(pausedCalls.map(call => call.paneId)).toEqual(['session-chat']);

    const off = world({ settings: () => ({ enabled: false, hours: 48 }) });
    off.advance(72 * HOUR);
    expect(await new AutoPauser(off.deps).sweep()).toEqual([]);
  });

  it('uses the configured hours', async () => {
    const { deps, advance } = world({ settings: () => ({ enabled: true, hours: 2 }), liveActivity: () => undefined });
    advance(3 * HOUR);
    expect(await new AutoPauser(deps).sweep()).toEqual(['idle', 'session-chat', 'typed-recently']);
  });

  it('keeps pausing the other idle Panes when one cannot pause', async () => {
    const { deps, advance } = world({
      pause: async (paneId) => {
        if (paneId === 'idle') throw new Error('state write refused');
        return { paused: [`${paneId}:1`], failed: [] };
      },
    });
    advance(49 * HOUR);
    expect(await new AutoPauser(deps).sweep()).toEqual(['session-chat']);
  });
});
