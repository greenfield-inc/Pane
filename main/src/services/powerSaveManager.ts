import { powerSaveBlocker } from 'electron';
import type { EventEmitter } from 'events';
import type { AppConfig } from '../types/config';
import type { Session } from '../types/session';
import type { AgentState } from '../../../shared/types/agentStatus';

const ACTIVE_SESSION_STATUSES = new Set<Session['status']>([
  'initializing',
  'ready',
  'running',
  'waiting',
]);

interface PowerSaveConfigSource extends EventEmitter {
  getConfig(): AppConfig;
}

interface PowerSaveSessionSource extends EventEmitter {
  getPowerSaveSnapshotSessions(): Session[];
}

// Session rows are not a reliable activity signal: they sit at stopped or
// interrupted while their agent panels run (#610). The panel's agent status is,
// and every terminal lifetime ends with an idle event.
type PowerSavePanelActivitySource = EventEmitter;

interface PanelAgentStatusChange {
  panelId: string;
  state: AgentState;
}

interface PowerSaveBlocker {
  start(type: 'prevent-app-suspension'): number;
  stop(id: number): void;
}

export class PowerSaveManager {
  private readonly activeSessionIds = new Set<string>();
  private readonly workingPanelIds = new Set<string>();
  private blockerId: number | null = null;

  private readonly handleSessionsLoaded = (sessions: Session[]): void => {
    for (const session of sessions) {
      this.retainIfActive(session);
    }
    this.sync();
  };

  private readonly handleSessionChanged = (session: Session): void => {
    this.retainIfActive(session);
    this.sync();
  };

  private readonly handleSessionDeleted = (session: Pick<Session, 'id'>): void => {
    this.activeSessionIds.delete(session.id);
    this.sync();
  };

  private readonly handlePanelAgentStatus = (change: PanelAgentStatusChange): void => {
    if (change.state === 'working') {
      this.workingPanelIds.add(change.panelId);
    } else {
      this.workingPanelIds.delete(change.panelId);
    }
    this.sync();
  };

  private readonly handleConfigUpdated = (): void => {
    this.sync();
  };

  constructor(
    private readonly configManager: PowerSaveConfigSource,
    private readonly sessionManager: PowerSaveSessionSource,
    private readonly panelActivity: PowerSavePanelActivitySource,
    private readonly blocker: PowerSaveBlocker = powerSaveBlocker,
  ) {
    this.sessionManager.on('sessions-loaded', this.handleSessionsLoaded);
    this.sessionManager.on('session-created', this.handleSessionChanged);
    this.sessionManager.on('session-updated', this.handleSessionChanged);
    this.sessionManager.on('session-deleted', this.handleSessionDeleted);
    this.panelActivity.on('agent-status', this.handlePanelAgentStatus);
    this.configManager.on('config-updated', this.handleConfigUpdated);

    for (const session of this.sessionManager.getPowerSaveSnapshotSessions()) {
      this.retainIfActive(session);
    }
  }

  sync(): void {
    const enabled = this.configManager.getConfig().keepAwakeWhileSessionsActive !== false;
    const hasActivity = this.activeSessionIds.size > 0 || this.workingPanelIds.size > 0;
    const shouldBlockSleep = enabled && hasActivity;

    if (shouldBlockSleep && this.blockerId === null) {
      this.blockerId = this.blocker.start('prevent-app-suspension');
    } else if (!shouldBlockSleep && this.blockerId !== null) {
      this.blocker.stop(this.blockerId);
      this.blockerId = null;
    }
  }

  private retainIfActive(session: Session): void {
    if (!session.archived && ACTIVE_SESSION_STATUSES.has(session.status)) {
      this.activeSessionIds.add(session.id);
      return;
    }

    this.activeSessionIds.delete(session.id);
  }

  dispose(): void {
    this.sessionManager.removeListener('sessions-loaded', this.handleSessionsLoaded);
    this.sessionManager.removeListener('session-created', this.handleSessionChanged);
    this.sessionManager.removeListener('session-updated', this.handleSessionChanged);
    this.sessionManager.removeListener('session-deleted', this.handleSessionDeleted);
    this.panelActivity.removeListener('agent-status', this.handlePanelAgentStatus);
    this.configManager.removeListener('config-updated', this.handleConfigUpdated);

    if (this.blockerId !== null) {
      this.blocker.stop(this.blockerId);
      this.blockerId = null;
    }
  }
}
