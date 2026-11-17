import path from 'path';
import { describe, expect, it } from 'vitest';
import type { Profile, ProfileRun } from '../../../../shared/types/profiles';
import { LOOP_GO_AGAIN, LOOP_STOP, answerCard, reportOutcome, setOutcome, startRun, stepExited, type RunTransition } from './flowMachine';
import { loadProfiles } from './profileLoader';

const FIXTURES = path.join(__dirname, '../../../../shared/profiles/fixtures');
const NOW = '2026-11-17T08:00:00.000Z';

function greenfield(): Profile {
  const [loaded] = loadProfiles([{ file: path.join(FIXTURES, 'greenfield.profile.yaml'), origin: 'bundled' }]);
  if (!loaded.profile) throw new Error('fixture did not load');
  return loaded.profile;
}

function newRun(): ProfileRun {
  return { id: 'run-1', profile: 'greenfield', profileVersion: '1.0.0', sessionId: 's1', repoId: 1, prompt: 'Export invoices as CSV', harness: {}, commands: {}, state: 'running', step: '', wait: { kind: 'none' }, edgeCounts: {}, history: [], createdAt: NOW, updatedAt: NOW };
}

function must(transition: RunTransition | undefined): RunTransition {
  if (!transition) throw new Error('expected the run to move');
  return transition;
}

/** Pretends the runner did the effect: the step's tab or the card now exists. */
function started(transition: RunTransition, id: string): ProfileRun {
  const run = transition.run;
  if (run.wait.kind === 'step') return { ...run, wait: { kind: 'step', panelId: id } };
  if (run.wait.kind === 'card') return { ...run, wait: { ...run.wait, approvalId: id } };
  return run;
}

describe('flow machine: greenfield', () => {
  const profile = greenfield();

  it('starts at the start step with the planner\'s tab to open', () => {
    const transition = startRun(newRun(), profile, NOW);
    expect(transition.run).toMatchObject({ state: 'running', step: 'plan', wait: { kind: 'step', panelId: '' } });
    expect(transition.effect).toMatchObject({ kind: 'start-step', step: { id: 'plan', agent: 'planner' } });
  });

  it('routes needs you → the answer ask → the planner again, carrying the answer', () => {
    let run = started(startRun(newRun(), profile, NOW), 'panel-plan');
    let transition = reportOutcome(run, profile, 'panel-plan', 'needs you', 'Q-1: Include refunds?', NOW);
    expect(transition.run).toMatchObject({ state: 'asking', step: 'answer', carry: 'Q-1: Include refunds?' });
    expect(transition.effect).toMatchObject({ kind: 'ask', step: { id: 'answer' } });
    run = started(transition, 'card-1');
    transition = answerCard(run, profile, 'card-1', 'Exclude refunds.', NOW);
    expect(transition.run).toMatchObject({ state: 'running', step: 'plan', carry: 'Exclude refunds.' });
    expect(transition.run.history.map((entry) => [entry.step, entry.took, entry.by])).toEqual([['plan', 'needs you', 'agent'], ['answer', 'answered', 'you']]);
  });

  it('follows run A to the end: approve, build, checks green, approved, merge, merged exits', () => {
    let run = started(startRun(newRun(), profile, NOW), 'p1');
    run = started(reportOutcome(run, profile, 'p1', 'plan ready', undefined, NOW), 'c1');
    expect(run.step).toBe('approve');
    run = started(answerCard(run, profile, 'c1', 'approve', NOW), 'p2');
    expect(run).toMatchObject({ step: 'build', state: 'running' });
    run = started(reportOutcome(run, profile, 'p2', 'PR ready', 'PR #91', NOW), 'p3');
    expect(run.step).toBe('checks');
    run = started(must(stepExited(run, profile, 'p3', 0, NOW)), 'p4');
    expect(run.step).toBe('review');
    run = started(reportOutcome(run, profile, 'p4', 'approved', undefined, NOW), 'c2');
    run = started(answerCard(run, profile, 'c2', 'merge', NOW), 'p5');
    expect(run.step).toBe('merged');
    const end = stepExited(run, profile, 'p5', 0, NOW);
    expect(end?.run).toMatchObject({ state: 'ended', wait: { kind: 'none' } });
    expect(end?.run.history.map((entry) => entry.step)).toEqual(['plan', 'approve', 'build', 'checks', 'review', 'merge', 'merged']);
  });

  it('refuses an undeclared outcome with the allowed ones, and does not move', () => {
    const run = started(startRun(newRun(), profile, NOW), 'p1');
    expect(() => reportOutcome(run, profile, 'p1', 'done', undefined, NOW)).toThrow(expect.objectContaining({
      code: 'PROFILE_OUTCOME_UNKNOWN',
      message: 'Step plan of greenfield has no outcome "done"; it allows "plan ready", "needs you". The run did not move.',
    }));
  });

  it('refuses a report from a tab that is not the current step', () => {
    const run = started(startRun(newRun(), profile, NOW), 'p1');
    expect(() => reportOutcome(run, profile, 'other-tab', 'plan ready', undefined, NOW)).toThrow(expect.objectContaining({ code: 'PROFILE_RUN_NOT_THIS_STEP' }));
  });

  it('pauses on the fourth red build and asks to go again or stop', () => {
    let run = started(startRun(newRun(), profile, NOW), 'p');
    run = started(reportOutcome(run, profile, 'p', 'plan ready', undefined, NOW), 'c');
    run = started(answerCard(run, profile, 'c', 'approve', NOW), 'build');
    let transition: RunTransition | undefined;
    for (let failure = 1; failure <= 4; failure += 1) {
      run = started(reportOutcome(run, profile, 'build', 'PR ready', undefined, NOW), 'checks');
      transition = stepExited(run, profile, 'checks', 1, NOW);
      if (!transition) throw new Error('no transition');
      if (failure < 4) {
        expect(transition.run).toMatchObject({ step: 'build', state: 'running' });
        run = started(transition, 'build');
      }
    }
    expect(transition?.run).toMatchObject({ state: 'paused', step: 'checks', pending: { from: 'checks', took: 'red', to: 'build' }, wait: { kind: 'card', card: 'loop' } });
    expect(transition?.effect).toEqual({ kind: 'ask-loop', from: 'checks', took: 'red', times: 3 });
    const paused = started(must(transition), 'loop-card');
    const again = answerCard(paused, profile, 'loop-card', LOOP_GO_AGAIN, NOW);
    expect(again.run).toMatchObject({ state: 'running', step: 'build', edgeCounts: { 'checks › red': 1 } });
    expect(again.run.pending).toBeUndefined();
    const stopped = answerCard(paused, profile, 'loop-card', LOOP_STOP, NOW);
    expect(stopped.run).toMatchObject({ state: 'ended' });
    expect(stopped.run.error).toContain('ran 3 times');
  });

  it('honours a profile\'s own loop_limit', () => {
    const tight: Profile = { ...profile, loopLimit: 1 };
    let run = started(startRun(newRun(), tight, NOW), 'p');
    run = started(reportOutcome(run, tight, 'p', 'needs you', undefined, NOW), 'c');
    run = started(answerCard(run, tight, 'c', 'answer', NOW), 'p');
    // plan › needs you points forward and never counts; answer › answered points back.
    run = started(reportOutcome(run, tight, 'p', 'needs you', undefined, NOW), 'c');
    expect(answerCard(run, tight, 'c', 'again', NOW).run).toMatchObject({ state: 'paused', pending: { from: 'answer', to: 'plan' } });
  });

  it('asks for the outcome when an agent step\'s tab closes without a report, and takes the answer', () => {
    const run = started(startRun(newRun(), profile, NOW), 'p1');
    const closed = stepExited(run, profile, 'p1', undefined, NOW);
    expect(closed?.run.wait).toEqual({ kind: 'card', approvalId: '', card: 'set-outcome' });
    expect(closed?.effect).toMatchObject({ kind: 'ask-outcome', step: { id: 'plan' } });
    const asked = started(must(closed), 'set');
    expect(answerCard(asked, profile, 'set', 'plan ready', NOW).run).toMatchObject({ step: 'approve', state: 'asking' });
    expect(() => answerCard(asked, profile, 'set', 'nope', NOW)).toThrow(expect.objectContaining({ code: 'PROFILE_OUTCOME_UNKNOWN' }));
  });

  it('lets the person set the running step\'s outcome', () => {
    const run = started(startRun(newRun(), profile, NOW), 'p1');
    const moved = setOutcome(run, profile, 'plan ready', NOW);
    expect(moved.run.step).toBe('approve');
    expect(moved.run.history[0]).toMatchObject({ step: 'plan', took: 'plan ready', by: 'you' });
  });

  it('refuses a choice the ask does not offer, and a card the run is not waiting on', () => {
    let run = started(startRun(newRun(), profile, NOW), 'p');
    run = started(reportOutcome(run, profile, 'p', 'plan ready', undefined, NOW), 'c');
    expect(() => answerCard(run, profile, 'c', 'ship it', NOW)).toThrow(expect.objectContaining({ code: 'PROFILE_CHOICE_UNKNOWN' }));
    expect(() => answerCard(run, profile, 'another', 'approve', NOW)).toThrow(expect.objectContaining({ code: 'PROFILE_RUN_NOT_THIS_CARD' }));
  });

  it('ignores an exit from a tab that is not the current step', () => {
    const run = started(startRun(newRun(), profile, NOW), 'p1');
    expect(stepExited(run, profile, 'someone-else', 0, NOW)).toBeUndefined();
  });

  it('refuses to start a team-only profile', () => {
    const { flow: _flow, ...teamOnly } = profile;
    expect(() => startRun(newRun(), teamOnly, NOW)).toThrow(expect.objectContaining({ code: 'PROFILE_TEAM_ONLY' }));
  });
});
