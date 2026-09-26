import { describe, expect, it } from 'vitest';
import { AgentStatusMonitor } from './agentStatusMonitor';
import type { AgentDetectionResult } from '../../../../shared/types/agentStatus';

const detection = (partial: Partial<AgentDetectionResult>): AgentDetectionResult => ({
  state: 'idle',
  visibleBlocker: false,
  visibleWorking: false,
  visibleIdle: false,
  skipStateUpdate: false,
  matchedRuleId: null,
  ...partial,
});

const opts = {
  idleSettleMs: 1000,
  startupGraceMs: 3000,
};

describe('AgentStatusMonitor', () => {
  it('publishes working while PTY bytes are flowing', () => {
    const m = new AgentStatusMonitor(opts);
    m.register('p', 0);
    m.noteActivity('p', 3010);
    expect(m.update('p', detection({ state: 'idle' }), 3020)).toBe('working');
    expect(m.getState('p')).toBe('working');
  });

  it('settles to idle after activity stops and the hold elapses (past startup grace)', () => {
    const m = new AgentStatusMonitor(opts);
    m.register('p', 0);
    m.noteActivity('p', 4000);
    expect(m.update('p', detection({ state: 'idle' }), 4010)).toBe('working');
    expect(m.update('p', detection({ state: 'idle' }), 4999)).toBeNull();
    expect(m.update('p', detection({ state: 'idle' }), 5000)).toBe('idle');
  });

  it('publishes blocked immediately, overriding recent activity', () => {
    const m = new AgentStatusMonitor(opts);
    m.register('p', 0);
    m.noteActivity('p', 4000);
    m.update('p', detection({ state: 'idle' }), 4010); // working
    const changed = m.update('p', detection({ state: 'blocked', visibleBlocker: true }), 4020);
    expect(changed).toBe('blocked');
  });

  it('holds the prior state on skipStateUpdate detections', () => {
    const m = new AgentStatusMonitor(opts);
    m.register('p', 0);
    m.noteActivity('p', 4000);
    m.update('p', detection({ state: 'idle' }), 4010); // working
    expect(m.update('p', detection({ state: 'unknown', skipStateUpdate: true }), 4020)).toBeNull();
    expect(m.getState('p')).toBe('working');
  });

  it('does not invent work during startup', () => {
    const m = new AgentStatusMonitor(opts);
    m.register('p', 0);
    // Empty shells and boot banners do not represent a completed task.
    expect(m.update('p', detection({ state: 'idle' }), 500)).toBeNull();
    expect(m.getState('p')).toBeUndefined();
    m.noteActivity('p', 600);
    m.noteActivity('p', 700);
    expect(m.update('p', detection({}), 800)).toBeNull();
    expect(m.getState('p')).toBeUndefined();
    expect(m.update('p', detection({}), 3100)).toBe('idle');
  });

  it('emits only on change', () => {
    const m = new AgentStatusMonitor(opts);
    m.register('p', 0);
    m.noteActivity('p', 4000);
    expect(m.update('p', detection({ state: 'working' }), 4010)).toBe('working');
    expect(m.update('p', detection({ state: 'working' }), 4020)).toBeNull();
  });

  it('settles immediately on reliable idle evidence and ignores redraw activity', () => {
    const m = new AgentStatusMonitor(opts);
    m.register('p', 0);
    expect(m.update('p', detection({ state: 'working', visibleWorking: true }), 10)).toBe('working');
    m.noteActivity('p', 4000);
    const idle = detection({ visibleIdle: true, matchedRuleId: 'osc_title_idle' });
    expect(m.update('p', idle, 4010)).toBe('idle');
    m.noteActivity('p', 4020);
    m.noteActivity('p', 4030);
    expect(m.update('p', idle, 4040)).toBeNull();
    expect(m.update('p', detection({ state: 'working', visibleWorking: true }), 4050)).toBe('working');
  });

  it('retains activity fallback for real work that starts during startup grace', () => {
    const m = new AgentStatusMonitor(opts);
    m.register('p', 0);
    m.noteActivity('p', 100);
    expect(m.update('p', detection({ visibleWorking: true }), 110)).toBe('working');
    const weakPrompt = detection({ matchedRuleId: 'live_prompt_box' });
    expect(m.update('p', weakPrompt, 120)).toBeNull();
    m.noteActivity('p', 900);
    expect(m.update('p', weakPrompt, 1800)).toBeNull();
    expect(m.update('p', weakPrompt, 1900)).toBe('idle');
  });

  it('does not let a persistent prompt box complete work or wake on typing', () => {
    const m = new AgentStatusMonitor(opts);
    m.register('p', 0);
    const prompt = detection({ matchedRuleId: 'live_prompt_box' });
    expect(m.update('p', prompt, 4000)).toBe('idle');
    m.noteActivity('p', 4010);
    m.noteActivity('p', 4020);
    expect(m.update('p', prompt, 4030)).toBeNull();
    expect(m.update('p', detection({ visibleWorking: true }), 4040)).toBe('working');
    expect(m.update('p', prompt, 4050)).toBeNull();
  });

  it('ignores unregistered panels', () => {
    const m = new AgentStatusMonitor(opts);
    expect(m.update('ghost', detection({ state: 'working' }), 0)).toBeNull();
    expect(m.getState('ghost')).toBeUndefined();
  });

  it('suppresses a single trailing chunk after idle', () => {
    const m = new AgentStatusMonitor(opts);
    m.register('p', 0);
    m.noteActivity('p', 4000);
    m.noteActivity('p', 4010);
    expect(m.update('p', detection({ state: 'idle' }), 4020)).toBe('working');
    expect(m.update('p', detection({ state: 'idle' }), 5010)).toBe('idle');

    m.noteActivity('p', 7000);
    expect(m.update('p', detection({ state: 'idle' }), 7010)).toBeNull();
    expect(m.getState('p')).toBe('idle');
  });

  it('publishes working after two chunks wake an idle panel', () => {
    const m = new AgentStatusMonitor(opts);
    m.register('p', 0);
    expect(m.update('p', detection({ state: 'idle' }), 3000)).toBe('idle');
    m.noteActivity('p', 4000);
    expect(m.update('p', detection({ state: 'idle' }), 4010)).toBeNull();
    m.noteActivity('p', 4020);
    expect(m.update('p', detection({ state: 'idle' }), 4030)).toBe('working');
  });
});
