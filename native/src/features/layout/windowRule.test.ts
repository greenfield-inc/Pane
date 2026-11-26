import { describe, expect, it } from 'vitest';

import { columnWidth, isWide } from './windowRule';

describe('the window rule', () => {
  it('draws Home beside the open screen from 600 × 480 dp', () => {
    expect(isWide({ width: 600, height: 480 })).toBe(true);
    expect(isWide({ width: 852, height: 883 })).toBe(true);
    expect(isWide({ width: 1280, height: 800 })).toBe(true);
  });

  it('keeps the phone layout below either edge', () => {
    expect(isWide({ width: 599, height: 900 })).toBe(false);
    expect(isWide({ width: 900, height: 479 })).toBe(false);
    // A folded Pixel 9 Pro Fold, and a phone on its side.
    expect(isWide({ width: 443, height: 994 })).toBe(false);
    expect(isWide({ width: 994, height: 443 })).toBe(false);
  });

  it('gives Home 36% of the window, from 280 to 352 dp', () => {
    expect(columnWidth(600)).toBe(280);
    expect(columnWidth(756)).toBe(280);
    expect(columnWidth(800)).toBe(288);
    expect(columnWidth(852)).toBe(307);
    expect(columnWidth(883)).toBe(318);
    expect(columnWidth(1280)).toBe(352);
  });
});
