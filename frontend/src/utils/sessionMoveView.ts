import type { SessionMoveCheck, SessionMoveMark, SessionMovePreflight, SessionMoveProgress, SessionMoveSummary } from '../../../shared/types/sessionMove';
import type { MoveTarget, MoveTargetList } from './moveSessionToHost';

/** Why a whole-Session move can't go to a teammate's machine (P-16). */
export const TEAMMATE_REASON = 'a teammate’s machine: hand off with a note instead';

/** "1 Pane", "6 Panes". */
function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A move still in flight: the dialog shows it instead of the chooser. */
export function isMoveRunning(progress: SessionMoveProgress | null | undefined): progress is SessionMoveProgress {
  return progress?.phase === 'waiting' || progress?.phase === 'moving' || progress?.phase === 'confirming';
}

/** The dialog's intro, with the Session's counts once the checks have reported them. */
export function moveIntro(preflight: Pick<SessionMovePreflight, 'paneCount' | 'tabCount'> | null): string {
  const what = preflight
    ? `with its ${plural(preflight.paneCount, 'Pane')} and ${plural(preflight.tabCount, 'tab')}`
    : 'with every Pane and tab';
  return `Moves the whole Session, ${what}, to another of your machines. It carries on there from where it is now.`;
}

/** "~140 MB", the package size before compression. */
export function formatMoveBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '~0 MB';
  const mb = bytes / 1_000_000;
  if (mb >= 1000) return `~${(mb / 1000).toFixed(1)} GB`;
  return `~${mb < 1 ? '<1' : Math.round(mb)} MB`;
}

/**
 * The machines a whole-Session move can go to: the handoff list with teammates' machines
 * disabled (they get a note instead), plus loopback test machines the host offers.
 */
export function wholeMoveTargets(list: MoveTargetList, peers: readonly string[]): MoveTargetList {
  if (!list.ok) return list;
  const targets: MoveTarget[] = list.targets.map(target => (
    target.owner ? { ...target, available: false, reason: TEAMMATE_REASON } : target
  ));
  const known = new Set(targets.map(target => target.name.toLowerCase()));
  for (const peer of peers) {
    if (known.has(peer.toLowerCase())) continue;
    known.add(peer.toLowerCase());
    targets.push({ name: peer, available: true });
  }
  return { ok: true, targets, noneReachable: !targets.some(target => target.available) };
}

export function blockingChecks(preflight: SessionMovePreflight | null): SessionMoveCheck[] {
  return preflight?.checks.filter(check => check.level === 'block') ?? [];
}

/** What the selected machine's row says once its checks are back. */
export function targetCheckLabel(preflight: SessionMovePreflight | null, checking: boolean): string | undefined {
  if (checking) return 'checking…';
  if (!preflight) return undefined;
  const blocks = blockingChecks(preflight).length;
  if (blocks > 0) return `needs ${blocks === 1 ? 'a fix' : `${blocks} fixes`}`;
  return `ready · ${formatMoveBytes(preflight.bytes)}`;
}

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/** "studio-b needs two things before the Session can move." */
export function needsFixLine(target: string, blocks: number): string {
  const count = NUMBER_WORDS[blocks] ?? String(blocks);
  return `${target} needs ${blocks === 1 ? 'one thing' : `${count} things`} before the Session can move.`;
}

/** "4 min", "40 s": how long a waiting tab's turn has run. */
export function workingFor(since: string | undefined, nowMs: number): string {
  const started = since ? Date.parse(since) : Number.NaN;
  if (Number.isNaN(started)) return 'working';
  const seconds = Math.max(0, Math.round((nowMs - started) / 1000));
  if (seconds < 60) return `working ${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `working ${minutes} min`;
  return `working ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** The dialog's heading for a move in flight or finished. */
export function progressHeading(progress: SessionMoveProgress): string {
  switch (progress.phase) {
    case 'waiting': {
      const count = progress.waiting.length;
      return `Waiting for ${plural(count, 'agent')} to finish ${count === 1 ? 'its' : 'their'} turn`;
    }
    case 'moving': return `Moving to ${progress.target}`;
    case 'confirming': return `Waiting for ${progress.target} to confirm`;
    case 'done': return `Moved to ${progress.target}`;
    case 'failed': return 'Couldn’t move the Session';
    case 'cancelled': return 'Move cancelled';
  }
}

export function waitingLine(progress: SessionMoveProgress): string {
  return 'Each tab stops as soon as it finishes its turn and takes no messages until the move is done. '
    + `${progress.stoppedTabs} of ${plural(progress.totalTabs, 'tab')} ${progress.stoppedTabs === 1 ? 'has' : 'have'} stopped.`;
}

export function confirmingLine(target: string): string {
  return `${target} hasn’t confirmed it started the Session. Pane keeps asking ${target} on its own: it finishes the move once ${target} confirms, `
    + `or runs the Session here again once ${target} confirms it rolled the move back. Until then it stays paused here, so two copies never run.`;
}

interface MoveSummaryLine {
  level: 'ok' | 'warning';
  title: string;
  detail?: string;
}

/** What state 5 shows: the line under the heading, then one line per thing that moved or differs. */
export interface MoveDoneView {
  lead: string;
  lines: MoveSummaryLine[];
}

/** State 5: the line under the heading, then what moved, what waits there, and what stayed behind. */
export function doneView(summary: SessionMoveSummary | undefined, target: string): MoveDoneView {
  if (!summary) return { lead: `The Session runs on ${target} now.`, lines: [] };
  const resumedAll = summary.failedTabs.length === 0 && summary.resumed === summary.tabs;
  const lead = (resumedAll
    ? `All ${plural(summary.tabs, 'tab')} resumed their conversations there.`
    : `${summary.resumed} of ${plural(summary.tabs, 'tab')} resumed their conversations there.`)
    + ' Each agent was told it moved and to restart its servers and watches.';
  const lines: MoveSummaryLine[] = [
    { level: 'ok', title: `${plural(summary.panes, 'Pane')} on the same branches, uncommitted work included` },
  ];
  if (summary.failedTabs.length > 0) {
    lines.push({ level: 'warning', title: `${plural(summary.failedTabs.length, 'tab')} couldn’t resume`, detail: `${summary.failedTabs.join(', ')}. Each shows Retry on ${target}.` });
  }
  if (summary.approvals > 0) {
    lines.push({ level: 'ok', title: `${plural(summary.approvals, 'open approval')} ${summary.approvals === 1 ? 'is' : 'are'} waiting on ${target}` });
  }
  if (summary.leftBehind.length > 0) {
    lines.push({ level: 'warning', title: `Left behind: ${plural(summary.leftBehind.length, 'ignored file')}`, detail: `${summary.leftBehind.join(', ')}. Listed in the Session folder’s moved.json.` });
  }
  if (summary.stayedHere?.length) {
    lines.push({ level: 'warning', title: `${plural(summary.stayedHere.length, 'Pane')} stayed here, paused`, detail: summary.stayedHere.join(' ') });
  }
  if (summary.missingEnv.length > 0) {
    lines.push({ level: 'warning', title: `${plural(summary.missingEnv.length, 'env var')} ${summary.missingEnv.length === 1 ? 'isn’t' : 'aren’t'} set on ${target}`, detail: `${summary.missingEnv.join(', ')}. Tabs that need them will see them missing.` });
  }
  return { lead, lines };
}

/** "Moving to studio-b", "Moved to studio-b", "Arriving from studio-b". */
export function moveMarkLabel(mark: Pick<SessionMoveMark, 'state' | 'machine'>): string {
  switch (mark.state) {
    case 'moving': return `Moving to ${mark.machine}`;
    case 'moved': return `Moved to ${mark.machine}`;
    case 'arriving': return `Arriving from ${mark.machine}`;
  }
}

/** "14 Nov", in this computer's locale. */
function shortDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'an unknown date' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** State 7's banner on the machine the Session left. */
export function movedBannerLine(mark: Pick<SessionMoveMark, 'machine' | 'at'>): string {
  return `This Session moved to ${mark.machine} on ${shortDate(mark.at)}.`;
}

export function restoreHereWarning(machine: string): string {
  return `Restore it here only if ${machine} no longer runs it: otherwise two copies of the Session run at once.`;
}

/**
 * What the dialog shows for a progress: a move with no tab left working is already on its steps,
 * even before the source's next update says so (no "Waiting for 0 agents").
 */
export function shownProgress(progress: SessionMoveProgress): SessionMoveProgress {
  return progress.phase === 'waiting' && progress.waiting.length === 0 ? { ...progress, phase: 'moving' } : progress;
}
