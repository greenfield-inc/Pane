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

  it('names the Session that changed when the event says, and none otherwise (review F-3 on #1281)', () => {
    const target = new EventTarget();
    const seen: Array<string | undefined> = [];
    onSessionOverviewChange(sessionId => seen.push(sessionId), target);
    target.dispatchEvent(new CustomEvent('orchestration-sessions-overview-updated', { detail: { panelId: 'p1', sessionId: 's1', state: 'working' } }));
    target.dispatchEvent(new CustomEvent('orchestration-sessions-changed', { detail: { sessionId: 's2', kind: 'report' } }));
    target.dispatchEvent(new CustomEvent('orchestration-sessions-overview-updated', { detail: { panelId: 'p1', state: 'idle' } }));
    target.dispatchEvent(new Event('orchestration-sessions-changed'));
    expect(seen).toEqual(['s1', 's2', undefined, undefined]);
  });
});
