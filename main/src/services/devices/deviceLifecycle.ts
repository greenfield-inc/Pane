import type { DevicePlatform } from '../../../../shared/types/devices';

/** One simulator or emulator on this machine, as the lifecycle sees it. */
export interface DeviceRecord {
  id: string;
  platform: DevicePlatform;
  name: string;
  /** Pane created it (it may erase, slim and delete it). */
  paneMade: boolean;
  booted: boolean;
  lastUsedAt?: number;
}

export type DevicePick =
  | { kind: 'device'; id: string }
  | { kind: 'create' }
  | { kind: 'busy'; id: string; holder: string };

interface EndedLease { paneId: string; id: string }

/** What a sweep decided: leases that idled out, and devices to shut down now. */
export interface SweepResult { ended: EndedLease[]; shutdown: string[] }

/** What archiving a Pane decided: devices to erase, leases it ended, and devices Pane booted to shut down now. */
export interface ArchiveResult { erase: string[]; ended: EndedLease[]; shutdown: string[] }

const DEVICE_IDLE_MS = 10 * 60_000;
const DEVICE_WARM_MS = 10 * 60_000;
const DEVICE_STALE_MS = 7 * 24 * 60 * 60_000;

interface Lease { paneId: string; id: string; platform: DevicePlatform; lastCallAt: number; visibleIn: Set<string> }

/**
 * Who holds which device, and when a device should shut down, be erased or be deleted.
 * Pure state over a clock: the devices service applies what it decides.
 *
 * - One booted device per platform per machine by default (`cap`); Panes share it by lease.
 * - A lease ends after `DEVICE_IDLE_MS` with no device call and its tab on screen nowhere.
 * - After device_close the device stays booted for `DEVICE_WARM_MS`, then shuts down.
 * - Pane shuts down only devices it booted (`booted()`); a device the person booted keeps running.
 * - Pane picks only devices it made; the person's own are used only when named.
 */
export class DeviceLifecycle {
  private readonly leases = new Map<string, Lease>();
  private readonly warmUntil = new Map<string, number>();
  /** Every Pane that has leased each device since it was last erased. */
  private readonly users = new Map<string, Set<string>>();
  /** The devices Pane booted: the only ones it shuts down on its own. */
  private readonly bootedByPane = new Set<string>();

  constructor(private readonly options: { now: () => number; cap: (platform: DevicePlatform) => number }) {}

  /** Which device `paneId` should get for `platform`, given the devices on this machine. */
  pick(paneId: string, platform: DevicePlatform, devices: readonly DeviceRecord[]): DevicePick {
    const held = this.leaseOf(paneId, platform);
    if (held) return { kind: 'device', id: held };
    const own = devices.filter(device => device.platform === platform && device.paneMade);
    const free = own.filter(device => !this.leases.has(device.id));
    const bootedFree = free.find(device => device.booted);
    if (bootedFree) return { kind: 'device', id: bootedFree.id };
    const bootedCount = devices.filter(device => device.platform === platform && device.booted && (device.paneMade || this.leases.has(device.id))).length;
    if (bootedCount < this.options.cap(platform)) {
      const shutDown = free.find(device => !device.booted);
      return shutDown ? { kind: 'device', id: shutDown.id } : { kind: 'create' };
    }
    const holder = own.map(device => this.leases.get(device.id)).find(lease => lease !== undefined);
    return holder ? { kind: 'busy', id: holder.id, holder: holder.paneId } : { kind: 'create' };
  }

  lease(paneId: string, id: string, platform: DevicePlatform = 'ios', options: { bootedByPane?: boolean } = {}): void {
    this.leases.set(id, { paneId, id, platform, lastCallAt: this.options.now(), visibleIn: new Set() });
    this.warmUntil.delete(id);
    if (options.bootedByPane) this.bootedByPane.add(id);
    const users = this.users.get(id) ?? new Set<string>();
    users.add(paneId);
    this.users.set(id, users);
  }

  /** A device Pane booted before it restarted (from the devices state file). */
  restoreBooted(id: string): void {
    this.bootedByPane.add(id);
  }

  /** The devices Pane booted and has not shut down, for the state file and for quitting. */
  booted(): string[] {
    return [...this.bootedByPane];
  }

  /** `id` shut down: Pane no longer owes it a shutdown. */
  shutDown(id: string): void {
    this.bootedByPane.delete(id);
    this.warmUntil.delete(id);
  }

  /** A Pane that used `id` before Pane restarted (from the devices state file). */
  restoreUser(id: string, paneId: string): void {
    const users = this.users.get(id) ?? new Set<string>();
    users.add(paneId);
    this.users.set(id, users);
  }

  holderOf(id: string): string | undefined {
    return this.leases.get(id)?.paneId;
  }

  leaseOf(paneId: string, platform?: DevicePlatform): string | undefined {
    for (const lease of this.leases.values()) {
      if (lease.paneId === paneId && (platform === undefined || lease.platform === platform)) return lease.id;
    }
    return undefined;
  }

  /** Every device `paneId` holds. */
  leasesOf(paneId: string): string[] {
    return [...this.leases.values()].filter(lease => lease.paneId === paneId).map(lease => lease.id);
  }

  /** Every Pane holding a device now. */
  holders(): string[] {
    return [...new Set([...this.leases.values()].map(lease => lease.paneId))];
  }

  /** A device call from `paneId`: its leases stay alive. */
  touch(paneId: string): void {
    const now = this.options.now();
    for (const lease of this.leases.values()) if (lease.paneId === paneId) lease.lastCallAt = now;
  }

  /** A client shows or hides the device tab of `paneId`'s device. */
  setVisible(paneId: string, id: string, clientId: string, visible: boolean): void {
    const lease = this.leases.get(id);
    if (!lease || lease.paneId !== paneId) return;
    if (visible) lease.visibleIn.add(clientId);
    else {
      lease.visibleIn.delete(clientId);
      lease.lastCallAt = Math.max(lease.lastCallAt, this.options.now());
    }
  }

  /** device_close: the lease ends and the device stays warm for the next open. */
  release(paneId: string, id: string): boolean {
    const lease = this.leases.get(id);
    if (!lease || lease.paneId !== paneId) return false;
    this.leases.delete(id);
    this.warmUntil.set(id, this.options.now() + DEVICE_WARM_MS);
    return true;
  }

  /** The person pressed Take over: the lease moves to `paneId`. Returns the Pane that lost it. */
  takeOver(paneId: string, id: string, platform: DevicePlatform): string | undefined {
    const previous = this.leases.get(id);
    this.lease(paneId, id, platform, { bootedByPane: this.bootedByPane.has(id) });
    return previous?.paneId;
  }

  /** Leases that idled out, and booted devices that should shut down now. */
  sweep(devices: readonly DeviceRecord[]): SweepResult {
    const now = this.options.now();
    const ended: EndedLease[] = [];
    const shutdown: string[] = [];
    for (const lease of [...this.leases.values()]) {
      if (lease.visibleIn.size === 0 && now - lease.lastCallAt >= DEVICE_IDLE_MS) {
        this.leases.delete(lease.id);
        ended.push({ paneId: lease.paneId, id: lease.id });
        if (this.bootedByPane.has(lease.id)) shutdown.push(lease.id);
      }
    }
    for (const device of devices) {
      if (!device.booted || this.leases.has(device.id) || shutdown.includes(device.id)) continue;
      if (!this.bootedByPane.has(device.id)) continue;
      const until = this.warmUntil.get(device.id);
      if (until === undefined) this.warmUntil.set(device.id, now + DEVICE_WARM_MS);
      else if (now >= until) shutdown.push(device.id);
    }
    // The mark that Pane booted it stays until the shutdown is seen to work, so a failed one is tried again.
    for (const id of shutdown) this.warmUntil.delete(id);
    return { ended, shutdown };
  }

  /**
   * A Pane was archived: its leases end, Pane-made devices no other Pane used are erased, and the
   * devices Pane booted for it shut down now rather than after their warm window.
   */
  archived(paneId: string, devices: readonly DeviceRecord[]): ArchiveResult {
    const ended = this.leasesOf(paneId).map(id => ({ paneId, id }));
    for (const { id } of ended) this.leases.delete(id);
    const erase: string[] = [];
    // The devices this Pane held or used: one it closed earlier may still be warm.
    const used = new Set(ended.map(({ id }) => id));
    for (const device of devices) {
      const users = this.users.get(device.id);
      if (!users?.delete(paneId)) continue;
      used.add(device.id);
      if (users.size === 0 && device.paneMade) {
        erase.push(device.id);
        this.users.delete(device.id);
      }
    }
    const shutdown = [...used].filter(id => this.bootedByPane.has(id) && !erase.includes(id) && !this.leases.has(id) && devices.some(device => device.id === id && device.booted));
    for (const id of shutdown) this.warmUntil.delete(id);
    return { erase, ended, shutdown };
  }

  /** Pane-made devices unused for `DEVICE_STALE_MS`, which Pane deletes. */
  stale(devices: readonly DeviceRecord[]): string[] {
    const now = this.options.now();
    return devices
      .filter(device => device.paneMade && !device.booted && !this.leases.has(device.id) && device.lastUsedAt !== undefined && now - device.lastUsedAt >= DEVICE_STALE_MS)
      .map(device => device.id);
  }

  /** Whether any lease or warm window is open, so the service keeps its timer. */
  active(): boolean {
    return this.leases.size > 0 || this.warmUntil.size > 0;
  }
}
