import { PaneCommandError } from '../../../core/commandError';
import type {
  SessionPort,
  SessionPortCloseResult,
  SessionPortOpenRequest,
  SessionPortOpenResult,
  SessionPortScheme,
  SessionPortSource,
  SessionPortsConfigureResult,
  SessionPortsListResult,
  SessionPortsManifestState,
  SuggestedPort,
} from '../../../../../shared/types/sessionPorts';
import type { ProcessEntry } from '../processTree';
import { findPanelAncestor, type TcpListener } from './listeners';
import { isTcpPort, isUrlPath, PORT_NAME_PATTERN, readPortsManifest, type ManifestRead } from './manifest';
import { emptyPortsState, manifestKey, PortsStateError, readPortsState, writePortsState, type PortsState, type StoredPort } from './portsStore';
import { describeListener, localTarget, type ServeBackend, type ServeListener } from './tailscaleServe';

/** Pane's own HTTPS port on every Session. */
const PANE_HTTPS_PORT = 443;
/** How long a first HTTPS request may take while tailscaled gets the name's certificate. */
const CERT_PROBE_TIMEOUT_MS = 45_000;
const VERIFY_TIMEOUT_MS = 3_000;
const BOOT_VERIFY_TIMEOUT_MS = 10_000;
const NO_CERT_DETAIL = 'no TLS certificate for';
/** After a failed certificate check, new ports go straight to http for this long (no 45 s wait each). */
const CERT_FAILURE_MEMORY_MS = 10 * 60_000;

export type ProbeResult = { ok: true; status: number } | { ok: false; error: string };

export interface PanelProcess {
  pid: number;
  panelId: string;
  paneId?: string;
}

export interface SessionPortsDependencies {
  serve: ServeBackend;
  statePath: string;
  /** Tailnet and local ports that stay Pane's own (the daemon's transport port). */
  reservedPorts(): number[];
  /** Directories of the repositories registered with this Pane. */
  projectPaths(): string[];
  readManifest?(repoPath: string): ManifestRead;
  panelProcesses(): PanelProcess[];
  readListeners(): TcpListener[];
  readProcesses(): ProcessEntry[];
  mapSocketOwners(inodes: ReadonlySet<number>, pids: readonly number[]): Map<number, number>;
  /** Any HTTP answer counts as ok; `error` when none came (TLS, refused, timeout). */
  probe(url: string, timeoutMs: number): Promise<ProbeResult>;
  emit(result: SessionPortsListResult): void;
  now(): number;
  log(message: string): void;
}

interface OpenOptions {
  source: SessionPortSource;
  repo?: string;
}

function fail(code: string, message: string, details: Record<string, string | number> = {}): never {
  throw new PaneCommandError(message, code, details);
}

function isOurs(listener: ServeListener | undefined, port: StoredPort | { port: number; scheme: SessionPortScheme }): boolean {
  return listener?.kind === 'web' && listener.scheme === port.scheme && listener.proxy === localTarget(port.port);
}

function portUrl(scheme: SessionPortScheme, dnsName: string, httpsPort: number, urlPath: string): string {
  return `${scheme}://${dnsName}:${httpsPort}${urlPath}`;
}

/**
 * Session ports: publishes local services as tailnet-only URLs on the Session's name with Tailscale
 * Serve, keeps them in `~/.runpane-cloud/ports.json`, re-applies them after a boot or wake that lost
 * them, opens what repositories declare in `.runpane/ports.json`, and suggests (never silently
 * publishes, unless the user opted in) ports that agents' processes start listening on.
 */
export class SessionPortsService {
  private queue: Promise<unknown> = Promise.resolve();
  private suggested: SuggestedPort[] = [];
  private suggestedKey = '';
  private readonly firstSeen = new Map<number, string>();
  private manifests: SessionPortsManifestState[] = [];
  private projectsKey: string | undefined;
  private timers: NodeJS.Timeout[] = [];
  private certFailure: { at: number; error: string } | undefined;

  constructor(private readonly deps: SessionPortsDependencies) {}

  /** Mutations run one at a time: Serve and the state file change together. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private isoNow(): string {
    return new Date(this.deps.now()).toISOString();
  }

  /** The state a mutation starts from; an unreadable state file refuses it (ERR_PORTS_STATE_INVALID) and stays untouched. */
  private readState(): PortsState {
    try {
      return readPortsState(this.deps.statePath);
    } catch (error) {
      if (error instanceof PortsStateError) fail('ERR_PORTS_STATE_INVALID', error.message, { path: error.file });
      throw error;
    }
  }

  /** For listing and detection: an unreadable state file shows as no ports plus `stateError`. */
  private readStateForView(): { state: PortsState; stateError?: string } {
    try {
      return { state: readPortsState(this.deps.statePath) };
    } catch (error) {
      if (!(error instanceof PortsStateError)) throw error;
      return { state: emptyPortsState(), stateError: error.message };
    }
  }

  private saveState(state: PortsState): void {
    writePortsState(this.deps.statePath, state);
  }

  async list(request: { verify?: boolean } = {}): Promise<SessionPortsListResult> {
    const result = await this.snapshot();
    if (!request.verify) return result;
    const ports = await Promise.all(result.ports.map(async (port): Promise<SessionPort> => {
      if (port.status !== 'serving') return { ...port, reachable: false };
      const probe = await this.deps.probe(port.url, VERIFY_TIMEOUT_MS);
      return { ...port, ...reachability(probe) };
    }));
    return { ...result, ports };
  }

  private async snapshot(): Promise<SessionPortsListResult> {
    const { state, stateError } = this.readStateForView();
    const self = await this.deps.serve.self();
    if (!self.running || !self.dnsName) {
      return {
        ok: true,
        stateError,
        autoOpen: state.autoOpen,
        manifests: this.manifests,
        available: false,
        unavailableReason: `Tailscale is not running here (${self.backendState}); Session ports need a Runpane Cloud Session`,
        scheme: 'https',
        ports: [],
        suggested: [],
      };
    }
    const dnsName = self.dnsName;
    const listeners = await this.deps.serve.listeners(dnsName);
    const ports = state.ports.map(port => toSessionPort(port, dnsName, listeners));
    const anyHttpFallback = state.ports.some(port => port.scheme === 'http' && port.detail);
    const scheme: SessionPortScheme = anyHttpFallback && !(await this.deps.serve.certCached(dnsName)) ? 'http' : 'https';
    // Suggestions refresh on the detection tick; one just opened is already a port.
    const published = new Set(state.ports.filter(port => !port.blockedBy).map(port => port.port));
    const suggested = this.suggested.filter(suggestion => !published.has(suggestion.port));
    return { ok: true, stateError, autoOpen: state.autoOpen, manifests: this.manifests, available: true, host: dnsName, scheme, ports, suggested };
  }

  private async emitChanged(): Promise<void> {
    try {
      this.deps.emit(await this.snapshot());
    } catch (error) {
      this.deps.log(`ports: could not send the change event: ${String(error)}`);
    }
  }

  open(request: SessionPortOpenRequest): Promise<SessionPortOpenResult> {
    return this.exclusive(async () => {
      const result = await this.openLocked(request, { source: 'user' });
      await this.emitChanged();
      return result;
    });
  }

  close(target: number | string): Promise<SessionPortCloseResult> {
    return this.exclusive(async () => {
      const state = this.readState();
      const numeric = Number(target);
      const found = state.ports.find(port => port.name === String(target))
        ?? (Number.isInteger(numeric) ? state.ports.find(port => port.port === numeric) : undefined);
      if (!found) return { ok: true, closed: null };
      const self = await this.deps.serve.self();
      let closed: SessionPort = { ...toSessionPort(found, self.dnsName ?? 'localhost', new Map()), status: 'missing' };
      if (self.running && self.dnsName) {
        const listeners = await this.deps.serve.listeners(self.dnsName);
        closed = { ...toSessionPort(found, self.dnsName, listeners), status: 'missing' };
        const listener = listeners.get(found.httpsPort);
        if (listener && isOurs(listener, found)) await this.deps.serve.remove(found.httpsPort, listener);
      }
      state.ports = state.ports.filter(port => port !== found);
      if (found.source === 'manifest' && found.repo) {
        const key = manifestKey(found.repo, found.name);
        if (!state.dismissed.includes(key)) state.dismissed.push(key);
      }
      this.saveState(state);
      this.deps.log(`ports: closed ${found.name} (${found.port} -> :${found.httpsPort})`);
      await this.emitChanged();
      return { ok: true, closed };
    });
  }

  configure(request: { autoOpen: boolean }): Promise<SessionPortsConfigureResult> {
    return this.exclusive(async () => {
      const state = this.readState();
      state.autoOpen = request.autoOpen;
      this.saveState(state);
      await this.emitChanged();
      return { ok: true, autoOpen: state.autoOpen };
    });
  }

  private async openLocked(request: SessionPortOpenRequest, options: OpenOptions): Promise<SessionPortOpenResult> {
    const port = request.port;
    if (!isTcpPort(port)) fail('ERR_PORTS_INVALID', 'port must be an integer 1-65535');
    const name = request.name ?? `port-${port}`;
    if (!PORT_NAME_PATTERN.test(name)) fail('ERR_PORTS_INVALID', 'name must be lowercase letters, digits and hyphens (at most 40)');
    const urlPath = request.path ?? '/';
    if (!isUrlPath(urlPath)) fail('ERR_PORTS_INVALID', 'path must start with / and hold URL characters only');
    const httpsPort = request.httpsPort ?? port;
    if (!isTcpPort(httpsPort)) fail('ERR_PORTS_INVALID', 'the HTTPS port must be an integer 1-65535');
    const reserved = this.deps.reservedPorts();
    if (httpsPort === PANE_HTTPS_PORT || reserved.includes(httpsPort)) {
      fail('ERR_PORTS_RESERVED', `tailnet port ${httpsPort} is Pane's own${request.httpsPort === undefined ? `; pick another with --https-port` : ''}`, { httpsPort });
    }
    if (reserved.includes(port)) fail('ERR_PORTS_RESERVED', `port ${port} is the Pane daemon itself`, { port });

    const self = await this.deps.serve.self();
    if (!self.running || !self.dnsName) {
      fail('ERR_PORTS_UNAVAILABLE', `Tailscale is not running here (${self.backendState}); Session ports need a Runpane Cloud Session`);
    }
    const dnsName = self.dnsName;
    const state = this.readState();
    const found = state.ports.find(entry => entry.port === port);
    // Asking for another scheme on the same tailnet port re-publishes it (e.g. https once a certificate exists).
    const rescheme = Boolean(found && request.scheme && request.scheme !== 'auto' && request.scheme !== found.scheme
      && (request.httpsPort === undefined || request.httpsPort === found.httpsPort));
    const sameLocal = rescheme ? undefined : found;
    if (sameLocal && (request.httpsPort === undefined || sameLocal.httpsPort === httpsPort) && !sameLocal.blockedBy) {
      return this.reopenExisting(state, sameLocal, request, dnsName);
    }
    if (sameLocal && !sameLocal.blockedBy) {
      fail('ERR_PORTS_IN_USE', `port ${port} is already published as ${sameLocal.name} on tailnet port ${sameLocal.httpsPort}; close it first`, { port });
    }
    const sameTailnet = state.ports.find(entry => entry.httpsPort === httpsPort && entry.port !== port);
    if (sameTailnet) {
      fail('ERR_PORTS_IN_USE', `tailnet port ${httpsPort} already serves ${sameTailnet.name} (port ${sameTailnet.port}); pick another with --https-port`, { httpsPort });
    }
    const sameName = state.ports.find(entry => entry.name === name && entry.port !== port);
    if (sameName) fail('ERR_PORTS_INVALID', `the name ${name} is taken by port ${sameName.port}; pass --name`);

    const listeners = await this.deps.serve.listeners(dnsName);
    if (found && rescheme) {
      const own = listeners.get(found.httpsPort);
      if (own && isOurs(own, found)) {
        await this.deps.serve.remove(found.httpsPort, own);
        listeners.delete(found.httpsPort);
      }
    }
    const current = listeners.get(httpsPort);
    let replaced: SessionPortOpenResult['replaced'];
    if (current && !(current.kind === 'web' && current.proxy === localTarget(port))) {
      const was = describeListener(current);
      if (!request.yes) {
        fail('ERR_PORTS_CONFLICT', `tailnet port ${httpsPort} is already served by Tailscale Serve (${was}); rerun with --yes to replace it`, { httpsPort, was });
      }
      await this.deps.serve.remove(httpsPort, current);
      replaced = { httpsPort, was };
      this.deps.log(`ports: replaced the Serve entry on :${httpsPort} (${was})`);
    }

    const remaining = replaced ? undefined : current;
    const { scheme, detail } = await this.applyScheme(request.scheme ?? 'auto', dnsName, httpsPort, port, remaining);
    const stored: StoredPort = {
      name,
      port,
      httpsPort,
      scheme,
      path: urlPath,
      source: options.source,
      repo: options.repo,
      createdAt: this.isoNow(),
      detail,
    };
    state.ports = [...state.ports.filter(entry => entry.port !== port), stored];
    if (options.repo) state.dismissed = state.dismissed.filter(key => key !== manifestKey(options.repo ?? '', name));
    this.saveState(state);
    this.deps.log(`ports: opened ${name} ${localTarget(port)} -> ${portUrl(scheme, dnsName, httpsPort, urlPath)} (${options.source})`);
    const published = toSessionPort(stored, dnsName, new Map([[httpsPort, { kind: 'web', scheme, proxy: localTarget(port) }]]));
    return replaced ? { ok: true, port: published, alreadyOpen: false, replaced } : { ok: true, port: published, alreadyOpen: false };
  }

  private async reopenExisting(state: PortsState, existing: StoredPort, request: SessionPortOpenRequest, dnsName: string): Promise<SessionPortOpenResult> {
    if (request.name && request.name !== existing.name) {
      if (state.ports.some(entry => entry.name === request.name)) fail('ERR_PORTS_INVALID', `the name ${request.name} is taken`);
      existing.name = request.name;
    }
    if (request.path) existing.path = request.path;
    const listeners = await this.deps.serve.listeners(dnsName);
    if (!isOurs(listeners.get(existing.httpsPort), existing)) {
      const current = listeners.get(existing.httpsPort);
      if (current) {
        if (!request.yes) fail('ERR_PORTS_CONFLICT', `tailnet port ${existing.httpsPort} is now served by ${describeListener(current)}; rerun with --yes to replace it`, { httpsPort: existing.httpsPort });
        await this.deps.serve.remove(existing.httpsPort, current);
      }
      await this.deps.serve.applyWeb(existing.scheme, existing.httpsPort, existing.port);
      listeners.set(existing.httpsPort, { kind: 'web', scheme: existing.scheme, proxy: localTarget(existing.port) });
    }
    this.saveState(state);
    return { ok: true, port: toSessionPort(existing, dnsName, listeners), alreadyOpen: true };
  }

  /**
   * HTTPS when the name has a certificate; tailscaled gets one on the first TLS request, so without a
   * cached one the first request is the check (one Let's Encrypt issuance per host name, which then
   * covers every port). No certificate in time: plain HTTP inside the tailnet, and `detail` says why.
   */
  private async applyScheme(
    requested: 'auto' | SessionPortScheme,
    dnsName: string,
    httpsPort: number,
    port: number,
    current: ServeListener | undefined,
  ): Promise<{ scheme: SessionPortScheme; detail?: string }> {
    const apply = async (scheme: SessionPortScheme) => {
      if (current && isOurs(current, { port, scheme })) return;
      if (current) await this.deps.serve.remove(httpsPort, current);
      await this.deps.serve.applyWeb(scheme, httpsPort, port);
      current = { kind: 'web', scheme, proxy: localTarget(port) };
    };
    if (requested === 'http') {
      await apply('http');
      return { scheme: 'http', detail: 'plain HTTP inside the tailnet, as asked' };
    }
    if (requested === 'https' || (await this.deps.serve.certCached(dnsName))) {
      await apply('https');
      return { scheme: 'https' };
    }
    const recent = this.certFailure && this.deps.now() - this.certFailure.at < CERT_FAILURE_MEMORY_MS ? this.certFailure : undefined;
    let probe: ProbeResult = { ok: false, error: recent?.error ?? '' };
    if (!recent) {
      await apply('https');
      probe = await this.deps.probe(portUrl('https', dnsName, httpsPort, '/'), CERT_PROBE_TIMEOUT_MS);
      if (probe.ok) {
        this.certFailure = undefined;
        return { scheme: 'https' };
      }
      this.certFailure = { at: this.deps.now(), error: probe.error };
    }
    this.deps.log(`ports: no TLS certificate for ${dnsName} (${probe.error}); falling back to http on :${httpsPort}`);
    await apply('http');
    return {
      scheme: 'http',
      detail: `${NO_CERT_DETAIL} ${dnsName} yet (${probe.error}; Let's Encrypt's weekly limit per tailnet is the usual cause); plain HTTP inside the tailnet (WireGuard-encrypted) until tailscaled has one, then https by itself. Retry now with: runpane port open ${port} --scheme https`,
    };
  }

  /**
   * Brings Serve in line with the state and the repositories' manifests: opens newly declared manifest
   * ports, closes ones a manifest dropped, re-applies entries a boot or wake lost, and (at boot) checks
   * each URL answers. Never replaces a Serve entry it did not make.
   */
  reconcile(reason: string): Promise<void> {
    return this.exclusive(async () => {
      const self = await this.deps.serve.self();
      if (!self.running || !self.dnsName) {
        this.deps.log(`ports: reconcile (${reason}) skipped: Tailscale is ${self.backendState}`);
        return;
      }
      const dnsName = self.dnsName;
      const before = JSON.stringify({ state: this.readState(), manifests: this.manifests });
      await this.reconcileManifests();
      const reapplied = await this.reapplyMissing(dnsName);
      await this.upgradeToHttps(dnsName);
      const after = JSON.stringify({ state: this.readState(), manifests: this.manifests });
      if (reapplied.length > 0) this.deps.log(`ports: reconcile (${reason}) RE-APPLIED ${reapplied.join(', ')}`);
      if (reason === 'boot') await this.verifyAll(dnsName);
      if (before !== after || reapplied.length > 0) await this.emitChanged();
    });
  }

  private async reconcileManifests(): Promise<void> {
    const readManifest = this.deps.readManifest ?? readPortsManifest;
    const repos = [...new Set(this.deps.projectPaths())];
    this.projectsKey = projectsKeyOf(repos);
    const reads = new Map(repos.map(repo => [repo, readManifest(repo)]));
    this.manifests = [...reads.entries()]
      .filter(([, read]) => read.kind !== 'absent')
      .map(([repo, read]) => read.kind === 'ok' ? { repo, ok: true, count: read.ports.length } : { repo, ok: false, error: read.kind === 'invalid' ? read.error : '', count: 0 });

    const state = this.readState();
    // Drop manifest ports whose declaration is gone (an invalid manifest keeps what it had).
    for (const stored of state.ports.filter(entry => entry.source === 'manifest')) {
      const read = stored.repo ? reads.get(stored.repo) : undefined;
      if (read?.kind === 'invalid') continue;
      const declared = read?.kind === 'ok' ? read.ports.find(entry => entry.name === stored.name) : undefined;
      if (declared && declared.port === stored.port && (declared.httpsPort ?? declared.port) === stored.httpsPort) {
        if (declared.path !== stored.path) {
          this.updateStored(stored, { path: declared.path });
        }
        continue;
      }
      await this.dropStored(stored, 'no longer declared');
    }

    for (const [repo, read] of reads) {
      if (read.kind !== 'ok') continue;
      for (const entry of read.ports) {
        const current = this.readState();
        if (current.dismissed.includes(manifestKey(repo, entry.name))) continue;
        const existing = current.ports.find(port => port.port === entry.port);
        if (existing && !existing.blockedBy) continue;
        if (existing?.blockedBy && existing.source !== 'manifest') continue;
        try {
          await this.openLocked({ port: entry.port, name: entry.name, httpsPort: entry.httpsPort, path: entry.path }, { source: 'manifest', repo });
        } catch (error) {
          const conflict = error instanceof PaneCommandError && error.code === 'ERR_PORTS_CONFLICT';
          this.recordBlocked(entry, repo, error instanceof Error ? error.message : String(error), conflict);
        }
      }
    }
  }

  private updateStored(stored: StoredPort, change: Partial<StoredPort>): void {
    const state = this.readState();
    state.ports = state.ports.map(entry => entry.port === stored.port ? { ...entry, ...change } : entry);
    this.saveState(state);
  }

  private async dropStored(stored: StoredPort, why: string): Promise<void> {
    const self = await this.deps.serve.self();
    if (self.running && self.dnsName && !stored.blockedBy) {
      const listener = (await this.deps.serve.listeners(self.dnsName)).get(stored.httpsPort);
      if (listener && isOurs(listener, stored)) await this.deps.serve.remove(stored.httpsPort, listener);
    }
    const state = this.readState();
    state.ports = state.ports.filter(entry => entry.port !== stored.port);
    this.saveState(state);
    this.deps.log(`ports: closed ${stored.name} (${why})`);
  }

  private recordBlocked(entry: { name: string; port: number; httpsPort?: number; path: string }, repo: string, message: string, conflict: boolean): void {
    this.deps.log(`ports: manifest port ${entry.name} (${repo}) not opened: ${message}`);
    const state = this.readState();
    if (state.ports.some(port => port.port === entry.port && !port.blockedBy)) return;
    // A port or name clash with another published port is shown on the manifest, not stored.
    if (!conflict) {
      this.manifests = this.manifests.map(manifest => manifest.repo === repo ? { ...manifest, error: `${entry.name}: ${message}` } : manifest);
      return;
    }
    const blocked: StoredPort = {
      name: entry.name,
      port: entry.port,
      httpsPort: entry.httpsPort ?? entry.port,
      scheme: 'https',
      path: entry.path,
      source: 'manifest',
      repo,
      createdAt: this.isoNow(),
      blockedBy: message,
    };
    state.ports = [...state.ports.filter(port => port.port !== entry.port), blocked];
    this.saveState(state);
  }

  /** Re-applies entries Serve lost, marks ones another entry took over, and frees ones whose clash left. */
  private async reapplyMissing(dnsName: string): Promise<string[]> {
    const state = this.readState();
    const listeners = await this.deps.serve.listeners(dnsName);
    const reapplied: string[] = [];
    let changed = false;
    for (const stored of state.ports) {
      const listener = listeners.get(stored.httpsPort);
      if (isOurs(listener, stored)) {
        if (stored.blockedBy) {
          delete stored.blockedBy;
          changed = true;
        }
        continue;
      }
      if (listener) {
        if (!stored.blockedBy) {
          stored.blockedBy = `tailnet port ${stored.httpsPort} is now served by ${describeListener(listener)}; runpane port open ${stored.port} --yes replaces it`;
          changed = true;
        }
        continue;
      }
      try {
        await this.deps.serve.applyWeb(stored.scheme, stored.httpsPort, stored.port);
        reapplied.push(`${stored.name} :${stored.httpsPort}`);
        if (stored.blockedBy) {
          delete stored.blockedBy;
          changed = true;
        }
      } catch (error) {
        this.deps.log(`ports: could not re-apply ${stored.name}: ${String(error)}`);
      }
    }
    if (changed) this.saveState(state);
    return reapplied;
  }

  /** Ports that fell back to http for want of a certificate move to https once tailscaled holds one. */
  private async upgradeToHttps(dnsName: string): Promise<void> {
    const state = this.readState();
    const waiting = state.ports.filter(port => port.scheme === 'http' && port.detail?.startsWith(NO_CERT_DETAIL) && !port.blockedBy);
    if (waiting.length === 0 || !(await this.deps.serve.certCached(dnsName))) return;
    const listeners = await this.deps.serve.listeners(dnsName);
    for (const stored of waiting) {
      const listener = listeners.get(stored.httpsPort);
      if (listener && isOurs(listener, stored)) await this.deps.serve.remove(stored.httpsPort, listener);
      await this.deps.serve.applyWeb('https', stored.httpsPort, stored.port);
      stored.scheme = 'https';
      delete stored.detail;
      this.deps.log(`ports: ${stored.name} moved to https now that ${dnsName} has a certificate`);
    }
    this.saveState(state);
  }

  private async verifyAll(dnsName: string): Promise<void> {
    for (const stored of this.readState().ports.filter(port => !port.blockedBy)) {
      const url = portUrl(stored.scheme, dnsName, stored.httpsPort, stored.path);
      const probe = await this.deps.probe(url, BOOT_VERIFY_TIMEOUT_MS);
      this.deps.log(`ports: verify ${stored.name} ${url}: ${probe.ok ? `HTTP ${probe.status}` : `no answer (${probe.error})`}`);
    }
  }

  /**
   * One detection round: TCP listeners on loopback or wildcard addresses whose process descends from a
   * Pane panel become suggestions. With autoOpen they are published. Cheap when nothing changed.
   */
  async detect(): Promise<void> {
    // The reconcile records the repositories it read, so one added at any moment since is seen here.
    if (this.projectsKey !== undefined && projectsKeyOf(this.deps.projectPaths()) !== this.projectsKey) {
      await this.reconcile('repo-add');
    }

    const { state } = this.readStateForView();
    const panels = this.deps.panelProcesses();
    const published = new Set(state.ports.filter(port => !port.blockedBy).map(port => port.port));
    const reserved = new Set(this.deps.reservedPorts());
    const candidates = panels.length === 0 ? [] : this.deps.readListeners()
      .filter(listener => !published.has(listener.port) && !reserved.has(listener.port));
    const key = candidates.map(listener => `${listener.port}/${listener.inode}`).sort().join(',');
    if (key === this.suggestedKey) return;
    this.suggestedKey = key;

    const table = candidates.length > 0 ? this.deps.readProcesses() : [];
    const owners = this.deps.mapSocketOwners(new Set(candidates.map(listener => listener.inode)), table.map(entry => entry.pid));
    const names = new Map(table.map(entry => [entry.pid, entry.name]));
    const byPort = new Map<number, SuggestedPort>();
    for (const listener of candidates) {
      const pid = owners.get(listener.inode);
      if (pid === undefined || byPort.has(listener.port)) continue;
      const panel = findPanelAncestor(pid, table, panels);
      if (!panel) continue;
      const detectedAt = this.firstSeen.get(listener.port) ?? this.isoNow();
      this.firstSeen.set(listener.port, detectedAt);
      byPort.set(listener.port, {
        port: listener.port,
        address: listener.address,
        process: names.get(pid),
        pid,
        paneId: panel.paneId,
        panelId: panel.panelId,
        detectedAt,
      });
    }
    for (const port of [...this.firstSeen.keys()]) if (!byPort.has(port)) this.firstSeen.delete(port);
    this.suggested = [...byPort.values()].sort((a, b) => a.port - b.port);

    if (state.autoOpen) {
      for (const suggestion of this.suggested) {
        try {
          await this.exclusive(() => this.openLocked({ port: suggestion.port }, { source: 'auto' }));
        } catch (error) {
          this.deps.log(`ports: auto-open of ${suggestion.port} failed: ${String(error)}`);
        }
      }
      // Published ones leave the suggestions at the next round.
      this.suggestedKey = '';
    }
    await this.emitChanged();
  }

  /**
   * Boot (and wake, which is a boot): reconcile once Tailscale runs, then every minute; detection
   * every few seconds. Timers never keep the process alive.
   */
  start(options: { reconcileIntervalMs?: number; detectIntervalMs?: number; bootRetryMs?: number; bootAttempts?: number } = {}): void {
    const bootRetryMs = options.bootRetryMs ?? 5_000;
    let attempts = options.bootAttempts ?? 36;
    const boot = async () => {
      const self = await this.deps.serve.self().catch(() => ({ running: false, backendState: 'unknown' }));
      if (!self.running && --attempts > 0) {
        this.timers.push(setTimeout(() => void boot(), bootRetryMs).unref());
        return;
      }
      await this.reconcile('boot').catch(error => this.deps.log(`ports: boot reconcile failed: ${String(error)}`));
      this.timers.push(setInterval(() => {
        void this.reconcile('periodic').catch(error => this.deps.log(`ports: reconcile failed: ${String(error)}`));
      }, options.reconcileIntervalMs ?? 60_000).unref());
    };
    this.timers.push(setTimeout(() => void boot(), 0).unref());
    this.timers.push(setInterval(() => {
      void this.detect().catch(error => this.deps.log(`ports: detection failed: ${String(error)}`));
    }, options.detectIntervalMs ?? 5_000).unref());
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }
}

function projectsKeyOf(paths: readonly string[]): string {
  return JSON.stringify([...new Set(paths)].sort());
}

function reachability(probe: ProbeResult): Pick<SessionPort, 'reachable' | 'detail'> {
  if (!probe.ok) return { reachable: false, detail: `no answer: ${probe.error}` };
  // Serve answers 502 when nothing listens on the local port.
  if (probe.status === 502) return { reachable: false, detail: 'Tailscale Serve answered 502: nothing listens on the local port' };
  return { reachable: true };
}

function toSessionPort(stored: StoredPort, dnsName: string, listeners: Map<number, ServeListener>): SessionPort {
  const status = stored.blockedBy ? 'error' : isOurs(listeners.get(stored.httpsPort), stored) ? 'serving' : 'missing';
  const port: SessionPort = {
    name: stored.name,
    port: stored.port,
    httpsPort: stored.httpsPort,
    url: portUrl(stored.scheme, dnsName, stored.httpsPort, stored.path),
    scheme: stored.scheme,
    path: stored.path,
    source: stored.source,
    createdAt: stored.createdAt,
    status,
  };
  if (stored.repo) port.repo = stored.repo;
  const detail = stored.blockedBy ?? stored.detail;
  if (detail) port.detail = detail;
  return port;
}
