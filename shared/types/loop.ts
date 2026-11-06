import { boundary } from '../validation/boundaryDecoder';
import type { BoundarySchema } from '../validation/boundaryDecoder';

/**
 * Loops (scheduled tasks): a cron schedule plus what each run does. A project
 * loop runs the request `runpane panes create` takes, so each run is a new
 * Pane in a fresh worktree. A Session loop sends its prompt to a Session's agent.
 *
 * Loops are for large recurring jobs and run at most once an hour. Agents that
 * only need to wait a few minutes use their own harness's sleep and wake.
 */

export const LOOP_AGENTS = ['claude', 'codex', 'cursor'] as const;
export type LoopAgent = typeof LOOP_AGENTS[number];

/** Saving a Session loop with this target creates a new Session named after the loop. */
export const LOOP_NEW_SESSION = 'new';

/**
 * What a loop stores and can be saved with. Exactly one target (`projectId` or
 * `orchestrationSessionId`), and exactly one of `agent` or `toolCommand`.
 */
export interface LoopInput {
  /** Present when updating an existing loop. */
  id?: string;
  name: string;
  /** A project loop: each run is a new Pane in this project. */
  projectId?: number;
  /**
   * A Session loop: each run sends `initialInput` to this Session's agent. Saving
   * also accepts a Session name or `LOOP_NEW_SESSION`, and stores the Session's id.
   */
  orchestrationSessionId?: string;
  /** Five-field cron, in the host machine's local time zone. Empty for a loop that only starts from GitHub events. */
  cron: string;
  agent?: LoopAgent;
  /** A custom command to run instead of a built-in agent, as `--tool-command`. Project loops only. */
  toolCommand?: string;
  /** Typed into the agent or command after it starts; a Session loop's message to its agent. */
  initialInput?: string;
  /** Worktree and branch name template; defaults to `loop-<name>`. Project loops only. */
  worktreeTemplate?: string;
  enabled: boolean;
  /** GitHub events that also start runs, beside or instead of the cron. Project loops only. */
  github?: LoopGithubTriggers;
}

/**
 * GitHub events that start a project loop's runs. The host that owns the loop
 * polls `repo` with its own `gh` sign-in; nothing passes through Greenfield.
 * Comments and reviews start runs only from repo collaborators.
 */
export interface LoopGithubTriggers {
  /** `owner/name` on github.com. */
  repo: string;
  /** A PR comment or review whose text contains this phrase, such as `/pane`. Omitted: comments start nothing. */
  commentPhrase?: string;
  /** A review that requests changes. */
  changesRequested?: boolean;
  /** A check run on an open PR that fails. */
  checkFailed?: boolean;
  /** A newly opened PR. */
  prOpened?: boolean;
  /** An issue getting this label, such as `agent`. */
  issueLabel?: string;
  /** Let PRs from forks start runs. Off by default. */
  allowForks?: boolean;
  /** The most runs GitHub events start in any hour. `LOOP_DEFAULT_HOURLY_CAP` when omitted. */
  hourlyCap?: number;
}

export type LoopGithubEventKind = 'comment' | 'review' | 'check' | 'pr' | 'label';

/** The GitHub event a run started from, as the run list and the run's prompt show it. */
export interface LoopGithubEvent {
  /** Unique per event, so one event never starts two runs, such as `comment:123`. */
  key: string;
  kind: LoopGithubEventKind;
  repo: string;
  /** The PR or issue number. */
  number: number;
  isPr: boolean;
  url: string;
  /** Who acted: the commenter, reviewer, PR author or labeler. Null for a check run. */
  author: string | null;
  /** GitHub's own timestamp: comment `created_at`, review `submitted_at`, check `completed_at`, PR `created_at` or label event `created_at`. */
  atMs: number;
  /** A short line, such as `Check "test" failed` or `Labeled agent`. */
  summary: string;
  /** Text written on GitHub (comment, review, PR or issue body), quoted as untrusted in the run's prompt. */
  text?: string;
  /** The PR's head branch, when it lives in `repo`. */
  headRef?: string;
  /** The PR comes from a fork. */
  fork?: boolean;
}

export type LoopRunTrigger = 'schedule' | 'manual' | 'github';

/**
 * `started`: the run's Pane was created, or a Session loop's prompt was sent
 * (whether the agent is still working is read from the Pane). `failed`: the
 * Pane could not be created or the Session could not be reached. `skipped`:
 * the slot came and went while Pane was not running.
 */
export type LoopRunStatus = 'started' | 'failed' | 'skipped';

export interface LoopRun {
  id: string;
  loopId: string;
  /** The schedule slot this run is for; the click time for a manual run. */
  slotAtMs: number;
  trigger: LoopRunTrigger;
  status: LoopRunStatus;
  error: string | null;
  /** The run's Pane, once created. Null for a Session loop's runs, which go to the loop's Session. */
  sessionId: string | null;
  /** The GitHub event a `github` run started from, or that a skipped event run was for. */
  event?: LoopGithubEvent;
}

export interface Loop extends Omit<LoopInput, 'id'> {
  id: string;
  createdAtMs: number;
  /** Computed from the cron on read; null while paused or without a cron. */
  nextRunAtMs: number | null;
  /** The schedule as a sentence, such as "Daily at 3:00 AM" (`describeSchedule`, or the cron when no picker mode matches). */
  scheduleText: string;
  /** Newest first: the last `LOOP_KEPT_RUNS`, plus older runs whose Pane was kept for its unsaved work. */
  runs: LoopRun[];
}

/** `loops:preview`: what a cron means, for the form. */
export type LoopSchedulePreview =
  | { ok: true; scheduleText: string; nextRunAtMs: number; /** The next three runs, soonest first. */ nextRunsAtMs: number[] }
  | { ok: false; error: string };

export const loopInputSchema = boundary.object({
  id: boundary.optional(boundary.string),
  name: boundary.string,
  projectId: boundary.optional(boundary.number),
  orchestrationSessionId: boundary.optional(boundary.string),
  cron: boundary.string,
  agent: boundary.optional(boundary.enumeration(...LOOP_AGENTS)),
  toolCommand: boundary.optional(boundary.string),
  initialInput: boundary.optional(boundary.string),
  worktreeTemplate: boundary.optional(boundary.string),
  enabled: boundary.boolean,
  github: boundary.optional(boundary.object({
    repo: boundary.string,
    commentPhrase: boundary.optional(boundary.string),
    changesRequested: boundary.optional(boundary.boolean),
    checkFailed: boundary.optional(boundary.boolean),
    prOpened: boundary.optional(boundary.boolean),
    issueLabel: boundary.optional(boundary.string),
    allowForks: boundary.optional(boundary.boolean),
    hourlyCap: boundary.optional(boundary.number),
  })),
}) satisfies BoundarySchema<LoopInput>;

/** The shortest allowed gap between two runs of one loop. */
export const LOOP_MIN_INTERVAL_MS = 60 * 60 * 1000;

/**
 * A run up to this late still starts. A later one is recorded as skipped:
 * missed runs are never caught up.
 */
export const LOOP_MISS_GRACE_MS = 15 * 60 * 1000;

/** Runs GitHub events start per loop per hour, unless the loop sets its own cap. */
export const LOOP_DEFAULT_HOURLY_CAP = 12;

/** The comment phrase the loop form fills in. */
export const LOOP_DEFAULT_COMMENT_PHRASE = '/pane';

/** How often an awake host polls each watched repo. Two polls fit in the 30 s an event may take to start a run. */
export const LOOP_GITHUB_POLL_MS = 15_000;

/** Run Panes kept per loop; older ones are archived. */
export const LOOP_KEPT_RUNS = 10;

export const LOOP_NAME_MAX_LENGTH = 80;

/** `Nightly Bug Sweep!` → `nightly-bug-sweep`, at most 40 characters, for run Pane and worktree names. */
export function loopSlug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, '') || 'loop';
}
