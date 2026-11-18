import { expect, it } from 'vitest';

import { skeletonState } from './skeletonTiming';

it('shows no skeleton for a load that answers within 150 ms', () => {
  expect(skeletonState(1_000, null, 1_100)).toMatchObject({ skeleton: true, bones: false });
  expect(skeletonState(1_000, 1_120, 1_120)).toEqual({ skeleton: false, bones: false, reveal: false, changeAt: null });
});

it('shows bones from 150 ms and holds them 300 ms even when the load answers at 200 ms', () => {
  expect(skeletonState(1_000, null, 1_150)).toEqual({ skeleton: true, bones: true, reveal: false, changeAt: null });
  expect(skeletonState(1_000, 1_200, 1_200)).toEqual({ skeleton: true, bones: true, reveal: false, changeAt: 1_450 });
  expect(skeletonState(1_000, 1_200, 1_450)).toEqual({ skeleton: false, bones: false, reveal: true, changeAt: null });
});

it('swaps a long load’s skeleton for its content as soon as it answers', () => {
  expect(skeletonState(1_000, 1_900, 1_900)).toEqual({ skeleton: false, bones: false, reveal: true, changeAt: null });
});

it('tells the screen when the blank start turns into bones', () => {
  expect(skeletonState(1_000, null, 1_010).changeAt).toBe(1_150);
});
