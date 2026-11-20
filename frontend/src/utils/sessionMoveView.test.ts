import { describe, expect, it } from 'vitest';
import type { SessionMovePreflight, SessionMoveProgress } from '../../../shared/types/sessionMove';
import type { TerminalPausedMark } from '../../../shared/types/panels';
import {
  TEAMMATE_REASON, confirmingReason, doneView, formatMoveBytes, isMoveRunning, moveIntro, moveMarkLabel, movedBannerLine, needsFixLine, progressHeading, shownProgress,
  targetCheckLabel, waitingLine, wholeMoveTargets, workingFor,
} from './sessionMoveView';
import { pauseOffersResume, pausedLabel, pausedReason } from './pause';

function progress(overrides: Partial<SessionMoveProgress> = {}): SessionMoveProgress {
  return {
    moveId: 'm1', sessionId: 's1', sessionName: 'Alpha', target: 'studio-b', phase: 'waiting', waiting: [], stoppedTabs: 0, totalTabs: 0,
    steps: [], frozen: false, updatedAt: '2026-11-15T10:00:00Z', ...overrides,
  };
}

function preflight(overrides: Partial<SessionMovePreflight> = {}): SessionMovePreflight {
  return { target: 'studio-b', ready: true, checks: [], paneCount: 6, tabCount: 11, bytes: 140_000_000, ...overrides };
}

describe('moveIntro', () => {
  it('names the counts once the checks report them, and reads without them before', () => {
    expect(moveIntro(preflight())).toBe('Moves the whole Session, with its 6 Panes and 11 tabs, to another of your machines. It carries on there from where it is now.');
    expect(moveIntro(preflight({ paneCount: 1, tabCount: 1 }))).toContain('with its 1 Pane and 1 tab,');
    expect(moveIntro(null)).toBe('Moves the whole Session, with every Pane and tab, to another of your machines. It carries on there from where it is now.');
  });
});

describe('isMoveRunning', () => {
  it('is true only while the move waits, moves or confirms', () => {
    expect(isMoveRunning(null)).toBe(false);
    for (const phase of ['waiting', 'moving', 'confirming'] as const) expect(isMoveRunning(progress({ phase }))).toBe(true);
    for (const phase of ['done', 'failed', 'cancelled'] as const) expect(isMoveRunning(progress({ phase }))).toBe(false);
  });
});

describe('wholeMoveTargets', () => {
  it('disables teammates’ machines with the note reason and adds loopback peers once', () => {
    const list = wholeMoveTargets({ ok: true, noneReachable: false, targets: [
      { name: 'studio-b', available: true },
      { name: 'sam-laptop', owner: 'sam@github', available: true },
    ] }, ['loop-a', 'STUDIO-B']);
    expect(list).toEqual({ ok: true, noneReachable: false, targets: [
      { name: 'studio-b', available: true },
      { name: 'sam-laptop', owner: 'sam@github', available: false, reason: TEAMMATE_REASON },
      { name: 'loop-a', available: true },
    ] });
  });

  it('says none is reachable when only teammates were', () => {
    const list = wholeMoveTargets({ ok: true, noneReachable: false, targets: [{ name: 'sam-laptop', owner: 'sam@github', available: true }] }, []);
    expect(list.ok && list.noneReachable).toBe(true);
  });

  it('passes a failed listing through', () => {
    expect(wholeMoveTargets({ ok: false, reason: 'Signed out', fix: 'Sign in.' }, ['loop-a'])).toEqual({ ok: false, reason: 'Signed out', fix: 'Sign in.' });
  });
});

describe('targetCheckLabel and needsFixLine', () => {
  it('reads checking, ready with the size, or how many fixes', () => {
    expect(targetCheckLabel(null, true)).toBe('checking…');
    expect(targetCheckLabel(null, false)).toBeUndefined();
    expect(targetCheckLabel(preflight(), false)).toBe('ready · ~140 MB');
    const blocked = preflight({ ready: false, checks: [{ id: 'a', level: 'block', title: 'A' }, { id: 'b', level: 'block', title: 'B' }, { id: 'c', level: 'warning', title: 'C' }] });
    expect(targetCheckLabel(blocked, false)).toBe('needs 2 fixes');
    expect(needsFixLine('studio-b', 2)).toBe('studio-b needs two things before the Session can move.');
    expect(needsFixLine('studio-b', 1)).toBe('studio-b needs one thing before the Session can move.');
  });

  it('formats sizes', () => {
    expect(formatMoveBytes(138_400_000)).toBe('~138 MB');
    expect(formatMoveBytes(2_300_000_000)).toBe('~2.3 GB');
    expect(formatMoveBytes(200_000)).toBe('~<1 MB');
  });
});

describe('confirmingReason', () => {
  it('tells a target that is not answering from one that answers without a decision (QA observation 1)', () => {
    const unreachable = confirmingReason(progress({ phase: 'confirming', frozen: true, waitReason: 'unreachable', error: { message: 'studio-b isn’t answering (timed out).', next: 'Open Pane on studio-b.' } }));
    const undecided = confirmingReason(progress({ phase: 'confirming', frozen: true, waitReason: 'undecided', error: { message: 'studio-b answers but can’t say yet whether the move finished.', next: 'Open the Session on studio-b to check it there.' } }));
    expect(unreachable).toEqual({ title: 'studio-b isn’t answering', detail: 'studio-b isn’t answering (timed out). Open Pane on studio-b.' });
    expect(undecided).toEqual({ title: 'studio-b answers, but hasn’t decided the move yet', detail: 'studio-b answers but can’t say yet whether the move finished. Open the Session on studio-b to check it there.' });
    expect(confirmingReason(progress({ phase: 'moving', waitReason: 'unreachable' }))).toBeUndefined();
  });
});

describe('waiting', () => {
  it('counts how long each turn has run', () => {
    const now = Date.parse('2026-11-15T10:04:00Z');
    expect(workingFor('2026-11-15T10:00:00Z', now)).toBe('working 4 min');
    expect(workingFor('2026-11-15T10:03:20Z', now)).toBe('working 40 s');
    expect(workingFor(undefined, now)).toBe('working');
  });

  it('heads with the agents still working and the tabs stopped', () => {
    const tab = { panelId: 'p', title: 'implementer', paneName: 'fix-login' };
    expect(progressHeading(progress({ waiting: [tab, { ...tab, panelId: 'q' }] }))).toBe('Waiting for 2 agents to finish their turn');
    expect(progressHeading(progress({ waiting: [tab] }))).toBe('Waiting for 1 agent to finish its turn');
    expect(waitingLine(progress({ stoppedTabs: 9, totalTabs: 11 }))).toMatch(/9 of 11 tabs have stopped\.$/);
  });

  it('heads every other phase', () => {
    expect(progressHeading(progress({ phase: 'moving' }))).toBe('Moving to studio-b');
    expect(progressHeading(progress({ phase: 'confirming' }))).toBe('Waiting for studio-b to confirm');
    expect(progressHeading(progress({ phase: 'done' }))).toBe('Moved to studio-b');
    expect(progressHeading(progress({ phase: 'failed' }))).toBe('Couldn’t move the Session');
  });
});

describe('doneView', () => {
  it('lists what moved, what waits there and what stayed behind', () => {
    const view = doneView({ panes: 6, tabs: 11, resumed: 11, failedTabs: [], approvals: 3, leftBehind: ['tmp/big.bin'], missingEnv: [] }, 'studio-b');
    expect(view.lead).toMatch(/^All 11 tabs resumed their conversations there\./);
    expect(view.lines.map(line => line.title)).toEqual([
      '6 Panes on the same branches, uncommitted work included',
      '3 open approvals are waiting on studio-b',
      'Left behind: 1 ignored file',
    ]);
  });

  it('says which tabs couldn’t resume and which env vars are missing', () => {
    const view = doneView({ panes: 1, tabs: 3, resumed: 2, failedTabs: ['reviewer'], approvals: 0, leftBehind: [], missingEnv: ['SENTRY_DSN'] }, 'studio-b');
    expect(view.lead).toMatch(/^2 of 3 tabs resumed/);
    expect(view.lines.map(line => [line.level, line.title])).toEqual([
      ['ok', '1 Pane on the same branches, uncommitted work included'],
      ['warning', '1 tab couldn’t resume'],
      ['warning', '1 env var isn’t set on studio-b'],
    ]);
  });
});

describe('move marks', () => {
  it('labels each state and the moved banner', () => {
    expect(moveMarkLabel({ state: 'moving', machine: 'studio-b' })).toBe('Moving to studio-b');
    expect(moveMarkLabel({ state: 'moved', machine: 'studio-b' })).toBe('Moved to studio-b');
    expect(moveMarkLabel({ state: 'arriving', machine: 'studio-a' })).toBe('Arriving from studio-a');
    expect(movedBannerLine({ machine: 'studio-b', at: '2026-11-14T12:00:00Z' })).toMatch(/^This Session moved to studio-b on .*14.*\.$/);
  });

  it('a tab the move stopped says where, with no Resume', () => {
    const moving: TerminalPausedMark = { at: '2026-11-15T10:00:00Z', by: 'move', machine: 'studio-b' };
    expect(pausedLabel(moving)).toBe('Moving to studio-b');
    expect(pausedLabel({ ...moving, arriving: true, machine: 'studio-a' })).toBe('Arriving from studio-a');
    expect(pauseOffersResume(moving)).toBe(false);
    expect(pauseOffersResume({ at: moving.at, by: 'manual' })).toBe(true);
    expect(pausedReason(moving)).toMatch(/move/);
  });
});

describe('shownProgress', () => {
  it('shows the steps once no tab is left working', () => {
    expect(shownProgress(progress({ phase: 'waiting', waiting: [] })).phase).toBe('moving');
  });

  it('keeps the wait while a tab is still working', () => {
    const working = progress({ phase: 'waiting', waiting: [{ panelId: 'p', title: 'reviewer', paneName: 'review-1' }] });
    expect(shownProgress(working).phase).toBe('waiting');
  });
});

describe('doneView', () => {
  it('lists a Pane that stayed here on its own line, apart from the ignored files left behind', () => {
    const stayed = 'Pane “fix-login” stays here, paused, with its worktree: its ignored files couldn\'t be set aside (files are still in /r/.git/pane-moved/p.incoming). Move what you need back.';
    const view = doneView({ panes: 2, tabs: 3, resumed: 3, failedTabs: [], approvals: 0, leftBehind: ['.env in fix-login'], missingEnv: [], stayedHere: [stayed] }, 'studio');
    expect(view.lines).toContainEqual({ level: 'warning', title: '1 Pane stayed here, paused', detail: stayed });
    expect(view.lines).toContainEqual(expect.objectContaining({ title: 'Left behind: 1 ignored file' }));
  });

  it('says which file previews weren’t carried, and why (T-42)', () => {
    const note = 'notes.html (/a/Downloads/notes.html): not carried, the file is outside the Session\'s worktrees and folder, so it stayed on mini';
    const view = doneView({ panes: 1, tabs: 1, resumed: 1, failedTabs: [], approvals: 0, leftBehind: [], missingEnv: [], previewsNotCarried: [note] }, 'studio');
    expect(view.lines).toContainEqual({ level: 'warning', title: '1 file preview tab wasn’t carried', detail: `${note}. Open the file again on studio if you still need it.` });
  });
});
