import { describe, expect, it } from 'vitest';
import { splitPixelSizes } from './splitPixelSizes';
import type { PanelLayoutNode } from '../../../shared/types/panels';

const group = (id: string): PanelLayoutNode => ({ type: 'group', id, panelIds: [id], activePanelId: id });

describe('splitPixelSizes', () => {
  it('gives a single group the whole stage width', () => {
    const { sizes, boxes } = splitPixelSizes(group('chat'), { width: 1148.4, height: 900 });
    expect(sizes).toEqual(new Map([['chat', [1148]]]));
    expect(boxes.get('chat')).toEqual({ width: 1148, height: 900 });
  });

  it('scales stored sizes to the stage, filling it exactly', () => {
    const root: PanelLayoutNode = { type: 'split', id: 'root', direction: 'row', sizes: [230, 230], children: [group('chat'), group('side')] };
    expect(splitPixelSizes(root, { width: 1148, height: 900 }).sizes.get('root')).toEqual([574, 574]);
    const uneven: PanelLayoutNode = { ...root, sizes: [2, 1] };
    expect(splitPixelSizes(uneven, { width: 1001, height: 900 }).sizes.get('root')).toEqual([667, 334]);
  });

  it('splits evenly without usable sizes, and sizes nested splits along their own direction', () => {
    const column: PanelLayoutNode = { type: 'split', id: 'right', direction: 'column', sizes: [], children: [group('a'), group('b')] };
    const root: PanelLayoutNode = { type: 'split', id: 'root', direction: 'row', sizes: [3, 0], children: [group('chat'), column] };
    const { sizes, boxes } = splitPixelSizes(root, { width: 1000, height: 801 });
    expect(sizes.get('root')).toEqual([500, 500]);
    expect(sizes.get('right')).toEqual([401, 400]);
    expect(boxes.get('chat')).toEqual({ width: 500, height: 801 });
    expect(boxes.get('b')).toEqual({ width: 500, height: 400 });
  });

  it('keeps every pane at the minimum while the box has room, taking it from the largest', () => {
    const root: PanelLayoutNode = { type: 'split', id: 'root', direction: 'row', sizes: [100, 450, 450], children: [group('a'), group('b'), group('c')] };
    expect(splitPixelSizes(root, { width: 1000, height: 900 }, 120).sizes.get('root')).toEqual([120, 430, 450]);
    expect(splitPixelSizes(root, { width: 300, height: 900 }, 120).sizes.get('root')).toEqual([100, 100, 100]);
  });
});
