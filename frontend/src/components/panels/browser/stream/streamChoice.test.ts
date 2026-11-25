import { describe, expect, it } from 'vitest';
import type { BrowserPanelState } from '../../../../../../shared/types/panels';
import { initialStreamChoice, offersViewLive, streamChoice, streamChoices, viewLive, type StreamChoice } from '../../../../../../shared/utils/streamChoice';

const agent = (state: StreamChoice, driving: boolean, at: number) => streamChoice(state, { kind: 'agent', driving, at });
const input = (state: StreamChoice, at: number) => streamChoice(state, { kind: 'input', at });
const tick = (state: StreamChoice, at: number) => streamChoice(state, { kind: 'tick', at });
const typed = (state: StreamChoice, on: boolean, at: number) => streamChoice(state, { kind: 'typed', typed: on, at });

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

  it('keeps streaming a page the agent typed into long after it stops, until Back to my copy', () => {
    // The agent fills page 2 of a form whose state its URL doesn't hold, then stops.
    let state = typed(agent(initialStreamChoice(false), true, 0), true, 5_000);
    state = agent(state, false, 6_000);
    expect(tick(state, 600_000).stream).toBe(true);
    state = streamChoice(state, { kind: 'back' });
    expect(state.stream).toBe(false);
    // The agent's next action streams it again.
    expect(agent(state, true, 700_000).stream).toBe(true);
  });

  it('goes back 30 s after the typed page loads a new document', () => {
    let state = agent(typed(agent(initialStreamChoice(false), true, 0), true, 1_000), false, 2_000);
    state = typed(state, false, 100_000);
    expect(tick(state, 129_999).stream).toBe(true);
    expect(tick(state, 130_000).stream).toBe(false);
  });

  it('streams a tab the agent typed into on a screen that opens it later', () => {
    expect(initialStreamChoice(false, true).stream).toBe(true);
  });

  it('streams on a screen that kept its own copy while the agent typed out of its sight', () => {
    // The phone showed its own copy, closed the tab, and opens it again after the agent typed.
    const state = typed(tick(agent(agent(initialStreamChoice(false), true, 0), false, 1_000), 31_000), true, 60_000);
    expect(state.stream).toBe(true);
    expect(tick(state, 600_000).stream).toBe(true);
  });
});

describe('View live', () => {
  const formTab: BrowserPanelState = { currentUrl: 'https://letsencrypt.formstack.com/forms/isrg_sponsorship', agentUse: 'used' };

  it('is offered on a tab an agent used while it shows the own copy, and streams it until Back to my copy', () => {
    expect(offersViewLive(streamChoices.all().get('form-1'), formTab)).toBe(true);
    viewLive('form-1', formTab);
    expect(streamChoices.all().get('form-1')?.stream).toBe(true);
    expect(offersViewLive(streamChoices.all().get('form-1'), formTab)).toBe(false);
    // An agent acts and stops: without View live, 30 s later the screen would go back.
    const at = Date.now();
    streamChoices.dispatch('form-1', { kind: 'agent', driving: true, at }, () => initialStreamChoice(false));
    streamChoices.dispatch('form-1', { kind: 'agent', driving: false, at: at + 1_000 }, () => initialStreamChoice(false));
    streamChoices.dispatch('form-1', { kind: 'tick', at: at + 600_000 }, () => initialStreamChoice(false));
    expect(streamChoices.all().get('form-1')?.stream).toBe(true);
    streamChoices.dispatch('form-1', { kind: 'back' }, () => initialStreamChoice(false));
    expect(offersViewLive(streamChoices.all().get('form-1'), formTab)).toBe(true);
  });

  it('is not offered on a tab no agent used, or on a host dev server', () => {
    expect(offersViewLive(undefined, { currentUrl: 'https://example.com/' })).toBe(false);
    expect(offersViewLive(undefined, { currentUrl: 'http://localhost:5173/', agentUse: 'typed' })).toBe(false);
  });
});
