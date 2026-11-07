import { describe, expect, it } from 'vitest';
import { onSessionOverviewChange } from './sessionOverviewEvents';

describe('onSessionOverviewChange', () => {
  it('calls back on a status update and on a membership or report change, until stopped (review F-5)', () => {
    const target = new EventTarget();
    let calls = 0;
    const stop = onSessionOverviewChange(() => { calls += 1; }, target);
    target.dispatchEvent(new Event('orchestration-sessions-overview-updated'));
    target.dispatchEvent(new Event('orchestration-sessions-changed'));
    expect(calls).toBe(2);
    stop();
    target.dispatchEvent(new Event('orchestration-sessions-changed'));
    expect(calls).toBe(2);
  });
});
