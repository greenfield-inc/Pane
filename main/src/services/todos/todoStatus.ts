import { MOVING_TODO_STATES, isOpenTodoState, type TodoRecord, type TodoStatus } from '../../../../shared/types/todos';
import type { LinkedApproval } from './todoStore';

/** The supervisor's first rung: a to-do quiet this long reads red. */
const QUIET_ALERT_MS = 10 * 60_000;

export interface TodoStatusInputs {
  todo: TodoRecord;
  /** Its open sub-to-dos (empty for a sub-to-do). */
  openChildren: readonly TodoRecord[];
  /** Waiting approvals linked to this to-do or any of its open sub-to-dos, oldest first. */
  waiting: readonly LinkedApproval[];
  /** The Session's orchestrator tab, the default assignee. */
  orchestratorPanelId: string | null;
  /** Mid-turn by the Session spinner's test, settled for 10 s. */
  isMidTurn: (panelId: string) => boolean;
  /** "devbox": the machine's name, for "devbox is busy". */
  machineName: string;
  /** The assignee's agent is at its usage limit until this time. */
  usageLimitUntil?: number | null;
  offline?: boolean;
  now: number;
}

function minutes(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60_000));
  if (total < 60) return `${total}m`;
  const hours = Math.floor(total / 60);
  return total % 60 === 0 ? `${hours}h` : `${hours}h ${total % 60}m`;
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** The tab doing a to-do's work: its assignee, or the Session's orchestrator. */
export function workingTabOf(todo: TodoRecord, orchestratorPanelId: string | null): string | null {
  return todo.assignee?.panelId ?? orchestratorPanelId;
}

interface QuietReason {
  reason: string;
  alert: boolean;
}

function quietReason(todo: TodoRecord, now: number): QuietReason {
  const since = todo.stuckSince ?? todo.lastProgressAt ?? todo.startedAt ?? todo.updatedAt;
  const quietFor = now - since;
  const quiet = `quiet ${minutes(quietFor)}`;
  if (todo.episodeRestarts > 0) return { reason: `${quiet} · Pane restarted the orchestrator`, alert: true };
  if (todo.episodeReminders > 0) return { reason: `${quiet} · Pane reminded the orchestrator ${todo.episodeReminders}×`, alert: true };
  return { reason: quiet, alert: quietFor >= QUIET_ALERT_MS };
}

/**
 * Waiting on you wins, then Working, then Queued, then Idle with a reason (D-395, D-408). Never stored:
 * every surface asks this with fresh inputs, so a status can't go stale.
 */
export function deriveTodoStatus(inputs: TodoStatusInputs): TodoStatus {
  const { todo } = inputs;
  if (todo.state === 'done') return { status: 'done', reason: '' };
  if (todo.state === 'dropped') return { status: 'dropped', reason: '' };

  if (inputs.waiting.length > 0) {
    const first = inputs.waiting[0];
    const review = todo.state === 'in_review' && first.todoNumber === todo.number;
    const question = first.title.replace(/^Q-\d+:\s*/, '');
    const waiting: TodoStatus = {
      status: 'waiting',
      reason: review ? 'ready for your review' : [first.qn, question].filter(Boolean).join(' · '),
      waitingApprovalId: first.id, waitingQuestion: question, waitingCount: inputs.waiting.length,
    };
    if (first.qn) waiting.waitingQn = first.qn;
    return waiting;
  }

  const moving = MOVING_TODO_STATES.includes(todo.state);
  if (moving) {
    const tabs = [workingTabOf(todo, inputs.orchestratorPanelId), ...inputs.openChildren.map(child => workingTabOf(child, inputs.orchestratorPanelId))];
    if (tabs.some(tab => tab !== null && inputs.isMidTurn(tab))) return { status: 'working', reason: '' };
  }

  if (todo.loadHold === 'queued') return { status: 'queued', reason: `${inputs.machineName} is busy · starts when load comes down` };
  if (todo.loadHold === 'paused') return { status: 'queued', reason: 'paused for load · resumes when load comes down' };

  if (inputs.offline) return { status: 'idle', idleReason: 'offline', reason: 'machine offline' };
  if (todo.state === 'todo') return { status: 'idle', idleReason: 'not_started', reason: 'not started' };
  if (todo.state === 'stopped') return { status: 'idle', idleReason: 'stopped', reason: 'stopped by you' };
  if (todo.state === 'in_review') return { status: 'idle', idleReason: 'in_review', reason: 'in review' };
  if (inputs.usageLimitUntil && inputs.usageLimitUntil > inputs.now) {
    return { status: 'idle', idleReason: 'usage_limit', reason: `usage limit, resumes ${clock(inputs.usageLimitUntil)}` };
  }
  if (!isOpenTodoState(todo.state)) return { status: 'idle', reason: '' };
  const quiet = quietReason(todo, inputs.now);
  const idle: TodoStatus = { status: 'idle', idleReason: 'quiet', reason: quiet.reason };
  if (quiet.alert) idle.alert = true;
  return idle;
}

/** List order inside a group, and the group order: Waiting on you, Working, Queued, Idle, Done. */
export const STATUS_ORDER = { waiting: 0, working: 1, queued: 2, idle: 3, done: 4, dropped: 5 } as const satisfies Record<TodoStatus['status'], number>;
