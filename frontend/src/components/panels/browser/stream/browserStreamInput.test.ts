import { describe, expect, it } from 'vitest';
import type { BrowserInput } from '../../../../../../shared/types/browserStream';
import { browserInputQueue, pagePoint } from '../../../../../../shared/utils/browserStreamInput';

describe('pagePoint', () => {
  it('maps a point in a letterboxed frame to the page, and the bars to nothing', () => {
    // A 390x844 phone page drawn in a 1000x844 box: 390 wide, centred with 305 px bars each side.
    const box = { width: 1000, height: 844 };
    const page = { width: 390, height: 844 };
    expect(pagePoint(305, 0, box, page)).toEqual({ x: 0, y: 0 });
    expect(pagePoint(500, 422, box, page)).toEqual({ x: 195, y: 422 });
    expect(pagePoint(100, 422, box, page)).toBeUndefined();
    // A 1280x800 page in a 640x600 box: half size, 100 px bars above and below.
    expect(pagePoint(320, 300, { width: 640, height: 600 }, { width: 1280, height: 800 })).toEqual({ x: 640, y: 400 });
    expect(pagePoint(320, 50, { width: 640, height: 600 }, { width: 1280, height: 800 })).toBeUndefined();
  });
});

describe('browserInputQueue', () => {
  it('sends in order, one batch at a time, merging moves and adding wheel turns that wait', async () => {
    const sent: BrowserInput[][] = [];
    let release: () => void = () => undefined;
    const queue = browserInputQueue(async (batch) => {
      sent.push(batch);
      await new Promise<void>(resolve => { release = resolve; });
      return {};
    });
    const move = (x: number): BrowserInput => ({ kind: 'mouse', action: 'move', x, y: 0, button: 'none', clicks: 0, modifiers: 0 });
    queue({ kind: 'mouse', action: 'down', x: 1, y: 1, button: 'left', clicks: 1, modifiers: 0 });
    // While the press travels: moves, a release and two wheel turns wait.
    queue(move(2));
    queue(move(3));
    queue({ kind: 'mouse', action: 'up', x: 3, y: 0, button: 'left', clicks: 1, modifiers: 0 });
    queue({ kind: 'wheel', x: 3, y: 0, dx: 0, dy: 100 });
    queue({ kind: 'wheel', x: 3, y: 0, dx: 0, dy: 50 });
    expect(sent).toHaveLength(1);
    release();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sent[1]).toEqual([move(3), { kind: 'mouse', action: 'up', x: 3, y: 0, button: 'left', clicks: 1, modifiers: 0 }, { kind: 'wheel', x: 3, y: 0, dx: 0, dy: 150 }]);
    release();
  });

  it('sends an empty batch to take control without input', async () => {
    const sent: BrowserInput[][] = [];
    const queue = browserInputQueue(async (batch) => { sent.push(batch); return {}; });
    queue(null);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sent).toEqual([[]]);
  });
});
