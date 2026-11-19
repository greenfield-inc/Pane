import { PaneError } from '../../../../shared/paneError';
import { ASK_NEXT_LABEL, stepEdges } from '../../../../shared/profiles/flowGraph';
import {
  PROFILE_END,
  type Profile,
  type ProfileAgentStep,
  type ProfileAskStep,
  type ProfileRun,
  type ProfileRunHistoryEntry,
  type ProfileStep,
} from '../../../../shared/types/profiles';

/**
 * A run's moves, as pure functions: each takes the run and what happened, and returns the
 * next run and the one thing the runner must do next. Nothing here starts a tab or a card.
 */

/** The choices of the card a loop limit raises. */
export const LOOP_GO_AGAIN = 'Go again';
export const LOOP_STOP = 'Stop the run';

export type RunEffect =
  /** Start this step's tab: an agent step or a command. */
  | { kind: 'start-step'; step: ProfileAgentStep | Extract<ProfileStep, { kind: 'command' }> }
  /** Raise this ask as an Approvals card. */
  | { kind: 'ask'; step: ProfileAskStep }
  /** A loop ran its limit: ask whether to go again. */
  | { kind: 'ask-loop'; from: string; took: string; times: number }
  /** A step's tab closed without its outcome (an agent that never reported, a command Pane didn't see exit): ask which outcome it had. */
  | { kind: 'ask-outcome'; step: ProfileAgentStep | Extract<ProfileStep, { kind: 'command' }> }
  | { kind: 'none' };

export interface RunTransition {
  run: ProfileRun;
  effect: RunEffect;
}

type Chooser = ProfileRunHistoryEntry['by'];

interface TakenFacts {
  summary?: string;
  answer?: string;
  panelId?: string;
}

function stepOf(profile: Profile, id: string): ProfileStep {
  const step = profile.flow?.steps.find((candidate) => candidate.id === id);
  if (!step) throw new PaneError('PROFILE_RUN_STEP_MISSING', `The run is at step "${id}", which ${profile.name} ${profile.version} no longer has.`, 'Stop this run and launch the profile again.');
  return step;
}

function edgeKey(from: string, took: string): string {
  return `${from} › ${took}`;
}

/**
 * Whether an edge closes a loop: it points back to a step at or before its own in the file, as
 * the drawing shows it (a loop is an outcome that points back). Only these count toward the limit.
 */
function isLoopEdge(profile: Profile, from: string, to: string): boolean {
  const order = profile.flow?.steps.map((step) => step.id) ?? [];
  const target = order.indexOf(to);
  return target >= 0 && target <= order.indexOf(from);
}

function quoted(names: readonly string[]): string {
  return names.map((name) => `"${name}"`).join(', ');
}

/** Enters `stepId` (or `end`): what the run waits on there, and what to start. */
export function enterStep(run: ProfileRun, profile: Profile, stepId: string, now: string): RunTransition {
  if (stepId === PROFILE_END) {
    return { run: { ...run, state: 'ended', wait: { kind: 'none' }, updatedAt: now }, effect: { kind: 'none' } };
  }
  const step = stepOf(profile, stepId);
  if (step.kind === 'ask') {
    return { run: { ...run, state: 'asking', step: step.id, wait: { kind: 'card', approvalId: '', card: 'ask' }, updatedAt: now }, effect: { kind: 'ask', step } };
  }
  return { run: { ...run, state: 'running', step: step.id, wait: { kind: 'step', panelId: '' }, updatedAt: now }, effect: { kind: 'start-step', step } };
}

/** A new run at the profile's start step. */
export function startRun(run: ProfileRun, profile: Profile, now: string): RunTransition {
  if (!profile.flow) throw new PaneError('PROFILE_TEAM_ONLY', `${profile.name} has no flow, so there is nothing to run.`, 'Launch a profile that has a flow, or add one to this profile.');
  return enterStep(run, profile, profile.flow.start, now);
}

/** Takes one edge out of `from`, unless it is a loop edge that has run its limit, which pauses the run. */
function takeEdge(run: ProfileRun, profile: Profile, from: ProfileStep, took: string, by: Chooser, facts: TakenFacts, now: string): RunTransition {
  const edge = stepEdges(from).find((candidate) => candidate.label === took);
  if (!edge) throw new PaneError('PROFILE_RUN_EDGE_MISSING', `Step ${from.id} has no way out named "${took}".`, 'Pick one of the step\'s outcomes or choices.');
  const entry: ProfileRunHistoryEntry = { step: from.id, took, by, at: now };
  if (facts.answer !== undefined) entry.answer = facts.answer;
  if (facts.summary !== undefined) entry.summary = facts.summary;
  if (facts.panelId !== undefined) entry.panelId = facts.panelId;
  const history = [...run.history, entry];
  const key = edgeKey(from.id, took);
  const loop = isLoopEdge(profile, from.id, edge.to);
  const times = (run.edgeCounts[key] ?? 0) + 1;
  if (loop && times > profile.loopLimit) {
    const pending: NonNullable<ProfileRun['pending']> = { from: from.id, took, to: edge.to, by };
    const carry = facts.answer ?? facts.summary;
    if (carry !== undefined) pending.summary = carry;
    return {
      run: { ...run, history, state: 'paused', pending, wait: { kind: 'card', approvalId: '', card: 'loop' }, updatedAt: now },
      effect: { kind: 'ask-loop', from: from.id, took, times: profile.loopLimit },
    };
  }
  const next: ProfileRun = { ...run, history, edgeCounts: loop ? { ...run.edgeCounts, [key]: times } : run.edgeCounts, updatedAt: now };
  const carry = facts.answer ?? facts.summary;
  if (carry !== undefined) next.carry = carry;
  else delete next.carry;
  delete next.pending;
  return enterStep(next, profile, edge.to, now);
}

function currentAgentStep(run: ProfileRun, profile: Profile): ProfileAgentStep | undefined {
  const step = stepOf(profile, run.step);
  return step.kind === 'agent' ? step : undefined;
}

/**
 * An agent step's `runpane report --outcome`. Throws when the tab isn't the run's current step
 * or the outcome isn't one the step declares; the run does not move then.
 */
export function reportOutcome(run: ProfileRun, profile: Profile, panelId: string, outcome: string, summary: string | undefined, now: string): RunTransition {
  const step = currentAgentStep(run, profile);
  if (run.state !== 'running' || run.wait.kind !== 'step' || run.wait.panelId !== panelId || !step) {
    throw new PaneError('PROFILE_RUN_NOT_THIS_STEP', `This tab is not the current step of ${profile.name} run ${run.id} (it is at ${run.step}, ${run.state}), so the outcome "${outcome}" was not recorded.`, 'Report outcomes only from the tab Pane started for the current step.');
  }
  const allowed = step.outcomes.map((edge) => edge.name);
  if (!allowed.includes(outcome)) {
    throw new PaneError('PROFILE_OUTCOME_UNKNOWN', `Step ${step.id} of ${profile.name} has no outcome "${outcome}"; it allows ${quoted(allowed)}. The run did not move.`, `Report one of them, for example: runpane report --outcome "${allowed[0]}"`);
  }
  return takeEdge(run, profile, step, outcome, 'agent', { summary, panelId }, now);
}

/** How a step's tab ended: its exit code, and the signal that ended it, if one did. */
export interface TabExit {
  code?: number;
  signal?: string;
}

/** Exit codes a shell gives a command killed by SIGHUP (its tab closed), SIGINT (Ctrl+C) or SIGTERM. */
const INTERRUPTED_EXIT_CODES = new Set([129, 130, 143]);

/** An exit the command didn't choose: a signal, no exit code at all (its tab was closed), or a shell's code for a signal. */
function interrupted(exit: TabExit): boolean {
  return exit.signal !== undefined || exit.code === undefined || INTERRUPTED_EXIT_CODES.has(exit.code);
}

/**
 * A step's tab exited. A command takes its first outcome on exit 0 and its second otherwise; one
 * with no outcomes ends the run. A command that was interrupted (Ctrl+C, its tab closed) didn't
 * finish, so like an agent step's tab closing without a report, it asks which outcome it had.
 * Undefined when the tab isn't the run's current step.
 */
export function stepExited(run: ProfileRun, profile: Profile, panelId: string, exit: TabExit, now: string): RunTransition | undefined {
  if (run.state !== 'running' || run.wait.kind !== 'step' || run.wait.panelId !== panelId) return undefined;
  const exitCode = exit.code;
  const step = stepOf(profile, run.step);
  if (step.kind === 'agent' || (step.kind === 'command' && interrupted(exit) && step.outcomes.length > 0)) {
    return { run: { ...run, wait: { kind: 'card', approvalId: '', card: 'set-outcome' }, updatedAt: now }, effect: { kind: 'ask-outcome', step } };
  }
  if (step.kind !== 'command') return undefined;
  if (step.outcomes.length === 0) {
    const entry: ProfileRunHistoryEntry = { step: step.id, by: 'command', panelId, at: now };
    if (exitCode !== undefined) entry.summary = `exit ${exitCode}`;
    return { run: { ...run, history: [...run.history, entry], state: 'ended', wait: { kind: 'none' }, updatedAt: now }, effect: { kind: 'none' } };
  }
  const took = exitCode === 0 ? step.outcomes[0].name : step.outcomes[1].name;
  return takeEdge(run, profile, step, took, 'command', { summary: `${step.title} exited with ${exitCode ?? 'no code'}.`, panelId }, now);
}

/** The person answered the run's current card. Throws for a card the run isn't waiting on, or an answer it doesn't offer. */
export function answerCard(run: ProfileRun, profile: Profile, approvalId: string, answer: string, now: string): RunTransition {
  if (run.wait.kind !== 'card' || run.wait.approvalId !== approvalId) {
    throw new PaneError('PROFILE_RUN_NOT_THIS_CARD', `${profile.name} run ${run.id} is not waiting on that approval.`, 'Answer the run\'s current approval in Approvals.');
  }
  if (run.wait.card === 'loop') {
    const pending = run.pending;
    if (!pending) throw new PaneError('PROFILE_RUN_NOT_PAUSED', `${profile.name} run ${run.id} has no loop waiting.`, 'Look at the run in Profiles.');
    if (answer !== LOOP_GO_AGAIN && answer !== LOOP_STOP) {
      throw new PaneError('PROFILE_CHOICE_UNKNOWN', `The loop card has no choice "${answer}"; it offers ${quoted([LOOP_GO_AGAIN, LOOP_STOP])}.`, 'Pick one of the card\'s buttons.');
    }
    if (answer === LOOP_STOP) {
      const stopped: ProfileRun = { ...run, state: 'ended', wait: { kind: 'none' }, error: `Stopped by you after ${pending.from} › ${pending.took} ran ${profile.loopLimit} times.`, updatedAt: now };
      delete stopped.pending;
      return { run: stopped, effect: { kind: 'none' } };
    }
    // Going again starts the edge's count over, so the loop may run its limit once more.
    const next: ProfileRun = { ...run, edgeCounts: { ...run.edgeCounts, [edgeKey(pending.from, pending.took)]: 1 }, updatedAt: now };
    if (pending.summary !== undefined) next.carry = pending.summary;
    delete next.pending;
    return enterStep(next, profile, pending.to, now);
  }
  const step = stepOf(profile, run.step);
  if (run.wait.card === 'set-outcome') {
    if (step.kind === 'ask' || !step.outcomes.some((edge) => edge.name === answer)) {
      throw new PaneError('PROFILE_OUTCOME_UNKNOWN', `Step ${step.id} has no outcome "${answer}".`, 'Pick one of the outcomes on the card.');
    }
    return takeEdge(run, profile, step, answer, 'you', {}, now);
  }
  if (step.kind !== 'ask') throw new PaneError('PROFILE_RUN_NOT_ASKING', `Step ${step.id} is not an ask.`, 'Look at the run in Profiles.');
  if (step.next !== undefined) return takeEdge(run, profile, step, ASK_NEXT_LABEL, 'you', { answer }, now);
  if (!step.choices.some((edge) => edge.name === answer)) {
    throw new PaneError('PROFILE_CHOICE_UNKNOWN', `"${step.ask}" has no choice "${answer}"; it offers ${quoted(step.choices.map((edge) => edge.name))}.`, 'Pick one of the card\'s buttons.');
  }
  return takeEdge(run, profile, step, answer, 'you', {}, now);
}

/** A step whose tab is gone and whose outcome Pane can't know (it closed while Pane was not running): ask the person. */
export function stepLost(run: ProfileRun, profile: Profile, now: string): RunTransition | undefined {
  if (run.state !== 'running' || run.wait.kind !== 'step') return undefined;
  const step = stepOf(profile, run.step);
  if (step.kind === 'ask' || step.outcomes.length === 0) return undefined;
  return { run: { ...run, wait: { kind: 'card', approvalId: '', card: 'set-outcome' }, updatedAt: now }, effect: { kind: 'ask-outcome', step } };
}

/** "Set outcome…": the person picks the current agent step's outcome themselves. */
export function setOutcome(run: ProfileRun, profile: Profile, outcome: string, now: string): RunTransition {
  const step = currentAgentStep(run, profile);
  if (run.state !== 'running' && !(run.wait.kind === 'card' && run.wait.card === 'set-outcome')) {
    throw new PaneError('PROFILE_RUN_NOT_RUNNING', `${profile.name} run ${run.id} is ${run.state}, so no step outcome can be set.`, 'Set an outcome only while an agent step runs.');
  }
  if (!step) throw new PaneError('PROFILE_RUN_NOT_AGENT_STEP', `Step ${run.step} is not an agent step, so it has no outcome to set.`, 'Wait for the step to finish.');
  const allowed = step.outcomes.map((edge) => edge.name);
  if (!allowed.includes(outcome)) {
    throw new PaneError('PROFILE_OUTCOME_UNKNOWN', `Step ${step.id} of ${profile.name} has no outcome "${outcome}"; it allows ${quoted(allowed)}. The run did not move.`, `Pick one of ${quoted(allowed)}.`);
  }
  return takeEdge(run, profile, step, outcome, 'you', {}, now);
}
