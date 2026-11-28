import { describe, expect, it } from 'vitest';
import { decodeChatPanelState } from './state';

describe('decodeChatPanelState', () => {
  // T-83 P3 QA finding 1: a linked agent's chat tab kept its parent in saved state, but decoding dropped it,
  // so every start ran without --parent and Agent Farm recorded the child as a root.
  it('keeps a profile launch\'s parent token', () => {
    const state = decodeChatPanelState({
      agent: 'claude', cwd: '/repo', status: 'starting',
      launch: { kind: 'profile', profile: 'greenfield/planner', args: { docs: 'grain' }, parent: 'greenfield/orchestrator:claude@af-1' },
    });
    expect(state?.launch).toEqual({ kind: 'profile', profile: 'greenfield/planner', args: { docs: 'grain' }, parent: 'greenfield/orchestrator:claude@af-1' });
  });

  it('reads a profile launch without a parent as before', () => {
    expect(decodeChatPanelState({ agent: 'claude', cwd: '/repo', status: 'idle', launch: { kind: 'profile', profile: 'greenfield/orchestrator' } })?.launch)
      .toEqual({ kind: 'profile', profile: 'greenfield/orchestrator' });
  });
});
