import { MOVING_TODO_STATES, type TodoRecord } from '../../../../shared/types/todos';

/**
 * The supervisor's ladder and limits (P6, D-409): plain code with fixed rules; no agent decides when
 * to nudge. Each in-progress or accepted to-do runs its own ladder from its last progress.
 */
export const SUPERVISOR = {
  passEveryMs: 60_000,
  remind1Ms: 10 * 60_000,
  remind2Ms: 20 * 60_000,
  restartMs: 30 * 60_000,
  cardMs: 40 * 60_000,
  /** After a restart with no progress, the card comes this much later. */
  cardAfterRestartMs: 10 * 60_000,
  /** A tab whose process stopped, or busy without a turn this long, is restarted without waiting for 30 min. */
  hungMs: 5 * 60_000,
  perEpisode: { reminders: 2, restarts: 1 },
  perMachineHour: { reminders: 12, restarts: 4 },
  /** A to-do that stalled this many times today goes straight to a card at its next stall. */
  stallsBeforeCard: 3,
  attachReminderWorkMs: 20 * 60_000,
} as const;

export interface SupervisorInputs {
  todo: TodoRecord;
  now: number;
  /** An approval linked to it or an open sub-to-do waits on the person. */
  waitingOnYou: boolean;
  /** Any agent in its Session is mid-turn. */
  anyMidTurn: boolean;
  /** The person has unsent text in the orchestrator's tab. */
  unsentText: boolean;
  usageLimitUntil: number | null;
  offline: boolean;
  /** The orchestrator's process stopped, its tab is gone, or it has been busy without a turn for 5 min. */
  orchestratorDown: boolean;
  /** The latest progress Pane saw from outside the to-do's row: a commit or push, an approval raised or answered. */
  externalProgressAt: number | null;
  /** When Pane last restarted this to-do's orchestrator in this episode. */
  lastRestartAt: number | null;
  /** The machine's ladder actions in the last hour. */
  machine: { remindersLastHour: number; restartsLastHour: number };
  /** The load gate allows starts now. */
  gateAllowsStart: boolean;
  /** The to-do and its sub-to-dos have at least one attachment. */
  hasAttachments: boolean;
}

export type SupervisorAction =
  | { kind: 'none'; why: string }
  | { kind: 'remind'; rung: 1 | 2 }
  | { kind: 'restart'; why: 'quiet' | 'down' }
  | { kind: 'queue_restart' }
  | { kind: 'card'; why: 'ladder' | 'repeat' | 'reminder_limit' | 'restart_limit' }
  | { kind: 'attach_reminder' };

/** When the to-do last moved: its own write, a commit, an approval, your comment, or its start. */
export function lastMovedAt(todo: TodoRecord, externalProgressAt: number | null): number {
  return Math.max(todo.lastProgressAt ?? 0, todo.startedAt ?? 0, todo.acceptedAt ?? 0, externalProgressAt ?? 0, todo.createdAt);
}

export function decideSupervisorAction(inputs: SupervisorInputs): SupervisorAction {
  const { todo, now } = inputs;
  if (!MOVING_TODO_STATES.includes(todo.state)) return { kind: 'none', why: 'not in progress' };
  if (inputs.waitingOnYou || todo.stuckCardId) return { kind: 'none', why: 'waiting on you' };
  if (todo.loadHold) return { kind: 'none', why: 'queued' };
  if (inputs.offline) return { kind: 'none', why: 'offline' };
  if (inputs.usageLimitUntil !== null && inputs.usageLimitUntil > now) return { kind: 'none', why: 'usage limit' };
  if (inputs.anyMidTurn) return { kind: 'none', why: 'mid-turn' };

  const quietFor = now - lastMovedAt(todo, inputs.externalProgressAt);
  const canType = !inputs.unsentText;
  const restartsLeft = todo.episodeRestarts < SUPERVISOR.perEpisode.restarts;
  const machineRestartsLeft = inputs.machine.restartsLastHour < SUPERVISOR.perMachineHour.restarts;
  const machineRemindersLeft = inputs.machine.remindersLastHour < SUPERVISOR.perMachineHour.reminders;

  const restart = (why: 'quiet' | 'down'): SupervisorAction => {
    if (!machineRestartsLeft) return { kind: 'card', why: 'restart_limit' };
    if (!inputs.gateAllowsStart) return { kind: 'queue_restart' };
    return { kind: 'restart', why };
  };

  // The card: at 40 min, or 10 min after a restart that brought no progress.
  const cardDue = quietFor >= SUPERVISOR.cardMs
    || (todo.episodeRestarts > 0 && inputs.lastRestartAt !== null && now - inputs.lastRestartAt >= SUPERVISOR.cardAfterRestartMs);
  if (cardDue) return { kind: 'card', why: 'ladder' };

  if (inputs.orchestratorDown && restartsLeft && quietFor >= 0) return restart('down');

  if (quietFor < SUPERVISOR.remind1Ms) {
    if (!inputs.hasAttachments && todo.attachRemindedAt === null && todo.state === 'in_progress' && todo.workMs >= SUPERVISOR.attachReminderWorkMs && canType && machineRemindersLeft) {
      return { kind: 'attach_reminder' };
    }
    return { kind: 'none', why: 'moving' };
  }

  // A stall starts here. A to-do that already stalled 3 times today goes straight to you.
  if (todo.stuckSince === null && todo.stallsToday >= SUPERVISOR.stallsBeforeCard && todo.stallsDay === dayOf(now)) return { kind: 'card', why: 'repeat' };

  if (quietFor >= SUPERVISOR.restartMs && restartsLeft) return canType ? restart('quiet') : { kind: 'none', why: 'unsent text' };

  const rung: 1 | 2 | null = quietFor >= SUPERVISOR.remind2Ms && todo.episodeReminders < 2 ? 2 : todo.episodeReminders < 1 ? 1 : null;
  if (rung === null) return { kind: 'none', why: 'next rung not due' };
  if (!machineRemindersLeft) return { kind: 'card', why: 'reminder_limit' };
  if (!canType) return { kind: 'none', why: 'unsent text' };
  return { kind: 'remind', rung };
}

/** The local day a stall is counted on: "2026-11-16". */
export function dayOf(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// ── What Pane types ───────────────────────────────────────────────────────

export function reminderText(todo: TodoRecord, quietMinutes: number, restarted = false): string {
  const prefix = restarted ? `[From Pane, To-dos] Pane restarted you because ${todo.ref} went quiet. ` : '[From Pane, To-dos] ';
  return `${prefix}${todo.ref} "${todo.title}" is in progress and nothing has moved for ${quietMinutes} minutes. Carry it on, ask for review with runpane todos review ${todo.ref}, ask with runpane todos ask ${todo.ref}, or say why it can't move.`;
}

export function attachReminderText(todo: TodoRecord): string {
  return `[From Pane, To-dos] ${todo.ref} has no attachments after 20 minutes of work. Attach the plan, PR, findings or decision pages you made or used: runpane todos attach ${todo.ref} <file|url>.`;
}

export function stuckCardText(todo: TodoRecord, quietMinutes: number): string {
  const did = [todo.episodeReminders > 0 ? `reminded ${todo.episodeReminders === 1 ? 'once' : `${todo.episodeReminders === 2 ? 'twice' : `${todo.episodeReminders} times`}`}` : null, todo.episodeRestarts > 0 ? 'restarted once' : null].filter(Boolean).join(' and ');
  return `${todo.ref} has been stuck for ${quietMinutes} minutes.${did ? ` The orchestrator was ${did}.` : ''}`;
}
