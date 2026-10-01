import { describeError } from './daemonProbe';
import type { SandboxActivity } from './guards';
import type {
  AlertSink,
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
 * Session it could not ask, or whose state the daemon could not make durable.
 */
export class IdleStopper {
  constructor(
    private readonly deps: {
      directory: SessionDirectory;
      provider: CoordinatorProvider;
      probe: DaemonProbe;
      activity: SandboxActivity;
      alerts: AlertSink;
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
      const health = await this.deps.probe.health(entry.baseUrl);
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
      const answer = await this.deps.probe.safeToStop(entry.baseUrl, entry.coordinatorToken);
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
          activity.resetSafe(entry.sandboxId);
          return result('safe-to-stop-error', answer.error);
        case 'safe':
          if (answer.checkpointed) break;
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
        return result('safe-streak', `safe ${streak}/${options.requiredConsecutiveSafe}`);
      }
      if (options.dryRun) {
        return result('would-stop', `safe ${streak}/${options.requiredConsecutiveSafe} (dry run)`);
      }
      try {
        // Stop immediately after the daemon's checkpoint: boat snapshots ~4 s after this call.
        await this.deps.provider.stop(entry.sandboxId, entry.org);
      } catch (error) {
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
      return result('stopped', `safe ${streak}/${options.requiredConsecutiveSafe}; checkpointed`);
    });
    return outcome.ran ? outcome.value : result('busy', 'a wake or another check holds this sandbox');
  }
}
