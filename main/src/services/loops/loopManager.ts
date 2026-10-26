import { randomUUID } from 'crypto';
import {
  LOOP_KEPT_RUNS,
  LOOP_NAME_MAX_LENGTH,
  type Loop,
  type LoopAgent,
  type LoopInput,
  type LoopRun,
  type LoopRunTrigger,
} from '../../../../shared/types/loop';
import { PaneError } from '../../../../shared/paneError';
import { decideLoop, nextLoopRun, previewLoopSchedule } from './loopSchedule';
import type { LoopRepository, StoredLoop } from './loopRepository';
import type { Logger } from '../../utils/logger';

/** The note on an old run whose Pane was not archived. */
const KEPT_RUN_NOTE = 'Kept because the run Pane has uncommitted or unpushed work. Archive it yourself when you\'re done.';

/** The longest the timer sleeps, so a changed clock or a slept laptop is noticed within the grace period. */
const MAX_SLEEP_MS = 60 * 1000;

/**
 * Starts one run: a project loop's Pane, as `runpane panes create`, returning
 * its id; or a Session loop's message to its agent, returning no Pane.
 */
export type LoopRunStarter = (loop: StoredLoop, slotAtMs: number) => Promise<{ sessionId: string | null; warning?: string }>;

export interface LoopManagerOptions {
  repo: LoopRepository;
  startRun: LoopRunStarter;
  /** Archive a run Pane that fell out of the kept runs. False when Pane refused, to keep uncommitted or unpushed work. */
  archiveRun: (sessionId: string) => Promise<boolean>;
  projectExists: (projectId: number) => boolean;
  /**
   * Resolve a Session loop's target (an id, a name or `LOOP_NEW_SESSION`) to a
   * Session id, and make that Session's agent run `agent` without permission prompts.
   */
  prepareSession: (target: string, loop: { name: string; agent: LoopAgent }) => Promise<string>;
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
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
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
    const nowMs = this.now();
    const preview = previewLoopSchedule(cron, nowMs);
    if (!preview.ok) throw new PaneError('ERR_LOOP_INVALID', `${preview.error} Nothing was saved.`, 'Fix the cron, then save again.');

    const existing = input.id ? repo.get(input.id) : null;
    if (input.id && !existing) throw loopNotFound(input.id);
    // Last, since a new Session is created here: everything else about the loop is valid.
    const orchestrationSessionId = sessionTarget && input.agent
      ? await this.options.prepareSession(sessionTarget, { name, agent: input.agent })
      : undefined;
    // A new cron or a resume counts from now, so it never replays older slots.
    const restartsSchedule = !existing || existing.cron !== cron || (!existing.enabled && input.enabled);
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

  /** Start a run now. The schedule is unchanged. */
  async runNow(id: string): Promise<Loop> {
    const loop = this.options.repo.get(id);
    if (!loop) throw loopNotFound(id);
    if (this.starting.has(id)) {
      throw new PaneError('ERR_LOOP_STARTING', `A run of "${loop.name}" is already starting. No second run was started.`, 'Wait for it to appear, then run again if you need another.');
    }
    await this.execute(loop, this.now(), 'manual');
    return this.present(this.options.repo.get(id) ?? loop);
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
      if (!loop?.enabled) continue;
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

  private async execute(loop: StoredLoop, slotAtMs: number, trigger: LoopRunTrigger): Promise<void> {
    const { repo } = this.options;
    // Recorded before the Pane exists, so a crash mid-create cannot run the slot twice.
    const run: LoopRun = { id: randomUUID(), loopId: loop.id, slotAtMs, trigger, status: 'started', error: null, sessionId: null };
    repo.addRun(run);
    this.starting.add(loop.id);
    try {
      this.options.onChange?.();
      const { sessionId, warning } = await this.options.startRun(loop, slotAtMs);
      repo.finishRun(run.id, { status: 'started', error: warning ?? null, sessionId });
      const where = sessionId ? `as Pane ${sessionId}` : `for Session ${loop.orchestrationSessionId}`;
      this.options.logger?.info(`[Loops] Started "${loop.name}" ${where}${warning ? `; it needs attention: ${warning}` : '.'}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      repo.finishRun(run.id, { status: 'failed', error: message, sessionId: null });
      this.options.logger?.warn(`[Loops] "${loop.name}" did not start: ${message}`);
    } finally {
      this.starting.delete(loop.id);
    }
    this.trim(loop.id);
    this.options.onChange?.();
  }

  /**
   * Archive the Panes of runs past the kept ten, and drop each row once its Pane
   * is gone. Rows without a Pane (Session loop runs, failures, skips) just go. A Pane kept for its uncommitted or unpushed work keeps its row, with a note, so the
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
            logger?.info(`[Loops] Kept old run Pane ${sessionId}: it has uncommitted or unpushed work.`);
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
    const preview = previewLoopSchedule(loop.cron, this.now());
    return {
      ...stored,
      nextRunAtMs: loop.enabled ? nextLoopRun(loop.cron, Math.max(this.countsFrom(loop), this.now())) : null,
      scheduleText: preview.ok ? preview.scheduleText : `Cron ${loop.cron}`,
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
      if (!loop.enabled) continue;
      const next = nextLoopRun(loop.cron, Math.max(this.countsFrom(loop), nowMs));
      if (next !== null) sleepMs = Math.min(sleepMs, next - nowMs);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.wake();
    }, Math.max(1_000, sleepMs));
    this.timer.unref?.();
  }
}

function loopNotFound(id: string): PaneError {
  return new PaneError('ERR_LOOP_NOT_FOUND', `No loop has id ${id}. Nothing was changed.`, 'List loops with `runpane loops list` to find its id.');
}
