import type { ConfigManager } from '../services/configManager';
import { boundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import type { PaneCommandRegistry } from './commandRegistry';
import { PaneRemoteHttpApiServer } from './httpApiServer';
import { runRemoteSetupCommand, type RemoteSetupCommandRunner } from './remote-setup-command';
import { randomBytes } from 'crypto';
import type { PaneEventSink } from '../core/eventSink';
import type { WorkspaceAccessPolicy } from './auth';
import { createWorkspacePasswordVerifier, type SecretCheck } from './workspacePassword';
import type { WorkspaceAccessSummary, WorkspacePasswordHash } from '../../../shared/types/workspaceAccess';
import {
  readTailnetIdentity,
  readTailscaleServeHandlers,
  tailscaleServeFailureFix,
  tailscaleStatusFailureIssue,
  resolveTailscaleCommandAsync,
  runTailscaleServe,
  type ResolvedCommand,
} from './tailscaleSetup';

/**
 * Tailnet port for workspaces; the remote daemon keeps 443. `PANE_WORKSPACES_PORT` moves it for
 * development, so a test host never takes over the 8443 handler of the Pane in daily use.
 */
const WORKSPACE_HTTPS_PORT = readWorkspacePort(process.env.PANE_WORKSPACES_PORT);
/** How often Pane re-reads the tailnet: Tailscale may start after Pane, or switch tailnets under it. */
const CHECK_INTERVAL_MS = 60_000;
const RETRIES = 'Pane retries within a minute';

export function readWorkspacePort(value: string | undefined): number {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 8443;
}

export type TailnetSelf =
  | {
    ok: true;
    ownerLogin: string;
    machineName: string;
    dnsName: string;
    /** Lowercased logins of the people with untagged devices in this tailnet, the owner included. */
    tailnetLogins: string[];
  }
  | { ok: false; reason: string; fix: string };

/** This machine on the tailnet, while workspaces are on. */
export interface WorkspaceTailnet {
  tailscale: ResolvedCommand;
  dnsName: string;
  machineName: string;
  ownerLogin: string;
}

export interface WorkspaceHostStatus {
  state: 'on' | 'off';
  /** Why workspaces are off, and the one step that turns them on. */
  reason?: string;
  fix?: string;
  machineName?: string;
  url?: string;
}

const tailnetPeerSchema = boundary.object({
  DNSName: boundary.string,
  UserID: boundary.number,
  Tags: boundary.optional(boundary.nullable(boundary.array(boundary.string))),
  ShareeNode: boundary.optional(boundary.boolean),
});
const tailnetStatusSchema = boundary.object({
  BackendState: boundary.string,
  MagicDNSSuffix: boundary.optional(boundary.string),
  Peer: boundary.optional(boundary.nullable(boundary.jsonObject)),
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
  if (!parsed || parsed.BackendState !== 'Running' || !parsed.Self) {
    const identity = readTailnetIdentity(statusJson);
    if (!identity.ok) return { ok: false, reason: fragment(identity.issue.summary), fix: sentence(identity.issue.fix) };
    return { ok: false, reason: 'Tailscale status could not be read', fix: 'Update Tailscale, then restart Pane.' };
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
  const suffix = `.${(parsed.MagicDNSSuffix ?? dnsName.split('.').slice(1).join('.')).toLowerCase()}`;
  const tailnetLogins = new Set([owner.LoginName.toLowerCase()]);
  for (const value of Object.values(parsed.Peer ?? {})) {
    const peer = decodeOptionalBoundary(value, tailnetPeerSchema);
    // Sharee nodes belong to people outside this tailnet whom a device was shared with.
    if (!peer || peer.Tags?.length || peer.ShareeNode) continue;
    if (!peer.DNSName.replace(/\.$/, '').toLowerCase().endsWith(suffix)) continue;
    const login = decodeOptionalBoundary(parsed.User?.[String(peer.UserID)], tailnetUserSchema)?.LoginName;
    if (login) tailnetLogins.add(login.toLowerCase());
  }
  return {
    ok: true,
    ownerLogin: owner.LoginName,
    machineName: dnsName.split('.')[0],
    dnsName,
    tailnetLogins: [...tailnetLogins].sort(),
  };
}

interface WorkspaceConfigProvider {
  getConfig(): Pick<ReturnType<ConfigManager['getConfig']>, 'deepgramApiKey' | 'remoteDaemon' | 'workspaces'>;
  on(event: 'config-updated', listener: () => void): object;
  off(event: 'config-updated', listener: () => void): object;
}

/**
 * Puts this Pane's own daemon on the owner's tailnet: a loopback listener published with
 * `tailscale serve --https=8443` in HTTP proxy mode. It trusts the owner's Tailscale login, or
 * everyone on the tailnet under "tailnet" visibility, plus the password when one is set.
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
  private tailnet: WorkspaceTailnet | null = null;
  private readonly syncListeners = new Set<() => void>();
  private tailnetLogins: ReadonlySet<string> = new Set();
  private passwordVerifier: { stored: WorkspacePasswordHash; verify: (secret: string, login: string) => SecretCheck } | null = null;
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
    private readonly isForwardedPort?: (port: number) => boolean,
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

  getAccess(): WorkspaceAccessSummary {
    const workspaces = this.configManager.getConfig().workspaces;
    return {
      ...this.status,
      visibility: this.isEnabled() ? workspaces?.visibility ?? 'owner' : 'off',
      passwordProtected: Boolean(workspaces?.password),
    };
  }

  getTailnet(): WorkspaceTailnet | null {
    return this.status.state === 'on' ? this.tailnet : null;
  }

  /** Called after every sync, the once-a-minute re-check included. */
  onSync(listener: () => void): () => void {
    this.syncListeners.add(listener);
    return () => this.syncListeners.delete(listener);
  }

  /** Read on every request, so config changes apply to the next one. */
  getAccessPolicy(): WorkspaceAccessPolicy | null {
    if (!this.ownerLogin || !this.isEnabled()) return null;
    const workspaces = this.configManager.getConfig().workspaces;
    return {
      ownerLogin: this.ownerLogin,
      visibility: workspaces?.visibility ?? 'owner',
      tailnetLogins: this.tailnetLogins,
      verifySecret: workspaces?.password ? this.verifierFor(workspaces.password) : null,
    };
  }

  private verifierFor(stored: WorkspacePasswordHash): (secret: string, login: string) => SecretCheck {
    if (this.passwordVerifier?.stored !== stored) {
      this.passwordVerifier = { stored, verify: createWorkspacePasswordVerifier(stored) };
    }
    return this.passwordVerifier.verify;
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
          const cli = (await resolveTailscaleCommandAsync(this.run))?.displayCommand ?? 'tailscale';
          this.setOff(removal, `Run "${cli} serve --https=${WORKSPACE_HTTPS_PORT} off" in a terminal; ${RETRIES}.`);
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
        this.setOff('Tailscale is not installed', `Install Tailscale from https://tailscale.com/download and sign in; ${RETRIES}.`);
        return;
      }
      const statusResult = await this.run(tailscale.command, ['status', '--json'], { env: tailscale.env });
      if (!statusResult.ok) {
        await this.stopServer();
        const issue = tailscaleStatusFailureIssue(`${statusResult.stderr}\n${statusResult.stdout}`, tailscale);
        this.setOff(fragment(issue.summary), sentence(issue.fix));
        return;
      }
      const self = readTailnetSelf(statusResult.stdout);
      if (!self.ok) {
        await this.stopServer();
        this.setOff(self.reason, self.fix);
        return;
      }

      this.ownerLogin = self.ownerLogin;
      this.tailnet = { tailscale, dnsName: self.dnsName, machineName: self.machineName, ownerLogin: self.ownerLogin };
      this.tailnetLogins = new Set(self.tailnetLogins);
      const port = await this.ensureServer();
      // Serve handlers belong to one tailnet profile, so a tailnet switch drops this one.
      if (this.servedPort !== port || !(await this.hasHandler(tailscale, self.dnsName))) {
        const target = `http://127.0.0.1:${port}/${this.pathSecret}`;
        const serve = await this.runServe(tailscale, ['--bg', `--https=${WORKSPACE_HTTPS_PORT}`, target]);
        if (!serve.ok) {
          const output = `${serve.stderr}\n${serve.stdout}`;
          const command = `${tailscale.displayCommand} serve --bg --https=${WORKSPACE_HTTPS_PORT} ${target}`;
          this.setOff(`tailscale serve couldn't publish this Pane on port ${WORKSPACE_HTTPS_PORT}: ${firstLine(output)}`, serveFix(output, command));
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
      workspace: { listenPort: 0, pathSecret: this.pathSecret, access: () => this.getAccessPolicy() },
      isForwardedPort: this.isForwardedPort,
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
    return runTailscaleServe(this.run, tailscale, args);
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.syncQueue.then(work, work).catch((error) => {
      console.error('[Pane workspaces] Failed to sync workspace host', error);
      this.setOff(error instanceof Error ? error.message : String(error), 'Pane retries every minute; restart Pane if it persists.');
    }).then(() => {
      for (const listener of this.syncListeners) listener();
    });
    this.syncQueue = next;
    return next;
  }
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0] ?? '';
}

/** Workspace status shows the reason inside "off (...)", so it has no closing period. */
function fragment(summary: string): string {
  return summary.replace(/\.$/, '');
}

/** Workspace status shows the fix as a sentence of its own, and Pane retries without being asked. */
function sentence(fix: string): string {
  return `${fix.charAt(0).toUpperCase()}${fix.slice(1)}`.replace(/, then try again\.$/, `; ${RETRIES}.`);
}

/** The one step that fixes a failed `tailscale serve`; Pane retries on its own after it. */
function serveFix(output: string, command: string): string {
  return sentence(tailscaleServeFailureFix(output, command).fix);
}
