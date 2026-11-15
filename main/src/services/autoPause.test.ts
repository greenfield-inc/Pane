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
    shownPaneId: () => 'focused',
    heldByUpdate: panel => panel.id === 'updating:1',
    pause: async (paneId, mark) => { pausedCalls.push({ paneId, mark }); return { paused: [`${paneId}:1`], failed: [] }; },
    chatRunning: () => true,
    pauseChats: async panelIds => ({ paused: panelIds, failed: [] }),
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

describe('auto-pause of chat tabs', () => {
  const MINUTE = 60 * 1000;
  function chat(id: string, lastActiveAt = new Date(START).toISOString()): ToolPanel {
    return { id, sessionId: id.split(':')[0], type: 'chat', title: id, state: { isActive: false }, metadata: { createdAt: '2026-11-01T00:00:00.000Z', lastActiveAt, position: 0 } };
  }

  function chats(overrides: Partial<AutoPauseDependencies> = {}) {
    const paused: string[][] = [];
    const panes: AutoPausePane[] = ['work', 'shown', 'archived'].map(id => ({ id, createdAt: new Date(START), archived: id === 'archived' }));
    const panels = new Map<string, ToolPanel[]>([
      ['work', [chat('work:idle'), chat('work:selected', new Date(START + 20 * MINUTE).toISOString()), chat('work:talking'), chat('work:asking'), chat('work:carded'), chat('work:released')]],
      ['shown', [chat('shown:idle')]],
      ['archived', [chat('archived:idle')]],
    ]);
    const { deps, advance } = world({
      panes: () => panes,
      panels: paneId => panels.get(paneId) ?? [],
      // The Pane on screen in a window the person has left for another app.
      focusedPaneId: () => undefined,
      shownPaneId: () => 'shown',
      liveActivity: panelId => panelId === 'work:talking' ? new Date(START + 25 * MINUTE) : undefined,
      agentState: panelId => panelId === 'work:asking' ? 'blocked' : 'idle',
      // A card the agent posted and ended its turn on: the tab reads idle, but the person owes an answer.
      hasOpenNotify: panelIds => panelIds.includes('work:carded'),
      chatRunning: panelId => panelId !== 'work:released',
      pauseChats: async (panelIds) => { paused.push(panelIds); return { paused: panelIds, failed: [] }; },
      ...overrides,
    });
    return { deps, advance, paused };
  }

  it('stops chat agents idle for 30 minutes, skipping the Pane on screen in an unfocused window, archived Panes, and chats waiting on the person', async () => {
    const { deps, advance, paused } = chats();
    advance(29 * MINUTE);
    await new AutoPauser(deps).sweep();
    expect(paused).toEqual([]);
    advance(2 * MINUTE);
    await new AutoPauser(deps).sweep();
    expect(paused).toEqual([['work:idle']]);
    // Selecting a chat tab or its agent's own activity counts as use.
    advance(30 * MINUTE);
    await new AutoPauser(deps).sweep();
    expect(paused.at(-1)).toEqual(['work:idle', 'work:selected', 'work:talking']);
  });

  it('uses the chat setting apart from the Pane hours, and stops nothing when auto-pause is off', async () => {
    const custom = chats({ settings: () => ({ enabled: true, hours: 48, chatMinutes: 90 }) });
    custom.advance(60 * MINUTE);
    await new AutoPauser(custom.deps).sweep();
    expect(custom.paused).toEqual([]);
    custom.advance(31 * MINUTE);
    await new AutoPauser(custom.deps).sweep();
    expect(custom.paused.at(-1)).toContain('work:idle');

    const off = chats({ settings: () => ({ enabled: false, chatMinutes: 30 }) });
    off.advance(120 * MINUTE);
    await new AutoPauser(off.deps).sweep();
    expect(off.paused).toEqual([]);
  });
});
