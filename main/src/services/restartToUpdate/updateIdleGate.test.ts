import { describe, expect, it, vi } from 'vitest';
import { UpdateIdleGate } from './updateIdleGate';
import type { UpdateBusyState } from '../../../../shared/types/updater';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function createGate(start: Date) {
  let now = start.getTime();
  let busy: UpdateBusyState | null = null;
  let systemIdleSeconds = 0;
  const restartTonight = vi.fn();
  const gate = new UpdateIdleGate({
    now: () => now,
    readBusy: () => busy,
    systemIdleSeconds: () => systemIdleSeconds,
    restartTonight,
  });
  return {
    gate,
    restartTonight,
    advance(ms: number) { now += ms; gate.tick(); },
    setBusy(next: UpdateBusyState | null) { busy = next; gate.tick(); },
    setSystemIdleMinutes(minutes: number) { systemIdleSeconds = minutes * 60; },
  };
}

const afternoon = new Date(2026, 9, 26, 14, 0);
const oneAgentWorking: UpdateBusyState = { reason: 'agents', agentCount: 1 };

describe('UpdateIdleGate idle toast', () => {
  it('is due once an update is ready and nothing has run for 5 minutes', () => {
    const t = createGate(afternoon);
    t.gate.setReady('2.4.203');
    t.advance(4 * MINUTE + 59_000);
    expect(t.gate.getState().idleToastDue).toBe(false);
    t.advance(1_000);
    expect(t.gate.getState()).toMatchObject({ readyVersion: '2.4.203', idleToastDue: true, busy: null });
  });

  it('is never due without a downloaded update', () => {
    const t = createGate(afternoon);
    t.advance(HOUR);
    expect(t.gate.getState().idleToastDue).toBe(false);
  });

  it('holds while anything is busy and restarts the 5 minute clock when it ends', () => {
    const t = createGate(afternoon);
    t.gate.setReady('2.4.203');
    t.advance(10 * MINUTE);
    t.setBusy({ reason: 'run-script', agentCount: 0 });
    expect(t.gate.getState()).toMatchObject({ idleToastDue: false, busy: { reason: 'run-script', agentCount: 0 } });
    t.advance(20 * MINUTE);
    expect(t.gate.getState().idleToastDue).toBe(false);
    t.setBusy(null);
    t.advance(4 * MINUTE);
    expect(t.gate.getState().idleToastDue).toBe(false);
    t.advance(1 * MINUTE);
    expect(t.gate.getState().idleToastDue).toBe(true);
  });

  it('counts a busy moment reported between ticks', () => {
    const t = createGate(afternoon);
    t.gate.setReady('2.4.203');
    t.advance(10 * MINUTE);
    t.gate.markBusy();
    expect(t.gate.getState().idleToastDue).toBe(false);
    t.advance(5 * MINUTE);
    expect(t.gate.getState().idleToastDue).toBe(true);
  });

  it('Later hides the toast for 4 hours, then it returns if still idle', () => {
    const t = createGate(afternoon);
    t.gate.setReady('2.4.203');
    t.advance(5 * MINUTE);
    t.gate.snooze();
    expect(t.gate.getState()).toMatchObject({ idleToastDue: false, snoozedUntil: afternoon.getTime() + 5 * MINUTE + 4 * HOUR });
    t.advance(4 * HOUR - 1_000);
    expect(t.gate.getState().idleToastDue).toBe(false);
    t.advance(1_000);
    expect(t.gate.getState()).toMatchObject({ idleToastDue: true, snoozedUntil: null });
  });

  it('keeps Later when a newer version downloads meanwhile', () => {
    const t = createGate(afternoon);
    t.gate.setReady('2.4.203');
    t.advance(5 * MINUTE);
    t.gate.snooze();
    t.gate.setReady('2.4.204');
    t.advance(MINUTE);
    expect(t.gate.getState()).toMatchObject({ readyVersion: '2.4.204', idleToastDue: false });
  });

  it('emits state only when it changes', () => {
    const t = createGate(afternoon);
    const listener = vi.fn();
    t.gate.on('state', listener);
    t.gate.setReady('2.4.203');
    t.advance(MINUTE);
    t.advance(MINUTE);
    expect(listener).toHaveBeenCalledTimes(1);
    t.advance(3 * MINUTE);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ idleToastDue: true }));
  });
});

describe('UpdateIdleGate with automatic updates off', () => {
  it('hides a ready update, even one that finishes downloading later, until turned back on', () => {
    const t = createGate(afternoon);
    t.gate.setReady('2.4.203');
    t.gate.setEnabled(false);
    t.gate.setReady('2.4.204');
    t.advance(10 * MINUTE);
    expect(t.gate.getState()).toMatchObject({ readyVersion: null, availableVersion: null, idleToastDue: false });
    t.gate.setEnabled(true);
    expect(t.gate.getState()).toMatchObject({ readyVersion: '2.4.204', idleToastDue: true });
  });

  it('cancels Tonight', () => {
    const t = createGate(new Date(2026, 9, 26, 23, 0));
    t.gate.setReady('2.4.203');
    t.gate.setTonight(true);
    t.gate.setEnabled(false);
    t.setSystemIdleMinutes(240);
    t.advance(4 * HOUR);
    expect(t.restartTonight).not.toHaveBeenCalled();
    expect(t.gate.getState().tonight).toBe(false);
  });
});

describe('UpdateIdleGate Tonight', () => {
  const evening = new Date(2026, 9, 26, 23, 0);

  function armedTonight() {
    const t = createGate(evening);
    t.gate.setReady('2.4.203');
    t.gate.setTonight(true);
    return t;
  }

  it('hides the idle toast while Tonight is on', () => {
    const t = armedTonight();
    t.advance(10 * MINUTE);
    expect(t.gate.getState()).toMatchObject({ tonight: true, idleToastDue: false });
  });

  it('restarts inside 2:00 to 5:00 once idle 60 minutes with 30 minutes without input', () => {
    const t = armedTonight();
    t.setSystemIdleMinutes(240);
    t.advance(2 * HOUR + 59 * MINUTE); // 1:59
    expect(t.restartTonight).not.toHaveBeenCalled();
    t.advance(MINUTE); // 2:00
    expect(t.restartTonight).toHaveBeenCalledTimes(1);
    t.advance(MINUTE);
    expect(t.restartTonight).toHaveBeenCalledTimes(1);
  });

  it('waits while someone used the computer in the last 30 minutes', () => {
    const t = armedTonight();
    t.setSystemIdleMinutes(29);
    t.advance(3 * HOUR + 30 * MINUTE); // 2:30
    expect(t.restartTonight).not.toHaveBeenCalled();
    t.setSystemIdleMinutes(30);
    t.advance(MINUTE);
    expect(t.restartTonight).toHaveBeenCalledTimes(1);
  });

  it('waits for 60 idle minutes after an agent finishes', () => {
    const t = armedTonight();
    t.setSystemIdleMinutes(240);
    t.setBusy(oneAgentWorking);
    t.advance(3 * HOUR + 30 * MINUTE); // 2:30
    expect(t.restartTonight).not.toHaveBeenCalled();
    t.setBusy(null);
    t.advance(59 * MINUTE);
    expect(t.restartTonight).not.toHaveBeenCalled();
    t.advance(MINUTE);
    expect(t.restartTonight).toHaveBeenCalledTimes(1);
  });

  it('never restarts outside the window and tries again the next night', () => {
    const t = armedTonight();
    t.setBusy(oneAgentWorking);
    t.advance(6 * HOUR + 1_000); // 5:00, busy all night
    t.setBusy(null);
    t.setSystemIdleMinutes(24 * 60);
    t.advance(12 * HOUR); // 17:00
    expect(t.restartTonight).not.toHaveBeenCalled();
    t.advance(9 * HOUR); // 2:00 the next night
    expect(t.restartTonight).toHaveBeenCalledTimes(1);
  });

  it("Don't restart tonight turns it off", () => {
    const t = armedTonight();
    t.gate.setTonight(false);
    t.setSystemIdleMinutes(240);
    t.advance(4 * HOUR);
    expect(t.restartTonight).not.toHaveBeenCalled();
    expect(t.gate.getState().tonight).toBe(false);
  });
});
