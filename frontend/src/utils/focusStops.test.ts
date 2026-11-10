import { describe, expect, it } from 'vitest';
import { cycleOrder, stepStop, stopInDirection, type FocusStop, type FocusStopKind } from './focusStops';

function stop(id: string, kind: FocusStopKind, left: number, top: number, right: number, bottom: number, preferred = false): FocusStop<string> {
  return { id, kind, rect: { left, top, right, bottom }, preferred, ref: id };
}

// The round-2 layout: sidebar | split 1 | split 2 | right panel, terminal under the splits.
const sidebar = stop('sidebar', 'sidebar', 0, 0, 352, 900);
const split1 = stop('split-1', 'group', 352, 38, 716, 868);
const split2 = stop('split-2', 'group', 716, 38, 1080, 868);
const right = stop('right', 'right-panel', 1080, 38, 1440, 900);
const terminal = stop('terminal', 'terminal', 352, 868, 1080, 1100);
const window = [sidebar, split1, split2, right, terminal];

describe('stopInDirection', () => {
  it('jumps right from the sidebar through both splits to the right panel', () => {
    expect(stopInDirection(window, sidebar, 'right')?.id).toBe('split-1');
    expect(stopInDirection(window, split1, 'right')?.id).toBe('split-2');
    expect(stopInDirection(window, split2, 'right')?.id).toBe('right');
    expect(stopInDirection(window, right, 'right')).toBeNull();
  });

  it('walks back left into the sidebar', () => {
    expect(stopInDirection(window, right, 'left')?.id).toBe('split-2');
    expect(stopInDirection(window, split2, 'left')?.id).toBe('split-1');
    expect(stopInDirection(window, split1, 'left')?.id).toBe('sidebar');
    expect(stopInDirection(window, sidebar, 'left')).toBeNull();
  });

  it('reaches the terminal below a split and comes back up to the last focused one', () => {
    expect(stopInDirection(window, split2, 'down')?.id).toBe('terminal');
    const remembered = window.map(candidate => candidate.id === 'split-2' ? { ...candidate, preferred: true } : candidate);
    expect(stopInDirection(remembered, terminal, 'up')?.id).toBe('split-2');
  });

  it('prefers the last focused group when stacked groups tie at an edge', () => {
    const top = stop('top', 'group', 352, 38, 1080, 450);
    const bottom = stop('bottom', 'group', 352, 450, 1080, 868, true);
    expect(stopInDirection([sidebar, top, bottom], sidebar, 'right')?.id).toBe('bottom');
    expect(stopInDirection([sidebar, top, { ...bottom, preferred: false }], sidebar, 'right')?.id).toBe('top');
  });

  it('ignores stops that share no span with the current one', () => {
    const lowRight = stop('low', 'group', 800, 600, 900, 700);
    const highLeft = stop('high', 'group', 0, 0, 100, 100);
    expect(stopInDirection([highLeft, lowRight], highLeft, 'right')).toBeNull();
  });
});

describe('F6 order', () => {
  it('cycles the sidebar, the splits in reading order, the right panel and the terminal', () => {
    expect(cycleOrder([terminal, right, split2, sidebar, split1]).map(candidate => candidate.id))
      .toEqual(['sidebar', 'split-1', 'split-2', 'right', 'terminal']);
  });

  it('wraps in both directions and starts from the ends when nothing is focused', () => {
    expect(stepStop(window, 'terminal', 1)?.id).toBe('sidebar');
    expect(stepStop(window, 'sidebar', -1)?.id).toBe('terminal');
    expect(stepStop(window, null, 1)?.id).toBe('sidebar');
    expect(stepStop(window, null, -1)?.id).toBe('terminal');
  });
});
