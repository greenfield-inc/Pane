import { describe, expect, it } from 'vitest';
import { selectAutopilotStack } from './autopilotStore';

describe('selectAutopilotStack', () => {
  it('returns the same empty stack every time before the first snapshot (review F-3)', () => {
    const state = { snapshot: null, pending: false };
    expect(selectAutopilotStack(state)).toBe(selectAutopilotStack(state));
    expect(selectAutopilotStack(state)).toEqual({ entries: [], shownId: null });
  });
});
