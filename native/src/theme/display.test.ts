import { describe, expect, it } from 'vitest';

import { parseTerminalFont, parseUiScale, scaleType, stepTerminalFont, stepUiScale } from './display';

describe('UI scale', () => {
  it('steps by tenths from 0.8x to 1.5x, like the desktop', () => {
    expect(stepUiScale(1, 1)).toBe(1.1);
    expect(stepUiScale(1, -1)).toBe(0.9);
    expect(stepUiScale(0.7 + 0.2, 1)).toBe(1);
    expect(stepUiScale(1.5, 1)).toBe(1.5);
    expect(stepUiScale(0.8, -1)).toBe(0.8);
  });

  it('reads back what was saved, and 1x for anything else', () => {
    expect(parseUiScale('1.2')).toBe(1.2);
    expect(parseUiScale('3')).toBe(1.5);
    expect(parseUiScale(null)).toBe(1);
    expect(parseUiScale('big')).toBe(1);
  });

  it('scales a text style’s size, line height and spacing', () => {
    expect(scaleType({ fontSize: 16, lineHeight: 24, letterSpacing: 2, fontWeight: '600' }, 1.5))
      .toEqual({ fontSize: 24, lineHeight: 36, letterSpacing: 3, fontWeight: '600' });
    expect(scaleType({ color: 'red' }, 0.8)).toEqual({ color: 'red' });
  });
});

describe('terminal font size', () => {
  it('steps by 1 px from 10 to 24, like the desktop', () => {
    expect(stepTerminalFont(12, 1)).toBe(13);
    expect(stepTerminalFont(10, -1)).toBe(10);
    expect(stepTerminalFont(24, 1)).toBe(24);
  });

  it('starts at the phone’s 12 px', () => {
    expect(parseTerminalFont(null)).toBe(12);
    expect(parseTerminalFont('18')).toBe(18);
    expect(parseTerminalFont('x')).toBe(12);
  });
});
