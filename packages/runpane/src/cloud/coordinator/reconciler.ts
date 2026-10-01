import { describeError } from './daemonProbe';
import type { RunawayGuard, SandboxActivity } from './guards';
import { isManagedSandbox } from './guards';
import type { AlertSink, Clock, CoordinatorProvider, ProviderSandbox, SessionDirectory } from './types';

type ReconcileAbortReason =
  | 'directory-unreadable'
  | 'directory-empty'
  | 'provider-error'
  | 'too-many-orphans';

export interface ReconcileReport {
  aborted: ReconcileAbortReason | null;
  detail: string;
  managedCount: number;
  directoryCount: number;
  liveCount: number;
  /** Running orphans past the creation grace this run: managed sandboxes the directory doesn't name. */
  orphans: string[];
  /** Orphans stopped this run (or that would be, in a dry run). Always empty unless `stopOrphans`. */
  stopped: string[];
  /** Orphans left alone this run, with the reason. */
  skipped: Array<{ sandboxId: string; reason: string }>;
  /** Directory entries whose sandbox the provider no longer has, or reports as failed. */
  lost: string[];
  dryRun: boolean;
}

export interface ReconcileOptions {
  managedNamePrefix: string;
  selfSandboxId: string | null;
  ignoreSandboxIds: readonly string[];
  orphanGraceMs: number;
  /** Off (the default): orphans are only reported (`orphan-found`). The directory can simply be stale. */
  stopOrphans: boolean;
  /** With `stopOrphans`: how long this coordinator must have seen a sandbox as a running orphan first. */
  orphanStopGraceMs: number;
  maxOrphanStopsPerRun: number;
  dryRun: boolean;
}

/**
 * Reconciler: compares the provider's sandboxes with the directory (saved cloud profiles).
 * It only ever STOPS and alerts; the provider port has no delete. A running orphan is reported once
 * (`orphan-found`) and, by default, left running: the coordinator holds no token for a sandbox the
 * directory doesn't name, so it can't ask that daemon's safe-to-stop, and a Session created from another
 * machine or dropped by a stale store looks exactly like an orphan. With `stopOrphans`, it stops an orphan
 * only once it has seen it as a running orphan for `orphanStopGraceMs`. It aborts without touching
 * anything when the directory can't be read, when the directory is empty while the provider lists
 * managed sandboxes, when the provider can't be listed, or when more orphans would be stopped than
 * `maxOrphanStopsPerRun` (a stale or truncated directory looks exactly like that).
 */
export class Reconciler {
  /** When this coordinator first saw each current running orphan. In memory: a restart starts over. */
  private readonly orphanSince = new Map<string, number>();

  constructor(
    private readonly deps: {
      directory: SessionDirectory;
      provider: CoordinatorProvider;
      activity: SandboxActivity;
      guard: RunawayGuard;
      alerts: AlertSink;
      clock: Clock;
    },
    private readonly options: ReconcileOptions,
  ) {}

  async runOnce(overrides: Partial<Pick<ReconcileOptions, 'dryRun'>> = {}): Promise<ReconcileReport> {
    const options = { ...this.options, ...overrides };
    const report: ReconcileReport = {
      aborted: null,
      detail: '',
      managedCount: 0,
      directoryCount: 0,
      liveCount: 0,
      orphans: [],
      stopped: [],
      skipped: [],
      lost: [],
      dryRun: options.dryRun,
    };
    const abort = (reason: ReconcileAbortReason, detail: string): ReconcileReport => {
      report.aborted = reason;
      report.detail = detail;
      this.deps.alerts.emit({ level: 'error', code: `reconcile-aborted-${reason}`, message: detail });
      return report;
    };

    // Read the directory first: a failed read must stop the run before any provider mutation.
    const directory = await this.deps.directory.read();
    if (!directory.ok) return abort('directory-unreadable', `reconcile aborted, nothing stopped: ${directory.error}`);
    report.directoryCount = directory.entries.length;

    let all: ProviderSandbox[];
    try {
      all = await this.deps.provider.list();
    } catch (error) {
      return abort('provider-error', `reconcile aborted, nothing stopped: provider list failed: ${describeError(error)}`);
    }
    const managed = all.filter((sandbox) => isManagedSandbox(sandbox, options));
    report.managedCount = managed.length;
    report.liveCount = this.deps.guard.countLive(managed);

    if (directory.entries.length === 0 && managed.length > 0) {
      return abort(
        'directory-empty',
        `reconcile aborted, nothing stopped: the directory is empty but the provider lists ${managed.length} `
          + `managed sandbox(es) (prefix "${options.managedNamePrefix}")`,
      );
    }

    const known = new Set(directory.entries.map((entry) => entry.sandboxId));
    const byId = new Map(all.map((sandbox) => [sandbox.id, sandbox]));
    for (const entry of directory.entries) {
      const sandbox = byId.get(entry.sandboxId);
      if (!sandbox || sandbox.state === 'failed') {
        report.lost.push(entry.sandboxId);
        this.deps.alerts.emit({
          level: 'error',
          code: 'session-lost',
          message: `${entry.label}: sandbox ${entry.sandboxId} is ${sandbox ? `in state ${sandbox.rawState}` : 'not listed by the provider'}`,
          sandboxId: entry.sandboxId,
          sessionId: entry.sessionId,
        });
      }
    }

    const now = this.deps.clock.now();
    const candidates: ProviderSandbox[] = [];
    for (const sandbox of managed) {
      if (known.has(sandbox.id)) continue;
      if (sandbox.state !== 'running' && sandbox.state !== 'starting') {
        report.skipped.push({ sandboxId: sandbox.id, reason: `orphan already ${sandbox.rawState}` });
        continue;
      }
      const createdAt = sandbox.createdAt ? Date.parse(sandbox.createdAt) : Number.NaN;
      if (!Number.isFinite(createdAt) || now - createdAt < options.orphanGraceMs) {
        // `runpane cloud new` may not have synced the directory yet.
        report.skipped.push({ sandboxId: sandbox.id, reason: 'orphan younger than the grace period (or no createdAt)' });
        continue;
      }
      candidates.push(sandbox);
    }
    const due = this.trackOrphans(candidates, now, options, report);

    if (due.length > options.maxOrphanStopsPerRun) {
      return abort(
        'too-many-orphans',
        `reconcile aborted, nothing stopped: ${due.length} running orphans exceeds maxOrphanStopsPerRun `
          + `${options.maxOrphanStopsPerRun}; is the directory stale? (${due.map((s) => s.id).join(', ')})`,
      );
    }

    for (const sandbox of due) {
      if (options.dryRun) {
        report.stopped.push(sandbox.id);
        continue;
      }
      const outcome = await this.deps.activity.exclusive(sandbox.id, () => this.deps.provider.stop(sandbox.id, sandbox.org))
        .catch((cause: unknown) => ({ ran: true as const, error: describeError(cause) }));
      if (!outcome.ran) {
        report.skipped.push({ sandboxId: sandbox.id, reason: 'busy' });
      } else if ('error' in outcome) {
        report.skipped.push({ sandboxId: sandbox.id, reason: `stop failed: ${outcome.error}` });
      } else {
        report.stopped.push(sandbox.id);
        this.deps.alerts.emit({
          level: 'warn',
          code: 'orphan-stopped',
          message: `stopped orphan sandbox ${sandbox.id} (${sandbox.name}): not in the directory. `
            + 'Its disk is kept; add it back with runpane cloud or delete it yourself.',
          sandboxId: sandbox.id,
        });
      }
    }

    const live = this.deps.guard.checkLive(managed);
    if (!live.ok) this.deps.alerts.emit({ level: 'error', code: 'runaway-guard', message: live.message });

    report.detail = `managed=${managed.length} directory=${directory.entries.length} live=${report.liveCount} `
      + `orphans=${report.orphans.length} stopped=${report.stopped.length} lost=${report.lost.length}${options.dryRun ? ' (dry run)' : ''}`;
    return report;
  }

  /**
   * Reports each new running orphan once and returns the ones to stop now: none unless `stopOrphans`,
   * then only those this coordinator has seen as running orphans for `orphanStopGraceMs`.
   */
  private trackOrphans(
    candidates: readonly ProviderSandbox[],
    now: number,
    options: ReconcileOptions,
    report: ReconcileReport,
  ): ProviderSandbox[] {
    const current = new Set(candidates.map((sandbox) => sandbox.id));
    for (const id of this.orphanSince.keys()) {
      if (!current.has(id)) this.orphanSince.delete(id);
    }
    const due: ProviderSandbox[] = [];
    for (const sandbox of candidates) {
      report.orphans.push(sandbox.id);
      const since = this.orphanSince.get(sandbox.id);
      if (since === undefined) {
        this.orphanSince.set(sandbox.id, now);
        this.deps.alerts.emit({
          level: 'warn',
          code: 'orphan-found',
          message: `sandbox ${sandbox.id} (${sandbox.name}) is running but not in the directory (made from another `
            + 'runpane cloud store, or lost from this one). '
            + (options.stopOrphans
              ? `It is stopped if it is still an orphan in ${Math.round(options.orphanStopGraceMs / 60_000)} min.`
              : 'It is left running (reconcile.stopOrphans is off); stop or delete it yourself if nothing uses it.'),
          sandboxId: sandbox.id,
        });
      }
      const seenMs = now - (since ?? now);
      if (!options.stopOrphans) continue;
      if (seenMs < options.orphanStopGraceMs) {
        report.skipped.push({
          sandboxId: sandbox.id,
          reason: `orphan for ${Math.round(seenMs / 60_000)} min; stopped after ${Math.round(options.orphanStopGraceMs / 60_000)} min`,
        });
        continue;
      }
      due.push(sandbox);
    }
    return due;
  }
}
