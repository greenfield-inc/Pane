import type { AgentState } from '../../../shared/types/agentStatus';
import type { RunpaneWorkspaceEntry } from '../../../shared/types/runpaneOrchestration';

export interface WorkspaceIdleCandidate {
  panelId: string;
  paneId: string;
  paneName: string;
  panelTitle?: string;
  agentType?: string;
  repoId?: number;
  repoName?: string;
  worktreePath?: string;
  agentState: AgentState;
  idleSinceMs: number;
  heldInputPresent?: boolean;
}

export interface WorkspaceIdleSchedule {
  idleAfterMs: number;
  /** Back off after the first step: 30m, 1h, 3h, then every 24h. */
  backoff?: boolean;
}

const BACKOFF_STEPS_MS = [30 * 60_000, 60 * 60_000, 3 * 60 * 60_000] as const;
const BACKOFF_TAIL_MS = 24 * 60 * 60_000;

function backoffThresholds(idleAfterMs: number): number[] {
  const thresholds = [idleAfterMs];
  for (const step of BACKOFF_STEPS_MS) {
    if (step > thresholds[thresholds.length - 1]) thresholds.push(step);
  }
  return thresholds;
}

/** Number of schedule thresholds crossed after `idleMs` of idleness. */
function idleCountFor(idleMs: number, schedule: WorkspaceIdleSchedule): number {
  const { idleAfterMs, backoff } = schedule;
  if (idleAfterMs <= 0 || idleMs < idleAfterMs) return 0;
  if (!backoff) return Math.floor(idleMs / idleAfterMs);
  const thresholds = backoffThresholds(idleAfterMs);
  const crossed = thresholds.filter(threshold => idleMs >= threshold).length;
  if (crossed < thresholds.length) return crossed;
  const last = thresholds[thresholds.length - 1];
  return thresholds.length + Math.floor((idleMs - last) / BACKOFF_TAIL_MS);
}

/** Idle duration at which the `count`-th IDLE fires (count >= 1). */
function idleThresholdFor(count: number, schedule: WorkspaceIdleSchedule): number {
  const { idleAfterMs, backoff } = schedule;
  if (!backoff) return count * idleAfterMs;
  const thresholds = backoffThresholds(idleAfterMs);
  if (count <= thresholds.length) return thresholds[count - 1];
  return thresholds[thresholds.length - 1] + (count - thresholds.length) * BACKOFF_TAIL_MS;
}

export function dueIdleEntries(
  candidates: readonly WorkspaceIdleCandidate[],
  schedule: WorkspaceIdleSchedule,
  fromMs: number,
  toMs: number,
  generation: number,
): RunpaneWorkspaceEntry[] {
  if (schedule.idleAfterMs <= 0 || toMs < fromMs) return [];

  const at = new Date(toMs).toISOString();
  return candidates.flatMap((candidate) => {
    if (candidate.agentState !== 'idle') return [];
    const fromIdleMs = Math.max(0, fromMs - candidate.idleSinceMs);
    const toIdleMs = Math.max(0, toMs - candidate.idleSinceMs);
    const previousCount = idleCountFor(fromIdleMs, schedule);
    const idleCount = idleCountFor(toIdleMs, schedule);
    if (idleCount < 1 || idleCount <= previousCount) return [];

    return [{
      gen: generation,
      at,
      kind: 'agent.idle' as const,
      paneId: candidate.paneId,
      paneName: candidate.paneName,
      repoId: candidate.repoId,
      repoName: candidate.repoName,
      worktreePath: candidate.worktreePath,
      panelId: candidate.panelId,
      panelTitle: candidate.panelTitle,
      agentType: candidate.agentType,
      to: 'idle' as const,
      source: 'agent' as const,
      idleMs: idleThresholdFor(idleCount, schedule),
      idleCount,
      heldInputPresent: candidate.heldInputPresent,
    }];
  });
}

export function nextIdleDeadline(
  candidates: readonly WorkspaceIdleCandidate[],
  schedule: WorkspaceIdleSchedule,
  nowMs: number,
): number | undefined {
  if (schedule.idleAfterMs <= 0 || candidates.length === 0) return undefined;
  const deadlines = candidates
    .filter(candidate => candidate.agentState === 'idle')
    .map((candidate) => {
      const elapsed = Math.max(0, nowMs - candidate.idleSinceMs);
      return candidate.idleSinceMs + idleThresholdFor(idleCountFor(elapsed, schedule) + 1, schedule);
    });
  return deadlines.length > 0 ? Math.min(...deadlines) : undefined;
}
