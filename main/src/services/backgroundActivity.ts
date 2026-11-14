import { execFile } from 'child_process';
import { EventEmitter } from 'events';
import { powerMonitor } from 'electron';
import type { AppConfig } from '../types/config';
import { readLinuxOnBattery } from './linuxPowerSupply';
import { remoteEventStreams } from '../daemon/remoteEventStreams';

export type BackgroundActivityProfile = NonNullable<AppConfig['backgroundActivity']>;

const DEFAULT_BACKGROUND_ACTIVITY: BackgroundActivityProfile = 'balanced';

/** A Low Power Mode read is reused this long, so switching apps doesn't start a process each time. */
const LOW_POWER_CACHE_MS = 60_000;
const LOW_POWER_READ_TIMEOUT_MS = 2_000;

type PowerEvent = 'lock-screen' | 'unlock-screen' | 'suspend' | 'resume' | 'on-ac' | 'on-battery';

export interface BackgroundActivityEnvironment {
  /** Electron's powerMonitor events. Linux never fires lock-screen, unlock-screen, on-ac or on-battery. */
  power: {
    on(event: PowerEvent, listener: () => void): void;
    removeListener(event: PowerEvent, listener: () => void): void;
  };
  /** True when lock-screen and unlock-screen fire here; else `isLocked` is read at each evaluation. */
  lockEvents: boolean;
  isLocked(): boolean;
  isOnBattery(): boolean;
  /** Whether the OS is in Low Power Mode; false when unknown. */
  readLowPower(): Promise<boolean>;
  remoteStreams: {
    count(): number;
    on(event: 'change', listener: () => void): void;
    removeListener(event: 'change', listener: () => void): void;
  };
  now(): number;
  logger: { info(message: string): void };
}

interface ConfigSource extends EventEmitter {
  getConfig(): AppConfig;
}

/**
 * Whether Pane is away: nobody is looking (no open remote stream, and the screen is locked or the
 * Pane window is neither focused nor on screen) while the profile's condition holds. Balanced
 * pauses while locked or in Low Power Mode; Battery saver also on battery; Performance never.
 * Background work that only serves the person's eyes pauses while away and catches up on `change`.
 */
export class BackgroundActivity extends EventEmitter {
  private readonly env: BackgroundActivityEnvironment;
  private locked: boolean;
  private suspended = false;
  // Until the window reports, it counts as looking, which is today's behaviour.
  private windowFocused = true;
  private windowVisible = true;
  private lowPower = false;
  private lowPowerReadAt = Number.NEGATIVE_INFINITY;
  private lowPowerRead: Promise<void> | null = null;
  private away = false;

  private readonly powerListeners: Array<[PowerEvent, () => void]> = [
    ['lock-screen', () => { this.locked = true; this.evaluate('the screen locked'); }],
    ['unlock-screen', () => { this.locked = false; this.evaluate('the screen unlocked'); }],
    ['suspend', () => { this.suspended = true; this.evaluate('the computer went to sleep'); }],
    ['resume', () => { this.suspended = false; this.evaluate('the computer woke'); }],
    ['on-ac', () => this.evaluate('the computer was plugged in')],
    ['on-battery', () => this.evaluate('the computer switched to battery')],
  ];
  private readonly handleRemoteStreams = () => this.evaluate('a remote app connected or disconnected');
  private readonly handleConfig = () => this.evaluate('the Background checks setting changed');

  constructor(private readonly config: ConfigSource, environment: Partial<BackgroundActivityEnvironment> = {}) {
    super();
    this.env = { ...electronEnvironment(), ...environment };
    this.locked = this.env.isLocked();
    for (const [event, listener] of this.powerListeners) this.env.power.on(event, listener);
    this.env.remoteStreams.on('change', this.handleRemoteStreams);
    this.config.on('config-updated', this.handleConfig);
    this.away = this.compute();
  }

  profile(): BackgroundActivityProfile {
    return this.config.getConfig().backgroundActivity ?? DEFAULT_BACKGROUND_ACTIVITY;
  }

  isAway(): boolean {
    return this.away;
  }

  /**
   * Whether optional network work, such as fetching on focus, should be skipped even while someone
   * looks: Low Power Mode outside Performance, or battery under Battery saver. Low Power Mode is
   * read again when the last read is over a minute old.
   */
  async isConstrained(): Promise<boolean> {
    const profile = this.profile();
    if (profile === 'performance') return false;
    if (profile === 'batterySaver' && this.env.isOnBattery()) return true;
    if (this.env.now() - this.lowPowerReadAt >= LOW_POWER_CACHE_MS) await this.refreshLowPower();
    return this.lowPower;
  }

  /**
   * The main window's focus and whether it is on screen (not minimized or fully covered). The lock
   * is read again here on every platform, since a lock can end without an unlock event (a
   * screensaver or secure desktop running when Pane launched).
   */
  setWindowState(state: { focused?: boolean; visible?: boolean }): void {
    const focused = state.focused ?? this.windowFocused;
    const visible = state.visible ?? this.windowVisible;
    const locked = this.env.isLocked();
    if (focused === this.windowFocused && visible === this.windowVisible && locked === this.locked) return;
    this.windowFocused = focused;
    this.windowVisible = visible;
    this.locked = locked;
    this.evaluate(focused || visible ? 'the Pane window came on screen' : 'the Pane window left the screen');
  }

  /** Re-reads every input, for platforms that report some of them only when asked. */
  evaluate(reason: string): void {
    if (!this.looking() && this.env.now() - this.lowPowerReadAt >= LOW_POWER_CACHE_MS) void this.refreshLowPower();
    const away = this.compute();
    if (away === this.away) return;
    this.away = away;
    this.env.logger.info(`[BackgroundActivity] ${away ? 'Away' : 'Back'} (${this.profile()}): ${reason}.`);
    this.emit('change', away);
  }

  dispose(): void {
    for (const [event, listener] of this.powerListeners) this.env.power.removeListener(event, listener);
    this.env.remoteStreams.removeListener('change', this.handleRemoteStreams);
    this.config.removeListener('config-updated', this.handleConfig);
    this.removeAllListeners();
  }

  private looking(): boolean {
    if (this.env.remoteStreams.count() > 0) return true;
    if (!this.env.lockEvents) this.locked = this.env.isLocked();
    return !this.locked && !this.suspended && (this.windowFocused || this.windowVisible);
  }

  private compute(): boolean {
    const profile = this.profile();
    if (profile === 'performance' || this.looking()) return false;
    if (this.suspended || this.locked || this.lowPower) return true;
    return profile === 'batterySaver' && this.env.isOnBattery();
  }

  private refreshLowPower(): Promise<void> {
    if (this.lowPowerRead) return this.lowPowerRead;
    this.lowPowerRead = this.env.readLowPower()
      .catch(() => false)
      .then(lowPower => {
        this.lowPowerReadAt = this.env.now();
        this.lowPowerRead = null;
        if (lowPower === this.lowPower) return;
        this.lowPower = lowPower;
        this.evaluate(lowPower ? 'Low Power Mode turned on' : 'Low Power Mode turned off');
      });
    return this.lowPowerRead;
  }
}

function electronEnvironment(): BackgroundActivityEnvironment {
  const linux = process.platform === 'linux';
  const events: NodeJS.EventEmitter = powerMonitor;
  return {
    power: {
      on: (event, listener) => { events.on(event, listener); },
      removeListener: (event, listener) => { events.removeListener(event, listener); },
    },
    lockEvents: process.platform === 'darwin' || process.platform === 'win32',
    // `locked` also covers a running screensaver on macOS; Linux answers only on desktops with a ScreenSaver D-Bus service.
    isLocked: () => powerMonitor.getSystemIdleState(60) === 'locked',
    isOnBattery: () => (linux ? readLinuxOnBattery() : powerMonitor.isOnBatteryPower()),
    readLowPower,
    remoteStreams: remoteEventStreams,
    now: () => Date.now(),
    logger: console,
  };
}

/** macOS: `pmset -g` lists `lowpowermode 1`. Linux: power-profiles-daemon's `power-saver` profile. Windows: unknown. */
function readLowPower(): Promise<boolean> {
  const command = process.platform === 'darwin'
    ? { file: 'pmset', args: ['-g'], on: (out: string) => /^\s*lowpowermode\s+1\b/mu.test(out) }
    : process.platform === 'linux'
      ? { file: 'powerprofilesctl', args: ['get'], on: (out: string) => out.trim() === 'power-saver' }
      : null;
  if (!command) return Promise.resolve(false);
  return new Promise(resolve => {
    execFile(command.file, command.args, { encoding: 'utf8', timeout: LOW_POWER_READ_TIMEOUT_MS }, (error, stdout) => {
      resolve(!error && command.on(stdout));
    });
  });
}
