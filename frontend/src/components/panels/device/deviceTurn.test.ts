import { describe, expect, it } from 'vitest';
import { frameDelta, framePoint, screenTurn } from './deviceTurn';

// A phone turned landscape-left, as a simulator streams it: the portrait framebuffer with the app's
// top along its left edge. The app's top-left corner sits at the frame's bottom-left (x 0, y 1).
describe('a simulator turned on its side', () => {
  it('turns a portrait frame upright for landscape, and leaves one that already has the turned shape', () => {
    expect(screenTurn('landscape_left', 370, 800)).toBe(90);
    expect(screenTurn('landscape_right', 370, 800)).toBe(270);
    expect(screenTurn('landscape_left', 800, 370)).toBe(0);
    expect(screenTurn('portrait', 370, 800)).toBe(0);
    expect(screenTurn(undefined, 370, 800)).toBe(0);
  });

  it('sends a tap on the upright top-left corner to the frame\'s bottom-left', () => {
    expect(framePoint(90, { x: 0, y: 0 })).toEqual({ x: 0, y: 1 });
  });

  it('sends a tap near the upright top-right (an address bar\'s end) to the frame\'s top-left', () => {
    expect(framePoint(90, { x: 0.9, y: 0.1 })).toEqual({ x: 0.1, y: expect.closeTo(0.1) });
  });

  it('turns the other way for landscape-right, and halfway round for upside down', () => {
    expect(framePoint(270, { x: 0, y: 0 })).toEqual({ x: 1, y: 0 });
    expect(framePoint(180, { x: 0.25, y: 0.1 })).toEqual({ x: 0.75, y: 0.9 });
  });

  it('turns a scroll down the upright screen into a scroll along the frame', () => {
    // Down on the upright screen runs from the frame's left edge to its right.
    expect(frameDelta(90, { dx: 0, dy: 0.2 })).toEqual({ dx: 0.2, dy: -0 });
    expect(frameDelta(0, { dx: 0.1, dy: 0.2 })).toEqual({ dx: 0.1, dy: 0.2 });
  });
});
