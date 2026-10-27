import { EventEmitter } from 'events';
import type { RestartToUpdateState, UpdateBusyState } from '../../../../shared/types/updater';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface UpdateIdleTiming {
  /** Nothing ran for this long before the idle toast shows. */
  quietHoldMs: number;
  /** How long Later hides the idle toast. */
  snoozeMs: number;
  /** Tonight restarts only after nothing ran for this long... */
  tonightQuietMs: number;
  /** ...and nobody touched the keyboard or mouse for this long... */
  tonightInputIdleMs: number;
  /** ...between these local hours, end exclusive. */
  tonightStartHour: number;
  tonightEndHour: number;
}

export const DEFAULT_UPDATE_IDLE_TIMING: UpdateIdleTiming = {
  quietHoldMs: 5 * MINUTE,
  snoozeMs: 4 * HOUR,
  tonightQuietMs: HOUR,
  tonightInputIdleMs: 30 * MINUTE,
  tonightStartHour: 2,
  tonightEndHour: 5,
};

export interface UpdateIdleGateOptions {
  now: () => number;
  /** What is running right now; null when nothing is. */
  readBusy: () => UpdateBusyState | null;
  /** Seconds since the last keyboard or mouse input on the computer. */
  systemIdleSeconds: () => number;
  restartTonight: () => void;
  timing?: UpdateIdleTiming;
}

/**
 * Decides when Pane may offer, or for Tonight perform, a restart to update.
 * The quiet clock starts at the last moment anything was busy; Later and
 * Tonight live only for the current run.
 */
export class UpdateIdleGate extends EventEmitter {
  private readonly options: UpdateIdleGateOptions;
  private readonly timing: UpdateIdleTiming;
  private readyVersion: string | null = null;
  private availableVersion: string | null = null;
  private busy: UpdateBusyState | null = null;
  private lastBusyAt: number;
  private snoozedUntil: number | null = null;
  private tonight = false;
  private tonightFired = false;
  private published = '';

  constructor(options: UpdateIdleGateOptions) {
    super();
    this.options = options;
    this.timing = options.timing ?? DEFAULT_UPDATE_IDLE_TIMING;
    this.lastBusyAt = options.now();
  }

  setReady(version: string): void {
    this.readyVersion = version;
    this.tick();
  }

  setAvailable(version: string): void {
    this.availableVersion = version;
    this.tick();
  }

  /** Something was busy just now, even if it has already finished. */
  markBusy(): void {
    this.lastBusyAt = this.options.now();
    this.tick();
  }

  snooze(): void {
    this.snoozedUntil = this.options.now() + this.timing.snoozeMs;
    this.tick();
  }

  setTonight(enabled: boolean): void {
    this.tonight = enabled;
    this.tonightFired = false;
    this.tick();
  }

  tick(): void {
    const now = this.options.now();
    this.busy = this.options.readBusy();
    if (this.busy) this.lastBusyAt = now;
    if (this.snoozedUntil !== null && now >= this.snoozedUntil) this.snoozedUntil = null;
    if (this.isTonightDue(now)) {
      this.tonightFired = true;
      this.options.restartTonight();
    }
    this.publish();
  }

  getState(): RestartToUpdateState {
    const now = this.options.now();
    return {
      readyVersion: this.readyVersion,
      availableVersion: this.availableVersion,
      busy: this.busy,
      idleToastDue: this.readyVersion !== null
        && !this.busy
        && now - this.lastBusyAt >= this.timing.quietHoldMs
        && this.snoozedUntil === null
        && !this.tonight,
      snoozedUntil: this.snoozedUntil,
      tonight: this.tonight,
    };
  }

  private isTonightDue(now: number): boolean {
    if (!this.tonight || this.tonightFired || !this.readyVersion || this.busy) return false;
    const hour = new Date(now).getHours();
    return hour >= this.timing.tonightStartHour
      && hour < this.timing.tonightEndHour
      && now - this.lastBusyAt >= this.timing.tonightQuietMs
      && this.options.systemIdleSeconds() * 1000 >= this.timing.tonightInputIdleMs;
  }

  private publish(): void {
    const state = this.getState();
    const serialized = JSON.stringify(state);
    if (serialized === this.published) return;
    this.published = serialized;
    this.emit('state', state);
  }
}
