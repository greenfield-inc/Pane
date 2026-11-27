import type { PanelLayoutNode } from '../../../shared/types/panels';

/** A box in CSS pixels: the stage a layout is drawn in, or one node's place in it. */
export interface StageBox { width: number; height: number }

/** Where a layout's nodes go in a stage, in pixels, worked out before Allotment has measured anything (T-140). */
export interface SplitPixels {
  /** Each Allotment's pane sizes, keyed by the node that draws it: a split, or a group at the root. They add up to its box. */
  sizes: Map<string, number[]>;
  /** Each node's box. */
  boxes: Map<string, StageBox>;
}

/**
 * Each node's place in a stage of `box`: a split divides its box by its sizes (any unit;
 * equally when it has none), no pane under `minPane` while the box has room (what Allotment
 * would enforce), and a group at the root takes the whole stage. Given as
 * Allotment's `defaultSizes`, the sizes fill the stage it is mounted in, so it can lay
 * its panes out before the first paint instead of after its own resize observer reports.
 */
export function splitPixelSizes(root: PanelLayoutNode, box: StageBox, minPane = 0): SplitPixels {
  const sizes = new Map<string, number[]>();
  const boxes = new Map<string, StageBox>();
  const rounded = { width: Math.round(box.width), height: Math.round(box.height) };
  if (root.type === 'group') sizes.set(root.id, [rounded.width]);
  (function walk(node: PanelLayoutNode, place: StageBox) {
    boxes.set(node.id, place);
    if (node.type === 'group') return;
    const row = node.direction === 'row';
    const total = row ? place.width : place.height;
    const weights = node.sizes?.length === node.children.length && node.sizes.every(size => Number.isFinite(size) && size > 0)
      ? node.sizes
      : node.children.map(() => 1);
    const sum = weights.reduce((a, b) => a + b, 0);
    let given = 0;
    const pixels = weights.map((weight, index) => {
      // The last pane takes what rounding left, so the panes fill the box exactly.
      const size = index === weights.length - 1 ? total - given : Math.round((weight / sum) * total);
      given += size;
      return size;
    });
    // A pane under the minimum takes it from the largest panes, as Allotment would clamp it.
    const floor = Math.min(minPane, Math.floor(total / pixels.length));
    for (let index = 0; index < pixels.length; index++) {
      let short = floor - pixels[index];
      while (short > 0) {
        const largest = pixels.reduce((best, size, at) => (at !== index && size > pixels[best] ? at : best), index === 0 ? 1 : 0);
        const spare = Math.min(short, pixels[largest] - floor);
        if (spare <= 0) break;
        pixels[largest] -= spare;
        pixels[index] += spare;
        short -= spare;
      }
    }
    sizes.set(node.id, pixels);
    node.children.forEach((child, index) => walk(child, row ? { width: pixels[index], height: place.height } : { width: place.width, height: pixels[index] }));
  })(root, rounded);
  return { sizes, boxes };
}
