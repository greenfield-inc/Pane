import { describe, expect, it } from 'vitest';

import type { SessionPanelLayout } from '@shared/types/panels';

import { followOpen, focusedTab, openBeside, selectTab, splitFits, splitFromLayout, type SplitState } from './sessionSplit';

const shown = new Set(['chat', 'term', 'page', 'file']);

/** The desktop's terminal on the left and a page on the right, as `panels:get-layout` returns it. */
function desktopSplit(focusedGroupId: string, direction: 'row' | 'column' = 'row'): SessionPanelLayout {
  return {
    version: 1,
    focusedGroupId,
    root: {
      type: 'split', id: 's', direction, sizes: [1, 1],
      children: [
        { type: 'group', id: 'g1', panelIds: ['chat', 'term'], activePanelId: 'term' },
        { type: 'group', id: 'g2', panelIds: ['page'], activePanelId: 'page' },
      ],
    },
  };
}

describe('splitFromLayout', () => {
  it('mirrors the desktop: the same left tab, right tab and focused side', () => {
    expect(splitFromLayout(desktopSplit('g2'), shown)).toEqual({ left: 'term', right: 'page', focus: 'right' });
    expect(splitFromLayout(desktopSplit('g1'), shown)).toEqual({ left: 'term', right: 'page', focus: 'left' });
  });

  it('picks the focused group inside a nested half, else its first group', () => {
    const layout: SessionPanelLayout = {
      version: 1,
      focusedGroupId: 'g3',
      root: {
        type: 'split', id: 's', direction: 'row', sizes: [1, 1],
        children: [
          { type: 'group', id: 'g1', panelIds: ['chat'], activePanelId: 'chat' },
          {
            type: 'split', id: 's2', direction: 'column', sizes: [1, 1],
            children: [
              { type: 'group', id: 'g2', panelIds: ['page'], activePanelId: 'page' },
              { type: 'group', id: 'g3', panelIds: ['file'], activePanelId: 'file' },
            ],
          },
        ],
      },
    };
    expect(splitFromLayout(layout, shown)).toEqual({ left: 'chat', right: 'file', focus: 'right' });
  });

  it('is no split for one group, a stacked split, or a tab the phone does not draw', () => {
    expect(splitFromLayout(null, shown)).toBeNull();
    expect(splitFromLayout({ version: 1, root: { type: 'group', id: 'g1', panelIds: ['chat'], activePanelId: 'chat' } }, shown)).toBeNull();
    expect(splitFromLayout(desktopSplit('g1', 'column'), shown)).toBeNull();
    expect(splitFromLayout(desktopSplit('g1'), new Set(['term']))).toBeNull();
  });
});

describe('splitFits', () => {
  // OnePlus Open unfolded: 916 dp. Beside Home's 330 dp column one tab fits; beside its 64 dp rail two do.
  it('fits two columns only from 640 dp of content', () => {
    expect(splitFits(586)).toBe(false);
    expect(splitFits(852)).toBe(true);
  });
});

describe('moving tabs', () => {
  const split: SplitState = { left: 'chat', right: 'page', focus: 'left' };

  it('an agent open goes beside the left tab without taking focus', () => {
    expect(followOpen({ left: 'chat', right: null, focus: 'left' }, 'page', 'split', true)).toEqual(split);
    expect(followOpen(split, 'file', 'split', true)).toEqual({ left: 'chat', right: 'file', focus: 'left' });
  });

  it('folded, an agent open shows the tab, and the split comes back on unfold', () => {
    const folded = followOpen(split, 'file', 'split', false);
    expect(focusedTab(folded)).toBe('file');
    expect(folded.right).toBe('page');
  });

  it('the strip focuses a column that has the tab, else replaces the focused column', () => {
    expect(selectTab(split, 'page')).toEqual({ ...split, focus: 'right' });
    expect(selectTab({ ...split, focus: 'right' }, 'term')).toEqual({ left: 'chat', right: 'term', focus: 'right' });
    expect(selectTab(split, 'term')).toEqual({ left: 'term', right: 'page', focus: 'left' });
  });

  it('an alert naming a tab shows it over the desktop split: in its column, else on the focused side', () => {
    // The desktop focused the preview an agent in `term` opened; the alert names `term`.
    const desktop = splitFromLayout(desktopSplit('g2'), shown);
    if (!desktop) throw new Error('expected the desktop split');
    expect(focusedTab(selectTab(desktop, 'term'))).toBe('term');
    expect(selectTab(desktop, 'file')).toEqual({ left: 'term', right: 'file', focus: 'right' });
  });

  it('opening the left tab beside swaps the columns, and narrow shows the focused one', () => {
    const swapped = openBeside(split, 'chat');
    expect(swapped).toEqual({ left: 'page', right: 'chat', focus: 'right' });
    expect(focusedTab(swapped)).toBe('chat');
  });
});
