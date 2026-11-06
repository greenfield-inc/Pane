import { randomUUID } from 'crypto';
import {
  LOOP_DEFAULT_HOURLY_CAP,
  LOOP_GITHUB_POLL_MS,
  LOOP_KEPT_RUNS,
  LOOP_MISS_GRACE_MS,
  LOOP_NAME_MAX_LENGTH,
  type Loop,
  type LoopAgent,
  type LoopGithubEvent,
  type LoopGithubTriggers,
  type LoopInput,
  type LoopRun,
  type LoopRunTrigger,
} from '../../../../shared/types/loop';
import type { GithubEventCandidate, GithubEventWants } from './githubLoopEvents';
import { PaneError } from '../../../../shared/paneError';
import { decideLoop, nextLoopRun, previewLoopSchedule } from './loopSchedule';
import type { LoopRepository, StoredLoop } from './loopRepository';
import type { Logger } from '../../utils/logger';

/** The note on an old run whose Pane was not archived. */
const KEPT_RUN_NOTE = 'Kept because the run Pane has unfinished work (a busy agent, unsent input, or uncommitted or unpushed changes). Archive it yourself when you\'re done.';

/** The longest the timer sleeps, so a changed clock or a slept laptop is noticed within the grace period. */
const MAX_SLEEP_MS = 60 * 1000;

/** Handled GitHub events are remembered this long; the event source lists only the last day. */
const GITHUB_EVENT_MEMORY_MS = 48 * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;

/**
 * Starts one run: a project loop's Pane, as `runpane panes create`, returning
 * its id; or a Session loop's message to its agent, returning no Pane. A run a
 * GitHub event starts gets the event.
 */
export type LoopRunStarter = (loop: StoredLoop, slotAtMs: number, event?: LoopGithubEvent) => Promise<{ sessionId: string | null; warning?: string }>;

export interface LoopManagerOptions {
  repo: LoopRepository;
  startRun: LoopRunStarter;
  /** Archive a run Pane that fell out of the kept runs. False when Pane refused, to keep unfinished work. */
  archiveRun: (sessionId: string) => Promise<boolean>;
  projectExists: (projectId: number) => boolean;
  /**
   * Resolve a Session loop's target (an id, a name or `LOOP_NEW_SESSION`) to a
   * Session id, and make that Session's agent run `agent` without permission prompts.
   */
  prepareSession: (target: string, loop: { name: string; agent: LoopAgent }) => Promise<string>;
  /** Polls a repo for recent events, with this host's own `gh` sign-in. Without it, GitHub triggers start nothing. */
  githubEvents?: { poll: (repo: string, wants: GithubEventWants) => Promise<GithubEventCandidate[]> };
  /** A project's `owner/name` on github.com from its origin remote, for GitHub triggers saved without a repo. */
  projectGithubRepo?: (projectId: number) => Promise<string | null>;
  /** Whether a run's Pane still has an agent at work, so a second event on the same PR waits. */
  runActive?: (sessionId: string) => boolean;
  /** Called after any loop or run changes, so clients refetch. */
  onChange?: () => void;
  now?: () => number;
  logger?: Logger;
}

/**
 * Runs loops when they come due. One timer sleeps until the next due loop,
 * capped at a few minutes, and is re-armed whenever a loop changes.
 */
export class LoopManager {
  private timer: NodeJS.Timeout | null = null;
  private githubTimer: NodeJS.Timeout | null = null;
  private polling: Promise<void> | null = null;
  private started = false;
  private ticking: Promise<void> | null = null;
  /** Loops whose run is being created, so one run is never started twice at once. */
  private readonly starting = new Set<string>();
  /** Old runs whose Pane is being archived, so two trims never archive one Pane twice. */
  private readonly archiving = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly options: LoopManagerOptions) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.wake();
    this.armGithub();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.githubTimer) clearTimeout(this.githubTimer);
    this.githubTimer = null;
  }

  list(): Loop[] {
    return this.options.repo.list().map(loop => this.present(loop));
  }

  async save(input: LoopInput): Promise<Loop> {
    const { repo } = this.options;
    const name = input.name.trim();
    const cron = input.cron.trim().replace(/\s+/g, ' ');
    const toolCommand = input.toolCommand?.trim() || undefined;
    if (!name) throw new PaneError('ERR_LOOP_INVALID', 'A loop needs a name. Nothing was saved.', 'Add a name, then save again.');
    if (name.length > LOOP_NAME_MAX_LENGTH) {
      throw new PaneError('ERR_LOOP_INVALID', `A loop name can be at most ${LOOP_NAME_MAX_LENGTH} characters; this one has ${name.length}. Nothing was saved.`, 'Shorten the name, then save again.');
    }
    const sessionTarget = input.orchestrationSessionId?.trim() || undefined;
    if ((input.projectId === undefined) === (sessionTarget === undefined)) {
      throw new PaneError('ERR_LOOP_INVALID', 'A loop targets either a project or a Session. Nothing was saved.', 'Give exactly one of projectId or orchestrationSessionId (`--repo` or `--session`).');
    }
    if (input.projectId !== undefined && !this.options.projectExists(input.projectId)) {
      throw new PaneError('ERR_LOOP_INVALID', `Project ${input.projectId} does not exist. Nothing was saved.`, 'Pick a saved project (`runpane repos list`), then save again.');
    }
    if (Boolean(input.agent) === Boolean(toolCommand)) {
      throw new PaneError('ERR_LOOP_INVALID', 'A loop runs either an agent or a command. Nothing was saved.', 'Give exactly one of agent or toolCommand.');
    }
    const initialInput = input.initialInput?.trim() ? input.initialInput : undefined;
    if (sessionTarget && toolCommand) {
      throw new PaneError('ERR_LOOP_INVALID', 'A Session loop sends its prompt to the Session\'s agent, so it cannot run a command. Nothing was saved.', 'Choose claude, codex or cursor as the agent, or target a project to run a command.');
    }
    if (sessionTarget && !initialInput) {
      throw new PaneError('ERR_LOOP_INVALID', 'A Session loop needs a prompt to send to the Session\'s agent. Nothing was saved.', 'Add the prompt (`--prompt`), then save again.');
    }
    const derivedRepo = input.github && !input.github.repo.trim() && input.projectId !== undefined
      ? await this.options.projectGithubRepo?.(input.projectId) ?? null
      : null;
    const github = input.github ? validGithubTriggers(derivedRepo ? { ...input.github, repo: derivedRepo } : input.github) : undefined;
    if (github && sessionTarget) {
      throw new PaneError('ERR_LOOP_INVALID', 'GitHub events start runs in a project, so a Session loop cannot use them. Nothing was saved.', 'Target a project (`--repo`), or remove the GitHub trigger.');
    }
    const nowMs = this.now();
    if (cron || !github) {
      const preview = previewLoopSchedule(cron, nowMs);
      if (!preview.ok) throw new PaneError('ERR_LOOP_INVALID', `${preview.error} Nothing was saved.`, 'Fix the cron, then save again.');
    }

    const existing = input.id ? repo.get(input.id) : null;
    if (input.id && !existing) throw loopNotFound(input.id);
    // Last, since a new Session is created here: everything else about the loop is valid.
    const orchestrationSessionId = sessionTarget && input.agent
      ? await this.options.prepareSession(sessionTarget, { name, agent: input.agent })
      : undefined;
    // A new cron, new GitHub triggers or a resume counts from now, so it never replays older slots or events.
    const restartsSchedule = !existing || existing.cron !== cron || (!existing.enabled && input.enabled)
      || JSON.stringify(existing.github ?? null) !== JSON.stringify(github ?? null);
    const loop: StoredLoop = {
      id: existing?.id ?? randomUUID(),
      name,
      projectId: orchestrationSessionId ? undefined : input.projectId,
      orchestrationSessionId,
      cron,
      agent: toolCommand ? undefined : input.agent,
      toolCommand,
      initialInput,
      // A Session loop's runs have no worktree.
      worktreeTemplate: orchestrationSessionId ? undefined : input.worktreeTemplate?.trim() || undefined,
      enabled: input.enabled,
      scheduleFromMs: restartsSchedule ? nowMs : existing.scheduleFromMs,
      createdAtMs: existing?.createdAtMs ?? nowMs,
      ...(github ? { github } : {}),
    };
    repo.upsert(loop);
    this.changed();
    return this.present(loop);
  }

  delete(id: string): void {
    if (!this.options.repo.get(id)) throw loopNotFound(id);
    this.options.repo.delete(id);
    this.changed();
  }

  setEnabled(id: string, enabled: boolean): Loop {
    const loop = this.options.repo.get(id);
    if (!loop) throw loopNotFound(id);
    if (loop.enabled !== enabled) {
      loop.enabled = enabled;
      if (enabled) loop.scheduleFromMs = this.now();
      this.options.repo.upsert(loop);
      this.changed();
    }
    return this.present(loop);
  }

  /**
   * Start a run now. The schedule is unchanged. With `runId`, start the
   * GitHub event that skipped run was for.
   */
  async runNow(id: string, runId?: string): Promise<Loop> {
    const loop = this.options.repo.get(id);
    if (!loop) throw loopNotFound(id);
    if (runId) {
      if (this.options.repo.getRun(runId)?.loopId !== id) {
        throw new PaneError('ERR_LOOP_NOT_FOUND', `Loop "${loop.name}" has no run ${runId}. Nothing was started.`, 'List the loop\'s runs with `runpane loops list --json` and pick a run id from it.');
      }
      return this.runEvent(runId);
    }
    if (this.starting.has(id)) {
      throw new PaneError('ERR_LOOP_STARTING', `A run of "${loop.name}" is already starting. No second run was started.`, 'Wait for it to appear, then run again if you need another.');
    }
    await this.execute(loop, this.now(), 'manual');
    return this.present(this.options.repo.get(id) ?? loop);
  }

  /**
   * Start a run from the GitHub event a skipped run was for: an event that was
   * missed, over the hourly cap, or on a PR with an active run.
   */
  async runEvent(runId: string): Promise<Loop> {
    const { repo } = this.options;
    const run = repo.getRun(runId);
    const loop = run ? repo.get(run.loopId) : null;
    if (!run?.event || !loop) {
      throw new PaneError('ERR_LOOP_NOT_FOUND', `No run ${runId} came from a GitHub event. Nothing was started.`, 'List the loop\'s runs with `runpane loops list` and pick a run that shows a GitHub event.');
    }
    repo.markEventStarted(loop.id, run.event.key, this.now());
    await this.execute(loop, this.now(), 'github', run.event);
    return this.present(repo.get(loop.id) ?? loop);
  }

  /** One poll of every watched repo: start runs for new events and list the ones that start nothing. */
  pollGithub(): Promise<void> {
    this.polling ??= this.runGithubPoll().finally(() => { this.polling = null; });
    return this.polling;
  }

  private async runGithubPoll(): Promise<void> {
    const { repo, githubEvents, logger } = this.options;
    if (!githubEvents) return;
    const watching = repo.list().filter(loop => loop.enabled && loop.github && loop.projectId !== undefined);
    const byRepo = new Map<string, typeof watching>();
    for (const loop of watching) {
      const key = loop.github!.repo.toLowerCase();
      byRepo.set(key, [...(byRepo.get(key) ?? []), loop]);
    }
    const starts: Array<Promise<void>> = [];
    for (const [repoName, loops] of byRepo) {
      let candidates: GithubEventCandidate[];
      try {
        candidates = await githubEvents.poll(repoName, wantsOf(loops.map(loop => loop.github!)));
      } catch (error) {
        logger?.warn(`[Loops] Could not read GitHub events for ${repoName}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      for (const loop of loops) {
        for (const candidate of candidates) {
          const start = this.handleEvent(loop, candidate);
          if (start) starts.push(start);
        }
      }
    }
    repo.pruneEvents(this.now() - GITHUB_EVENT_MEMORY_MS);
    await Promise.all(starts);
  }

  /**
   * Decide, now and in order, what one event does for one loop: nothing, a
   * skipped run that says why, or a run. Returns the run's start, so the runs
   * of one poll start together.
   */
  private handleEvent(loop: StoredLoop, candidate: GithubEventCandidate): Promise<void> | null {
    const { repo } = this.options;
    const { event } = candidate;
    const triggers = loop.github!;
    if (event.atMs < loop.scheduleFromMs) return null;
    const verdict = eventVerdict(triggers, candidate);
    if (verdict === 'ignore') return null;
    if (!repo.claimEvent(loop.id, event.key, event.atMs)) return null;
    const nowMs = this.now();
    const skipReason = verdict !== 'start' ? verdict.skip
      : nowMs - event.atMs > LOOP_MISS_GRACE_MS ? 'Missed while Pane was not running or the computer was asleep. Use Run now to start it.'
        : event.isPr && this.activeOnPr(loop.id, event.number) ? 'A run is already active on this PR. Use Run now to start another.'
          : repo.eventRunsSince(loop.id, nowMs - HOUR_MS) >= (triggers.hourlyCap ?? LOOP_DEFAULT_HOURLY_CAP)
            ? `This loop already started ${triggers.hourlyCap ?? LOOP_DEFAULT_HOURLY_CAP} runs from GitHub in the last hour, its hourly cap. Use Run now to start this one anyway.`
            : null;
    if (skipReason) {
      repo.addRun({ id: randomUUID(), loopId: loop.id, slotAtMs: event.atMs, trigger: 'github', status: 'skipped', error: skipReason, sessionId: null, event });
      this.trim(loop.id);
      this.options.onChange?.();
      return null;
    }
    repo.markEventStarted(loop.id, event.key, nowMs);
    return this.execute(loop, event.atMs, 'github', event);
  }

  private activeOnPr(loopId: string, number: number): boolean {
    const runActive = this.options.runActive ?? (() => false);
    return this.options.repo.runs(loopId).some(run => run.status === 'started' && run.event?.isPr && run.event.number === number
      && run.sessionId !== null && runActive(run.sessionId));
  }

  /** One pass over the loops: start what is due and record what was missed. */
  tick(): Promise<void> {
    this.ticking ??= this.runTick().finally(() => { this.ticking = null; });
    return this.ticking;
  }

  private async runTick(): Promise<void> {
    const { repo } = this.options;
    for (const { id } of repo.list()) {
      if (!this.started) return;
      if (this.starting.has(id)) continue;
      // Read again: an earlier loop's start can take minutes, and this one may
      // have been edited, paused or deleted meanwhile.
      const loop = repo.get(id);
      if (!loop?.enabled || !loop.cron) continue;
      const decision = decideLoop(loop.cron, this.countsFrom(loop), this.now());
      if (decision.kind === 'skip') {
        this.options.logger?.info(`[Loops] Skipped "${loop.name}": its run came due while Pane was not running or the computer was asleep.`);
        repo.addRun({
          id: randomUUID(),
          loopId: loop.id,
          slotAtMs: decision.slotAtMs,
          trigger: 'schedule',
          status: 'skipped',
          error: 'Pane was not running, or the computer was asleep, when this run came due.',
          sessionId: null,
        });
        this.trim(loop.id);
        this.options.onChange?.();
      } else if (decision.kind === 'run') {
        await this.execute(loop, decision.slotAtMs, 'schedule');
      }
    }
  }

  private async execute(loop: StoredLoop, slotAtMs: number, trigger: LoopRunTrigger, event?: LoopGithubEvent): Promise<void> {
    const { repo } = this.options;
    // Recorded before the Pane exists, so a crash mid-create cannot run the slot twice.
    const run: LoopRun = { id: randomUUID(), loopId: loop.id, slotAtMs, trigger, status: 'started', error: null, sessionId: null, ...(event ? { event } : {}) };
    repo.addRun(run);
    // Runs from events start side by side; the set guards one schedule or manual run at a time.
    if (!event) this.starting.add(loop.id);
    try {
      this.options.onChange?.();
      const { sessionId, warning } = await this.options.startRun(loop, slotAtMs, event);
      repo.finishRun(run.id, { status: 'started', error: warning ?? null, sessionId });
      const where = sessionId ? `as Pane ${sessionId}` : `for Session ${loop.orchestrationSessionId}`;
      this.options.logger?.info(`[Loops] Started "${loop.name}" ${where}${warning ? `; it needs attention: ${warning}` : '.'}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      repo.finishRun(run.id, { status: 'failed', error: message, sessionId: null });
      this.options.logger?.warn(`[Loops] "${loop.name}" did not start: ${message}`);
    } finally {
      if (!event) this.starting.delete(loop.id);
    }
    this.trim(loop.id);
    this.options.onChange?.();
  }

  /**
   * Archive the Panes of runs past the kept ten, and drop each row once its Pane
   * is gone. Rows without a Pane (Session loop runs, failures, skips) just go. A Pane kept for its unfinished work keeps its row, with a note, so the
   * loop still links to it. Trimming never fails a run.
   */
  private trim(loopId: string): void {
    const { repo, logger } = this.options;
    let old: LoopRun[];
    try {
      old = repo.oldRuns(loopId, LOOP_KEPT_RUNS);
    } catch (error) {
      logger?.warn(`[Loops] Could not trim old runs: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    for (const run of old) {
      const { sessionId } = run;
      if (!sessionId) {
        repo.deleteRun(run.id);
        continue;
      }
      if (this.archiving.has(run.id)) continue;
      this.archiving.add(run.id);
      void this.options.archiveRun(sessionId)
        .then(archived => {
          if (archived) {
            repo.deleteRun(run.id);
          } else {
            logger?.info(`[Loops] Kept old run Pane ${sessionId}: it has unfinished work (a busy agent, unsent input, or uncommitted or unpushed changes).`);
            repo.finishRun(run.id, { status: run.status, error: KEPT_RUN_NOTE, sessionId });
          }
        }, error => {
          // The Pane is gone or was archived elsewhere; the row has nothing left to link to.
          logger?.warn(`[Loops] Dropped old run Pane ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
          repo.deleteRun(run.id);
        })
        .catch(error => logger?.warn(`[Loops] Could not update old run ${run.id}: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => {
          this.archiving.delete(run.id);
          this.options.onChange?.();
        });
    }
  }

  private countsFrom(loop: StoredLoop): number {
    return Math.max(loop.scheduleFromMs, this.options.repo.lastScheduledSlot(loop.id) ?? 0);
  }

  private present(loop: StoredLoop): Loop {
    const { scheduleFromMs: _scheduleFromMs, ...stored } = loop;
    const preview = loop.cron ? previewLoopSchedule(loop.cron, this.now()) : null;
    const events = loop.github ? `On GitHub events in ${loop.github.repo}` : null;
    return {
      ...stored,
      nextRunAtMs: loop.enabled && loop.cron ? nextLoopRun(loop.cron, Math.max(this.countsFrom(loop), this.now())) : null,
      scheduleText: [preview ? (preview.ok ? preview.scheduleText : `Cron ${loop.cron}`) : null, events].filter(Boolean).join(', and '),
      runs: this.options.repo.runs(loop.id),
    };
  }

  /** Tell clients, and re-arm the timer for the changed schedule. */
  private changed(): void {
    this.options.onChange?.();
    this.wake();
  }

  /** Tick now, then sleep until the next due loop. */
  private wake(): void {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    void this.tick()
      .catch(error => this.options.logger?.error('[Loops] Tick failed', error instanceof Error ? error : undefined))
      .finally(() => this.arm())
      .catch(error => this.options.logger?.error('[Loops] Could not schedule the next tick', error instanceof Error ? error : undefined));
  }

  private arm(): void {
    if (!this.started || this.timer) return;
    const nowMs = this.now();
    let sleepMs = MAX_SLEEP_MS;
    for (const loop of this.options.repo.list()) {
      if (!loop.enabled || !loop.cron) continue;
      const next = nextLoopRun(loop.cron, Math.max(this.countsFrom(loop), nowMs));
      if (next !== null) sleepMs = Math.min(sleepMs, next - nowMs);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.wake();
    }, Math.max(1_000, sleepMs));
    this.timer.unref?.();
  }

  /** Poll watched repos every `LOOP_GITHUB_POLL_MS` while any enabled loop has GitHub triggers. */
  private armGithub(): void {
    if (!this.started || !this.options.githubEvents || this.githubTimer) return;
    this.githubTimer = setTimeout(() => {
      this.githubTimer = null;
      void this.pollGithub()
        .catch(error => this.options.logger?.error('[Loops] GitHub poll failed', error instanceof Error ? error : undefined))
        .finally(() => this.armGithub());
    }, LOOP_GITHUB_POLL_MS);
    this.githubTimer.unref?.();
  }
}

/** What one event does for a loop: start a run, a skipped run with a reason, or nothing. */
function eventVerdict(triggers: LoopGithubTriggers, candidate: GithubEventCandidate): 'start' | 'ignore' | { skip: string } {
  const { event } = candidate;
  const phrase = triggers.commentPhrase;
  const hasPhrase = Boolean(phrase && event.text?.toLowerCase().includes(phrase.toLowerCase()));
  let wanted: boolean | { skip: string };
  switch (event.kind) {
    case 'comment':
      wanted = !phrase ? false : hasPhrase || { skip: `The comment does not contain "${phrase}".` };
      break;
    case 'review':
      wanted = (triggers.changesRequested && candidate.reviewState === 'CHANGES_REQUESTED') || hasPhrase;
      break;
    case 'check':
      wanted = Boolean(triggers.checkFailed);
      break;
    case 'pr':
      wanted = Boolean(triggers.prOpened);
      break;
    case 'label':
      wanted = Boolean(triggers.issueLabel && candidate.label?.toLowerCase() === triggers.issueLabel.toLowerCase());
      break;
  }
  if (wanted === false) return 'ignore';
  if (wanted !== true) return wanted;
  if (event.isPr && event.fork && !triggers.allowForks) return { skip: `PR #${event.number} comes from a fork, and this loop does not run on forks.` };
  if (!candidate.collaborator) {
    const what = event.kind === 'pr' ? 'their PR' : event.kind === 'review' ? 'their review' : 'their comment';
    return { skip: `@${event.author ?? 'ghost'} is not a collaborator on ${event.repo}, so ${what} starts nothing.` };
  }
  return 'start';
}

function wantsOf(triggers: LoopGithubTriggers[]): GithubEventWants {
  return {
    comments: triggers.some(t => t.commentPhrase),
    reviews: triggers.some(t => t.changesRequested),
    checks: triggers.some(t => t.checkFailed),
    prs: triggers.some(t => t.prOpened),
    labels: triggers.some(t => t.issueLabel),
  };
}

/** Trimmed triggers with at least one event, or a PaneError that says what to fix. */
function validGithubTriggers(input: LoopGithubTriggers): LoopGithubTriggers {
  const repo = input.repo.trim().replace(/^https:\/\/github\.com\//u, '').replace(/\.git$/u, '').replace(/\/+$/u, '');
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repo)) {
    throw new PaneError('ERR_LOOP_INVALID', input.repo.trim()
      ? `"${input.repo}" is not a GitHub repository. Nothing was saved.`
      : 'The project has no github.com origin remote to watch. Nothing was saved.', 'Give the repository as owner/name, such as acme/app.');
  }
  const commentPhrase = input.commentPhrase?.trim() || undefined;
  const issueLabel = input.issueLabel?.trim() || undefined;
  const triggers: LoopGithubTriggers = {
    repo,
    ...(commentPhrase ? { commentPhrase } : {}),
    ...(input.changesRequested ? { changesRequested: true } : {}),
    ...(input.checkFailed ? { checkFailed: true } : {}),
    ...(input.prOpened ? { prOpened: true } : {}),
    ...(issueLabel ? { issueLabel } : {}),
    ...(input.allowForks ? { allowForks: true } : {}),
  };
  if (!commentPhrase && !triggers.changesRequested && !triggers.checkFailed && !triggers.prOpened && !issueLabel) {
    throw new PaneError('ERR_LOOP_INVALID', 'Choose at least one GitHub event, or remove the GitHub trigger. Nothing was saved.', 'Turn on a comment phrase, changes-requested reviews, failing checks, new PRs or an issue label.');
  }
  if (input.hourlyCap !== undefined) {
    if (!Number.isInteger(input.hourlyCap) || input.hourlyCap < 1 || input.hourlyCap > 60) {
      throw new PaneError('ERR_LOOP_INVALID', `The hourly cap must be a whole number from 1 to 60; it was ${input.hourlyCap}. Nothing was saved.`, 'Pick a cap from 1 to 60, then save again.');
    }
    if (input.hourlyCap !== LOOP_DEFAULT_HOURLY_CAP) triggers.hourlyCap = input.hourlyCap;
  }
  return triggers;
}

function loopNotFound(id: string): PaneError {
  return new PaneError('ERR_LOOP_NOT_FOUND', `No loop has id ${id}. Nothing was changed.`, 'List loops with `runpane loops list` to find its id.');
}
