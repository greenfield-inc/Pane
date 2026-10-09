import { createHash, randomBytes } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import type { ListeningPortsSnapshot } from '../../../shared/types/listeningPorts';
import { authenticateWorkspaceRequest } from './auth';
import { runRemoteSetupCommand, type RemoteSetupCommandRunner } from './remote-setup-command';
import { resolveTailscaleCommandAsync, runTailscaleServe, type ResolvedCommand } from './tailscaleSetup';
import { startPreviewProxy, type PreviewFiles, type PreviewProxy } from './previewProxy';
import type { PaneWorkspaceHostController } from './workspaceHost';

/** Serve ports Pane picks for phone pages start here, clear of common dev server ports. */
const FIRST_SERVE_PORT = 44300;
const FILES = 'files';
const PASSWORD_REASON = 'this machine is password protected, and a page in a frame cannot send the password';
/**
 * Quit removes handlers one `tailscale serve` call at a time, inside Pane's 10 s shutdown budget.
 * Whatever is left after this long is removed at the next launch.
 */
const QUIT_REMOVAL_BUDGET_MS = 5_000;

const serveStatusSchema = boundary.object({
  TCP: boundary.optional(boundary.nullable(boundary.jsonObject)),
  Web: boundary.optional(boundary.nullable(boundary.jsonObject)),
});
const webHandlerSchema = boundary.object({
  Handlers: boundary.optional(boundary.nullable(boundary.jsonObject)),
});
const proxyHandlerSchema = boundary.object({ Proxy: boundary.optional(boundary.string) });

export interface PhonePreviewHostOptions {
  workspace: Pick<PaneWorkspaceHostController, 'getTailnet' | 'getAccessPolicy' | 'getStatus' | 'onSync'>;
  /** This Pane's data directory: its hash marks the Serve handlers this instance owns. */
  paneDir: string;
  files: PreviewFiles;
  run?: RemoteSetupCommandRunner;
  /** Phone addresses changed: publish the Ports list again. */
  onChange?(): void;
}

/**
 * Phone pages: one `tailscale serve --https=<n>` handler per web port, plus one for HTML files and
 * media, each pointing at a loopback preview proxy. Every handler target starts with
 * `/pane-<instance>/`, so a relaunch, even after kill -9, finds and removes this instance's
 * leftovers without touching handlers that belong to anyone else.
 */
export class PhonePreviewHost {
  private readonly instancePrefix: string;
  private readonly basePath: string;
  private readonly run: RemoteSetupCommandRunner;
  private proxy: PreviewProxy | null = null;
  /** Serve HTTPS port for each forwarded port (by number) and for files. */
  private handlers = new Map<string, number>();
  private webPorts: number[] = [];
  private listeningPorts = new Set<number>();
  private lastError: string | null = null;
  /** What `decorate` last reflected, to publish only real changes. */
  private published = '';
  /** Serve holds none of this instance's handlers, so a pass with nothing wanted has nothing to do. */
  private serveClear = false;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
  /** Past this time, quit stops removing handlers and leaves the rest to the next launch. */
  private removeUntil = Number.POSITIVE_INFINITY;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly options: PhonePreviewHostOptions) {
    this.instancePrefix = `/pane-${createHash('sha256').update(options.paneDir).digest('hex').slice(0, 8)}/`;
    this.basePath = `${this.instancePrefix}${randomBytes(24).toString('hex')}`;
    this.run = options.run ?? runRemoteSetupCommand;
  }

  async start(): Promise<void> {
    this.proxy = await startPreviewProxy({ basePath: this.basePath, gate: () => this.gate(), files: this.options.files });
    // The workspace re-reads the tailnet every minute; follow it, and remove leftovers now.
    this.unsubscribe = this.options.workspace.onSync(() => void this.reconcile());
    await this.reconcile();
  }

  /** Follows the Ports list: web ports gain handlers, and ports that stopped listening lose theirs. */
  update(snapshot: ListeningPortsSnapshot): Promise<void> {
    this.webPorts = snapshot.ports.filter(port => port.kind === 'web').map(port => port.port);
    this.listeningPorts = new Set(snapshot.ports.map(port => port.port));
    return this.reconcile();
  }

  /** The Ports list as phones need it: each web port's phone address, and whether pages work. */
  decorate(snapshot: ListeningPortsSnapshot): ListeningPortsSnapshot {
    const tailnet = this.options.workspace.getTailnet();
    const filesPort = this.handlers.get(FILES);
    if (this.options.workspace.getAccessPolicy()?.verifySecret) {
      return { ...snapshot, phone: { state: 'off', reason: PASSWORD_REASON } };
    }
    if (!tailnet || filesPort === undefined) {
      const status = this.options.workspace.getStatus();
      const reason = this.lastError ?? (status.state === 'off' ? status.reason ?? 'starting' : 'starting');
      return { ...snapshot, phone: { state: 'off', reason } };
    }
    const origin = (servePort: number) => `https://${tailnet.dnsName}:${servePort}`;
    return {
      ...snapshot,
      ports: snapshot.ports.map(port => {
        const servePort = this.handlers.get(String(port.port));
        return servePort === undefined ? port : { ...port, phoneUrl: origin(servePort) };
      }),
      phone: { state: 'on', filesUrl: origin(filesPort) },
    };
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.removeUntil = Date.now() + QUIT_REMOVAL_BUDGET_MS;
    this.unsubscribe?.();
    await this.reconcile();
    await this.proxy?.close();
    this.proxy = null;
  }

  private gate() {
    const tailnet = this.options.workspace.getTailnet();
    const policy = this.options.workspace.getAccessPolicy();
    if (!tailnet || !policy) return null;
    // A frame sends no password, so on a password-protected machine every page request fails here.
    const detected = new Set(this.webPorts);
    return {
      dnsName: tailnet.dnsName,
      machineName: tailnet.machineName,
      ownerLogin: tailnet.ownerLogin,
      admits: (login: string) => authenticateWorkspaceRequest(login, undefined, policy).ok,
      // Detection revokes a port at once, before Serve confirms its handler is gone.
      ports: new Set([...this.handlers.keys()].filter(key => key !== FILES).map(Number).filter(port => detected.has(port))),
    };
  }

  private reconcile(): Promise<void> {
    const work = () => this.applyHandlers().catch(error => {
      this.lastError = error instanceof Error ? error.message : String(error);
      console.warn('[Pane phone previews] Serve handlers out of sync:', this.lastError);
    });
    this.queue = this.queue.then(work, work);
    return this.queue;
  }

  /** Makes Serve hold exactly this instance's wanted handlers, starting from what Serve reports. */
  private async applyHandlers(): Promise<void> {
    const tailnet = this.stopped ? null : this.options.workspace.getTailnet();
    if (!tailnet && this.serveClear) {
      this.publishIfChanged();
      return;
    }
    const tailscale: ResolvedCommand | null = tailnet?.tailscale ?? await resolveTailscaleCommandAsync(this.run);
    if (!tailscale) {
      this.handlers.clear();
      this.publishIfChanged();
      return;
    }
    // At quit, no single call may outlast the removal budget.
    const serve = (args: string[]) => runTailscaleServe(this.run, tailscale, args, this.stopped ? Math.max(500, this.removeUntil - Date.now()) : undefined);
    const next = new Map<string, number>();
    let failure: string | null = null;
    // Another Pane may pick ports from the same Serve config, so reading, choosing and writing happen under one machine-wide lock.
    await withServeLock(this.stopped ? Math.max(0, this.removeUntil - Date.now()) : SERVE_LOCK_WAIT_MS, async () => {
      const status = await serve(['status', '--json']);
      if (!status.ok) throw new Error(`tailscale serve status failed: ${firstLine(status.stderr || status.stdout)}`);
      const { ours, taken } = this.readServeConfig(status.stdout);

      const proxyPort = this.proxy?.port;
      const target = (key: string) => `http://127.0.0.1:${proxyPort}${this.basePath}/${key}`;
      const passwordProtected = Boolean(this.options.workspace.getAccessPolicy()?.verifySecret);
      const wanted = tailnet && proxyPort && !passwordProtected ? [FILES, ...this.webPorts.map(String)] : [];

      for (const handler of ours) {
        if (wanted.includes(handler.key) && handler.target === target(handler.key) && !next.has(handler.key)) {
          next.set(handler.key, handler.servePort);
          continue;
        }
        if (Date.now() > this.removeUntil) {
          failure ??= 'quit ran out of time; the next launch removes the remaining Serve handlers';
          break;
        }
        // --set-path=/ removes only Pane's mount; other routes on the same port stay.
        const removal = await serve([`--https=${handler.servePort}`, '--set-path=/', 'off']);
        if (!removal.ok) failure ??= `could not remove the Serve handler on ${handler.servePort}: ${firstLine(removal.stderr || removal.stdout)}`;
      }
      for (const key of wanted) {
        if (next.has(key)) continue;
        let servePort = FIRST_SERVE_PORT;
        while (taken.has(servePort) || this.listeningPorts.has(servePort)) servePort += 1;
        taken.add(servePort);
        const added = await serve(['--bg', `--https=${servePort}`, target(key)]);
        if (added.ok) next.set(key, servePort);
        else failure ??= `tailscale serve could not add a handler on ${servePort}: ${firstLine(added.stderr || added.stdout)}`;
      }
    });

    this.handlers = next;
    this.lastError = failure;
    this.serveClear = next.size === 0 && failure === null;
    this.publishIfChanged();
  }

  /** Phone addresses are the tailnet name plus the handler ports, so either changing republishes. */
  private publishIfChanged(): void {
    const published = JSON.stringify([this.options.workspace.getTailnet()?.dnsName ?? null, ...this.handlers]);
    if (published === this.published) return;
    this.published = published;
    this.options.onChange?.();
  }

  /** This instance's handlers (any launch's), and every Serve port in use. */
  private readServeConfig(json: string) {
    let parsed: ReturnType<typeof serveStatusSchema.decode> | undefined;
    try {
      parsed = decodeOptionalBoundary(JSON.parse(json), serveStatusSchema);
    } catch {
      parsed = undefined;
    }
    const taken = new Set(Object.keys(parsed?.TCP ?? {}).map(Number));
    const ours: Array<{ servePort: number; key: string; target: string }> = [];
    for (const [hostPort, value] of Object.entries(parsed?.Web ?? {})) {
      const servePort = Number(hostPort.slice(hostPort.lastIndexOf(':') + 1));
      taken.add(servePort);
      const handlers = decodeOptionalBoundary(value, webHandlerSchema)?.Handlers ?? {};
      const target = decodeOptionalBoundary(handlers['/'], proxyHandlerSchema)?.Proxy;
      if (!target) continue;
      const path = new URL(target, 'http://invalid').pathname;
      if (!path.startsWith(this.instancePrefix)) continue;
      ours.push({ servePort, key: path.slice(path.lastIndexOf('/') + 1), target });
    }
    return { ours, taken };
  }
}

const SERVE_LOCK = path.join(os.tmpdir(), 'pane-tailscale-serve.lock');
const SERVE_LOCK_WAIT_MS = 30_000;
/** A lock older than this is left from a crash, even if its pid was reused. */
const SERVE_LOCK_STALE_MS = 120_000;

/**
 * Runs `work` while holding a lock every Pane on this machine shares: a directory created
 * atomically, holding the owner's pid. A dead owner's lock is taken over.
 */
async function withServeLock(waitMs: number, work: () => Promise<void>): Promise<void> {
  const giveUpAt = Date.now() + waitMs;
  for (;;) {
    try {
      await fs.mkdir(SERVE_LOCK);
      break;
    } catch (error) {
      // SAFETY: fs.mkdir rejects with a Node system error carrying `code`.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const owner = Number(await fs.readFile(path.join(SERVE_LOCK, 'pid'), 'utf8').catch(() => ''));
    const age = Date.now() - ((await fs.stat(SERVE_LOCK).catch(() => null))?.mtimeMs ?? Date.now());
    // A lock with no pid yet is being taken; give its owner a moment to write one.
    const abandoned = age > SERVE_LOCK_STALE_MS || (owner > 0 ? !isRunning(owner) : age > 2_000);
    if (abandoned) {
      await fs.rm(SERVE_LOCK, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= giveUpAt) throw new Error('another Pane on this machine is changing Serve handlers');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  try {
    await fs.writeFile(path.join(SERVE_LOCK, 'pid'), String(process.pid));
    await work();
  } finally {
    await fs.rm(SERVE_LOCK, { recursive: true, force: true });
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // SAFETY: process.kill throws a Node system error carrying `code`.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/u)[0] ?? '';
}
