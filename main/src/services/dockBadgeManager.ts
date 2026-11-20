import { app } from 'electron';
import type { EventEmitter } from 'events';
import type { AppConfig } from '../types/config';
import type { AgentState } from '../../../shared/types/agentStatus';
import { reasonOf } from '../../../shared/paneError';

interface DockBadgeConfigSource extends EventEmitter {
  getConfig(): AppConfig;
}

// Archiving or deleting a Pane emits `session-deleted`.
type DockBadgeSessionSource = EventEmitter;

// The same per-panel agent status the sidebar shows. Every terminal lifetime
// ends with an idle event, so a closed tab leaves the count.
type DockBadgePanelActivitySource = EventEmitter;

interface PanelAgentStatusChange {
  panelId: string;
  sessionId: string;
  state: AgentState;
}

/** Where the count goes: Electron's app badge in the app, a stub in tests. */
interface DockBadgeTarget {
  setBadgeCount(count: number): boolean;
}

interface DockBadgeLogger {
  warn(message: string): void;
}

export interface DockBadgeEnvironment {
  target: DockBadgeTarget;
  logger: DockBadgeLogger;
}

/**
 * Electron's badge works on macOS (the Dock) and on Linux launchers that read
 * the Unity launcher API. Windows has no badge count: an overlay icon would
 * need a drawn image per number, so Windows shows no badge.
 */
function electronBadgeTarget(): DockBadgeTarget {
  if (process.platform === 'win32') return { setBadgeCount: () => false };
  return { setBadgeCount: count => app.setBadgeCount(count) };
}

/**
 * Shows how many agents wait on the person (blocked panels) on the Dock or
 * taskbar icon, and clears it at zero. `dockBadge: false` turns it off.
 */
export class DockBadgeManager {
  /** Blocked panel id to the Pane it belongs to. */
  private readonly blockedPanels = new Map<string, string>();
  private readonly env: DockBadgeEnvironment;
  private shownCount = 0;

  private readonly handlePanelAgentStatus = (change: PanelAgentStatusChange): void => {
    if (change.state === 'blocked') this.blockedPanels.set(change.panelId, change.sessionId);
    else this.blockedPanels.delete(change.panelId);
    this.sync();
  };

  private readonly handleSessionDeleted = (session: { id: string }): void => {
    for (const [panelId, sessionId] of this.blockedPanels) {
      if (sessionId === session.id) this.blockedPanels.delete(panelId);
    }
    this.sync();
  };

  private readonly handleConfigUpdated = (): void => {
    this.sync();
  };

  constructor(
    private readonly configManager: DockBadgeConfigSource,
    private readonly sessionManager: DockBadgeSessionSource,
    private readonly panelActivity: DockBadgePanelActivitySource,
    environment: Partial<DockBadgeEnvironment> = {},
  ) {
    this.env = {
      target: environment.target ?? electronBadgeTarget(),
      logger: environment.logger ?? console,
    };
    this.panelActivity.on('agent-status', this.handlePanelAgentStatus);
    this.sessionManager.on('session-deleted', this.handleSessionDeleted);
    this.configManager.on('config-updated', this.handleConfigUpdated);
  }

  /** The number the badge should show now. */
  desiredCount(): number {
    if (this.configManager.getConfig().dockBadge === false) return 0;
    return this.blockedPanels.size;
  }

  sync(): void {
    this.show(this.desiredCount());
  }

  dispose(): void {
    this.panelActivity.removeListener('agent-status', this.handlePanelAgentStatus);
    this.sessionManager.removeListener('session-deleted', this.handleSessionDeleted);
    this.configManager.removeListener('config-updated', this.handleConfigUpdated);
    this.blockedPanels.clear();
    this.show(0);
  }

  private show(count: number): void {
    if (count === this.shownCount) return;
    // The badge is a hint: a failure is logged and never reaches the agent status path.
    try {
      this.env.target.setBadgeCount(count);
      this.shownCount = count;
    } catch (error) {
      this.env.logger.warn(`[DockBadge] Pane couldn't set the app badge to ${count} (${reasonOf(error)}). The badge keeps its last number; Pane tries again on the next agent status change.`);
    }
  }
}
