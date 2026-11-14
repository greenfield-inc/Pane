import { execFile } from 'child_process';
import { EventEmitter } from 'events';
import { readFile } from 'fs/promises';
import { powerMonitor } from 'electron';
import type { AppConfig } from '../types/config';
import { DEFAULT_BACKGROUND_ACTIVITY, type BackgroundActivityProfile } from '../../../shared/types/backgroundActivity';
import { readLinuxOnBattery } from './linuxPowerSupply';
import { remoteEventStreams } from '../daemon/remoteEventStreams';

/** A Low Power Mode read is reused this long, so switching apps doesn't start a process each time. */
const LOW_POWER_CACHE_MS = 60_000;
const LOW_POWER_READ_TIMEOUT_MS = 2_000;
const LINUX_PLATFORM_PROFILE = '/sys/firmware/acpi/platform_profile';
/** The platform profiles power-profiles-daemon reports as power-saver. */
const LINUX_LOW_POWER_PROFILES = new Set(['low-power', 'quiet', 'cool']);
/** Where no unlock event fires (Linux), the lock is read this often while away, so an unlock is seen without a click. */
const AWAY_LOCK_RECHECK_MS = 30_000;
/**
 * `getSystemIdleState` answers `locked` before it compares idle time with this threshold, so the
 * threshold never changes a lock read; it only splits `idle` from `active`, which Pane ignores.
 */
const IDLE_THRESHOLD_SECONDS = 60;

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
  private lockRecheck: NodeJS.Timeout | null = null;

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
    this.syncLockRecheck();
  }

  profile(): BackgroundActivityProfile {
    return this.config.getConfig().backgroundActivity ?? DEFAULT_BACKGROUND_ACTIVITY;
  }

  isAway(): boolean {
    return this.away;
  }

  /**
   * The main window's focus and whether it is on screen (not minimized or fully covered). The lock
   * is read again here, since a lock can end without an unlock event (a screensaver running when
   * Pane launched). Where lock events fire, this read only clears a lock: Windows also reads a UAC
   * prompt as locked, and no event would clear it afterwards.
   */
  setWindowState(state: { focused?: boolean; visible?: boolean }): void {
    const focused = state.focused ?? this.windowFocused;
    const visible = state.visible ?? this.windowVisible;
    const locked = this.env.lockEvents ? this.locked && this.env.isLocked() : this.env.isLocked();
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
    this.syncLockRecheck();
    this.env.logger.info(`[BackgroundActivity] ${away ? 'Away' : 'Back'} (${this.profile()}): ${reason}.`);
    this.emit('change', away);
  }

  dispose(): void {
    if (this.lockRecheck) clearInterval(this.lockRecheck);
    this.lockRecheck = null;
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

  private syncLockRecheck(): void {
    const wanted = this.away && !this.env.lockEvents;
    if (wanted === (this.lockRecheck !== null)) return;
    if (this.lockRecheck) {
      clearInterval(this.lockRecheck);
      this.lockRecheck = null;
      return;
    }
    this.lockRecheck = setInterval(() => this.evaluate('the screen was checked again'), AWAY_LOCK_RECHECK_MS);
    this.lockRecheck.unref?.();
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
    isLocked: () => powerMonitor.getSystemIdleState(IDLE_THRESHOLD_SECONDS) === 'locked',
    isOnBattery: () => (linux ? readLinuxOnBattery() : powerMonitor.isOnBatteryPower()),
    readLowPower,
    remoteStreams: remoteEventStreams,
    now: () => Date.now(),
    logger: console,
  };
}

/**
 * macOS: `pmset -g` lists `lowpowermode 1`. Linux: power-profiles-daemon's `power-saver` profile,
 * else (no daemon) an ACPI platform profile that ppd would show as power-saver (`low-power`,
 * `quiet` or `cool`). Windows: unknown.
 */
async function readLowPower(): Promise<boolean> {
  if (process.platform === 'darwin') {
    return (await run('pmset', ['-g'], out => /^\s*lowpowermode\s+1\b/mu.test(out))) ?? false;
  }
  if (process.platform !== 'linux') return false;
  const daemon = await run('powerprofilesctl', ['get'], out => out.trim() === 'power-saver');
  if (daemon !== null) return daemon;
  const profile = await readFile(LINUX_PLATFORM_PROFILE, 'utf8').catch(() => '');
  return LINUX_LOW_POWER_PROFILES.has(profile.trim());
}

/** Runs a read-only command; its answer, or null when it couldn't run. */
function run(file: string, args: string[], answer: (out: string) => boolean): Promise<boolean | null> {
  return new Promise(resolve => {
    execFile(file, args, { encoding: 'utf8', timeout: LOW_POWER_READ_TIMEOUT_MS }, (error, stdout) => {
      resolve(error ? null : answer(stdout));
    });
  });
}
