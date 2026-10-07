import type { ConfigManager } from '../services/configManager';
import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import type { PaneCommandRegistry } from './commandRegistry';
import { PaneRemoteHttpApiServer } from './httpApiServer';
import { runRemoteSetupCommand, type RemoteSetupCommandRunner } from './remote-setup-command';
import { randomBytes } from 'crypto';
import type { PaneEventSink } from '../core/eventSink';
import {
  isTailscaleServeDisabled,
  isTailscaleServePermissionDenied,
  readTailscaleServeHandlers,
  resolveTailscaleCommandAsync,
  type ResolvedCommand,
} from './tailscaleSetup';

/** Tailnet port for workspaces; the remote daemon keeps 443. */
const WORKSPACE_HTTPS_PORT = 8443;
/** How often Pane re-reads the tailnet: Tailscale may start after Pane, or switch tailnets under it. */
const CHECK_INTERVAL_MS = 60_000;

export type TailnetSelf =
  | { ok: true; ownerLogin: string; machineName: string; dnsName: string }
  | { ok: false; reason: string; fix: string };

export interface WorkspaceHostStatus {
  state: 'on' | 'off';
  /** Why workspaces are off, and the one step that turns them on. */
  reason?: string;
  fix?: string;
  machineName?: string;
  url?: string;
}

const tailnetStatusSchema = boundary.object({
  BackendState: boundary.string,
  CertDomains: boundary.optional(boundary.nullable(boundary.array(boundary.string))),
  Self: boundary.optional(boundary.nullable(boundary.object({
    DNSName: boundary.string,
    UserID: boundary.number,
    Tags: boundary.optional(boundary.nullable(boundary.array(boundary.string))),
  }))),
  User: boundary.optional(boundary.nullable(boundary.jsonObject)),
});
const tailnetUserSchema = boundary.object({ LoginName: boundary.string });

/** Reads this machine's owner and name from the output of `tailscale status --json`. */
export function readTailnetSelf(statusJson: string): TailnetSelf {
  let parsed: ReturnType<typeof tailnetStatusSchema.decode> | undefined;
  try {
    parsed = decodeOptionalBoundary(JSON.parse(statusJson), tailnetStatusSchema);
  } catch {
    parsed = undefined;
  }
  if (!parsed) {
    return { ok: false, reason: 'Tailscale status could not be read', fix: 'Update Tailscale, then restart Pane.' };
  }
  if (parsed.BackendState !== 'Running' || !parsed.Self) {
    return { ok: false, reason: 'Tailscale is signed out', fix: 'Open Tailscale and sign in.' };
  }
  if (parsed.Self.Tags?.length) {
    return {
      ok: false,
      reason: 'this machine is a tagged Tailscale device, so it has no owner to trust',
      fix: 'Sign this machine in to Tailscale as yourself instead of with a tag.',
    };
  }
  if (!parsed.CertDomains?.length) {
    return {
      ok: false,
      reason: 'this tailnet has HTTPS certificates turned off',
      fix: 'Turn on HTTPS Certificates at https://login.tailscale.com/admin/dns.',
    };
  }
  const owner = decodeOptionalBoundary(parsed.User?.[String(parsed.Self.UserID)], tailnetUserSchema);
  if (!owner) {
    return { ok: false, reason: 'Tailscale did not report this machine\'s user', fix: 'Restart Tailscale, then restart Pane.' };
  }
  const dnsName = parsed.Self.DNSName.replace(/\.$/, '');
  return { ok: true, ownerLogin: owner.LoginName, machineName: dnsName.split('.')[0], dnsName };
}

interface WorkspaceConfigProvider {
  getConfig(): Pick<ReturnType<ConfigManager['getConfig']>, 'deepgramApiKey' | 'remoteDaemon' | 'workspaces'>;
  on(event: 'config-updated', listener: () => void): object;
  off(event: 'config-updated', listener: () => void): object;
}

/**
 * Puts this Pane's own daemon on the owner's tailnet: a loopback listener that trusts only the
 * owner's Tailscale login, published with `tailscale serve --https=8443` in HTTP proxy mode.
 */
export class PaneWorkspaceHostController {
  private server: PaneRemoteHttpApiServer | null = null;
  private servedPort: number | null = null;
  /** This Pane put a handler on 8443 that is not confirmed removed; it outlives the listener. */
  private handlerInstalled = false;
  /** Serve's target path, new each launch; see WorkspaceIdentityOptions.pathSecret. */
  private readonly pathSecret = randomBytes(24).toString('hex');
  private readonly eventSink: PaneEventSink = {
    send: (channel, ...args) => this.server?.getEventSink().send(channel, ...args),
  };
  private ownerLogin: string | null = null;
  private status: WorkspaceHostStatus = { state: 'off', reason: 'starting' };
  private syncQueue: Promise<void> = Promise.resolve();
  private checkTimer: NodeJS.Timeout | null = null;
  private watching = false;
  private readonly configUpdatedListener = () => {
    void this.sync();
  };

  constructor(
    private readonly commandRegistry: PaneCommandRegistry,
    private readonly configManager: WorkspaceConfigProvider,
    private readonly defaultEnabled: boolean,
    private readonly run: RemoteSetupCommandRunner = runRemoteSetupCommand,
  ) {}

  getEventSink(): PaneEventSink {
    return this.eventSink;
  }

  getStatus(): WorkspaceHostStatus {
    return this.status;
  }

  isEnabled(): boolean {
    return this.configManager.getConfig().workspaces?.enabled ?? this.defaultEnabled;
  }

  async start(): Promise<void> {
    if (!this.watching) {
      this.configManager.on('config-updated', this.configUpdatedListener);
      this.watching = true;
    }
    await this.sync();
  }

  async shutdown(): Promise<void> {
    if (this.watching) {
      this.configManager.off('config-updated', this.configUpdatedListener);
      this.watching = false;
    }
    this.clearCheck();
    await this.enqueue(async () => {
      this.clearCheck();
      await this.stopServer();
      // A handler left behind would point tailnet traffic at a closed loopback port.
      const removal = await this.unserve();
      if (removal) console.warn(`[Pane workspaces] ${removal}`);
    });
  }

  sync(): Promise<void> {
    return this.enqueue(async () => {
      this.clearCheck();
      if (!this.isEnabled()) {
        await this.stopServer();
        const removal = await this.unserve();
        if (removal) {
          this.setOff(removal, `Run "tailscale serve --https=${WORKSPACE_HTTPS_PORT} off"; Pane also retries every minute.`);
          return;
        }
        this.status = {
          state: 'off',
          reason: this.configManager.getConfig().workspaces?.enabled === false
            ? 'turned off with runpane workspace disable'
            : 'off by default for a Pane data directory other than ~/.pane',
          fix: 'runpane workspace enable',
        };
        return;
      }

      const tailscale = await resolveTailscaleCommandAsync(this.run);
      if (!tailscale) {
        await this.stopServer();
        this.setOff('Tailscale is not installed', 'Install Tailscale from https://tailscale.com/download and sign in.');
        return;
      }
      const statusResult = await this.run(tailscale.command, ['status', '--json'], { env: tailscale.env });
      const self = readTailnetSelf(statusResult.stdout);
      if (!self.ok) {
        await this.stopServer();
        this.setOff(self.reason, self.fix);
        return;
      }

      this.ownerLogin = self.ownerLogin;
      const port = await this.ensureServer();
      // Serve handlers belong to one tailnet profile, so a tailnet switch drops this one.
      if (this.servedPort !== port || !(await this.hasHandler(tailscale, self.dnsName))) {
        const target = `http://127.0.0.1:${port}/${this.pathSecret}`;
        const serve = await this.runServe(tailscale, ['--bg', `--https=${WORKSPACE_HTTPS_PORT}`, target]);
        if (!serve.ok) {
          const output = `${serve.stderr}\n${serve.stdout}`;
          this.setOff(`tailscale serve failed: ${firstLine(output)}`, serveFix(output));
          return;
        }
        this.servedPort = port;
        this.handlerInstalled = true;
      }
      this.status = {
        state: 'on',
        machineName: self.machineName,
        url: `https://${self.dnsName}:${WORKSPACE_HTTPS_PORT}`,
      };
      this.scheduleCheck();
    });
  }

  private setOff(reason: string, fix: string): void {
    this.status = { state: 'off', reason, fix };
    this.scheduleCheck();
  }

  private scheduleCheck(): void {
    // A sync that finishes after shutdown must not start the next one.
    if (!this.watching) return;
    this.clearCheck();
    this.checkTimer = setTimeout(() => void this.sync(), CHECK_INTERVAL_MS);
    this.checkTimer.unref?.();
  }

  private clearCheck(): void {
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = null;
  }

  private async ensureServer(): Promise<number> {
    const address = this.server?.getAddress();
    if (address) return address.port;
    const server = new PaneRemoteHttpApiServer(this.commandRegistry, this.configManager, {
      workspace: { listenPort: 0, pathSecret: this.pathSecret, ownerLogin: () => this.ownerLogin },
    });
    await server.start();
    this.server = server;
    const port = server.getAddress()?.port;
    if (!port) throw new Error('Workspace listener did not report a port');
    return port;
  }

  private async stopServer(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.servedPort = null;
    await server?.stop();
  }

  /** Removes this Pane's 8443 handler; returns why it could not, or null when none is left. */
  private async unserve(): Promise<string | null> {
    if (!this.handlerInstalled) return null;
    const tailscale = await resolveTailscaleCommandAsync(this.run);
    const removal = tailscale
      ? await this.runServe(tailscale, [`--https=${WORKSPACE_HTTPS_PORT}`, 'off'])
      : { ok: false, stdout: '', stderr: 'the tailscale CLI was not found' };
    if (!removal.ok) {
      return `could not remove the tailscale serve handler on ${WORKSPACE_HTTPS_PORT}: ${firstLine(`${removal.stderr}\n${removal.stdout}`)}`;
    }
    this.handlerInstalled = false;
    return null;
  }


  private async hasHandler(tailscale: ResolvedCommand, dnsName: string): Promise<boolean> {
    const status = await this.runServe(tailscale, ['status', '--json']);
    return readTailscaleServeHandlers(status.stdout).hasHttpsHandler(dnsName, WORKSPACE_HTTPS_PORT);
  }

  private runServe(tailscale: ResolvedCommand, args: string[]) {
    return this.run(tailscale.command, ['serve', ...args], { env: tailscale.env });
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.syncQueue.then(work, work).catch((error) => {
      console.error('[Pane workspaces] Failed to sync workspace host', error);
      this.setOff(error instanceof Error ? error.message : String(error), 'Pane retries every minute; restart Pane if it persists.');
    });
    this.syncQueue = next;
    return next;
  }
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0] ?? '';
}

/** The one step that fixes a failed `tailscale serve`; Pane retries on its own after it. */
function serveFix(output: string): string {
  if (isTailscaleServeDisabled(output)) {
    const url = /https:\/\/login\.tailscale\.com\/\S+/.exec(output)?.[0];
    return `Enable Tailscale Serve for your tailnet${url ? ` at ${url}` : ' in the Tailscale admin console'}.`;
  }
  if (isTailscaleServePermissionDenied(output)) {
    return 'Allow Pane to configure Serve: run "sudo tailscale set --operator=$USER" once.';
  }
  return 'Run the same tailscale serve command in a terminal to see the full error.';
}
