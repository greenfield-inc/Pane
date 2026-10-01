import { describeError } from './daemonProbe';
import type { SandboxActivity } from './guards';
import type {
  AlertSink,
  Clock,
  CoordinatorProvider,
  DaemonProbe,
  DirectoryEntry,
  ProviderSandbox,
  SessionDirectory,
} from './types';

type IdleDecision =
  | 'stopped'
  | 'would-stop'
  | 'safe-streak'
  | 'unsafe'
  | 'not-running'
  | 'woken-recently'
  | 'busy'
  | 'daemon-unreachable'
  | 'daemon-not-ready'
  | 'no-token'
  | 'safe-to-stop-unsupported'
  | 'safe-to-stop-error'
  | 'not-checkpointed'
  | 'provider-error'
  | 'lease-expired'
  | 'stop-failed';

export interface IdleCheckResult {
  sessionId: string;
  sandboxId: string;
  decision: IdleDecision;
  detail: string;
}

export interface IdleCheckReport {
  ok: boolean;
  error?: string;
  results: IdleCheckResult[];
}

/**
 * The stop lease asked with the answer that completes the streak: the daemon refuses every other call
 * for this long, and the coordinator only calls stop while at least STOP_LEASE_MARGIN_MS of it is left,
 * which covers the stop call and boat's snapshot ~4 s after it.
 */
export const STOP_LEASE_MS = 60_000;
const STOP_LEASE_MARGIN_MS = 30_000;

export interface IdleStopOptions {
  requiredConsecutiveSafe: number;
  wakeGraceMs: number;
  dryRun: boolean;
}

/**
 * Idle-stop: ask each awake cloud Session's daemon whether it is safe to stop, and stop it only after
 * `requiredConsecutiveSafe` consecutive "safe" answers. Anything other than an explicit "safe" with a
 * confirmed durable checkpoint (unsafe, unconfirmed flush, error, unreachable, unsupported daemon,
 * missing token) resets the streak and leaves the sandbox running: the coordinator never stops a
 * Session it could not ask, or whose state the daemon could not make durable. The answer that completes
 * the streak asks for a stop lease, so nothing new starts on the daemon between that "safe" and the stop;
 * the lease is released whenever the coordinator does not go on to stop.
 */
export class IdleStopper {
  constructor(
    private readonly deps: {
      directory: SessionDirectory;
      provider: CoordinatorProvider;
      probe: DaemonProbe;
      activity: SandboxActivity;
      alerts: AlertSink;
      clock: Clock;
    },
    private readonly options: IdleStopOptions,
  ) {}

  async runOnce(overrides: Partial<IdleStopOptions> = {}): Promise<IdleCheckReport> {
    const options = { ...this.options, ...overrides };
    const directory = await this.deps.directory.read();
    if (!directory.ok) {
      this.deps.alerts.emit({ level: 'warn', code: 'idle-check-directory-unreadable', message: directory.error });
      return { ok: false, error: directory.error, results: [] };
    }
    const results: IdleCheckResult[] = [];
    for (const entry of directory.entries) {
      results.push(await this.checkEntry(entry, options));
    }
    return { ok: true, results };
  }

  private async checkEntry(entry: DirectoryEntry, options: IdleStopOptions): Promise<IdleCheckResult> {
    const result = (decision: IdleDecision, detail: string): IdleCheckResult => ({
      sessionId: entry.sessionId,
      sandboxId: entry.sandboxId,
      decision,
      detail,
    });
    const { activity } = this.deps;
    const outcome = await activity.exclusive(entry.sandboxId, async (): Promise<IdleCheckResult> => {
      let sandbox: ProviderSandbox;
      try {
        sandbox = await this.deps.provider.get(entry.sandboxId, entry.org);
      } catch (error) {
        return result('provider-error', describeError(error));
      }
      if (sandbox.state !== 'running') {
        activity.resetSafe(entry.sandboxId);
        return result('not-running', `provider state ${sandbox.rawState}`);
      }
      const sinceWoken = activity.msSinceWoken(entry.sandboxId);
      if (sinceWoken !== null && sinceWoken < options.wakeGraceMs) {
        activity.resetSafe(entry.sandboxId);
        return result('woken-recently', `woken ${Math.round(sinceWoken / 1000)}s ago`);
      }
      if (!entry.coordinatorToken) {
        activity.resetSafe(entry.sandboxId);
        return result('no-token', 'directory entry has no coordinator token; cannot ask safe-to-stop');
      }
      const health = await this.deps.probe.health(entry.baseUrl, entry.coordinatorToken);
      if (!health.reachable) {
        activity.resetSafe(entry.sandboxId);
        this.deps.alerts.emit({
          level: 'warn',
          code: 'daemon-down',
          message: `${entry.label}: sandbox is running but its daemon does not answer /health (${health.error}); not stopping`,
          sandboxId: entry.sandboxId,
          sessionId: entry.sessionId,
        });
        return result('daemon-unreachable', health.error);
      }
      if (!health.ready) {
        activity.resetSafe(entry.sandboxId);
        return result('daemon-not-ready', 'daemon /health is not ready yet');
      }
      const token = entry.coordinatorToken;
      const completesStreak = !options.dryRun && activity.safeStreak(entry.sandboxId) + 1 >= options.requiredConsecutiveSafe;
      const askedAt = this.deps.clock.now();
      const answer = await this.deps.probe.safeToStop(entry.baseUrl, token, completesStreak ? { stopLeaseMs: STOP_LEASE_MS } : {});
      const releaseLease = async () => {
        if (answer.kind === 'safe' && answer.lease) await this.deps.probe.releaseStopLease(entry.baseUrl, token);
      };
      switch (answer.kind) {
        case 'unsafe':
          activity.resetSafe(entry.sandboxId);
          return result('unsafe', answer.reasons.join('; '));
        case 'unsupported':
          activity.resetSafe(entry.sandboxId);
          this.deps.alerts.emit({
            level: 'warn',
            code: 'safe-to-stop-unsupported',
            message: `${entry.label}: daemon has no safe-to-stop API (${answer.error}); idle-stop disabled for it`,
            sandboxId: entry.sandboxId,
            sessionId: entry.sessionId,
          });
          return result('safe-to-stop-unsupported', answer.error);
        case 'error':
          // The answer may have been lost after the daemon took the lease: lift it rather than wait it out.
          if (completesStreak) await this.deps.probe.releaseStopLease(entry.baseUrl, token);
          activity.resetSafe(entry.sandboxId);
          return result('safe-to-stop-error', answer.error);
        case 'safe':
          if (answer.checkpointed) break;
          await releaseLease();
          activity.resetSafe(entry.sandboxId);
          this.deps.alerts.emit({
            level: 'warn',
            code: 'idle-stop-not-checkpointed',
            message: `${entry.label}: daemon answered safe but did not confirm a durable checkpoint; not stopping`,
            sandboxId: entry.sandboxId,
            sessionId: entry.sessionId,
          });
          return result('not-checkpointed', 'safe, but the daemon did not confirm a durable checkpoint');
      }
      const streak = activity.recordSafe(entry.sandboxId);
      if (streak < options.requiredConsecutiveSafe) {
        await releaseLease();
        return result('safe-streak', `safe ${streak}/${options.requiredConsecutiveSafe}`);
      }
      if (options.dryRun) {
        await releaseLease();
        return result('would-stop', `safe ${streak}/${options.requiredConsecutiveSafe} (dry run)`);
      }
      if (answer.lease && this.deps.clock.now() - askedAt > answer.lease.ms - STOP_LEASE_MARGIN_MS) {
        // Too little of the fence is left to cover the stop and the snapshot; ask again next round.
        await releaseLease();
        activity.resetSafe(entry.sandboxId);
        return result('lease-expired', `safe-to-stop took ${Math.round((this.deps.clock.now() - askedAt) / 1000)}s; not stopping without a fence`);
      }
      try {
        // Stop immediately after the daemon's checkpoint: boat snapshots ~4 s after this call. A daemon
        // without stop leases (lease null) still has the short gap between its answer and the snapshot.
        await this.deps.provider.stop(entry.sandboxId, entry.org);
      } catch (error) {
        await releaseLease();
        this.deps.alerts.emit({
          level: 'warn',
          code: 'idle-stop-failed',
          message: `${entry.label}: provider stop failed (${describeError(error)}); it stays running`,
          sandboxId: entry.sandboxId,
          sessionId: entry.sessionId,
        });
        return result('stop-failed', describeError(error));
      }
      activity.resetSafe(entry.sandboxId);
      this.deps.alerts.emit({
        level: 'info',
        code: 'idle-stopped',
        message: `${entry.label}: idle-stopped after ${streak} consecutive safe-to-stop answers`,
        sandboxId: entry.sandboxId,
        sessionId: entry.sessionId,
      });
      return result('stopped', `safe ${streak}/${options.requiredConsecutiveSafe}; checkpointed${answer.lease ? '; fenced' : '; not fenced (daemon without stop leases)'}`);
    });
    return outcome.ran ? outcome.value : result('busy', 'a wake or another check holds this sandbox');
  }
}
