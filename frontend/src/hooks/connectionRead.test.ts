import { describe, expect, it } from 'vitest';
import { connectionReadOutcome } from './connectionRead';

describe('what the first read of the window\'s connection says (review 1781 round 7)', () => {
  it('a state when it answered with one', () => {
    expect(connectionReadOutcome({ success: true, data: { mode: 'local' } })).toBe('state');
  });
  it('this computer when it answered with no data, so nothing waits on it forever (the window starts here)', () => {
    expect(connectionReadOutcome({ success: true })).toBe('local');
    expect(connectionReadOutcome({ success: true, data: null })).toBe('local');
  });
  it('failed when it refused', () => {
    expect(connectionReadOutcome({ success: false, error: 'no' })).toBe('failed');
  });
});
