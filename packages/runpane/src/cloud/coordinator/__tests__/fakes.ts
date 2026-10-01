import type {
  Clock,
  CoordinatorProvider,
  DaemonHealth,
  DaemonProbe,
  DirectoryEntry,
  DirectoryReadResult,
  ProviderSandbox,
  ProviderSandboxState,
  SafeToStopAnswer,
  SessionDirectory,
  UpgradeAnswer,
  UpgradeTarget,
} from '../types';

export class FakeClock implements Clock {
  constructor(public time = Date.parse('2026-09-30T08:00:00Z')) {}

  now(): number {
    return this.time;
  }

  async sleep(ms: number): Promise<void> {
    this.time += ms;
    await Promise.resolve();
  }
}

export function sandbox(id: string, state: ProviderSandboxState, overrides: Partial<ProviderSandbox> = {}): ProviderSandbox {
  return {
    id,
    name: `rp-${id}`,
    state,
    rawState: state,
    createdAt: '2026-09-29T00:00:00Z',
    updatedAt: '2026-09-29T00:00:00Z',
    ...overrides,
  };
}

export function entry(sessionId: string, sandboxId: string, overrides: Partial<DirectoryEntry> = {}): DirectoryEntry {
  return {
    sessionId,
    label: `label-${sessionId}`,
    provider: 'boat',
    sandboxId,
    baseUrl: `https://rp-${sessionId}.tail.ts.net`,
    nodeId: null,
    pinnedVersion: null,
    coordinatorToken: `token-${sessionId}`,
    org: null,
    githubRepos: [],
    secretsManifest: null,
    ...overrides,
  };
}

export class FakeDirectory implements SessionDirectory {
  constructor(public result: DirectoryReadResult) {}

  static of(entries: DirectoryEntry[]): FakeDirectory {
    return new FakeDirectory({ ok: true, generatedAt: null, entries });
  }

  async read(): Promise<DirectoryReadResult> {
    return this.result;
  }
}

export class FakeProvider implements CoordinatorProvider {
  readonly kind = 'fake';
  readonly calls: string[] = [];
  readonly sandboxes = new Map<string, ProviderSandbox>();
  listError: Error | null = null;
  /** Errors thrown by the next resume() calls, in order. */
  resumeErrors: Error[] = [];
  /** Errors thrown by the next stop() calls, in order; the sandbox keeps its state. */
  stopErrors: Error[] = [];
  /** State the sandbox moves to on the Nth get() after a resume (simulates boot). */
  bootAfterGets = 1;
  private pendingBoot = new Map<string, number>();

  constructor(initial: ProviderSandbox[] = []) {
    for (const item of initial) this.sandboxes.set(item.id, item);
  }

  async list(): Promise<ProviderSandbox[]> {
    this.calls.push('list');
    if (this.listError) throw this.listError;
    return [...this.sandboxes.values()];
  }

  async get(sandboxId: string): Promise<ProviderSandbox> {
    this.calls.push(`get ${sandboxId}`);
    const current = this.sandboxes.get(sandboxId);
    if (!current) return sandbox(sandboxId, 'missing');
    const remaining = this.pendingBoot.get(sandboxId);
    if (remaining !== undefined) {
      if (remaining <= 1) {
        this.pendingBoot.delete(sandboxId);
        current.state = 'running';
        current.rawState = 'idle';
      } else {
        this.pendingBoot.set(sandboxId, remaining - 1);
      }
    }
    return { ...current };
  }

  async stop(sandboxId: string): Promise<void> {
    this.calls.push(`stop ${sandboxId}`);
    const failure = this.stopErrors.shift();
    if (failure) throw failure;
    const current = this.sandboxes.get(sandboxId);
    if (current) {
      current.state = 'stopped';
      current.rawState = 'archived';
    }
  }

  async resume(sandboxId: string): Promise<void> {
    this.calls.push(`resume ${sandboxId}`);
    const failure = this.resumeErrors.shift();
    if (failure) throw failure;
    const current = this.sandboxes.get(sandboxId);
    if (current) {
      current.state = 'starting';
      current.rawState = 'provisioning';
      this.pendingBoot.set(sandboxId, this.bootAfterGets);
    }
  }

  mutations(): string[] {
    return this.calls.filter((call) => call.startsWith('stop') || call.startsWith('resume'));
  }
}

export class FakeProbe implements DaemonProbe {
  readonly calls: string[] = [];
  healthByUrl = new Map<string, DaemonHealth>();
  safeByUrl = new Map<string, SafeToStopAnswer>();
  upgradeAnswer: UpgradeAnswer = { kind: 'unsupported', error: 'ERR_UNKNOWN_CHANNEL' };
  /** False: an older daemon that ignores stopLeaseMs. */
  grantsLeases = true;
  /** Health reported once an upgrade has started. */
  healthAfterUpgrade: DaemonHealth | null = null;

  async health(baseUrl: string): Promise<DaemonHealth> {
    this.calls.push(`health ${baseUrl}`);
    return this.healthByUrl.get(baseUrl) ?? { reachable: true, ready: true, version: '1.0.0', detail: null };
  }

  async safeToStop(baseUrl: string, token: string, options: { stopLeaseMs?: number } = {}): Promise<SafeToStopAnswer> {
    this.calls.push(`safe ${baseUrl} ${token}${options.stopLeaseMs ? ` lease=${options.stopLeaseMs}` : ''}`);
    const answer = this.safeByUrl.get(baseUrl) ?? { kind: 'safe', checkpointed: true, lease: null };
    // Like a daemon with stop leases: a safe answer to a lease request carries the lease.
    if (answer.kind === 'safe' && options.stopLeaseMs && this.grantsLeases) return { ...answer, lease: { ms: options.stopLeaseMs } };
    return answer;
  }

  async releaseStopLease(baseUrl: string): Promise<void> {
    this.calls.push(`release ${baseUrl}`);
  }

  async upgrade(baseUrl: string, _token: string, target: UpgradeTarget): Promise<UpgradeAnswer> {
    this.calls.push(`upgrade ${baseUrl} ${target.version} ${target.sha256}`);
    if (this.upgradeAnswer.kind === 'started' && this.healthAfterUpgrade) {
      this.healthByUrl.set(baseUrl, this.healthAfterUpgrade);
    }
    return this.upgradeAnswer;
  }
}
