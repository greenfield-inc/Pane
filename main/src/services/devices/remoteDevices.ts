import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import type { WebSocket } from 'ws';
import { PaneError, reasonOf } from '../../../../shared/paneError';
import type { DeviceMac, DevicePlatform, DeviceStreamInfo, DeviceSummary } from '../../../../shared/types/devices';
import { boundary, decodeBoundary, type BoundarySchema, type JsonValue } from '../../../../shared/validation/boundaryDecoder';
import { createPortTunnel, type PortTunnel } from '../../daemon/client/portTunnel';
import type { DeviceJobResult } from './deviceJobs';
import type { DeviceScreenshot } from './deviceService';
import { snapshotBundle } from './deviceSync';

/** The channel a linked computer calls on a Mac for its devices; `runpane:machine:` admits only the owner's own computers. */
export const MAC_DEVICES_CHANNEL = 'runpane:machine:devices';

/** Bundles cross in pieces small enough for any route, the relay included. */
const CHUNK_BYTES = 4 * 1024 * 1024;

/** What a linked computer sends the Mac on MAC_DEVICES_CHANNEL; the Mac decodes it with `macDeviceRequestSchema`. */
export const macDeviceRequestSchema = boundary.object({
  op: boundary.enumeration('probe', 'list', 'open', 'screenshot', 'act', 'stream', 'frame', 'visible', 'sync-begin', 'sync-chunk', 'sync-end', 'run', 'close', 'archived'),
  from: boundary.object({ id: boundary.string, name: boundary.string }),
  paneId: boundary.string,
  paneName: boundary.optional(boundary.string),
  platform: boundary.optional(boundary.enumeration('ios', 'android')),
  device: boundary.optional(boundary.string),
  args: boundary.optional(boundary.array(boundary.string)),
  base: boundary.optional(boundary.string),
  offset: boundary.optional(boundary.number),
  data: boundary.optional(boundary.string),
  commit: boundary.optional(boundary.string),
  bytes: boundary.optional(boundary.number),
  command: boundary.optional(boundary.string),
  background: boundary.optional(boundary.boolean),
  waitMs: boundary.optional(boundary.number),
  visible: boundary.optional(boundary.boolean),
});

export interface MacDeviceRequest {
  op: 'probe' | 'list' | 'open' | 'screenshot' | 'act' | 'stream' | 'frame' | 'visible' | 'sync-begin' | 'sync-chunk' | 'sync-end' | 'run' | 'close' | 'archived';
  from: { id: string; name: string };
  paneId: string;
  paneName?: string;
  platform?: DevicePlatform;
  device?: string;
  args?: string[];
  base?: string;
  offset?: number;
  data?: string;
  commit?: string;
  bytes?: number;
  command?: string;
  background?: boolean;
  waitMs?: number;
  visible?: boolean;
}

/** A request's fields besides its op, caller and Pane. */
type MacDeviceFields = Omit<MacDeviceRequest, 'op' | 'from' | 'paneId'>;

/** How this computer reaches its saved Macs. */
export interface MacRoutes {
  macs(): DeviceMac[];
  /** The Mac pinned in Settings > Devices, if any. */
  pinned(): string | undefined;
  invoke(machineId: string, channel: string, args: MacDeviceRequest[]): Promise<JsonValue>;
  openPortStream(machineId: string, port: number): WebSocket;
  /** This computer, as the Mac keys its leases. */
  self(): { id: string; name: string };
}

export interface RemoteLease {
  macId: string;
  macName: string;
  deviceId: string;
  platform: DevicePlatform;
  reason: 'automatic' | 'pinned';
  /** The last snapshot the Mac's checkout has, so the next sync is a delta. */
  synced?: string;
}

const summarySchema = boundary.object({
  id: boundary.string,
  platform: boundary.enumeration('ios', 'android'),
  name: boundary.string,
  os: boundary.string,
  machine: boundary.string,
  state: boundary.enumeration('booted', 'shutdown'),
  paneMade: boundary.boolean,
  heldBy: boundary.optional(boundary.object({ paneId: boundary.string, paneName: boundary.string })),
});
const probeSchema = boundary.object({ ios: boundary.boolean });
const openSchema = boundary.object({ device: summarySchema });
const listSchema = boundary.object({ devices: boundary.array(summarySchema) });
const streamSchema = boundary.object({ port: boundary.number, token: boundary.string, path: boundary.string, inputPath: boundary.string });
const shotSchema = boundary.object({ data: boundary.string, width: boundary.optional(boundary.number), height: boundary.optional(boundary.number) });
const actSchema = boundary.object({ exitCode: boundary.number, output: boundary.string });
const jobSchema = boundary.object({ jobId: boundary.string, state: boundary.enumeration('running', 'exited'), exitCode: boundary.optional(boundary.number), logTail: boundary.string, cwd: boundary.string });
const syncBeginSchema = boundary.object({ has: boundary.boolean });
const closeSchema = boundary.object({ closed: boundary.array(boundary.string), jobsStopped: boundary.number });
const frameSchema = boundary.object({ data: boundary.string });

function decodeOrThrow<Value>(value: JsonValue, schema: BoundarySchema<Value>, mac: string): Value {
  try {
    return decodeBoundary(value, schema);
  } catch (cause) {
    throw new PaneError('ERR_DEVICE_MAC_OUTDATED', `${mac} answered a device call in a form this Pane does not read: ${reasonOf(cause)}.`, `Update Pane on ${mac} and on this computer to the same release, then try again.`);
  }
}

/**
 * iOS for a computer without Xcode, on a linked Mac Pane picks: device calls, builds and the
 * screen go to it over the routes saved computers already use, with no SSH. Leases are kept here
 * per Pane; the Mac keys its own by this computer and Pane.
 */
export class RemoteDevices {
  private readonly leases = new Map<string, RemoteLease>();
  private readonly tunnels = new Map<string, { tunnel: PortTunnel; ports: Map<number, number> }>();
  /** Macs that answered the devices channel this session, so the pick asks each once. */
  private readonly ready = new Map<string, boolean>();

  constructor(private readonly routes: MacRoutes, private readonly root: string) {}

  leaseOf(paneId: string): RemoteLease | undefined {
    return this.leases.get(paneId);
  }

  /** The iOS devices on the Mac Pane would pick now, named by that Mac; none when no Mac is reachable. */
  async list(): Promise<DeviceSummary[]> {
    let picked;
    try {
      picked = await this.pick();
    } catch {
      return [];
    }
    const { devices } = decodeOrThrow(await this.call(picked.mac, 'list', '', {}), listSchema, picked.mac.name);
    return devices.filter(device => device.platform === 'ios').map(device => ({ ...device, machine: picked.mac.name }));
  }

  /** Picks the Mac (pinned, else the first online one with Xcode) and leases a device there. */
  async open(paneId: string, paneName: string, platform: DevicePlatform, device: string | undefined): Promise<{ lease: RemoteLease; device: DeviceSummary }> {
    const { mac, reason } = await this.pick();
    const request: MacDeviceFields = { paneName, platform };
    if (device) request.device = device;
    const opened = decodeOrThrow(await this.call(mac, 'open', paneId, request), openSchema, mac.name);
    const previous = this.leases.get(paneId);
    const lease: RemoteLease = { macId: mac.id, macName: mac.name, deviceId: opened.device.id, platform, reason };
    if (previous?.macId === mac.id && previous.synced) lease.synced = previous.synced;
    this.leases.set(paneId, lease);
    return { lease, device: { ...opened.device, machine: mac.name } };
  }

  async screenshot(paneId: string): Promise<DeviceScreenshot> {
    const lease = this.require(paneId);
    const shot = decodeOrThrow(await this.call(this.mac(lease), 'screenshot', paneId, {}), shotSchema, lease.macName);
    const folder = path.join(this.root, 'screenshots');
    mkdirSync(folder, { recursive: true });
    const file = path.join(folder, `${paneId}-${Date.now()}.png`);
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    const result: DeviceScreenshot = { path: file };
    if (shot.width !== undefined) result.width = shot.width;
    if (shot.height !== undefined) result.height = shot.height;
    return result;
  }

  async act(paneId: string, args: readonly string[]): Promise<{ exitCode: number; output: string }> {
    const lease = this.require(paneId);
    return decodeOrThrow(await this.call(this.mac(lease), 'act', paneId, { args: [...args] }), actSchema, lease.macName);
  }

  /** Syncs the worktree to the Pane's checkout on the Mac, then runs `command` there. */
  async run(paneId: string, worktree: string, command: string | undefined, options: { background: boolean; waitMs: number }): Promise<{ synced: boolean; job?: DeviceJobResult & { cwd: string } }> {
    const lease = this.require(paneId);
    const mac = this.mac(lease);
    await this.sync(paneId, worktree, lease);
    if (!command) return { synced: true };
    const job = decodeOrThrow(await this.call(mac, 'run', paneId, { command, background: options.background, waitMs: options.waitMs }), jobSchema, lease.macName);
    return { synced: true, job: { ...job, owner: paneId } };
  }

  async close(paneId: string): Promise<{ closed: string[]; jobsStopped: number }> {
    const lease = this.leases.get(paneId);
    if (!lease) return { closed: [], jobsStopped: 0 };
    const result = decodeOrThrow(await this.call(this.mac(lease), 'close', paneId, {}), closeSchema, lease.macName);
    this.leases.delete(paneId);
    return result;
  }

  /** A Pane was archived here: its jobs stop on the Mac and its checkout there is removed. */
  async archived(paneId: string): Promise<void> {
    const lease = this.leases.get(paneId);
    this.leases.delete(paneId);
    if (!lease) return;
    await this.call(this.mac(lease), 'archived', paneId, {});
  }

  /** Where main reads the Mac's screen: the hub's port, tunnelled to this computer's loopback. */
  async stream(paneId: string): Promise<DeviceStreamInfo> {
    const lease = this.require(paneId);
    const info = decodeOrThrow(await this.call(this.mac(lease), 'stream', paneId, {}), streamSchema, lease.macName);
    const local = await this.tunnelPort(lease.macId, info.port);
    return { streamUrl: `http://127.0.0.1:${local}${info.path}`, inputUrl: `ws://127.0.0.1:${local}${info.inputPath}`, token: info.token };
  }

  /** The device tab is on screen (or not) on this computer, so the Mac keeps the lease while it is. */
  async visible(paneId: string, visible: boolean): Promise<void> {
    const lease = this.leases.get(paneId);
    if (lease) await this.call(this.mac(lease), 'visible', paneId, { visible });
  }

  async frame(paneId: string): Promise<Buffer> {
    const lease = this.require(paneId);
    return Buffer.from(decodeOrThrow(await this.call(this.mac(lease), 'frame', paneId, {}), frameSchema, lease.macName).data, 'base64');
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.tunnels.values()].map(({ tunnel }) => tunnel.close()));
    this.tunnels.clear();
  }

  // ---- internals

  private async pick(): Promise<{ mac: DeviceMac; reason: 'automatic' | 'pinned' }> {
    const macs = this.routes.macs();
    const pinnedId = this.routes.pinned();
    const pinned = pinnedId ? macs.find(mac => mac.id === pinnedId) : undefined;
    if (pinned) {
      if (!pinned.online) throw offline(pinned.name);
      await this.requireDevices(pinned);
      return { mac: pinned, reason: 'pinned' };
    }
    if (macs.length === 0) {
      throw new PaneError(
        'ERR_DEVICE_NO_MAC',
        'iOS needs a Mac with Xcode, and this PC has no Mac linked.',
        'On the Mac, open Pane > Add a device > Computer and choose Copy link. On this PC, open Add a device > Computer and paste it under Or finish here, or run runpane link \'<link>\'. Android works on this PC now.',
      );
    }
    let outdated: DeviceMac | undefined;
    for (const mac of macs.filter(candidate => candidate.online)) {
      try {
        await this.requireDevices(mac);
        return { mac, reason: 'automatic' };
      } catch (cause) {
        if (cause instanceof PaneError && cause.code === 'ERR_DEVICE_MAC_OUTDATED') outdated ??= mac;
      }
    }
    if (outdated) throw outdatedMac(outdated.name);
    throw offline(macs[0].name);
  }

  /** The Mac runs a Pane with device support and has Xcode. */
  private async requireDevices(mac: DeviceMac): Promise<void> {
    if (this.ready.get(mac.id)) return;
    const probe = decodeOrThrow(await this.call(mac, 'probe', '', {}), probeSchema, mac.name);
    if (!probe.ios) throw new PaneError('ERR_DEVICE_MAC_NO_XCODE', `${mac.name} has no Xcode with an iOS runtime, so it cannot run iOS for this PC.`, `Install Xcode on ${mac.name} and open it once, or pick another Mac in Settings > Devices.`);
    this.ready.set(mac.id, true);
  }

  private async sync(paneId: string, worktree: string, lease: RemoteLease): Promise<void> {
    const mac = this.mac(lease);
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'pane-device-bundle-'));
    try {
      const begin = decodeOrThrow(await this.call(mac, 'sync-begin', paneId, { base: lease.synced ?? '' }), syncBeginSchema, lease.macName);
      const base = begin.has ? lease.synced : undefined;
      const bundle = await snapshotBundle(worktree, paneId, base, path.join(scratch, 'sync.bundle'));
      const bytes = readFileSync(bundle.path);
      for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
        await this.call(mac, 'sync-chunk', paneId, { offset, data: bytes.subarray(offset, offset + CHUNK_BYTES).toString('base64') });
      }
      await this.call(mac, 'sync-end', paneId, { commit: bundle.commit, bytes: bytes.length });
      lease.synced = bundle.commit;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  private async tunnelPort(macId: string, port: number): Promise<number> {
    let entry = this.tunnels.get(macId);
    if (!entry) {
      entry = { tunnel: createPortTunnel(hostPort => this.routes.openPortStream(macId, hostPort)), ports: new Map() };
      this.tunnels.set(macId, entry);
    }
    const known = entry.ports.get(port);
    if (known) return known;
    const mapped = await entry.tunnel.sync([...entry.ports.keys(), port]);
    const local = mapped.get(port);
    if (local === undefined) throw new PaneError('ERR_DEVICE_TUNNEL', 'Pane could not open a local port for the Mac\'s screen.', 'Try again.');
    entry.ports.set(port, local);
    return local;
  }

  private require(paneId: string): RemoteLease {
    const lease = this.leases.get(paneId);
    if (!lease) throw new PaneError('ERR_DEVICE_NOT_OPEN', 'This Pane has no device open, so there is nothing to act on.', 'Call device_open first.');
    return lease;
  }

  private mac(lease: RemoteLease): DeviceMac {
    const mac = this.routes.macs().find(candidate => candidate.id === lease.macId);
    if (!mac) throw new PaneError('ERR_DEVICE_MAC_OFFLINE', `${lease.macName} is no longer a saved computer here.`, 'Link it again, or call device_open to pick another Mac.');
    return mac;
  }

  private async call(mac: DeviceMac, op: MacDeviceRequest['op'], paneId: string, fields: MacDeviceFields): Promise<JsonValue> {
    if (!mac.online && op !== 'archived') throw offline(mac.name);
    try {
      return await this.routes.invoke(mac.id, MAC_DEVICES_CHANNEL, [{ ...fields, op, from: this.routes.self(), paneId }]);
    } catch (cause) {
      if (cause instanceof PaneError && cause.code.startsWith('ERR_DEVICE')) throw cause;
      const reason = reasonOf(cause);
      if (/no handler|not registered|unknown (command|channel)/i.test(reason)) throw outdatedMac(mac.name);
      if (/ERR_DEVICE_[A-Z_]+/.test(reason)) throw new PaneError(/ERR_DEVICE_[A-Z_]+/.exec(reason)?.[0] ?? 'ERR_DEVICE_MAC', `${mac.name}: ${reason}.`, 'See the message above for the next step.');
      throw new MacUnavailableError('ERR_DEVICE_MAC_OFFLINE', mac.name, `${mac.name} runs iOS for this PC but did not answer: ${reason}.`, 'Wake it and open Pane there, or pick another Mac in Settings > Devices.');
    }
  }
}

/** The Mac that runs iOS for this computer is offline or out of date; the device tab names it. */
export class MacUnavailableError extends PaneError {
  constructor(code: string, readonly macName: string, message: string, next: string) {
    super(code, message, next);
  }
}

function offline(name: string): PaneError {
  return new MacUnavailableError('ERR_DEVICE_MAC_OFFLINE', name, `${name} runs iOS for this PC but is not reachable.`, 'Wake it and open Pane there, or pick another Mac in Settings > Devices.');
}

function outdatedMac(name: string): PaneError {
  return new MacUnavailableError('ERR_DEVICE_MAC_OUTDATED', name, `${name} runs a Pane without device support.`, `Update Pane on ${name}, then try again.`);
}
