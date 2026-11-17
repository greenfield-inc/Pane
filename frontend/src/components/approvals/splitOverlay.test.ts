import { describe, expect, it } from 'vitest';
import { backToLabel, coverRect, isTypingTarget, sameRect } from './splitOverlay';

const edges = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

describe('coverRect', () => {
  it('covers one split group relative to the base', () => {
    expect(coverRect(edges(100, 40, 1100, 700), [edges(600, 40, 1100, 700)])).toEqual({ left: 500, top: 0, width: 500, height: 660 });
  });

  it('covers every group of a right split stacked in a column', () => {
    const base = edges(0, 30, 1200, 730);
    expect(coverRect(base, [edges(640, 30, 1200, 380), edges(640, 380, 1200, 730)])).toEqual({ left: 640, top: 0, width: 560, height: 700 });
  });

  it('is null when nothing is found to cover', () => {
    expect(coverRect(edges(0, 0, 10, 10), [])).toBeNull();
  });
});

describe('sameRect', () => {
  it('keeps the previous rect when nothing moved, so a resize tick does not re-render', () => {
    expect(sameRect({ left: 1, top: 2, width: 3, height: 4 }, { left: 1, top: 2, width: 3, height: 4 })).toBe(true);
    expect(sameRect({ left: 1, top: 2, width: 3, height: 4 }, { left: 1, top: 2, width: 5, height: 4 })).toBe(false);
    expect(sameRect(null, null)).toBe(true);
    expect(sameRect(null, { left: 0, top: 0, width: 0, height: 0 })).toBe(false);
  });
});

describe('backToLabel', () => {
  it('names what the split shows underneath', () => {
    expect(backToLabel('Plan')).toBe('Back to Plan');
    expect(backToLabel(undefined)).toBe('Back');
    expect(backToLabel('')).toBe('Back');
  });
});

describe('isTypingTarget', () => {
  it('leaves Esc to a field being typed in', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'WEBVIEW']) expect(isTypingTarget({ tagName, isContentEditable: false })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('takes Esc everywhere else in the column', () => {
    expect(isTypingTarget({ tagName: 'BUTTON', isContentEditable: false })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
