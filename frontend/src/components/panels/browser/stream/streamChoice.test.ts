import { describe, expect, it } from 'vitest';
import { initialStreamChoice, streamChoice, type StreamChoice } from '../../../../../../shared/utils/streamChoice';

const agent = (state: StreamChoice, driving: boolean, at: number) => streamChoice(state, { kind: 'agent', driving, at });
const input = (state: StreamChoice, at: number) => streamChoice(state, { kind: 'input', at });
const tick = (state: StreamChoice, at: number) => streamChoice(state, { kind: 'tick', at });

describe('streamChoice', () => {
  it('shows the own copy until an agent acts, then streams', () => {
    let state = initialStreamChoice(false);
    expect(state.stream).toBe(false);
    state = agent(state, true, 1_000);
    expect(state.stream).toBe(true);
  });

  it('streams at once when an agent already drives the tab', () => {
    expect(initialStreamChoice(true).stream).toBe(true);
  });

  it('keeps streaming while the agent drives, however long', () => {
    expect(tick(agent(initialStreamChoice(false), true, 0), 600_000).stream).toBe(true);
  });

  it('goes back to the own copy 30 s after the last input by anyone, and a new agent action streams again', () => {
    let state = agent(initialStreamChoice(false), true, 0);
    state = agent(state, false, 10_000);
    expect(tick(state, 39_999).stream).toBe(true);
    state = tick(state, 40_000);
    expect(state.stream).toBe(false);
    state = agent(state, true, 50_000);
    expect(state.stream).toBe(true);
  });

  it('keeps the stream while the person types after taking over, and goes back 30 s after their last key', () => {
    // The agent stops, the person takes over and types a login for a minute.
    let state = agent(agent(initialStreamChoice(false), true, 0), false, 1_000);
    for (let at = 20_000; at <= 80_000; at += 20_000) {
      state = input(state, at);
      state = tick(state, at + 15_000);
      expect(state.stream).toBe(true);
    }
    expect(tick(state, 80_000 + 29_999).stream).toBe(true);
    expect(tick(state, 80_000 + 30_000).stream).toBe(false);
  });

  it('input on the own copy starts nothing', () => {
    expect(input(initialStreamChoice(false), 5_000).stream).toBe(false);
  });

  it('Back to my copy switches now and lasts until the agent acts again', () => {
    let state = agent(initialStreamChoice(false), true, 0);
    state = streamChoice(state, { kind: 'back' });
    expect(state.stream).toBe(false);
    state = agent(state, false, 6_000);
    expect(state.stream).toBe(false);
    state = agent(state, true, 20_000);
    expect(state.stream).toBe(true);
  });
});
