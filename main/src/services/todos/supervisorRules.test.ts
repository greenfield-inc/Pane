import { describe, expect, it } from 'vitest';
import type { TodoRecord } from '../../../../shared/types/todos';
import { SUPERVISOR, dayOf, decideSupervisorAction, stuckCardText, type SupervisorInputs } from './supervisorRules';

const START = Date.UTC(2026, 10, 16, 9, 0);
const MIN = 60_000;

function todo(over: Partial<TodoRecord> = {}): TodoRecord {
  return {
    number: 12, ref: 'T-12', sessionId: 's1', parentNumber: null, title: 'Keyboard sheet', summary: '', doneWhen: [], state: 'in_progress',
    requester: { kind: 'person', name: 'you' }, projectId: null, agent: null, assignee: null, createdBy: 'you', createdAt: START,
    startedAt: START, updatedAt: START, acceptedAt: null, closedAt: null, lastProgressAt: START, stuckSince: null,
    episodeReminders: 0, episodeRestarts: 0, stallsToday: 0, stallsDay: null, attachRemindedAt: null, workMs: 0, loadHold: null,
    loadHoldSince: null, loadOverride: null, stuckCardId: null, ...over,
  };
}

function decide(minutesQuiet: number, over: Partial<SupervisorInputs> = {}, todoOver: Partial<TodoRecord> = {}) {
  return decideSupervisorAction({
    todo: todo(todoOver), now: START + minutesQuiet * MIN, waitingOnYou: false, anyMidTurn: false, unsentText: false, usageLimitUntil: null,
    offline: false, orchestratorDown: false, externalProgressAt: null, lastRestartAt: null, machine: { remindersLastHour: 0, restartsLastHour: 0 },
    gateAllowsStart: true, hasAttachments: true, ...over,
  });
}

/** Runs the ladder minute by minute the way TodoService applies it, returning [minute, action] for every action. */
function runLadder(minutes: number, over: Partial<SupervisorInputs> = {}): Array<[number, string]> {
  let record = todo();
  let lastRestartAt: number | null = null;
  const actions: Array<[number, string]> = [];
  for (let minute = 1; minute <= minutes; minute += 1) {
    const now = START + minute * MIN;
    const action = decideSupervisorAction({
      todo: record, now, waitingOnYou: false, anyMidTurn: false, unsentText: false, usageLimitUntil: null, offline: false, orchestratorDown: false,
      externalProgressAt: null, lastRestartAt, machine: { remindersLastHour: 0, restartsLastHour: 0 }, gateAllowsStart: true, hasAttachments: true, ...over,
    });
    if (action.kind === 'none') continue;
    actions.push([minute, action.kind === 'remind' ? `remind ${action.rung}` : action.kind]);
    if (action.kind === 'remind') record = { ...record, stuckSince: record.stuckSince ?? now, episodeReminders: record.episodeReminders + 1 };
    if (action.kind === 'restart') { record = { ...record, episodeRestarts: record.episodeRestarts + 1 }; lastRestartAt = now; }
    if (action.kind === 'card') { record = { ...record, stuckCardId: 'card' }; }
  }
  return actions;
}

describe('the supervisor ladder', () => {
  it('reminds at 10 and 20 min, restarts at 30, and raises a card at 40, then stops', () => {
    expect(runLadder(90)).toEqual([[10, 'remind 1'], [20, 'remind 2'], [30, 'restart'], [40, 'card']]);
  });

  it('does nothing while an agent is mid-turn, while you have unsent text, while it waits on you, is queued, offline or at its usage limit', () => {
    expect(decide(15, { anyMidTurn: true }).kind).toBe('none');
    expect(decide(15, { unsentText: true }).kind).toBe('none');
    expect(decide(35, { unsentText: true }).kind).toBe('none');
    expect(decide(15, { waitingOnYou: true }).kind).toBe('none');
    expect(decide(15, {}, { loadHold: 'queued' }).kind).toBe('none');
    expect(decide(15, { offline: true }).kind).toBe('none');
    expect(decide(15, { usageLimitUntil: START + 60 * MIN }).kind).toBe('none');
    expect(decide(15, {}, { state: 'stopped' }).kind).toBe('none');
    expect(decide(15, {}, { state: 'todo' }).kind).toBe('none');
  });

  it('a turn alone does not reset the clock; a commit or other progress does', () => {
    expect(decide(15).kind).toBe('remind');
    expect(decide(15, { externalProgressAt: START + 10 * MIN }).kind).toBe('none');
    expect(decide(15, {}, { lastProgressAt: START + 12 * MIN }).kind).toBe('none');
  });

  it('keeps an accepted to-do moving like an in-progress one', () => {
    expect(decide(15, {}, { state: 'accepted', acceptedAt: START }).kind).toBe('remind');
  });

  it('restarts a dead or hung orchestrator without waiting for 30 minutes, once per episode', () => {
    expect(decide(6, { orchestratorDown: true })).toEqual({ kind: 'restart', why: 'down' });
    expect(decide(6, { orchestratorDown: true }, { episodeRestarts: 1 }).kind).toBe('none');
  });

  it('raises the card 10 minutes after a restart that brought no progress', () => {
    expect(decide(16, { lastRestartAt: START + 6 * MIN }, { episodeRestarts: 1 })).toEqual({ kind: 'card', why: 'ladder' });
  });

  it('waits for the load gate before a restart, and the to-do reads Queued', () => {
    expect(decide(31, { gateAllowsStart: false }, { episodeReminders: 2 })).toEqual({ kind: 'queue_restart' });
  });

  it('holds to 12 reminders and 4 restarts an hour per machine; past that it raises cards', () => {
    expect(decide(11, { machine: { remindersLastHour: SUPERVISOR.perMachineHour.reminders, restartsLastHour: 0 } })).toEqual({ kind: 'card', why: 'reminder_limit' });
    expect(decide(31, { machine: { remindersLastHour: 0, restartsLastHour: SUPERVISOR.perMachineHour.restarts } }, { episodeReminders: 2 })).toEqual({ kind: 'card', why: 'restart_limit' });
  });

  it('sends a to-do that stalled 3 times today straight to you at its next stall', () => {
    expect(decide(11, {}, { stallsToday: 3, stallsDay: dayOf(START) })).toEqual({ kind: 'card', why: 'repeat' });
    expect(decide(11, {}, { stallsToday: 3, stallsDay: '2000-01-01' }).kind).toBe('remind');
  });

  it('sends one attachment reminder after 20 minutes of agent work with no attachments', () => {
    expect(decide(5, { hasAttachments: false }, { workMs: 20 * MIN })).toEqual({ kind: 'attach_reminder' });
    expect(decide(5, { hasAttachments: false }, { workMs: 19 * MIN }).kind).toBe('none');
    expect(decide(5, { hasAttachments: true }, { workMs: 25 * MIN }).kind).toBe('none');
    expect(decide(5, { hasAttachments: false }, { workMs: 25 * MIN, attachRemindedAt: START }).kind).toBe('none');
  });

  it('says what Pane did on the card', () => {
    expect(stuckCardText(todo({ episodeReminders: 2, episodeRestarts: 1 }), 40)).toBe('T-12 has been stuck for 40 minutes. The orchestrator was reminded twice and restarted once.');
  });
});
