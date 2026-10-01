import type { AgentState } from '../../../../shared/types/agentStatus';
import type {
  CloudAgentReadinessCounts,
  CloudAgentRestorePhase,
  CloudDaemonReadiness,
} from '../../../../shared/types/cloudDaemon';

/** One agent panel of a non-archived Pane, as readiness sees it. */
export interface ReadinessAgentPanel {
  running: boolean;
  agentState?: AgentState;
}

export interface CloudHealthFields {
  version: string | null;
  gitCommit: string | null;
  startedAt: string;
  readiness: CloudDaemonReadiness;
}

/**
 * What `/health` says about this daemon beyond "the HTTP server answers": its version and
 * whether agents are usable yet. A wake returns only once `readiness.state` leaves `starting`.
 *
 * The daemon marks itself ready when bootstrap finishes. The agent-restore step
 * reports `pending` while it re-launches agent panels and `done` after; `lazy` means panels
 * start on first use, so a panel with no terminal is expected rather than degraded.
 */
export class CloudDaemonHealthState {
  private daemonReady = false;
  private agentRestore: CloudAgentRestorePhase = 'none';
  private lazyRestore = false;
  private version: string | null = null;
  private gitCommit: string | null = null;
  private agentPanels: () => ReadinessAgentPanel[] = () => [];
  private readonly startedAt: string;

  constructor(now: () => number = Date.now) {
    this.startedAt = new Date(now()).toISOString();
  }

  setVersion(version: string, gitCommit: string | null): void {
    this.version = version;
    this.gitCommit = gitCommit;
  }

  setAgentPanelSource(source: () => ReadinessAgentPanel[]): void {
    this.agentPanels = source;
  }

  markDaemonReady(): void {
    this.daemonReady = true;
  }

  setAgentRestorePhase(phase: CloudAgentRestorePhase, options: { lazy?: boolean } = {}): void {
    this.agentRestore = phase;
    this.lazyRestore = options.lazy === true;
  }

  getVersion(): string | null {
    return this.version;
  }

  fields(): CloudHealthFields {
    return {
      version: this.version,
      gitCommit: this.gitCommit,
      startedAt: this.startedAt,
      readiness: this.readiness(),
    };
  }

  readiness(): CloudDaemonReadiness {
    const agents = countAgentPanels(this.daemonReady ? safePanels(this.agentPanels) : []);
    return {
      state: resolveReadinessState(this.daemonReady, this.agentRestore, this.lazyRestore, agents),
      daemon: this.daemonReady ? 'ready' : 'starting',
      agentRestore: this.agentRestore,
      agents,
    };
  }
}

export function countAgentPanels(panels: readonly ReadinessAgentPanel[]): CloudAgentReadinessCounts {
  const counts: CloudAgentReadinessCounts = { expected: panels.length, ready: 0, starting: 0, blocked: 0, notRunning: 0 };
  for (const panel of panels) {
    if (!panel.running) counts.notRunning += 1;
    else if (panel.agentState === 'idle' || panel.agentState === 'working') counts.ready += 1;
    else if (panel.agentState === 'blocked') counts.blocked += 1;
    else counts.starting += 1;
  }
  return counts;
}

function resolveReadinessState(
  daemonReady: boolean,
  agentRestore: CloudAgentRestorePhase,
  lazyRestore: boolean,
  agents: CloudAgentReadinessCounts,
): CloudDaemonReadiness['state'] {
  if (!daemonReady || agentRestore === 'pending' || agents.starting > 0) return 'starting';
  if (agentRestore === 'done' && !lazyRestore && agents.notRunning > 0) return 'degraded';
  return 'ready';
}

/** `/health` must answer even if reading panels fails mid-startup. */
function safePanels(source: () => ReadinessAgentPanel[]): ReadinessAgentPanel[] {
  try {
    return source();
  } catch {
    return [];
  }
}

/** The daemon's one health state; agent restore reports through `cloudDaemonHealth.setAgentRestorePhase`. */
export const cloudDaemonHealth = new CloudDaemonHealthState();
