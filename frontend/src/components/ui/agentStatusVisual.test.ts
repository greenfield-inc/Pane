import { describe, expect, it } from 'vitest';
import { agentStatusVisual } from './agentStatusVisual';

describe('agentStatusVisual', () => {
  it('maps each status to its token, label, and attention cue', () => {
    expect(agentStatusVisual('blocked')).toEqual({ colorClass: 'bg-status-error', label: 'blocked', attention: true });
    expect(agentStatusVisual('working')).toEqual({ colorClass: 'bg-status-info', label: 'working', attention: false });
    expect(agentStatusVisual('done')).toEqual({ colorClass: 'bg-status-info', label: 'done', attention: false });
    expect(agentStatusVisual('idle')).toEqual({ colorClass: 'bg-status-success', label: 'idle', attention: false });
  });

  it('returns null for unknown so no badge renders', () => {
    expect(agentStatusVisual('unknown')).toBeNull();
  });
});
