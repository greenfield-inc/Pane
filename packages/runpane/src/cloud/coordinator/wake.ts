import { findDirectoryEntry } from './directory';
import { describeError } from './daemonProbe';
import { BoatProviderError } from './boatProvider';
import type { RunawayGuard, SandboxActivity } from './guards';
import { isManagedSandbox } from './guards';
import type {
  AlertSink,
  Clock,
  CoordinatorProvider,
  DaemonHealth,
  DaemonProbe,
  DirectoryEntry,
  ProviderSandbox,
  SessionDirectory,
} from './types';

/** asleep, waking, daemon-down and lost, plus `awake`, the success answer once /health is ready. */
export type CloudHostStatus = 'awake' | 'asleep' | 'waking' | 'daemon-down' | 'lost';

export interface CloudHostReport {
  ok: true;
  host: string;
  label: string;
  sandboxId: string;
  status: CloudHostStatus;
  baseUrl: string;
  version: string | null;
  detail: string;
}

type WakeFailureCode =
  | 'unknown-host'
  | 'directory-unreadable'
  | 'runaway-guard'
  | 'wake-rate-limited'
  | 'peer-wake-refused'
  | 'provider-rate-limited'
  | 'provider-error';

export interface WakeFailure {
  ok: false;
  code: WakeFailureCode;
  message: string;
}

export type WakeResult = CloudHostReport | WakeFailure;

export interface WakeOptions {
  managedNamePrefix: string;
  selfSandboxId: string | null;
  ignoreSandboxIds: readonly string[];
  pinnedVersion: string | null;
  pinnedDebUrl: string | null;
  pinnedDebSha256: string | null;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  daemonDownGraceMs: number;
  pollIntervalMs: number;
  upgradeTimeoutMs: number;
}

/** Who asked for a wake: the laptop CLI (`user:*`) or another cloud Session (its session id). */
export interface WakeCaller {
  role: 'user' | 'peer';
  id: string;
}

/**
 * Resumes one peer may cause per rolling hour, on top of the account-wide runaway guard. boat's
 * start limit is account-wide, so without it one peer could spend the whole hour's starts.
 */
export const PEER_RESUMES_PER_HOUR = 2;
const PEER_RESUME_WINDOW_MS = 60 * 60_000;

const STOPPING_WAIT_MS = 60_000;
const RATE_LIMIT_BACKOFF_MS = [5_000, 10_000, 20_000, 30_000];

export class WakeService {
  private readonly inflight = new Map<string, Promise<WakeResult>>();
  /** Per peer caller: when its wakes resumed a sandbox, within the last hour. */
  private readonly peerResumes = new Map<string, number[]>();

  constructor(
    private readonly deps: {
      directory: SessionDirectory;
      provider: CoordinatorProvider;
      probe: DaemonProbe;
      activity: SandboxActivity;
      guard: RunawayGuard;
      alerts: AlertSink;
      clock: Clock;
    },
    private readonly options: WakeOptions,
  ) {}

  /** Reports a host's status without waking it (for workspace:wait / panels:list against a peer). */
  async status(host: string): Promise<WakeResult> {
    const resolved = await this.resolve(host);
    if (!resolved.ok) return resolved;
    try {
      const sandbox = await this.deps.provider.get(resolved.entry.sandboxId, resolved.entry.org);
      return await this.classify(resolved.entry, sandbox);
    } catch (error) {
      return { ok: false, code: 'provider-error', message: describeError(error) };
    }
  }

  /**
   * Wakes a host: resumes its sandbox if it is asleep and, with `wait`, returns once the daemon's
   * /health reports ready (then applies the pinned version). Concurrent wakes of one sandbox share
   * a single resume. Only a wake that resumed the sandbox holds idle-stop off for its grace period:
   * a peer must not be able to keep an awake sandbox up by asking again and again.
   */
  async wake(host: string, request: { wait: boolean; timeoutMs?: number }, caller?: WakeCaller): Promise<WakeResult> {
    const resolved = await this.resolve(host);
    if (!resolved.ok) return resolved;
    const { entry } = resolved;
    if (caller?.role === 'peer' && caller.id === entry.sessionId) {
      return { ok: false, code: 'peer-wake-refused', message: 'a cloud Session may not wake its own sandbox' };
    }
    const timeoutMs = Math.min(request.timeoutMs ?? this.options.defaultTimeoutMs, this.options.maxTimeoutMs);
    const existing = this.inflight.get(entry.sandboxId);
    if (existing) {
      return request.wait ? existing : this.status(entry.sessionId);
    }
    const run = this.runWake(entry, request.wait, timeoutMs, caller).finally(() => {
      this.inflight.delete(entry.sandboxId);
    });
    this.inflight.set(entry.sandboxId, run);
    return run;
  }

  private async runWake(entry: DirectoryEntry, wait: boolean, timeoutMs: number, caller: WakeCaller | undefined): Promise<WakeResult> {
    const deadline = this.deps.clock.now() + timeoutMs;
    let sandbox: ProviderSandbox;
    try {
      sandbox = await this.deps.provider.get(entry.sandboxId, entry.org);
      if (sandbox.state === 'stopping') sandbox = await this.waitWhileStopping(entry.sandboxId);
    } catch (error) {
      return { ok: false, code: 'provider-error', message: describeError(error) };
    }

    let resumed = false;
    if (sandbox.state === 'stopped') {
      // Without wait the caller wants an answer now: one resume attempt, no rate-limit retries.
      const failure = await this.resume(entry, wait ? deadline : this.deps.clock.now(), caller);
      if (failure) return failure;
      resumed = true;
      if (!wait) return this.report(entry, 'waking', null, 'resume requested');
    } else if (sandbox.state === 'missing' || sandbox.state === 'failed') {
      return this.classify(entry, sandbox);
    } else if (caller?.role !== 'peer') {
      // The user is back on an awake host: idle-stop starts its safe streak over. A peer's wake does not,
      // or asking every few minutes would keep the host up forever.
      this.deps.activity.resetSafe(entry.sandboxId);
    }

    let last: CloudHostReport | null = null;
    while (this.deps.clock.now() < deadline) {
      let current: ProviderSandbox;
      try {
        current = await this.deps.provider.get(entry.sandboxId, entry.org);
      } catch (error) {
        return { ok: false, code: 'provider-error', message: describeError(error) };
      }
      last = await this.classify(entry, current);
      if (last.status === 'awake' || last.status === 'lost') break;
      if (!wait && last.status !== 'asleep') return last;
      await this.deps.clock.sleep(this.options.pollIntervalMs);
    }
    if (!last) return this.status(entry.sessionId);
    if (last.status !== 'awake') {
      last.detail = `timed out after ${timeoutMs} ms: ${last.detail}`;
      return last;
    }
    if (resumed) this.deps.activity.markWoken(entry.sandboxId);
    return this.applyPinnedVersion(entry, last, deadline);
  }

  private async resume(entry: DirectoryEntry, retryUntil: number, caller: WakeCaller | undefined): Promise<WakeFailure | null> {
    const peerWindow = caller?.role === 'peer' ? this.recentPeerResumes(caller.id) : null;
    if (peerWindow && peerWindow.length >= PEER_RESUMES_PER_HOUR) {
      return {
        ok: false,
        code: 'wake-rate-limited',
        message: `peer ${caller?.id ?? ''} already resumed ${PEER_RESUMES_PER_HOUR} sandbox(es) this hour; ask the user to wake ${entry.label}`,
      };
    }
    let managed: ProviderSandbox[];
    try {
      managed = (await this.deps.provider.list()).filter((sandbox) => isManagedSandbox(sandbox, this.options));
    } catch (error) {
      return { ok: false, code: 'provider-error', message: describeError(error) };
    }
    const verdict = this.deps.guard.checkResume(entry.sandboxId, managed);
    if (!verdict.ok) {
      this.deps.alerts.emit({
        level: 'error',
        code: verdict.code,
        message: `${entry.label}: ${verdict.message}`,
        sandboxId: entry.sandboxId,
        sessionId: entry.sessionId,
      });
      return { ok: false, code: verdict.code, message: verdict.message };
    }
    let rateLimited = 0;
    let busyWaits = 0;
    for (;;) {
      // Idle-stop may hold the sandbox for a few seconds; wait for it rather than racing its stop call.
      const outcome = await this.deps.activity.exclusive(entry.sandboxId, async () => {
        await this.deps.provider.resume(entry.sandboxId, entry.org);
      }).catch((cause: unknown) => ({ ran: true as const, error: cause }));
      if (!outcome.ran) {
        busyWaits += 1;
        if (busyWaits > 120) return { ok: false, code: 'provider-error', message: 'sandbox stayed busy; resume not sent' };
        await this.deps.clock.sleep(500);
        continue;
      }
      if (!('error' in outcome)) break;
      const error = outcome.error;
      // 409: a resume is already in progress; the readiness loop picks it up.
      if (error instanceof BoatProviderError && error.status === 409) return null;
      if (!(error instanceof BoatProviderError && error.status === 429)) {
        return { ok: false, code: 'provider-error', message: describeError(error) };
      }
      // boat's machine-start limits are account-wide (creates, forks and resumes share them), so a
      // wake can be refused for reasons unrelated to this Session. Retry until the wake deadline.
      const backoff = RATE_LIMIT_BACKOFF_MS[Math.min(rateLimited, RATE_LIMIT_BACKOFF_MS.length - 1)];
      if (rateLimited === 0) {
        this.deps.alerts.emit({
          level: 'warn',
          code: 'provider-rate-limited',
          message: `${entry.label}: the provider refused the resume (${describeError(error)}); retrying until the wake deadline`,
          sandboxId: entry.sandboxId,
          sessionId: entry.sessionId,
        });
      }
      rateLimited += 1;
      if (this.deps.clock.now() + backoff > retryUntil) {
        return {
          ok: false,
          code: 'provider-rate-limited',
          message: `the provider's machine-start limit refused the resume ${rateLimited} time(s): ${describeError(error)}`,
        };
      }
      await this.deps.clock.sleep(backoff);
    }
    this.deps.guard.recordResume(entry.sandboxId);
    if (caller?.role === 'peer' && peerWindow) this.peerResumes.set(caller.id, [...peerWindow, this.deps.clock.now()]);
    this.deps.activity.markWoken(entry.sandboxId);
    this.deps.alerts.emit({
      level: 'info',
      code: 'woken',
      message: `${entry.label}: resume requested${rateLimited > 0 ? ` after ${rateLimited} provider rate-limit retries` : ''}`,
      sandboxId: entry.sandboxId,
      sessionId: entry.sessionId,
    });
    return null;
  }

  private recentPeerResumes(peerId: string): number[] {
    const now = this.deps.clock.now();
    return (this.peerResumes.get(peerId) ?? []).filter((at) => now - at < PEER_RESUME_WINDOW_MS);
  }

  private async waitWhileStopping(sandboxId: string): Promise<ProviderSandbox> {
    const until = this.deps.clock.now() + STOPPING_WAIT_MS;
    let sandbox = await this.deps.provider.get(sandboxId);
    while (sandbox.state === 'stopping' && this.deps.clock.now() < until) {
      await this.deps.clock.sleep(this.options.pollIntervalMs);
      sandbox = await this.deps.provider.get(sandboxId);
    }
    return sandbox;
  }

  private async applyPinnedVersion(entry: DirectoryEntry, report: CloudHostReport, deadline: number): Promise<CloudHostReport> {
    const pinned = entry.pinnedVersion ?? this.options.pinnedVersion;
    if (!pinned || report.version === pinned) return report;
    // The configured .deb belongs to the coordinator-wide pin; a per-Session pin to another version has no artifact.
    const artifactMatches = pinned === this.options.pinnedVersion;
    const url = artifactMatches ? this.options.pinnedDebUrl : null;
    const sha256 = artifactMatches ? this.options.pinnedDebSha256 : null;
    if (!entry.coordinatorToken || !url || !sha256) {
      const reason = !entry.coordinatorToken
        ? 'no coordinator token'
        : `no pinnedDebUrl/pinnedDebSha256 configured for ${pinned}`;
      report.detail = `version-mismatch: running ${report.version ?? 'unknown'}, pinned ${pinned} (${reason})`;
      this.alertVersionMismatch(entry, report.detail);
      return report;
    }
    const answer = await this.deps.probe.upgrade(entry.baseUrl, entry.coordinatorToken, { version: pinned, url, sha256 });
    if (answer.kind !== 'started') {
      report.detail = `version-mismatch: running ${report.version ?? 'unknown'}, pinned ${pinned}; upgrade ${answer.kind}: ${answer.error}`;
      this.alertVersionMismatch(entry, report.detail);
      return report;
    }
    const upgradeDeadline = Math.max(deadline, this.deps.clock.now() + this.options.upgradeTimeoutMs);
    let health: DaemonHealth = { reachable: false, error: 'not checked' };
    while (this.deps.clock.now() < upgradeDeadline) {
      await this.deps.clock.sleep(this.options.pollIntervalMs);
      health = await this.deps.probe.health(entry.baseUrl);
      if (health.reachable && health.ready && health.version === pinned) {
        return this.report(entry, 'awake', pinned, `upgraded to pinned ${pinned}`);
      }
    }
    const status: CloudHostStatus = health.reachable ? 'waking' : 'daemon-down';
    return this.report(entry, status, health.reachable ? health.version : null, `upgrade to ${pinned} did not finish in time`);
  }

  private alertVersionMismatch(entry: DirectoryEntry, detail: string): void {
    this.deps.alerts.emit({
      level: 'warn',
      code: 'version-mismatch',
      message: `${entry.label}: ${detail}`,
      sandboxId: entry.sandboxId,
      sessionId: entry.sessionId,
    });
  }

  private async classify(entry: DirectoryEntry, sandbox: ProviderSandbox): Promise<CloudHostReport> {
    switch (sandbox.state) {
      case 'missing':
      case 'failed':
        return this.report(entry, 'lost', null, `provider state ${sandbox.rawState}`);
      case 'stopped':
      case 'stopping':
        return this.report(entry, 'asleep', null, `provider state ${sandbox.rawState}`);
      case 'starting':
        return this.report(entry, 'waking', null, `provider state ${sandbox.rawState}`);
      case 'running':
        break;
    }
    const health = await this.deps.probe.health(entry.baseUrl);
    if (health.reachable && health.ready) return this.report(entry, 'awake', health.version, health.detail ?? 'daemon ready');
    const sinceUp = this.deps.activity.msSinceWoken(entry.sandboxId)
      ?? (sandbox.updatedAt ? this.deps.clock.now() - Date.parse(sandbox.updatedAt) : null);
    const grace = health.reachable ? this.options.daemonDownGraceMs * 2 : this.options.daemonDownGraceMs;
    const withinGrace = sinceUp !== null && Number.isFinite(sinceUp) && sinceUp < grace;
    const detail = health.reachable ? 'daemon answers but is not ready' : `daemon /health: ${health.error}`;
    return this.report(entry, withinGrace ? 'waking' : 'daemon-down', health.reachable ? health.version : null, detail);
  }

  private report(entry: DirectoryEntry, status: CloudHostStatus, version: string | null, detail: string): CloudHostReport {
    return {
      ok: true,
      host: entry.sessionId,
      label: entry.label,
      sandboxId: entry.sandboxId,
      status,
      baseUrl: entry.baseUrl,
      version,
      detail,
    };
  }

  private async resolve(host: string): Promise<{ ok: true; entry: DirectoryEntry } | WakeFailure> {
    const directory = await this.deps.directory.read();
    if (!directory.ok) return { ok: false, code: 'directory-unreadable', message: directory.error };
    const entry = findDirectoryEntry(directory.entries, host);
    if (!entry) return { ok: false, code: 'unknown-host', message: `no cloud Session "${host}" in the directory` };
    return { ok: true, entry };
  }
}
