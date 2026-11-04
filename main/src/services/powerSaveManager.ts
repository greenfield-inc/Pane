import { powerMonitor, powerSaveBlocker } from 'electron';
import type { EventEmitter } from 'events';
import type { AppConfig } from '../types/config';
import type { Session } from '../types/session';
import type { AgentState } from '../../../shared/types/agentStatus';
import { reasonOf } from '../../../shared/paneError';
import { readLinuxOnBattery } from './linuxPowerSupply';
import { createWindowsKeepAwakeHelper, type WindowsKeepAwakeHelper, type WindowsKeepAwakeHelperHandle } from './windowsKeepAwakeHelper';

const ACTIVE_SESSION_STATUSES = new Set<Session['status']>([
  'initializing',
  'ready',
  'running',
  'waiting',
]);

/** Electron reports no battery on desktop Linux, so Pane reads sysfs on this cadence while it has work. */
const LINUX_POWER_SOURCE_POLL_MS = 60_000;

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

type PowerSaveBlockerType = 'prevent-app-suspension' | 'prevent-display-sleep';

interface PowerSaveBlocker {
  start(type: PowerSaveBlockerType): number;
  stop(id: number): void;
}

type PowerSourceEvent = 'on-ac' | 'on-battery' | 'resume';

/**
 * Whether the machine runs on battery. It emits `on-ac` and `on-battery` when
 * the source changes, and `resume` after the machine wakes, as Electron's
 * powerMonitor does.
 */
interface PowerSource {
  isOnBattery(): boolean;
  on(event: PowerSourceEvent, listener: () => void): void;
  removeListener(event: PowerSourceEvent, listener: () => void): void;
}

interface PowerSaveLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface PowerSaveEnvironment {
  blocker: PowerSaveBlocker;
  powerSource: PowerSource;
  /** Windows only: the helper that holds what Electron cannot. Null elsewhere. */
  helper: WindowsKeepAwakeHelper | null;
  /** Re-read the power source on this interval while there is activity; null when it emits its own events. */
  powerSourcePollMs: number | null;
  logger: PowerSaveLogger;
}

/**
 * What Pane holds right now. Plugged in keeps the computer working and lets the
 * screen sleep; battery keeps the screen on, because Modern Standby ends system
 * requests on DC power.
 */
export type KeepAwakeMode = 'off' | 'plugged-in' | 'battery';

const BLOCKER_TYPE = {
  'plugged-in': 'prevent-app-suspension',
  battery: 'prevent-display-sleep',
} satisfies Record<Exclude<KeepAwakeMode, 'off'>, PowerSaveBlockerType>;

const HELPER_MODE = {
  'plugged-in': 'system-required',
  battery: 'press-f15',
} as const;

export class PowerSaveManager {
  private readonly activeSessionIds = new Set<string>();
  private readonly workingPanelIds = new Set<string>();
  private readonly env: PowerSaveEnvironment;
  private mode: KeepAwakeMode = 'off';
  private blockerId: number | null = null;
  private helperHandle: WindowsKeepAwakeHelperHandle | null = null;
  private pollTimer: NodeJS.Timeout | null = null;

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

  // Windows ends power requests when the user puts the machine to sleep, so a
  // held mode is applied again from scratch after waking and after the power
  // source changes. PowerToys Awake shipped bugs from skipping this.
  private readonly handleResume = (): void => this.reapply('the computer woke');
  private readonly handleOnAc = (): void => this.reapply('the computer was plugged in');
  private readonly handleOnBattery = (): void => this.reapply('the computer switched to battery');

  constructor(
    private readonly configManager: PowerSaveConfigSource,
    private readonly sessionManager: PowerSaveSessionSource,
    private readonly panelActivity: PowerSavePanelActivitySource,
    environment: Partial<PowerSaveEnvironment> = {},
  ) {
    this.env = {
      blocker: environment.blocker ?? powerSaveBlocker,
      powerSource: environment.powerSource ?? electronPowerSource(),
      helper: environment.helper !== undefined
        ? environment.helper
        : process.platform === 'win32' ? createWindowsKeepAwakeHelper() : null,
      powerSourcePollMs: environment.powerSourcePollMs !== undefined
        ? environment.powerSourcePollMs
        : process.platform === 'linux' ? LINUX_POWER_SOURCE_POLL_MS : null,
      logger: environment.logger ?? console,
    };
    this.sessionManager.on('sessions-loaded', this.handleSessionsLoaded);
    this.sessionManager.on('session-created', this.handleSessionChanged);
    this.sessionManager.on('session-updated', this.handleSessionChanged);
    this.sessionManager.on('session-deleted', this.handleSessionDeleted);
    this.panelActivity.on('agent-status', this.handlePanelAgentStatus);
    this.configManager.on('config-updated', this.handleConfigUpdated);
    this.env.powerSource.on('resume', this.handleResume);
    this.env.powerSource.on('on-ac', this.handleOnAc);
    this.env.powerSource.on('on-battery', this.handleOnBattery);

    for (const session of this.sessionManager.getPowerSaveSnapshotSessions()) {
      this.retainIfActive(session);
    }
  }

  sync(): void {
    const hasActivity = this.hasActivity();
    this.updatePolling(hasActivity);
    const desired = this.desiredMode(hasActivity);
    if (desired === this.mode) return;

    const previous = this.mode;
    this.release();
    this.hold(desired);
    this.env.logger.info(`[PowerSave] Keep-awake mode ${previous} -> ${desired}.`);
  }

  private reapply(reason: string): void {
    const hasActivity = this.hasActivity();
    const desired = this.desiredMode(hasActivity);
    const previous = this.mode;
    if (desired === 'off' && previous === 'off') return;

    this.release();
    this.hold(desired);
    this.env.logger.info(`[PowerSave] Keep-awake mode ${previous} -> ${desired}, applied again because ${reason}.`);
  }

  private hasActivity(): boolean {
    return this.activeSessionIds.size > 0 || this.workingPanelIds.size > 0;
  }

  private desiredMode(hasActivity: boolean): KeepAwakeMode {
    const config = this.configManager.getConfig();
    if (config.keepAwakeWhileSessionsActive === false || !hasActivity) return 'off';
    if (this.env.powerSource.isOnBattery()) {
      return config.keepAwakeOnBattery === true ? 'battery' : 'off';
    }
    return config.keepAwakeWhilePluggedIn === false ? 'off' : 'plugged-in';
  }

  private hold(mode: KeepAwakeMode): void {
    this.mode = mode;
    if (mode === 'off') return;

    this.blockerId = this.env.blocker.start(BLOCKER_TYPE[mode]);
    if (!this.env.helper) return;
    try {
      this.helperHandle = this.env.helper.start(HELPER_MODE[mode]);
    } catch (error) {
      this.env.logger.warn(
        `[PowerSave] The Windows keep-awake helper did not start: ${reasonOf(error)}. ` +
          `Electron's ${BLOCKER_TYPE[mode]} request is still held. Next: check that powershell.exe can run.`,
      );
    }
  }

  private release(): void {
    if (this.blockerId !== null) {
      this.env.blocker.stop(this.blockerId);
      this.blockerId = null;
    }
    this.helperHandle?.stop();
    this.helperHandle = null;
    this.mode = 'off';
  }

  private updatePolling(hasActivity: boolean): void {
    const shouldPoll = hasActivity && this.env.powerSourcePollMs !== null;
    if (shouldPoll && this.pollTimer === null && this.env.powerSourcePollMs !== null) {
      this.pollTimer = setInterval(() => this.sync(), this.env.powerSourcePollMs);
      this.pollTimer.unref?.();
    } else if (!shouldPoll && this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
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
    this.env.powerSource.removeListener('resume', this.handleResume);
    this.env.powerSource.removeListener('on-ac', this.handleOnAc);
    this.env.powerSource.removeListener('on-battery', this.handleOnBattery);
    this.updatePolling(false);
    this.release();
  }
}

/**
 * Electron's power source. On desktop Linux Electron always reports AC and
 * never fires on-ac or on-battery, so Pane reads sysfs there and relies on polling.
 */
function electronPowerSource(): PowerSource {
  const linux = process.platform === 'linux';
  const events: NodeJS.EventEmitter = powerMonitor;
  return {
    isOnBattery: () => (linux ? readLinuxOnBattery() : powerMonitor.isOnBatteryPower()),
    on: (event, listener) => {
      if (!linux || event === 'resume') events.on(event, listener);
    },
    removeListener: (event, listener) => {
      events.removeListener(event, listener);
    },
  };
}
