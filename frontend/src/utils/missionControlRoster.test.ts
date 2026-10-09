import { describe, expect, it } from 'vitest';
import type { AgentState } from '../../../shared/types/agentStatus';
import type {
  MissionControlAgentPanel,
  MissionControlSnapshot,
  MissionControlTileModel,
} from '../../../shared/types/missionControl';
import {
  createRequestGate,
  pruneSelection,
  pruneSnapshots,
  reconcileTileModels,
} from './missionControlRoster';

function agent(panelId: string, overrides: Partial<MissionControlAgentPanel> = {}): MissionControlAgentPanel {
  return {
    panelId,
    sessionId: `session-${panelId}`,
    sessionName: `Session ${panelId}`,
    projectId: 1,
    projectName: 'Pane',
    worktreePath: null,
    worktreeName: null,
    panelTitle: 'Claude',
    agentType: 'claude',
    isPermanent: false,
    isLive: true,
    ...overrides,
  };
}

function snapshot(panelId: string, text: string): MissionControlSnapshot {
  return { panelId, text, lastActivityAt: '2026-01-01T00:00:00.000Z', cols: 80, rows: 24 };
}

describe('reconcileTileModels', () => {
  it('keeps the identity of every tile whose snapshot did not move', () => {
    const agents = [agent('a'), agent('b'), agent('c')];
    const status = { a: 'working', b: 'working', c: 'blocked' } satisfies Record<string, AgentState>;
    const first = { a: snapshot('a', 'one'), b: snapshot('b', 'two'), c: snapshot('c', 'three') };

    const before = reconcileTileModels([], agents, status, first);
    // One agent printed a line; the poll preserves the other two objects.
    const after = reconcileTileModels(before, agents, status, { ...first, a: snapshot('a', 'one and a half') });

    expect(after[0]).not.toBe(before[0]);
    // The point of the whole helper: the other sixty-odd tiles do not re-render
    // because one of them produced output.
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toBe(before[2]);
  });

  it('rebuilds the tile whose agent state changed and no others', () => {
    const agents = [agent('a'), agent('b')];
    const snapshots = { a: snapshot('a', 'one'), b: snapshot('b', 'two') };

    const before = reconcileTileModels([], agents, { a: 'working', b: 'working' }, snapshots);
    const after = reconcileTileModels(before, agents, { a: 'working', b: 'blocked' }, snapshots);

    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[1].agentState).toBe('blocked');
  });

  it('rebuilds a tile whose roster row was renamed', () => {
    const snapshots = { a: snapshot('a', 'one') };
    const before = reconcileTileModels([], [agent('a')], { a: 'idle' }, snapshots);
    const after = reconcileTileModels(before, [agent('a', { sessionName: 'Renamed' })], { a: 'idle' }, snapshots);

    expect(after[0]).not.toBe(before[0]);
    expect(after[0].sessionName).toBe('Renamed');
  });

  it('drops a tile whose panel left the roster', () => {
    const snapshots = { a: snapshot('a', 'one'), b: snapshot('b', 'two') };
    const before = reconcileTileModels([], [agent('a'), agent('b')], {}, snapshots);
    const after = reconcileTileModels(before, [agent('a')], {}, snapshots);

    expect(after.map(tile => tile.panelId)).toEqual(['a']);
  });

  it('reports an agent with no status yet rather than guessing at one', () => {
    const [tile] = reconcileTileModels([], [agent('a')], {}, {});
    expect(tile.agentState).toBe('unknown');
    expect(tile.snapshot).toBeNull();
  });
});

describe('pruneSelection', () => {
  const roster = new Set(['a', 'b']);

  it('lets go of a focused pane deleted from somewhere else', () => {
    // The pane the user was typing into was deleted through RunPane. The
    // keyboard, the live terminal and the cursor all have to come back.
    const pruned = pruneSelection({
      focusedPanelId: 'gone',
      liveTileId: 'gone',
      selectedPanelId: 'gone',
      pendingClosePanelId: null,
    }, roster);

    expect(pruned).toEqual({
      focusedPanelId: null,
      liveTileId: null,
      selectedPanelId: null,
      pendingClosePanelId: null,
    });
  });

  it('closes a confirmation asking about a pane that is already gone', () => {
    // Confirming it would call deletePanel on a panel id main no longer knows,
    // and the dialog would fail in place of doing nothing.
    const pruned = pruneSelection({
      focusedPanelId: null,
      liveTileId: null,
      selectedPanelId: null,
      pendingClosePanelId: 'gone',
    }, roster);

    expect(pruned.pendingClosePanelId).toBeNull();
  });

  it('forgets only what left, when a whole session is archived', () => {
    const pruned = pruneSelection({
      focusedPanelId: 'a',
      liveTileId: 'archived-1',
      selectedPanelId: 'archived-2',
      pendingClosePanelId: 'b',
    }, roster);

    expect(pruned).toEqual({
      focusedPanelId: 'a',
      liveTileId: null,
      selectedPanelId: null,
      pendingClosePanelId: 'b',
    });
  });

  it('returns the same object when nothing left, so no render is scheduled', () => {
    const selection = {
      focusedPanelId: 'a',
      liveTileId: 'b',
      selectedPanelId: 'a',
      pendingClosePanelId: null,
    };
    expect(pruneSelection(selection, roster)).toBe(selection);
  });
});

describe('pruneSnapshots', () => {
  it('drops the snapshot of a panel that left the roster', () => {
    const snapshots = { a: snapshot('a', 'one'), gone: snapshot('gone', 'stale') };
    expect(Object.keys(pruneSnapshots(snapshots, new Set(['a'])))).toEqual(['a']);
  });

  it('returns the same object when every snapshot still belongs', () => {
    const snapshots = { a: snapshot('a', 'one') };
    expect(pruneSnapshots(snapshots, new Set(['a', 'b']))).toBe(snapshots);
  });
});

describe('createRequestGate', () => {
  it('ignores an older roster that lands after a newer one', async () => {
    const gate = createRequestGate();
    const applied: string[] = [];

    // Two loads in flight: a status transition started A, the refresh button
    // started B. Over a remote daemon B can easily come back first.
    const first = gate.start();
    const second = gate.start();

    const slowA = new Promise<string>(resolve => setTimeout(() => resolve('stale roster'), 5));
    const fastB = Promise.resolve('current roster');

    const b = await fastB;
    if (second()) applied.push(b);
    const a = await slowA;
    if (first()) applied.push(a);

    expect(applied).toEqual(['current roster']);
  });

  it('lets a request that is still the newest apply', async () => {
    const gate = createRequestGate();
    const isCurrent = gate.start();
    await Promise.resolve();
    expect(isCurrent()).toBe(true);
  });

  it('drops everything in flight once the view is gone', () => {
    const gate = createRequestGate();
    const isCurrent = gate.start();
    gate.abandon();
    expect(isCurrent()).toBe(false);
  });
});

describe('tile model shape', () => {
  it('carries the roster row through unchanged', () => {
    const [tile]: MissionControlTileModel[] = reconcileTileModels(
      [], [agent('a', { worktreeName: 'feature/x' })], { a: 'blocked' }, { a: snapshot('a', 'hi') },
    );
    expect(tile.worktreeName).toBe('feature/x');
    expect(tile.agentState).toBe('blocked');
    expect(tile.snapshot?.text).toBe('hi');
  });
});
