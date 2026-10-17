import type { AgentState } from '../../../shared/types/agentStatus';
import type { RunpaneWorkspaceEntry } from '../../../shared/types/runpaneOrchestration';

/** What brought a Session worker back: Pane starting, the computer waking, or a turn that died on a transient API error. */
export type AutoResumeReason = 'pane-start' | 'system-resume' | 'api-error';

export interface AutoResumeWorker {
  panelId: string;
  paneId: string;
  panelTitle?: string;
  agentType?: string;
  /** When the agent stopped, if Pane knows (its shutdown mark or its last output). */
  interruptedAt?: string;
}

export interface AutoResumeScreen {
  text: string;
  composerPresent: boolean;
  composerHasText: boolean;
}

export type AutoResumeEntry = Omit<RunpaneWorkspaceEntry, 'gen' | 'at' | 'paneName'>;

export interface SessionAgentAutoResumeDependencies {
  isEnabled(): boolean;
  /**
   * Agent panels of active Sessions' workers whose agent is not running and that should come
   * back: not the Session's own orchestrator, not finished (a done or failed report), and not
   * held by an update for review.
   */
  listStoppedWorkers(): Promise<AutoResumeWorker[]>;
  /** Running agent panels of active Sessions' workers, for the wake-up check of turns that died while asleep. */
  listRunningWorkers(): AutoResumeWorker[];
  /** The worker for a panel of an active Session, or undefined for any other panel. */
  worker(panelId: string): AutoResumeWorker | undefined;
  /** Restart the panel in place with its agent's own resume command and wait for it; `blocked` when it waits on a person. */
  resume(panelId: string): Promise<{ ready: boolean; blocked: boolean }>;
  agentState(panelId: string): AgentState | undefined;
  readScreen(panelId: string): Promise<AutoResumeScreen>;
  submit(panelId: string, text: string): Promise<boolean>;
  record(entry: AutoResumeEntry): void;
  log(message: string, error?: Error): void;
  now?(): number;
  setTimer?(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer?(timer: ReturnType<typeof setTimeout>): void;
}

/** Waits before each nudge after a transient API error: the first, second and third in an hour. */
export const API_ERROR_BACKOFF_MS = [30_000, 2 * 60_000, 5 * 60_000] as const;
const ATTEMPT_WINDOW_MS = 60 * 60_000;
/** Lets the network come back after a wake before agents are restarted. */
const WAKE_DELAY_MS = 10_000;
/** How far up from the bottom of the screen the turn's last words are read. */
const ERROR_TAIL_LINES = 15;

/**
 * Sleep and network failures an agent prints when its turn dies. A failure that will not pass on
 * its own (an auth error, a usage limit, a prompt that is too long) is not listed.
 */
const TRANSIENT_API_ERRORS: readonly RegExp[] = [
  /API Error:?\s*\(?(?:Connection error|Request timed out|fetch failed|terminated|socket hang up|other side closed)/iu,
  /API Error:?\s*\(?5\d\d\b/iu,
  /\boverloaded_error\b/iu,
  /Your computer went to sleep mid-response/iu,
  /Can't reach the API server|Unable to connect to API/iu,
  /\b(?:ENOTFOUND|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN)\b/u,
  /Agent terminated early due to an API error/iu,
  /Agent stalled: no progress/iu,
  /stream disconnected before completion|error sending request for url|exceeded retry limit/iu,
];

/** The transient API error the turn ended on, read from the last lines of the screen. */
export function transientApiError(screenText: string): string | undefined {
  const tail = screenText.split('\n').filter(line => line.trim()).slice(-ERROR_TAIL_LINES);
  for (const line of [...tail].reverse()) {
    if (TRANSIENT_API_ERRORS.some(pattern => pattern.test(line))) return line.trim();
  }
  return undefined;
}

export function nudgeText(interruptedAt: string | undefined): string {
  const at = interruptedAt && Number.isFinite(Date.parse(interruptedAt))
    ? new Date(interruptedAt).toISOString().replace(/\.\d{3}Z$/u, 'Z')
    : 'an unknown time';
  return `You were interrupted at ${at}. Re-read your task's status and continue.`;
}

/**
 * Brings Session workers back after Pane restarts, the computer wakes, or a turn dies on a
 * transient API error, and tells the orchestrator with one `panel.resumed` journal entry each.
 * Each restarted agent keeps its panel and conversation and gets one short nudge; a composer that
 * holds unsent text is never typed into.
 */
export class SessionAgentAutoResume {
  private readonly inFlight = new Set<string>();
  private readonly attempts = new Map<string, number[]>();
  private readonly pendingNudges = new Map<string, ReturnType<typeof setTimeout>>();
  private startupWorkers: Promise<AutoResumeWorker[]> | undefined;
  private wakeTimer: ReturnType<typeof setTimeout> | undefined;
  private suspendedAt: string | undefined;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;

  constructor(private readonly dependencies: SessionAgentAutoResumeDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.setTimer = dependencies.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = dependencies.clearTimer ?? (timer => clearTimeout(timer));
  }

  /**
   * Lists the workers Pane's restart stopped before anything else can start them (the app shows
   * the selected Pane), so each still gets its nudge. Call `resumeStartupWorkers` once Pane is up.
   */
  captureStartupWorkers(): void {
    if (!this.dependencies.isEnabled()) return;
    this.startupWorkers = this.dependencies.listStoppedWorkers().catch(error => {
      this.dependencies.log('[AutoResume] Could not list stopped Session workers at startup', error instanceof Error ? error : new Error(String(error)));
      return [];
    });
  }

  async resumeStartupWorkers(): Promise<void> {
    const workers = await this.startupWorkers;
    this.startupWorkers = undefined;
    if (!workers || !this.dependencies.isEnabled()) return;
    await Promise.all(workers.map(worker => this.resumeAndNudge(worker, 'pane-start')));
  }

  handleSuspend(): void {
    this.suspendedAt = new Date(this.now()).toISOString();
  }

  /** After a wake: restart workers whose agent stopped, and nudge any whose turn died on a network error while asleep. */
  handleSystemResume(): void {
    if (this.wakeTimer) this.clearTimer(this.wakeTimer);
    this.wakeTimer = this.setTimer(() => {
      this.wakeTimer = undefined;
      void this.resumeAfterWake().catch(error => this.dependencies.log('[AutoResume] Wake-up resume failed', error instanceof Error ? error : new Error(String(error))));
    }, WAKE_DELAY_MS);
  }

  /** A turn that ends on a transient API error gets a nudge after a backoff, at most three times an hour. */
  handleAgentStatus(panelId: string, state: AgentState, reason?: string | null): void {
    if (state === 'working') {
      this.cancelPendingNudge(panelId);
      return;
    }
    if (state !== 'idle' || reason === 'terminal_start' || this.inFlight.has(panelId) || this.pendingNudges.has(panelId)) return;
    if (!this.dependencies.isEnabled()) return;
    const worker = this.dependencies.worker(panelId);
    if (!worker) return;
    void this.scheduleApiErrorNudge(worker, new Date(this.now()).toISOString())
      .catch(error => this.dependencies.log(`[AutoResume] Could not check panel ${panelId} for an API error`, error instanceof Error ? error : new Error(String(error))));
  }

  dispose(): void {
    if (this.wakeTimer) this.clearTimer(this.wakeTimer);
    for (const timer of this.pendingNudges.values()) this.clearTimer(timer);
    this.pendingNudges.clear();
  }

  private async resumeAfterWake(): Promise<void> {
    if (!this.dependencies.isEnabled()) return;
    const interruptedAt = this.suspendedAt;
    const stopped = await this.dependencies.listStoppedWorkers();
    const running = this.dependencies.listRunningWorkers();
    await Promise.all([
      ...stopped.map(worker => this.resumeAndNudge({ ...worker, interruptedAt: interruptedAt ?? worker.interruptedAt }, 'system-resume')),
      ...running
        .filter(worker => this.dependencies.agentState(worker.panelId) === 'idle' && !this.pendingNudges.has(worker.panelId))
        .map(worker => this.scheduleApiErrorNudge(worker, interruptedAt ?? worker.interruptedAt)),
    ]);
  }

  private async resumeAndNudge(worker: AutoResumeWorker, reason: AutoResumeReason): Promise<void> {
    if (this.inFlight.has(worker.panelId)) return;
    this.inFlight.add(worker.panelId);
    this.cancelPendingNudge(worker.panelId);
    try {
      const resumed = await this.dependencies.resume(worker.panelId);
      const nudged = resumed.ready && !resumed.blocked
        ? await this.nudge(worker)
        : { nudged: false, blocked: resumed.blocked };
      this.recordResumed(worker, reason, nudged);
    } catch (error) {
      this.dependencies.log(`[AutoResume] Could not resume panel ${worker.panelId} after ${reason}`, error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.inFlight.delete(worker.panelId);
    }
  }

  private async scheduleApiErrorNudge(worker: AutoResumeWorker, interruptedAt: string | undefined): Promise<void> {
    const screen = await this.dependencies.readScreen(worker.panelId);
    const signature = transientApiError(screen.text);
    if (!signature) return;
    const recent = this.recentAttempts(worker.panelId);
    if (recent.length >= API_ERROR_BACKOFF_MS.length) {
      this.dependencies.log(`[AutoResume] Panel ${worker.panelId} hit "${signature}" again; ${recent.length} nudges in the last hour, so it is left for the orchestrator.`);
      return;
    }
    if (this.pendingNudges.has(worker.panelId)) return;
    const attempt = recent.length + 1;
    const timer = this.setTimer(() => {
      this.pendingNudges.delete(worker.panelId);
      void this.nudgeAfterApiError(worker, interruptedAt, attempt)
        .catch(error => this.dependencies.log(`[AutoResume] Could not nudge panel ${worker.panelId} after an API error`, error instanceof Error ? error : new Error(String(error))));
    }, API_ERROR_BACKOFF_MS[recent.length]);
    this.pendingNudges.set(worker.panelId, timer);
  }

  private async nudgeAfterApiError(worker: AutoResumeWorker, interruptedAt: string | undefined, attempt: number): Promise<void> {
    if (!this.dependencies.isEnabled() || this.inFlight.has(worker.panelId)) return;
    // The agent may have recovered on its own, or someone answered it, during the backoff.
    if (this.dependencies.agentState(worker.panelId) !== 'idle') return;
    if (!transientApiError((await this.dependencies.readScreen(worker.panelId)).text)) return;
    this.inFlight.add(worker.panelId);
    try {
      this.attempts.set(worker.panelId, [...this.recentAttempts(worker.panelId), this.now()]);
      const nudged = await this.nudge({ ...worker, interruptedAt });
      this.recordResumed({ ...worker, interruptedAt }, 'api-error', nudged, attempt);
    } finally {
      this.inFlight.delete(worker.panelId);
    }
  }

  /** Types the nudge only into an empty composer of an agent that is not waiting on a person. */
  private async nudge(worker: AutoResumeWorker): Promise<{ nudged: boolean; heldInput?: boolean; blocked?: boolean }> {
    if (this.dependencies.agentState(worker.panelId) === 'blocked') return { nudged: false, blocked: true };
    const screen = await this.dependencies.readScreen(worker.panelId);
    if (screen.composerHasText) return { nudged: false, heldInput: true };
    if (!screen.composerPresent) return { nudged: false };
    return { nudged: await this.dependencies.submit(worker.panelId, nudgeText(worker.interruptedAt)) };
  }

  private recordResumed(
    worker: AutoResumeWorker,
    reason: AutoResumeReason,
    outcome: { nudged: boolean; heldInput?: boolean; blocked?: boolean },
    attempt?: number,
  ): void {
    this.dependencies.record({
      kind: 'panel.resumed',
      paneId: worker.paneId,
      panelId: worker.panelId,
      panelTitle: worker.panelTitle,
      agentType: worker.agentType,
      source: 'session',
      reason,
      nudged: outcome.nudged,
      interruptedAt: worker.interruptedAt,
      attempt,
      heldInputPresent: outcome.heldInput || undefined,
      to: outcome.blocked ? 'blocked' : undefined,
    });
  }

  private recentAttempts(panelId: string): number[] {
    const since = this.now() - ATTEMPT_WINDOW_MS;
    return (this.attempts.get(panelId) ?? []).filter(at => at > since);
  }

  private cancelPendingNudge(panelId: string): void {
    const timer = this.pendingNudges.get(panelId);
    if (!timer) return;
    this.clearTimer(timer);
    this.pendingNudges.delete(panelId);
  }
}
