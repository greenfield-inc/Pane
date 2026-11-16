import { EventEmitter } from 'events';
import type { CleanupRun, CleanupSource } from '../../../../shared/types/machineHealth';

/** Panes whose work is done: their PR merged or closed, their folder is gone, or nobody used them for days. */

type FinishedReason = 'pr-merged' | 'pr-closed' | 'folder-missing' | 'idle';

export interface FinishedPane {
  sessionId: string;
  name: string;
  projectName: string;
  reason: FinishedReason;
  prNumber?: number;
  idleDays: number;
  /** Bytes the archive frees (its worktree), when the inventory has measured it. */
  sizeBytes: number | null;
  /** Why it is skipped (pinned, focused, an agent busy, an open card, uncommitted changes), or null. */
  protection: string | null;
}

interface OpenPane {
  id: string;
  name: string;
  projectName: string;
  worktreePath: string;
  /** paneInactiveSince, in ms. */
  inactiveSince: number;
}

export interface FinishedPaneDeps {
  now: () => number;
  idleDays: number;
  panes: () => OpenPane[];
  /** The same lookup `runpane panes archive --merged` uses. */
  prStatus: (paneId: string) => Promise<{ state: 'merged' | 'closed' | 'open' | 'none' | 'unknown'; number?: number }>;
  folderExists: (folder: string) => Promise<boolean>;
  protectionOf: (paneId: string) => Promise<string | null>;
  sizeOf: (paneId: string) => number | null;
}

const DAY = 86_400_000;

export async function findFinishedPanes(deps: FinishedPaneDeps): Promise<FinishedPane[]> {
  const finished: FinishedPane[] = [];
  for (const pane of deps.panes()) {
    const idleDays = Math.floor((deps.now() - pane.inactiveSince) / DAY);
    let reason: FinishedReason | null = null;
    let prNumber: number | undefined;
    if (!await deps.folderExists(pane.worktreePath)) {
      reason = 'folder-missing';
    } else {
      const pr = await deps.prStatus(pane.id);
      if (pr.state === 'merged' || pr.state === 'closed') {
        reason = pr.state === 'merged' ? 'pr-merged' : 'pr-closed';
        prNumber = pr.number;
      } else if (idleDays >= deps.idleDays) {
        reason = 'idle';
      }
    }
    if (!reason) continue;
    const entry: FinishedPane = {
      sessionId: pane.id, name: pane.name, projectName: pane.projectName, reason, idleDays,
      sizeBytes: deps.sizeOf(pane.id),
      protection: await deps.protectionOf(pane.id),
    };
    if (prNumber !== undefined) entry.prNumber = prNumber;
    finished.push(entry);
  }
  return finished;
}

export interface FinishedMonitorDeps {
  now: () => number;
  find: () => Promise<FinishedPane[]>;
  /** Archives through the normal archive path, so the branch stays and Restore works. */
  archive: (paneId: string) => Promise<void>;
  automatic: () => boolean;
  record: (run: CleanupRun) => void;
}

const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const FIRST_CHECK_DELAY_MS = 15 * 60_000;

/** Checks for finished Panes every 6 hours and on demand; archives them when asked, or by itself once the person opts in. */
export class FinishedPaneMonitor extends EventEmitter {
  private latest: FinishedPane[] | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: FinishedMonitorDeps) {
    super();
  }

  start(): void {
    if (this.timer) return;
    const first = setTimeout(() => {
      void this.checkSafely();
      this.timer = setInterval(() => void this.checkSafely(), CHECK_INTERVAL_MS);
      this.timer.unref?.();
    }, FIRST_CHECK_DELAY_MS);
    first.unref?.();
    this.timer = first;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async list(refresh = false): Promise<FinishedPane[]> {
    if (this.latest && !refresh) return this.latest;
    this.latest = await this.deps.find();
    this.emit('finished', this.latest);
    return this.latest;
  }

  /** One scheduled check (also run when disk reaches the warning level). */
  async check(): Promise<void> {
    const finished = await this.list(true);
    if (!this.deps.automatic()) return;
    const ready = finished.filter(pane => !pane.protection).map(pane => pane.sessionId);
    if (ready.length > 0) await this.archive(ready, 'schedule');
  }

  /** Archives the named Panes that are still finished and unprotected right now. */
  async archive(paneIds: readonly string[], source: CleanupSource): Promise<CleanupRun> {
    const current = new Map((await this.list(true)).map(pane => [pane.sessionId, pane]));
    const run: CleanupRun = { at: this.deps.now(), source, removed: [], skipped: [], freedBytes: 0 };
    for (const id of paneIds) {
      const pane = current.get(id);
      const entry = { id, kind: 'finished-pane' as const, path: pane?.name ?? id, sizeBytes: pane?.sizeBytes ?? 0 };
      if (!pane) {
        run.skipped.push({ ...entry, reason: 'It is no longer finished.' });
        continue;
      }
      if (pane.protection) {
        run.skipped.push({ ...entry, reason: pane.protection });
        continue;
      }
      try {
        await this.deps.archive(id);
        run.removed.push(entry);
      } catch (error) {
        run.skipped.push({ ...entry, reason: `Archive failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    this.deps.record(run);
    await this.list(true).catch(() => undefined);
    return run;
  }

  private async checkSafely(): Promise<void> {
    try {
      await this.check();
    } catch (error) {
      console.warn('[MachineHealth] finished-Pane check failed:', error instanceof Error ? error.message : error);
    }
  }
}
