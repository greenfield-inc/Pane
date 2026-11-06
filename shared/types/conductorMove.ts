import type { ImportRunning, ImportSessionResult } from './sessionImport';

/**
 * "Move from Conductor": every Conductor workspace on this Mac becomes a Pane on another
 * machine, with its unpushed commits, uncommitted files and chats. The Mac reads Conductor and
 * packs each workspace; the chosen machine places it with its own Pane.
 */

/** A chat in a Conductor workspace, resumed on the machine by its own id. */
export interface MovableChat {
  /** `<agent>:<session id>`, as the session import uses. */
  key: string;
  agent: string;
  sessionId: string;
  title?: string;
  running: ImportRunning;
  /** Why this chat can't come along; the workspace still moves without it. */
  unavailable?: string;
}

/** One Conductor workspace, as the move dialog lists it. */
export interface MovableWorkspace {
  /** The workspace folder on this Mac. */
  key: string;
  name: string;
  repoName?: string;
  branch?: string;
  /** Uncommitted files (changed, staged or untracked). */
  uncommitted: number;
  /** Commits on the branch that aren't on its remote. */
  unpushed: number;
  chats: MovableChat[];
  /** Why the workspace can't move, shown in place of its checkbox. */
  unavailable?: string;
  /** Whether a chat is running, in Conductor or elsewhere, so the move would copy work in progress. */
  running: boolean;
}

export interface ConductorMoveScan {
  /** absent: no Conductor on this Mac. unreadable: `reason` says why. */
  status: 'ok' | 'absent' | 'unreadable';
  reason?: string;
  /** Files Pane read, for the "What Pane reads" disclosure. */
  storePaths: string[];
  workspaces: MovableWorkspace[];
}

export interface ConductorMoveRequest {
  /** A saved machine's id from `machines:list`. */
  machineId: string;
  /** Workspace keys from the scan. */
  workspaces: string[];
}

export type MovedWorkspaceOutcome = 'moved' | 'already there' | 'not moved';

export interface MovedWorkspaceResult {
  key: string;
  name: string;
  outcome: MovedWorkspaceOutcome;
  paneId?: string;
  paneName?: string;
  /** The worktree on the machine. */
  worktreePath?: string;
  /** What happened and the next step, for anything not moved. */
  reason?: string;
  /** The setup script from the repository's config, run once in the new worktree. */
  setup?: { source: string; ok: boolean; detail?: string };
  chats: ImportSessionResult[];
}

export interface ConductorMoveResult {
  machine: string;
  results: MovedWorkspaceResult[];
  /** Why the import record couldn't be updated, when it couldn't. */
  recordError?: string;
}

export interface ConductorMoveProgress {
  running: boolean;
  done: number;
  total: number;
  /** The workspace being moved now. */
  current?: string;
}

/** The host commands the move calls on the chosen machine. */
export const HOST_PLACEMENT_CHANNELS = {
  uploadStart: 'session-import:upload-start',
  uploadChunk: 'session-import:upload-chunk',
  place: 'session-import:place-workspace',
  status: 'session-import:place-status',
} as const;

/** A file the Mac uploaded for one placement. */
export interface PlacementFile {
  upload: string;
  /** Where it goes, relative to the agent's store on the machine (`projects/<folder>/<id>.jsonl`). */
  path: string;
}

/** What the machine needs to rebuild one workspace. */
export interface HostWorkspacePlacement {
  name: string;
  repo: { name: string; remoteUrl: string };
  branch: string;
  /** The branch's commit on the Mac. */
  head: string;
  /** The branch it tracks on the remote, when it has one. */
  upstreamBranch?: string;
  /** The repository's default branch, which setup scripts read as `CONDUCTOR_DEFAULT_BRANCH`. */
  defaultBranch?: string;
  /**
   * A git bundle with `refs/heads/<branch>` and, when there are uncommitted files,
   * `refs/pane-import/wip`: a commit on the branch holding them. A thin bundle leaves out what the
   * remote already has; none at all when the remote has the whole branch and nothing is uncommitted.
   */
  bundle?: { upload: string; thin: boolean };
  wip: boolean;
  chats: Array<{ agent: 'claude' | 'codex'; sessionId: string; title?: string; files: PlacementFile[] }>;
  origin: { machine: string; folder: string };
  /** The name the Mac saved this machine under, which every message here uses. */
  machineLabel?: string;
}

export type HostPlacementStatus =
  | { state: 'running'; step: string }
  | { state: 'done'; result: HostPlacementResult };

export interface HostPlacementResult extends Omit<MovedWorkspaceResult, 'key'> {
  /** The machine's clone lacks commits a thin bundle left out: send a full one. */
  needsFullBundle?: boolean;
}
