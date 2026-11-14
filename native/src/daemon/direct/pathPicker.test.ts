import { describe, expect, it } from 'vitest';

import { FIRST_PICK, pathFailed, pickPath, type PathPick, type PathSample } from './pathPicker';

function run(samples: PathSample[], from: PathPick = FIRST_PICK): PathPick['path'][] {
  const paths: PathPick['path'][] = [];
  samples.reduce((pick, sample) => {
    const next = pickPath(pick, sample);
    paths.push(next.path);
    return next;
  }, from);
  return paths;
}

describe('pickPath', () => {
  it('starts on the relay and moves to a clearly faster direct path after three probes in a row', () => {
    const fast = { relayMs: 120, directMs: 20 };
    expect(run([fast, fast, fast, fast])).toEqual(['relay', 'relay', 'direct', 'direct']);
  });

  it('starts over when one probe is not clearly faster', () => {
    const fast = { relayMs: 120, directMs: 20 };
    const even = { relayMs: 120, directMs: 110 };
    expect(run([fast, fast, even, fast, fast, fast])).toEqual(['relay', 'relay', 'relay', 'relay', 'relay', 'direct']);
  });

  it('never moves for a small gain', () => {
    // 25% faster but only 5 ms: noise on a fast network.
    const small = { relayMs: 20, directMs: 15 };
    // 8% faster: noise on a slow one.
    const slight = { relayMs: 250, directMs: 230 };
    expect(run([small, small, small, slight, slight, slight])).toEqual(Array(6).fill('relay'));
  });

  it('moves back to the relay only when the relay is clearly faster for three probes', () => {
    const direct: PathPick = { ...FIRST_PICK, path: 'direct' };
    expect(run([{ relayMs: 60, directMs: 70 }, { relayMs: 60, directMs: 70 }, { relayMs: 60, directMs: 70 }], direct))
      .toEqual(['direct', 'direct', 'direct']);
    expect(run(Array(3).fill({ relayMs: 30, directMs: 200 }), direct)).toEqual(['direct', 'direct', 'relay']);
  });

  it('leaves a path that stops answering at once when the other answers', () => {
    // Same Wi-Fi without internet: the relay can't be reached at all.
    expect(run([{ relayMs: null, directMs: 8 }])).toEqual(['direct']);
    const direct: PathPick = { ...FIRST_PICK, path: 'direct' };
    expect(run([{ relayMs: 90, directMs: null }], direct)).toEqual(['relay']);
  });

  it('stays put when neither path answers', () => {
    expect(run([{ relayMs: null, directMs: null }, { relayMs: null, directMs: null }])).toEqual(['relay', 'relay']);
  });
});

describe('pathFailed', () => {
  it('leaves the failed path when it is the current one', () => {
    expect(pathFailed({ ...FIRST_PICK, path: 'direct' }, 'direct').path).toBe('relay');
  });

  it('drops the progress toward a path that failed', () => {
    const fast = { relayMs: 120, directMs: 20 };
    const twoAhead = [fast, fast].reduce(pickPath, FIRST_PICK);
    const afterFailure = pathFailed(twoAhead, 'direct');
    expect(pickPath(afterFailure, fast).path).toBe('relay');
  });
});
