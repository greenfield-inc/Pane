import type { ConfigManager } from '../services/configManager';
import {
  normalizeRemoteDaemonConfig,
  type RemoteDaemonHostAccess,
  type RemoteHostTailnetNotice,
} from '../../../shared/types/remoteDaemon';
import { runRemoteSetupCommand, type RemoteSetupCommandRunner } from './remote-setup-command';
import { remoteHostRuntimeStateStore } from './remoteHostRuntimeState';
import { readConfiguredTailscaleServeAccess } from './setupRemoteHost';
import { formatTailscaleIssue, type TailscaleIssue } from './tailscaleSetup';

const CHECK_INTERVAL_MS = 60_000;

interface RemoteHostConfigStore {
  getConfig(): Pick<ReturnType<ConfigManager['getConfig']>, 'remoteDaemon'>;
  updateConfigWith(
    update: (current: Pick<ReturnType<ConfigManager['getConfig']>, 'remoteDaemon'>) => Pick<Partial<ReturnType<ConfigManager['getConfig']>>, 'remoteDaemon'>,
  ): Promise<object>;
}

/** Where Settings reads the tailnet notice from; the host runtime state in the app. */
interface TailnetNoticeSink {
  getTailnetNotice(): RemoteHostTailnetNotice | null;
  setTailnetNotice(notice: RemoteHostTailnetNotice | null): void;
}

export function tailnetProblemNotice(issue: TailscaleIssue): RemoteHostTailnetNotice {
  const notice: RemoteHostTailnetNotice = { tone: 'warning', title: issue.summary, message: `To fix it: ${issue.fix}` };
  if (issue.command) notice.command = issue.command;
  return notice;
}

export function tailnetMovedNotice(tailnet: string, baseUrl: string): RemoteHostTailnetNotice {
  return {
    tone: 'info',
    title: `Moved to tailnet ${tailnet}`,
    message: `New connection codes use ${baseUrl}. Devices paired before the move still point at the old tailnet, so create a new code for each of them.`,
  };
}

/**
 * Keeps the remote daemon reachable on whichever tailnet this host is on. Serve config belongs to
 * one tailnet profile, so after a switch this re-applies the `:443` forward and moves the saved
 * access (the URL in new connection codes) to the new tailnet. What it finds is shown in Settings.
 */
export class RemoteHostTailnetMonitor {
  private timer: NodeJS.Timeout | null = null;
  private checking: Promise<void> = Promise.resolve();
  private lastError: string | null = null;

  constructor(
    private readonly configStore: RemoteHostConfigStore,
    private readonly run: RemoteSetupCommandRunner = runRemoteSetupCommand,
    private readonly notices: TailnetNoticeSink = remoteHostRuntimeStateStore,
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
      this.notices.setTailnetNotice(null);
      return;
    }

    const live = await readConfiguredTailscaleServeAccess(remoteDaemon.host.config.listenPort, { run: this.run, reapply: true });
    if (!live.ok) {
      const error = formatTailscaleIssue(live.issue);
      if (error !== this.lastError) console.warn(`[Pane remote daemon] ${error}`);
      this.lastError = error;
      this.notices.setTailnetNotice(tailnetProblemNotice(live.issue));
      return;
    }
    this.lastError = null;
    // A fixed problem disappears; news that the host moved stays until Pane restarts.
    if (this.notices.getTailnetNotice()?.tone === 'warning') {
      this.notices.setTailnetNotice(null);
    }
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
      this.notices.setTailnetNotice(tailnetMovedNotice(live.tailnet, live.access.baseUrl));
    }
  }
}

function sameEndpoint(left: RemoteDaemonHostAccess, right: RemoteDaemonHostAccess): boolean {
  return left.baseUrl === right.baseUrl
    && left.tunnel?.kind === right.tunnel?.kind
    && left.tunnel?.tailscaleIp === right.tunnel?.tailscaleIp;
}
