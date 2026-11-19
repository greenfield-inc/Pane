import { describe, expect, it } from 'vitest';
import type { TodoRecord, TodoState } from '../../../../shared/types/todos';
import { STATUS_ORDER, deriveTodoStatus, type TodoStatusInputs } from './todoStatus';
import type { LinkedApproval } from './todoStore';

const NOW = Date.UTC(2026, 10, 16, 15, 0);

function todo(over: Partial<TodoRecord> = {}): TodoRecord {
  return {
    number: 12, ref: 'T-12', sessionId: 's1', parentNumber: null, title: 'Keyboard sheet', summary: '', doneWhen: [], state: 'in_progress',
    requester: { kind: 'person', name: 'you' }, projectId: null, agent: null, assignee: null, createdBy: 'you', createdAt: NOW - 3_600_000,
    startedAt: NOW - 3_600_000, updatedAt: NOW - 60_000, acceptedAt: null, closedAt: null, lastProgressAt: NOW - 60_000, stuckSince: null,
    episodeReminders: 0, episodeRestarts: 0, stallsToday: 0, stallsDay: null, attachRemindedAt: null, workMs: 0, loadHold: null,
    loadHoldSince: null, loadOverride: null, stuckCardId: null, ...over,
  };
}

const approval = (over: Partial<LinkedApproval> = {}): LinkedApproval => ({ id: 'a1', todoNumber: 12, title: 'Q-11: Merge #1352 now?', qn: 'Q-11', createdAt: NOW - 1000, ...over });

function status(over: Partial<TodoStatusInputs> = {}) {
  return deriveTodoStatus({ todo: todo(), openChildren: [], waiting: [], orchestratorPanelId: 'orch', isMidTurn: () => false, machineName: 'devbox', now: NOW, ...over });
}

describe('deriveTodoStatus', () => {
  it('reads Waiting on you, naming the question, whenever an approval waits, over Working and Queued', () => {
    const waiting = [approval()];
    for (const loadHold of [null, 'queued', 'paused'] as const) {
      expect(status({ todo: todo({ loadHold }), waiting, isMidTurn: () => true })).toMatchObject({ status: 'waiting', reason: 'Q-11 · Merge #1352 now?', waitingApprovalId: 'a1', waitingCount: 1 });
    }
  });

  it('reads Waiting on you · ready for your review while its own review waits', () => {
    expect(status({ todo: todo({ state: 'in_review' }), waiting: [approval({ title: 'Review T-12' })] })).toMatchObject({ status: 'waiting', reason: 'ready for your review' });
  });

  it('a parent waits when one of its open sub-to-dos waits', () => {
    expect(status({ waiting: [approval({ todoNumber: 14 })] }).status).toBe('waiting');
  });

  it('reads Working when its assignee, the orchestrator by default, or an open sub-to-do’s assignee is mid-turn', () => {
    expect(status({ isMidTurn: tab => tab === 'orch' }).status).toBe('working');
    expect(status({ todo: todo({ assignee: { panelId: 'w1' } }), isMidTurn: tab => tab === 'w1' }).status).toBe('working');
    expect(status({ todo: todo({ assignee: { panelId: 'w1' } }), isMidTurn: tab => tab === 'orch' }).status).not.toBe('working');
    expect(status({ openChildren: [todo({ number: 14, assignee: { panelId: 'w2' } })], isMidTurn: tab => tab === 'w2' }).status).toBe('working');
    expect(status({ todo: todo({ state: 'accepted' }), isMidTurn: () => true }).status).toBe('working');
  });

  it('never reads Working unless in progress or accepted', () => {
    const states: TodoState[] = ['todo', 'stopped', 'in_review'];
    for (const state of states) {
      expect(status({ todo: todo({ state }), isMidTurn: () => true }).status).toBe('idle');
    }
  });

  it('reads Queued with the machine and why when the load gate holds or paused it', () => {
    expect(status({ todo: todo({ loadHold: 'queued', state: 'todo' }) })).toEqual({ status: 'queued', reason: 'devbox is busy · starts when load comes down' });
    expect(status({ todo: todo({ loadHold: 'paused' }) })).toEqual({ status: 'queued', reason: 'paused for load · resumes when load comes down' });
  });

  it('gives every Idle a reason', () => {
    expect(status({ todo: todo({ state: 'todo' }) })).toMatchObject({ status: 'idle', idleReason: 'not_started', reason: 'not started' });
    expect(status({ todo: todo({ state: 'stopped' }) })).toMatchObject({ idleReason: 'stopped', reason: 'stopped by you' });
    expect(status({ offline: true })).toMatchObject({ idleReason: 'offline', reason: 'machine offline' });
    expect(status({ usageLimitUntil: NOW + 600_000 })).toMatchObject({ idleReason: 'usage_limit' });
    expect(status({ usageLimitUntil: NOW + 600_000 }).reason).toMatch(/^usage limit, resumes /);
    expect(status({ todo: todo({ lastProgressAt: NOW - 3 * 60_000 }) })).toEqual({ status: 'idle', idleReason: 'quiet', reason: 'quiet 3m' });
  });

  it('shows a quiet to-do in red with what Pane did about it', () => {
    expect(status({ todo: todo({ stuckSince: NOW - 34 * 60_000, episodeReminders: 2 }) })).toEqual({ status: 'idle', idleReason: 'quiet', reason: 'quiet 34m · Pane reminded the orchestrator 2×', alert: true });
    expect(status({ todo: todo({ lastProgressAt: NOW - 12 * 60_000 }) })).toMatchObject({ reason: 'quiet 12m', alert: true });
  });

  it('reads Done and Dropped from the state alone', () => {
    expect(status({ todo: todo({ state: 'done' }), waiting: [approval()] }).status).toBe('done');
    expect(status({ todo: todo({ state: 'dropped' }) }).status).toBe('dropped');
  });

  describe('snoozed (round 9, T-17)', () => {
    // Wednesday 18 Nov 2026, 9:00 AM in Los Angeles.
    const until = Date.UTC(2026, 10, 18, 17, 0);
    const snoozed = (over: Partial<NonNullable<TodoRecord['snooze']>> = {}) => todo({
      state: 'stopped', snooze: { until, zone: 'Europe/London', note: 'check Sentry\nthen the logs', action: 'agents', by: 'you', from: 'in_progress', reminderCardId: null, ...over },
    });
    const zone = 'America/Los_Angeles';

    it('reads Snoozed until the time in the host’s zone, with the note’s first line, over Queued and Idle', () => {
      expect(status({ todo: snoozed(), zone })).toEqual({ status: 'snoozed', reason: 'until Wed 9:00 AM · check Sentry' });
      expect(status({ todo: { ...snoozed({ note: '' }), loadHold: 'queued' }, zone })).toEqual({ status: 'snoozed', reason: 'until Wed 9:00 AM' });
    });

    it('ends “· machine offline” when its host is unreachable', () => {
      expect(status({ todo: snoozed({ note: '' }), zone, offline: true })).toEqual({ status: 'snoozed', reason: 'until Wed 9:00 AM · machine offline' });
    });

    it('still reads Waiting on you while an approval waits, with “snoozed until …” after it', () => {
      expect(status({ todo: snoozed(), zone, waiting: [approval()] })).toMatchObject({ status: 'waiting', reason: 'Q-11 · Merge #1352 now? · snoozed until Wed 9:00 AM' });
    });

    it('reads as a plain stopped to-do to a build that knows nothing of snoozing', () => {
      const older = { ...snoozed() };
      delete older.snooze;
      expect(status({ todo: older })).toMatchObject({ status: 'idle', idleReason: 'stopped' });
    });

    it('lists the Snoozed group after Idle', () => {
      expect(STATUS_ORDER.snoozed).toBeGreaterThan(STATUS_ORDER.idle);
      expect(STATUS_ORDER.snoozed).toBeLessThan(STATUS_ORDER.done);
    });
  });
});
