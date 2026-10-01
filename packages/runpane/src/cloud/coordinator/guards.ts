import fs from 'node:fs';
import path from 'node:path';
import { boundary, decodeBoundary } from '../../boundaryDecoder';
import { describeError } from './daemonProbe';
import type { Clock, ProviderSandbox } from './types';
import { isLiveState } from './types';

const HOUR_MS = 60 * 60 * 1000;

/**
 * In-memory bookkeeping shared by wake and idle-stop, so the two never act on the same sandbox at once
 * and a freshly woken sandbox is not idle-stopped before the caller that woke it gets to use it.
 * The coordinator stays stateless across restarts: losing this only makes it more cautious
 * for one grace period, because `wokenAt` falls back to "unknown".
 */
export class SandboxActivity {
  private readonly busy = new Set<string>();
  private readonly wokenAt = new Map<string, number>();
  private readonly safeStreak = new Map<string, number>();

  constructor(private readonly clock: Clock) {}

  /** Runs `task` unless another coordinator action already holds this sandbox. */
  async exclusive<T>(sandboxId: string, task: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    if (this.busy.has(sandboxId)) return { ran: false };
    this.busy.add(sandboxId);
    try {
      return { ran: true, value: await task() };
    } finally {
      this.busy.delete(sandboxId);
    }
  }

  isBusy(sandboxId: string): boolean {
    return this.busy.has(sandboxId);
  }

  markWoken(sandboxId: string): void {
    this.wokenAt.set(sandboxId, this.clock.now());
    this.safeStreak.delete(sandboxId);
  }

  msSinceWoken(sandboxId: string): number | null {
    const at = this.wokenAt.get(sandboxId);
    return at === undefined ? null : this.clock.now() - at;
  }

  recordSafe(sandboxId: string): number {
    const next = (this.safeStreak.get(sandboxId) ?? 0) + 1;
    this.safeStreak.set(sandboxId, next);
    return next;
  }

  resetSafe(sandboxId: string): void {
    this.safeStreak.delete(sandboxId);
  }
}

type GuardRefusalCode = 'runaway-guard' | 'wake-rate-limited' | 'resume-history-invalid' | 'resume-history-busy';
type GuardRefusal = { ok: false; code: GuardRefusalCode; message: string };
export type GuardVerdict = { ok: true } | GuardRefusal;

interface ResumeRecord {
  sandboxId: string;
  at: number;
}

/** What `resumeWithinCaps` runs while it holds the history lock. */
export interface GuardedResume {
  /** The managed sandboxes, listed fresh: the live count must include resumes other processes made. */
  listManaged(): Promise<ProviderSandbox[]>;
  /** The provider resume. A throw records nothing and reaches the caller. */
  resume(): Promise<void>;
}

const resumeHistorySchema = boundary.array(boundary.object({ sandboxId: boundary.string, at: boundary.number }));
const historyLockSchema = boundary.object({ pid: boundary.number, at: boundary.number });

/** How long a resume waits for another process's resume to finish before refusing. */
const HISTORY_LOCK_WAIT_MS = 30_000;
const HISTORY_LOCK_POLL_MS = 50;
/** A holder older than this is gone: one provider resume call takes seconds. */
const HISTORY_LOCK_STALE_MS = 5 * 60_000;

/**
 * Runaway guard: caps live cloud sandboxes (25 per user by default) and how often the
 * coordinator may resume, per sandbox and overall, so a wake loop can't burn money unnoticed.
 * With `historyFile`, the last hour's resumes live in that file, so the service, each
 * `coordinator wake --local` run and a restarted service all count the same resumes. A lock file next
 * to it makes the fresh read, the cap check, the provider resume and its recording one step across
 * processes; a history that can't be read or decoded refuses every resume until it is fixed or removed.
 */
export class RunawayGuard {
  private resumes: ResumeRecord[] = [];

  constructor(
    private readonly clock: Clock,
    private readonly limits: { maxLiveSandboxes: number; maxResumesPerSandboxPerHour: number; maxResumesPerHour: number },
    private readonly historyFile?: string,
    private readonly lockWaitMs = HISTORY_LOCK_WAIT_MS,
  ) {}

  countLive(managed: readonly ProviderSandbox[]): number {
    return managed.filter((sandbox) => isLiveState(sandbox.state)).length;
  }

  checkLive(managed: readonly ProviderSandbox[]): GuardVerdict {
    const live = this.countLive(managed);
    if (live > this.limits.maxLiveSandboxes) {
      return {
        ok: false,
        code: 'runaway-guard',
        message: `${live} live cloud sandboxes exceeds the limit of ${this.limits.maxLiveSandboxes}`,
      };
    }
    return { ok: true };
  }

  /**
   * Resumes `sandboxId` (currently stopped, so one more live sandbox) only within the caps, holding the
   * history lock from the fresh read until the successful resume is recorded.
   */
  async resumeWithinCaps(sandboxId: string, steps: GuardedResume): Promise<GuardVerdict> {
    const lock = await this.lockHistory();
    if (!lock.ok) return lock;
    try {
      const history = this.readHistory();
      if (!history.ok) return history;
      const verdict = this.checkResume(sandboxId, await steps.listManaged(), history.resumes);
      if (!verdict.ok) return verdict;
      // Prove the history is writable before resuming, so a resume is never left uncounted.
      this.writeHistory(history.resumes);
      await steps.resume();
      this.writeHistory([...history.resumes, { sandboxId, at: this.clock.now() }]);
      return { ok: true };
    } finally {
      lock.release();
    }
  }

  private checkResume(sandboxId: string, managed: readonly ProviderSandbox[], resumes: readonly ResumeRecord[]): GuardVerdict {
    const live = this.countLive(managed);
    if (live >= this.limits.maxLiveSandboxes) {
      return {
        ok: false,
        code: 'runaway-guard',
        message: `refusing to wake: ${live} cloud sandboxes are already live (limit ${this.limits.maxLiveSandboxes})`,
      };
    }
    const forSandbox = resumes.filter((entry) => entry.sandboxId === sandboxId).length;
    if (forSandbox >= this.limits.maxResumesPerSandboxPerHour) {
      return {
        ok: false,
        code: 'wake-rate-limited',
        message: `${sandboxId} was resumed ${forSandbox} times in the last hour (limit ${this.limits.maxResumesPerSandboxPerHour})`,
      };
    }
    if (resumes.length >= this.limits.maxResumesPerHour) {
      return {
        ok: false,
        code: 'wake-rate-limited',
        message: `${resumes.length} resumes in the last hour (limit ${this.limits.maxResumesPerHour})`,
      };
    }
    return { ok: true };
  }

  /** The last hour's resumes. Another process may have resumed since: the file wins. Only a missing file is empty. */
  private readHistory(): { ok: true; resumes: ResumeRecord[] } | GuardRefusal {
    if (!this.historyFile) return { ok: true, resumes: this.prune(this.resumes) };
    let text: string;
    try {
      text = fs.readFileSync(this.historyFile, 'utf8');
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return { ok: true, resumes: [] };
      return this.invalidHistory(`cannot be read (${describeError(error)})`);
    }
    try {
      return { ok: true, resumes: this.prune(decodeBoundary(JSON.parse(text), resumeHistorySchema)) };
    } catch (error) {
      return this.invalidHistory(`is not a resume history (${describeError(error)})`);
    }
  }

  private invalidHistory(problem: string): GuardRefusal {
    return {
      ok: false,
      code: 'resume-history-invalid',
      message: `refusing to wake: ${this.historyFile ?? 'the resume history'} ${problem}; fix or remove it to allow wakes`,
    };
  }

  private writeHistory(resumes: ResumeRecord[]): void {
    this.resumes = resumes;
    if (!this.historyFile) return;
    fs.mkdirSync(path.dirname(this.historyFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.historyFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(resumes), { mode: 0o600 });
    fs.renameSync(temporary, this.historyFile);
  }

  private prune(resumes: readonly ResumeRecord[]): ResumeRecord[] {
    const cutoff = this.clock.now() - HOUR_MS;
    return resumes.filter((entry) => entry.at > cutoff);
  }

  /**
   * `<historyFile>.lock`, created exclusively and holding `{pid, at}`. A lock whose process is gone,
   * or older than any resume, is broken. Waits are real time: the holder is another process.
   */
  private async lockHistory(): Promise<{ ok: true; release(): void } | GuardRefusal> {
    if (!this.historyFile) return { ok: true, release: () => undefined };
    const lockFile = `${this.historyFile}.lock`;
    fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
    const waitUntil = Date.now() + this.lockWaitMs;
    for (;;) {
      try {
        fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx', mode: 0o600 });
        return { ok: true, release: () => fs.rmSync(lockFile, { force: true }) };
      } catch (error) {
        if (!hasErrorCode(error, 'EEXIST')) {
          return { ok: false, code: 'resume-history-busy', message: `refusing to wake: cannot lock ${lockFile} (${describeError(error)})` };
        }
      }
      if (isStaleLock(lockFile)) {
        fs.rmSync(lockFile, { force: true });
        continue;
      }
      if (Date.now() >= waitUntil) {
        return {
          ok: false,
          code: 'resume-history-busy',
          message: `refusing to wake: another coordinator process held ${lockFile} for over ${Math.round(this.lockWaitMs / 1000)} s`,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, HISTORY_LOCK_POLL_MS));
    }
  }
}

function isStaleLock(lockFile: string): boolean {
  let holder: { pid: number; at: number };
  try {
    holder = decodeBoundary(JSON.parse(fs.readFileSync(lockFile, 'utf8')), historyLockSchema);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return false;
    // Created but not written yet, or torn by a crash: stale once it is old.
    try {
      return Date.now() - fs.statSync(lockFile).mtimeMs > HISTORY_LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
  return Date.now() - holder.at > HISTORY_LOCK_STALE_MS || !isProcessAlive(holder.pid);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, owned by another user.
    return !hasErrorCode(error, 'ESRCH');
  }
}

function hasErrorCode(cause: unknown, code: string): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === code;
}

export function isManagedSandbox(
  sandbox: ProviderSandbox,
  options: { managedNamePrefix: string; selfSandboxId: string | null; ignoreSandboxIds: readonly string[] },
): boolean {
  if (sandbox.id === options.selfSandboxId) return false;
  if (options.ignoreSandboxIds.includes(sandbox.id)) return false;
  return sandbox.name.startsWith(options.managedNamePrefix);
}
