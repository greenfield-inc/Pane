import { createHash, randomBytes } from 'crypto';
import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import type { ListeningPortsSnapshot } from '../../../shared/types/listeningPorts';
import { authenticateWorkspaceRequest } from './auth';
import { runRemoteSetupCommand, type RemoteSetupCommandRunner } from './remote-setup-command';
import { resolveTailscaleCommandAsync, type ResolvedCommand } from './tailscaleSetup';
import { startPreviewProxy, type PreviewFiles, type PreviewProxy } from './previewProxy';
import type { PaneWorkspaceHostController } from './workspaceHost';

/** Serve ports Pane picks for phone pages start here, clear of common dev server ports. */
const FIRST_SERVE_PORT = 44300;
const FILES = 'files';

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
  /** Serve holds none of this instance's handlers, so a pass with nothing wanted has nothing to do. */
  private serveClear = false;
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;
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
    this.unsubscribe?.();
    await this.reconcile();
    await this.proxy?.close();
    this.proxy = null;
  }

  private gate() {
    const tailnet = this.options.workspace.getTailnet();
    const policy = this.options.workspace.getAccessPolicy();
    if (!tailnet || !policy) return null;
    // A frame cannot send the machine's password, so password protection admits the owner only.
    const pagePolicy = { ...policy, visibility: policy.verifySecret ? 'owner' as const : policy.visibility, verifySecret: null };
    return {
      dnsName: tailnet.dnsName,
      machineName: tailnet.machineName,
      ownerLogin: tailnet.ownerLogin,
      admits: (login: string) => authenticateWorkspaceRequest(login, undefined, pagePolicy).ok,
      ports: new Set([...this.handlers.keys()].filter(key => key !== FILES).map(Number)),
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
    const before = JSON.stringify([...this.handlers]);
    const tailnet = this.stopped ? null : this.options.workspace.getTailnet();
    if (!tailnet && this.serveClear) return;
    const tailscale: ResolvedCommand | null = tailnet?.tailscale ?? await resolveTailscaleCommandAsync(this.run);
    if (!tailscale) {
      this.handlers.clear();
      this.notifyIfChanged(before);
      return;
    }
    const serve = (args: string[]) => this.run(tailscale.command, ['serve', ...args], { env: tailscale.env });
    const status = await serve(['status', '--json']);
    if (!status.ok) throw new Error(`tailscale serve status failed: ${firstLine(status.stderr || status.stdout)}`);
    const { ours, taken } = this.readServeConfig(status.stdout);

    const proxyPort = this.proxy?.port;
    const target = (key: string) => `http://127.0.0.1:${proxyPort}${this.basePath}/${key}`;
    const wanted = tailnet && proxyPort ? [FILES, ...this.webPorts.map(String)] : [];
    const next = new Map<string, number>();
    let failure: string | null = null;

    for (const handler of ours) {
      if (wanted.includes(handler.key) && handler.target === target(handler.key) && !next.has(handler.key)) {
        next.set(handler.key, handler.servePort);
        continue;
      }
      const removal = await serve([`--https=${handler.servePort}`, 'off']);
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

    this.handlers = next;
    this.lastError = failure;
    this.serveClear = next.size === 0 && failure === null;
    this.notifyIfChanged(before);
  }

  private notifyIfChanged(before: string): void {
    if (JSON.stringify([...this.handlers]) !== before) this.options.onChange?.();
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

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/u)[0] ?? '';
}
