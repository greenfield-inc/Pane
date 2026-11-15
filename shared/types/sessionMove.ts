import { PaneError } from '../paneError';
/**
 * Moving a whole Session to another of your machines (docs/SESSIONS.md, "Move a Session to
 * another machine"). The source Pane runs the move: it stops each tab as its turn ends, packs a
 * manifest, one git bundle per Pane (with a snapshot of uncommitted work), every conversation and
 * the Session folder, and sends them to the target Pane over the existing Pane-to-Pane
 * connection. The target rebuilds the Session with the same IDs on its own paths, starts the
 * tabs once the source is frozen, and the source then retires its copy.
 */

/** The manifest's own format version; a target refuses a package newer than it understands. */
export const SESSION_MOVE_MANIFEST_VERSION = 1;

/** The daemon feature a target reports from `runpane doctor` when it can receive a move. */
export const SESSION_MOVE_FEATURE = 'session-move';

/** Where a Session record stands in a move. Absent on a Session that never moved. */
export type SessionMoveState =
  /** Target: being built, no tab running. Removed if the move fails. */
  | 'arriving'
  /** Source: frozen and read-only while the target starts the tabs. */
  | 'moving'
  /** Source: retired. Archived, read-only, restorable while the archive lasts. */
  | 'moved';

/** The move fields on a Session record. */
export interface SessionMoveMark {
  state: SessionMoveState;
  /** The other machine: the target on the source, the source on the target. */
  machine: string;
  moveId: string;
  at: string;
}

/** One check the target (or the source) ran before anything stops. */
export interface SessionMoveCheck {
  id: string;
  level: 'ok' | 'warning' | 'block';
  title: string;
  /** What will differ, or why it blocks, and what fixing it does. */
  detail?: string;
  fix?: SessionMoveFix;
}

/** A blocking check the dialog can fix with one button, run on the target. */
export type SessionMoveFix =
  | { kind: 'clone'; label: string; remote: string; path: string }
  | { kind: 'trust'; label: string; path: string };

export interface SessionMovePreflight {
  target: string;
  /** False when any check blocks; Move stays disabled. */
  ready: boolean;
  checks: SessionMoveCheck[];
  paneCount: number;
  tabCount: number;
  /** Estimated package size before compression. */
  bytes: number;
}

/** A tab still working while the move waits for turns to end. */
export interface SessionMoveWaitingTab {
  panelId: string;
  title: string;
  paneName: string;
  /** When its current turn started, if known. */
  since?: string;
}

export type SessionMoveStepId = 'stop' | 'pack' | 'send' | 'build' | 'start';

export interface SessionMoveStep {
  id: SessionMoveStepId;
  state: 'pending' | 'running' | 'done' | 'failed';
  title: string;
  detail?: string;
}

/** What the dialog shows while a move runs, after it finishes, or after it fails. */
export interface SessionMoveProgress {
  moveId: string;
  sessionId: string;
  sessionName: string;
  target: string;
  phase:
    /** Waiting for tabs to finish their turn (state 3). */
    | 'waiting'
    /** Packing, sending, building, starting (state 4). */
    | 'moving'
    /** Frozen, waiting for the target to confirm (contact lost after the freeze). */
    | 'confirming'
    | 'done'
    | 'failed'
    | 'cancelled';
  waiting: SessionMoveWaitingTab[];
  stoppedTabs: number;
  totalTabs: number;
  steps: SessionMoveStep[];
  /** Set when done: what moved, what is waiting, what stayed behind. */
  summary?: SessionMoveSummary;
  /** Set when failed: what happened, why, what changed, and the next step. */
  error?: { message: string; next: string };
  /** True once the source froze: a failure from here never restarts tabs on its own. */
  frozen: boolean;
  updatedAt: string;
}

export interface SessionMoveSummary {
  panes: number;
  tabs: number;
  resumed: number;
  /** Tabs that couldn't resume on the target; each shows Retry there. */
  failedTabs: string[];
  approvals: number;
  /** Ignored files that stayed behind, by Pane (rebuilt on the target, not copied). */
  leftBehind: string[];
  /** Env var names set here and not on the target. */
  missingEnv: string[];
}

/** A path prefix on the source and its place on the target. */
export interface SessionMovePathEntry {
  from: string;
  to: string;
}

/** The record written to the Session folder as moved.json on the target. */
export interface SessionMoveRecord {
  moveId: string;
  from: string;
  to: string;
  at: string;
  paths: SessionMovePathEntry[];
  /** Tabs that were working when the move stopped them, and those Stop now interrupted. */
  working: string[];
  interrupted: string[];
  leftBehind: string[];
}

/**
 * The calls the dialog makes on the Session's own host (this computer, or a machine in All
 * machines through `machines.run`'s `move-session` command). Each takes one object argument.
 */
export const SESSION_MOVE_CHANNELS = {
  /** { sessionId, target } → SessionMovePreflight. Runs every check; stops nothing. */
  check: 'runpane:sessions:move-check',
  /** { sessionId, target, fix } → SessionMovePreflight, checked again after the fix ran on the target. */
  fix: 'runpane:sessions:move-fix',
  /** { sessionId, target } → SessionMoveProgress. Starts the move. */
  start: 'runpane:sessions:move',
  /** { sessionId, recheck? } → SessionMoveProgress | null. recheck asks a silent target again ("Check again"). */
  status: 'runpane:sessions:move-status',
  /** { sessionId } → SessionMoveProgress. Interrupts the tabs still working. */
  stopNow: 'runpane:sessions:move-stop-now',
  /** { sessionId } → SessionMoveProgress. Before the freeze only: restarts the stopped tabs here. */
  cancel: 'runpane:sessions:move-cancel',
  /** {} → { peers: string[] }. Loopback test machines (unpackaged builds with PANE_MOVE_TEST_PEERS only). */
  peers: 'runpane:sessions:move-peers',
} as const;

/** The calls the source makes on the target's daemon. */
export const SESSION_MOVE_TARGET_CHANNELS = {
  preflight: 'runpane:move:preflight',
  fix: 'runpane:move:fix',
  write: 'runpane:move:write',
  build: 'runpane:move:build',
  start: 'runpane:move:start',
  abort: 'runpane:move:abort',
  status: 'runpane:move:status',
} as const;

/** The error code a tab answers with while its Session moves. */
export const ERR_SESSION_MOVING = 'ERR_SESSION_MOVING';

/** What a tab stopped for a move says when something sends to it or tries to start it. */
export function sessionMovingError(mark: { machine?: string; arriving?: boolean }): PaneError {
  const machine = mark.machine ?? 'another machine';
  return mark.arriving
    ? new PaneError(ERR_SESSION_MOVING, `This tab's Session is arriving from ${machine} and hasn't started here yet, so nothing was sent or started.`, 'Wait for the move to finish; the tab starts on its own.')
    : new PaneError(ERR_SESSION_MOVING, `This tab's Session is moving to ${machine}, so it takes no messages until the move is done. Nothing was sent or started.`, `Open the Session on ${machine} once the move finishes, or cancel the move to keep it here.`);
}
