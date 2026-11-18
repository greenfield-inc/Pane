import { reasonOf } from '../../../../shared/paneError';
import type { TargetStatus } from './importer';

/**
 * The source's side after the freeze: it keeps asking the target until the target's durable record
 * decides the move, and acts only on that decision. Committed or started retires the copy here;
 * rolled back releases it. Silence, an error, or an answer that proves neither keeps it frozen, so
 * the Session never runs on both machines.
 */

/** The target's move calls, for one move. */
export interface FreezeTarget {
  status(): Promise<TargetStatus>;
  /** Idempotent: a target already starting or started answers with its status. */
  start(): Promise<TargetStatus>;
  /** Asks the target to record a roll-back; it refuses once the move committed. */
  rollBack(): Promise<TargetStatus>;
}

export type FreezeOutcome =
  | { kind: 'committed'; status: TargetStatus }
  | { kind: 'rolledBack'; status: TargetStatus };

/** What the dialog shows while the move waits on the target. */
export type FreezeWait =
  /** Asked to start, or starting: no action needed. */
  | { kind: 'starting'; status: TargetStatus }
  /** The target's start failed before any tab started; Check again asks it to start again. */
  | { kind: 'startFailed'; status: TargetStatus }
  /** The target answers, but its answer doesn't decide the move (an older Pane there). */
  | { kind: 'unknown'; status: TargetStatus }
  | { kind: 'unreachable'; error: string; since: number };

export interface FreezeHooks {
  onWait(wait: FreezeWait): void;
  /** True once the move no longer needs this loop (done elsewhere, or Pane quitting). */
  stopped(): boolean;
  sleep(ms: number): Promise<void>;
  now?(): number;
}

const FIRST_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

/** A target answer that proves the move was rolled back there, or never committed. */
function provesRolledBack(status: TargetStatus): boolean {
  return status.stage === 'aborted' && status.rolledBack === true;
}

export async function settleAfterFreeze(target: FreezeTarget, hooks: FreezeHooks): Promise<FreezeOutcome | undefined> {
  const now = hooks.now ?? Date.now;
  let delay = FIRST_DELAY_MS;
  let silentSince: number | undefined;
  const wait = (waited: FreezeWait) => {
    hooks.onWait(waited);
    // A target that is starting is asked again soon; one that can't decide, or doesn't answer, less often.
    delay = waited.kind === 'starting' ? FIRST_DELAY_MS : Math.min(delay * 2, MAX_DELAY_MS);
  };
  for (;;) {
    if (hooks.stopped()) return undefined;
    let status: TargetStatus;
    try {
      status = await target.status();
      silentSince = undefined;
    } catch (error) {
      silentSince ??= now();
      const current = delay;
      wait({ kind: 'unreachable', error: reasonOf(error), since: silentSince });
      await hooks.sleep(current);
      continue;
    }
    if (status.stage === 'started') return { kind: 'committed', status };
    if (provesRolledBack(status)) return { kind: 'rolledBack', status };
    if (status.stage === 'built') {
      // The start was lost, or the target restarted before it arrived: ask again (idempotent).
      const answer = await target.start().catch(() => undefined);
      if (answer?.stage === 'started') return { kind: 'committed', status: answer };
      wait({ kind: 'starting', status: answer ?? status });
    } else if (status.stage === 'aborted' && status.durable) {
      // The target keeps a durable record and has none for this move, so it never committed it.
      // Asking it to roll back records that, so the move can never start there later.
      const answer = await target.rollBack().catch(() => undefined);
      if (answer && provesRolledBack(answer)) return { kind: 'rolledBack', status: answer };
      wait({ kind: 'unknown', status: answer ?? status });
    } else if (status.stage === 'failed' && status.retryable) {
      wait({ kind: 'startFailed', status });
    } else if (status.stage === 'starting') {
      wait({ kind: 'starting', status });
    } else {
      wait({ kind: 'unknown', status });
    }
    await hooks.sleep(delay);
  }
}
