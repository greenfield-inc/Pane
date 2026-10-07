import type { ConfigManager } from '../services/configManager';
import { normalizeRemoteDaemonConfig, type RemoteDaemonHostAccess } from '../../../shared/types/remoteDaemon';
import { runRemoteSetupCommand, type RemoteSetupCommandRunner } from './remote-setup-command';
import { readConfiguredTailscaleServeAccess } from './setupRemoteHost';

const CHECK_INTERVAL_MS = 60_000;

interface RemoteHostConfigStore {
  getConfig(): Pick<ReturnType<ConfigManager['getConfig']>, 'remoteDaemon'>;
  updateConfigWith(
    update: (current: Pick<ReturnType<ConfigManager['getConfig']>, 'remoteDaemon'>) => Pick<Partial<ReturnType<ConfigManager['getConfig']>>, 'remoteDaemon'>,
  ): Promise<object>;
}

/**
 * Keeps the remote daemon reachable on whichever tailnet this host is on. Serve config belongs to
 * one tailnet profile, so after a switch this re-applies the `:443` forward and moves the saved
 * access (the URL in new connection codes) to the new tailnet.
 */
export class RemoteHostTailnetMonitor {
  private timer: NodeJS.Timeout | null = null;
  private checking: Promise<void> = Promise.resolve();
  private lastError: string | null = null;

  constructor(
    private readonly configStore: RemoteHostConfigStore,
    private readonly run: RemoteSetupCommandRunner = runRemoteSetupCommand,
  ) {}

  start(): Promise<void> {
    if (!this.timer) {
      this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
      this.timer.unref?.();
    }
    return this.check();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Resolves once the check in progress, if any, has finished. */
  idle(): Promise<void> {
    return this.checking;
  }

  check(): Promise<void> {
    this.checking = this.checking.then(() => this.checkOnce()).catch((error) => {
      console.error('[Pane remote daemon] Failed to check the current tailnet', error);
    });
    return this.checking;
  }

  private async checkOnce(): Promise<void> {
    const remoteDaemon = normalizeRemoteDaemonConfig(this.configStore.getConfig().remoteDaemon);
    const saved = remoteDaemon.host.access;
    if (!remoteDaemon.host.config.enabled || saved?.tunnel?.kind !== 'tailscale') {
      return;
    }

    const live = await readConfiguredTailscaleServeAccess(remoteDaemon.host.config.listenPort, { run: this.run, reapply: true });
    if (!live.ok) {
      if (live.error !== this.lastError) console.warn(`[Pane remote daemon] ${live.error}`);
      this.lastError = live.error;
      return;
    }
    this.lastError = null;
    if (live.reapplied) {
      console.log(`[Pane remote daemon] Re-applied the Tailscale Serve :443 forward on tailnet ${live.tailnet}`);
    }
    if (sameEndpoint(saved, live.access)) {
      return;
    }

    let moved = false;
    await this.configStore.updateConfigWith((config) => {
      const current = normalizeRemoteDaemonConfig(config.remoteDaemon);
      // Forgotten or replaced while this check ran: the newer choice wins.
      if (!current.host.access || !sameEndpoint(current.host.access, saved)) {
        return {};
      }
      moved = true;
      return { remoteDaemon: { ...current, host: { ...current.host, access: live.access } } };
    });
    if (moved) {
      console.log(`[Pane remote daemon] Host moved to tailnet ${live.tailnet}; connection codes now use ${live.access.baseUrl}`);
    }
  }
}

function sameEndpoint(left: RemoteDaemonHostAccess, right: RemoteDaemonHostAccess): boolean {
  return left.baseUrl === right.baseUrl
    && left.tunnel?.kind === right.tunnel?.kind
    && left.tunnel?.tailscaleIp === right.tunnel?.tailscaleIp;
}
