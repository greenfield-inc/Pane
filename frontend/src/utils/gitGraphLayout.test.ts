import { describe, it, expect } from 'vitest';
import { computeGitGraphLayout } from './gitGraphLayout';
import type { GitGraphNode } from '../../../shared/types/gitGraph';

function node(hash: string, parents: string[]): GitGraphNode {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents,
    subject: `commit ${hash}`,
    authorName: 'Test',
    authorEmail: 'test@example.com',
    authorDate: '2026-01-01T00:00:00Z',
    refs: [],
  };
}

describe('computeGitGraphLayout', () => {
  it('returns an empty layout for no commits', () => {
    expect(computeGitGraphLayout([])).toEqual({ rows: [], laneCount: 0 });
  });

  it('keeps a linear history in a single lane', () => {
    const layout = computeGitGraphLayout([
      node('c', ['b']),
      node('b', ['a']),
      node('a', []),
    ]);

    expect(layout.laneCount).toBe(1);
    expect(layout.rows.map(row => row.lane)).toEqual([0, 0, 0]);
    expect(layout.rows.every(row => row.colorIndex === 0)).toBe(true);
  });

  it('gives a root commit no outgoing edges', () => {
    const layout = computeGitGraphLayout([node('a', [])]);
    expect(layout.rows[0].edges).toEqual([]);
  });

  it('opens a second lane for a merge and rejoins it', () => {
    // m merges feature (f) into main (b); both descend from a.
    const layout = computeGitGraphLayout([
      node('m', ['b', 'f']),
      node('f', ['a']),
      node('b', ['a']),
      node('a', []),
    ]);

    expect(layout.laneCount).toBe(2);
    expect(layout.rows[0].lane).toBe(0);

    const mergeEdge = layout.rows[0].edges.find(edge => edge.kind === 'merge');
    expect(mergeEdge).toBeDefined();
    expect(mergeEdge?.fromLane).toBe(0);
    expect(mergeEdge?.toLane).toBe(1);

    // Both sides converge on `a`, which must occupy a single lane — and the
    // side that ends there is drawn joining it rather than stopping mid-air.
    const rootRow = layout.rows[3];
    expect(rootRow.node.hash).toBe('a');
    expect(rootRow.edges).toEqual([
      { fromLane: 1, toLane: 0, kind: 'join', colorIndex: 1 },
    ]);
  });

  it('handles an octopus merge with three parents', () => {
    const layout = computeGitGraphLayout([
      node('m', ['p1', 'p2', 'p3']),
      node('p1', []),
      node('p2', []),
      node('p3', []),
    ]);

    const mergeEdges = layout.rows[0].edges.filter(edge => edge.kind === 'merge');
    expect(mergeEdges).toHaveLength(2);
    expect(mergeEdges.map(edge => edge.toLane).sort()).toEqual([1, 2]);
    expect(layout.laneCount).toBe(3);
  });

  it('places two unrelated roots in separate lanes', () => {
    const layout = computeGitGraphLayout([
      node('x', []),
      node('y', []),
    ]);

    expect(layout.rows[0].lane).toBe(0);
    // The first root frees lane 0 immediately, so the second reuses it.
    expect(layout.rows[1].lane).toBe(0);
    expect(layout.laneCount).toBe(1);
  });

  it('flags edges whose parent falls outside the loaded window', () => {
    const layout = computeGitGraphLayout([node('c', ['older-than-limit'])]);

    expect(layout.rows[0].edges).toHaveLength(1);
    expect(layout.rows[0].edges[0].danglesBelow).toBe(true);
  });

  it('does not flag edges whose parent is loaded', () => {
    const layout = computeGitGraphLayout([node('c', ['b']), node('b', [])]);
    expect(layout.rows[0].edges[0].danglesBelow).toBeUndefined();
  });

  it('carries an unrelated in-flight branch through intervening rows', () => {
    // `side` stays pending while the mainline advances, so rows between the
    // branch tip and its parent must draw a pass-through edge for it.
    const layout = computeGitGraphLayout([
      node('side', ['old']),
      node('c', ['b']),
      node('b', ['old']),
      node('old', []),
    ]);

    // The mainline leaves the dot; the unrelated branch crosses the whole row.
    expect(layout.rows[1].edges.filter(edge => edge.kind === 'straight')).toHaveLength(1);
    expect(layout.rows[1].edges.filter(edge => edge.kind === 'passthrough')).toHaveLength(1);
    expect(layout.laneCount).toBeGreaterThanOrEqual(2);
  });

  /**
   * A pass-through drawn as `straight` starts at the dot, half a row down,
   * which is what left continuing branches looking like dashed lines.
   */
  it('spans crossing lanes with pass-through edges, never straight ones', () => {
    const layout = computeGitGraphLayout([
      node('side', ['old']),
      node('c', ['b']),
      node('b', ['old']),
      node('old', []),
    ]);

    for (const row of layout.rows) {
      for (const edge of row.edges) {
        // A straight edge always belongs to the row's own commit.
        if (edge.kind === 'straight') expect(edge.fromLane).toBe(row.lane);
      }
    }
  });

  it('marks the newest commit of a branch as its start', () => {
    const layout = computeGitGraphLayout([
      node('side', ['old']),
      node('c', ['b']),
      node('b', ['old']),
      node('old', []),
    ]);

    // Nothing above points at `side` or at `c`; `b` and `old` are parents.
    expect(layout.rows.map(row => row.isBranchTip)).toEqual([true, true, false, false]);
  });

  it('joins a branch that ends at a shared ancestor instead of dropping it', () => {
    // Both `a` and `b` have `r` as parent, so one lane must visibly end at it.
    const layout = computeGitGraphLayout([
      node('m', ['a', 'b']),
      node('a', ['r']),
      node('b', ['r']),
      node('r', []),
    ]);

    const rootRow = layout.rows[3];
    expect(rootRow.node.hash).toBe('r');

    const joins = rootRow.edges.filter(edge => edge.kind === 'join');
    expect(joins).toHaveLength(1);
    expect(joins[0].toLane).toBe(rootRow.lane);
    expect(joins[0].fromLane).not.toBe(rootRow.lane);
  });

  it('never assigns a lane index at or beyond laneCount', () => {
    const layout = computeGitGraphLayout([
      node('m', ['a', 'b']),
      node('a', ['r']),
      node('b', ['r']),
      node('r', []),
    ]);

    for (const row of layout.rows) {
      expect(row.lane).toBeLessThan(layout.laneCount);
      for (const edge of row.edges) {
        expect(edge.fromLane).toBeLessThan(layout.laneCount);
        expect(edge.toLane).toBeLessThan(layout.laneCount);
      }
    }
  });
});
