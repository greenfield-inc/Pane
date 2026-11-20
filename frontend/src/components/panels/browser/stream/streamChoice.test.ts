import { describe, expect, it } from 'vitest';
import { initialStreamChoice, streamChoice, type StreamChoice } from '../../../../../../shared/utils/streamChoice';

const driver = (state: StreamChoice, driving: boolean, at: number) => streamChoice(state, { kind: 'driver', driving, at });
const tick = (state: StreamChoice, at: number) => streamChoice(state, { kind: 'tick', at });

describe('streamChoice', () => {
  it('shows the own copy until an agent acts, then streams', () => {
    let state = initialStreamChoice(false);
    expect(state.stream).toBe(false);
    state = driver(state, true, 1_000);
    expect(state.stream).toBe(true);
  });

  it('streams at once when an agent already drives the tab', () => {
    expect(initialStreamChoice(true).stream).toBe(true);
  });

  it('goes back to the own copy 30 s after the agent last acted, and a new action streams again', () => {
    let state = driver(initialStreamChoice(false), true, 0);
    state = driver(state, false, 10_000);
    expect(tick(state, 39_999).stream).toBe(true);
    state = tick(state, 40_000);
    expect(state.stream).toBe(false);
    state = driver(state, true, 50_000);
    expect(state.stream).toBe(true);
  });

  it('keeps streaming while the agent keeps acting, however long', () => {
    let state = driver(initialStreamChoice(false), true, 0);
    expect(tick(state, 300_000).stream).toBe(true);
    state = driver(state, false, 300_000);
    state = driver(state, true, 310_000);
    expect(tick(state, 400_000).stream).toBe(true);
  });

  it('Back to my copy switches now; the agent acting again streams again', () => {
    let state = driver(initialStreamChoice(false), true, 0);
    state = streamChoice(state, { kind: 'back' });
    expect(state.stream).toBe(false);
    // The same run of actions keeps the own copy the person chose.
    expect(tick(state, 5_000).stream).toBe(false);
    state = driver(state, false, 6_000);
    expect(state.stream).toBe(false);
    state = driver(state, true, 20_000);
    expect(state.stream).toBe(true);
  });
});
