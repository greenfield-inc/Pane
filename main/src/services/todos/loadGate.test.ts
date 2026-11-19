import { describe, expect, it } from 'vitest';
import { LoadGate, pickShedTarget, type LoadGateChange, type MemoryLevel } from './loadGate';

/** Feeds a reading every 10 s for `forMs`, from `start`, returning the changes and the end time. */
interface Fed {
  changes: LoadGateChange[];
  end: number;
}

interface Reading {
  cpu: number | null;
  memory?: MemoryLevel;
}

function feed(gate: LoadGate, start: number, forMs: number, reading: (at: number) => Reading): Fed {
  const changes: LoadGateChange[] = [];
  let at = start;
  for (; at <= start + forMs; at += 10_000) {
    const { cpu, memory = 'ok' } = reading(at);
    const change = gate.record({ at, cpuPercent: cpu, memory });
    if (change) changes.push(change);
  }
  return { changes, end: at };
}

describe('LoadGate', () => {
  it('holds when memory pressure is Warning for 30 s, not sooner', () => {
    const gate = new LoadGate();
    const early = feed(gate, 0, 20_000, () => ({ cpu: 10, memory: 'warning' }));
    expect(early.changes).toEqual([]);
    const later = feed(gate, early.end, 10_000, () => ({ cpu: 10, memory: 'warning' }));
    expect(later.changes).toEqual([{ from: 'normal', to: 'holding', at: 30_000, why: 'memory pressure high' }]);
    expect(gate.allowsStart()).toBe(false);
    expect(gate.line('This Mac', 30_000 + 3 * 60_000)).toBe('This Mac is busy: memory pressure high for 3 min');
  });

  it('holds on CPU averaging 85% over 60 s and releases only after 2 min under 70% with memory OK', () => {
    const gate = new LoadGate();
    const busy = feed(gate, 0, 60_000, () => ({ cpu: 90 }));
    expect(busy.changes.map(change => change.to)).toEqual(['holding']);
    const middling = feed(gate, busy.end, 5 * 60_000, () => ({ cpu: 75 }));
    expect(middling.changes).toEqual([]);
    const calm = feed(gate, middling.end, 120_000, () => ({ cpu: 20 }));
    expect(calm.changes.map(change => change.to)).toEqual(['normal']);
    expect(calm.changes[0].at - middling.end).toBe(120_000);
  });

  it('changes state at most twice with CPU swinging between 80% and 90% every 20 s for 10 minutes', () => {
    const gate = new LoadGate();
    const { changes } = feed(gate, 0, 10 * 60_000, at => ({ cpu: Math.floor(at / 20_000) % 2 === 0 ? 80 : 90 }));
    expect(changes.length).toBeLessThanOrEqual(2);
  });

  it('sheds on memory Critical for 60 s or CPU ≥ 95% for 3 min, and eases back to Holding after 2 min below', () => {
    const memory = new LoadGate();
    expect(feed(memory, 0, 60_000, () => ({ cpu: 10, memory: 'critical' })).changes.map(change => change.to)).toEqual(['holding', 'shedding']);
    const cpu = new LoadGate();
    const hot = feed(cpu, 0, 180_000, () => ({ cpu: 97 }));
    expect(hot.changes.map(change => change.to)).toEqual(['holding', 'shedding']);
    expect(hot.changes[1].at).toBe(180_000);
    const easing = feed(cpu, hot.end, 120_000, () => ({ cpu: 80 }));
    expect(easing.changes.map(change => change.to)).toEqual(['holding']);
  });

  it('spaces queued starts 30 s apart and resumes paused to-dos only after 5 min of Normal, 2 min apart', () => {
    const gate = new LoadGate();
    const busy = feed(gate, 0, 60_000, () => ({ cpu: 99 }));
    expect(gate.mayStartQueued(busy.end)).toBe(false);
    const calm = feed(gate, busy.end, 120_000, () => ({ cpu: 5 }));
    const normalAt = calm.changes[0].at;
    expect(gate.mayStartQueued(normalAt)).toBe(true);
    gate.noteQueuedStart(normalAt);
    expect(gate.mayStartQueued(normalAt + 29_000)).toBe(false);
    expect(gate.mayStartQueued(normalAt + 30_000)).toBe(true);
    expect(gate.mayResumePaused(normalAt + 4 * 60_000)).toBe(false);
    expect(gate.mayResumePaused(normalAt + 5 * 60_000)).toBe(true);
    gate.noteResume(normalAt + 5 * 60_000);
    expect(gate.mayResumePaused(normalAt + 6 * 60_000)).toBe(false);
    expect(gate.mayResumePaused(normalAt + 7 * 60_000)).toBe(true);
  });

  it('sheds one to-do every 2 minutes', () => {
    const gate = new LoadGate();
    feed(gate, 0, 60_000, () => ({ cpu: 5, memory: 'critical' }));
    expect(gate.mayShed(60_000)).toBe(true);
    gate.noteShed(60_000);
    expect(gate.mayShed(170_000)).toBe(false);
    expect(gate.mayShed(180_000)).toBe(true);
  });

  it('holds and sheds nothing while the setting is off', () => {
    let enabled = false;
    const gate = new LoadGate(() => enabled);
    feed(gate, 0, 60_000, () => ({ cpu: 5, memory: 'critical' }));
    expect(gate.state).toBe('normal');
    expect(gate.allowsStart()).toBe(true);
    expect(gate.mayShed(60_000)).toBe(false);
    enabled = true;
    expect(gate.state).toBe('shedding');
  });
});

describe('pickShedTarget', () => {
  const candidate = (number: number, startedAt: number, over = {}) => ({ number, startedAt, waitingOnYou: false, neverPause: false, protectedTab: false, ...over });

  it('pauses the newest-started first', () => {
    expect(pickShedTarget([candidate(1, 100), candidate(2, 300), candidate(3, 200)])).toBe(2);
  });

  it('never pauses the last running to-do, one waiting on you, one set to Never pause, or one with your unsent text', () => {
    expect(pickShedTarget([candidate(1, 100)])).toBeNull();
    expect(pickShedTarget([candidate(1, 100), candidate(2, 300, { waitingOnYou: true }), candidate(3, 400, { neverPause: true }), candidate(4, 500, { protectedTab: true })])).toBe(1);
    expect(pickShedTarget([candidate(2, 300, { waitingOnYou: true }), candidate(3, 400, { neverPause: true })])).toBeNull();
  });
});
