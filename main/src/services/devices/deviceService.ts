import { execFile } from 'child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { promisify } from 'util';
import { PaneError, reasonOf } from '../../../../shared/paneError';
import type { DevicePlatform, DeviceStreamInfo, DeviceSummary } from '../../../../shared/types/devices';
import { boundary, decodeBoundary, decodeOptionalBoundary, type BoundarySchema } from '../../../../shared/validation/boundaryDecoder';
import { DeviceHelpers, paneNode, refuseRetarget, runAgentDevice, startHub, type NodeRunner, type RunningHub } from './deviceHelpers';
import { DeviceJobs, type DeviceJobResult } from './deviceJobs';
import { DeviceLifecycle, type DeviceRecord } from './deviceLifecycle';
import { probeDevices, type DeviceCapabilities, type ProbeEnvironment } from './deviceProbe';

const execFileAsync = promisify(execFile);

const BUSY_WAIT_MS = 60_000;
const SWEEP_MS = 30_000;
const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);
const PANE_DEVICE_NAMES = { ios: 'Pane iPhone', android: 'Pane_Android' } satisfies Record<DevicePlatform, string>;

/** A Pane-made device, as the state file keeps it. */
interface MadeDevice { platform: DevicePlatform; name: string; model?: string; createdAt: number; lastUsedAt: number; users: string[]; slimmed?: boolean }
const stateSchema = boundary.object({
  made: boundary.record(boundary.object({
    platform: boundary.enumeration('ios', 'android'),
    name: boundary.string,
    model: boundary.optional(boundary.string),
    createdAt: boundary.number,
    lastUsedAt: boundary.number,
    users: boundary.array(boundary.string),
    slimmed: boundary.optional(boundary.boolean),
  })),
});

/** The devices state file: Pane-made devices, who used them and when. */
interface DeviceState { made: Record<string, MadeDevice> }

/** The hub's device list entries Pane reads. */
const hubDevicesSchema = boundary.object({
  simulators: boundary.array(boundary.object({ id: boundary.string, name: boundary.string, version: boundary.optional(boundary.string), booted: boundary.boolean, physical: boundary.optional(boundary.boolean) })),
  emulators: boundary.array(boundary.object({ id: boundary.string, name: boundary.string, version: boundary.optional(boundary.string), booted: boundary.boolean, serial: boundary.optional(boundary.string) })),
});

interface HubDevice extends DeviceRecord { os: string; serial?: string; model?: string }

/** Every device Pane may boot is held by another Pane. */
export class DeviceBusyError extends PaneError {
  constructor(readonly deviceId: string, readonly deviceName: string, readonly holder: string, message: string) {
    super('ERR_DEVICE_BUSY', message, 'Try again later, press Take over in the device tab, or raise Settings > Devices > Simulators at once.');
  }
}

/** Who is calling: the Pane (lease owner) and, for a linked computer, which one. */
export interface DeviceCaller { paneId: string; paneName: string; panelId?: string }

export interface DeviceOpenResult {
  device: DeviceSummary;
}

export interface DeviceServiceOptions {
  root: string;
  machineName: () => string;
  /** How device tabs name this machine ("This Mac"); `machineName` when absent. */
  machineLabel?: () => string;
  findExecutable: (name: string) => string | null;
  probeEnvironment: () => ProbeEnvironment;
  maxBooted: () => number;
  paneName: (paneId: string) => string;
  now?: () => number;
  node?: NodeRunner;
  /** A device's state changed (lease moved, shut down, booted); the device tabs follow. */
  onChange?: (event: DeviceChange) => void;
  /** The helpers started installing on this machine. */
  onInstall?: () => void;
  log?: (message: string) => void;
}

export type DeviceChange =
  | { kind: 'held'; id: string; paneId: string; previous?: string }
  | { kind: 'released'; id: string; paneId: string; reason: 'closed' | 'idle' | 'archived' | 'taken' }
  | { kind: 'shutdown'; id: string };

/**
 * The devices service on one machine. Lazy: nothing runs until the first device call, and the
 * helpers stop when no device is booted. It acts only for the Pane named in each call; the IPC
 * layer decides who that caller is.
 */
export class DeviceService {
  readonly lifecycle: DeviceLifecycle;
  readonly jobs: DeviceJobs;
  private capabilities?: Promise<DeviceCapabilities>;
  private hub?: Promise<RunningHub>;
  private sweepTimer?: NodeJS.Timeout;
  private readonly helpers: DeviceHelpers;
  private readonly node: NodeRunner;
  private readonly now: () => number;
  /** The last frame read of each device, kept for its off and closed states. */
  private readonly lastFrames = new Map<string, Buffer>();

  constructor(private readonly options: DeviceServiceOptions) {
    this.now = options.now ?? Date.now;
    this.node = options.node ?? paneNode();
    this.helpers = new DeviceHelpers({ root: options.root, findExecutable: options.findExecutable, machineName: options.machineName });
    this.lifecycle = new DeviceLifecycle({ now: this.now, cap: () => Math.min(4, Math.max(1, options.maxBooted())) });
    this.jobs = new DeviceJobs({ shell: () => process.platform === 'win32' ? { executable: 'cmd.exe', args: (command) => ['/d', '/s', '/c', command] } : { executable: process.env.SHELL || '/bin/sh', args: (command) => ['-lc', command] } });
    for (const [id, made] of Object.entries(this.readState().made)) for (const paneId of made.users) this.lifecycle.restoreUser(id, paneId);
  }

  /** What this machine can run; probed once, on the first device call. */
  probe(refresh = false): Promise<DeviceCapabilities> {
    if (refresh || !this.capabilities) this.capabilities = probeDevices(this.options.probeEnvironment());
    return this.capabilities;
  }

  helpersInstalled(): boolean {
    return this.helpers.installed() !== undefined;
  }

  async list(): Promise<DeviceSummary[]> {
    const capabilities = await this.probe();
    if (!capabilities.ios.ready && !capabilities.android.ready) return [];
    return (await this.devices()).map(device => this.summary(device));
  }

  /** Leases and boots a device for `caller`, waiting up to `BUSY_WAIT_MS` when every one is held. */
  async open(caller: DeviceCaller, request: { platform: DevicePlatform; device?: string }, onPhase?: (phase: 'installing' | 'booting') => void): Promise<DeviceOpenResult> {
    const capabilities = await this.probe();
    this.requireReady(capabilities, request.platform);
    const deadline = this.now() + BUSY_WAIT_MS;
    for (;;) {
      const devices = await this.devices(() => onPhase?.('installing'));
      const chosen = request.device ? this.named(devices, request) : await this.choose(caller, request.platform, devices, deadline);
      if (!chosen) continue;
      const holder = this.lifecycle.holderOf(chosen.id);
      if (holder && holder !== caller.paneId) {
        if (this.now() < deadline) { await sleep(2_000); continue; }
        throw this.busy(chosen, holder);
      }
      if (holder !== caller.paneId) {
        this.lifecycle.lease(caller.paneId, chosen.id, chosen.platform, { bootedByPane: !chosen.booted && !chosen.paneMade });
        this.options.onChange?.({ kind: 'held', id: chosen.id, paneId: caller.paneId });
      }
      this.markUsed(chosen.id, caller.paneId);
      if (!chosen.booted || this.needsSlim(chosen, capabilities)) {
        onPhase?.('booting');
        await this.boot(chosen, capabilities);
      }
      await this.agentDevice(caller.paneId, chosen, ['open']);
      this.scheduleSweep();
      return { device: this.summary({ ...chosen, booted: true }) };
    }
  }

  private async choose(caller: DeviceCaller, platform: DevicePlatform, devices: HubDevice[], deadline: number): Promise<HubDevice | undefined> {
    const pick = this.lifecycle.pick(caller.paneId, platform, devices);
    if (pick.kind === 'device') return devices.find(device => device.id === pick.id);
    if (pick.kind === 'create') return this.create(platform);
    if (this.now() >= deadline) throw this.busy(devices.find(device => device.id === pick.id) ?? { id: pick.id, name: PANE_DEVICE_NAMES[platform] }, pick.holder);
    await sleep(2_000);
    return undefined;
  }

  private named(devices: HubDevice[], request: { platform: DevicePlatform; device?: string }): HubDevice {
    const wanted = request.device?.trim().toLowerCase();
    const device = devices.find(candidate => candidate.platform === request.platform && (candidate.id.toLowerCase() === wanted || candidate.name.toLowerCase() === wanted));
    if (!device) {
      throw new PaneError('ERR_DEVICE_NOT_FOUND', `No ${request.platform === 'ios' ? 'iOS simulator' : 'Android emulator'} named "${request.device}" on ${this.options.machineName()}. Nothing was opened.`, 'Call device_list for the devices you can open, or leave device out to get Pane\'s own.');
    }
    return device;
  }

  private busy(device: { id: string; name: string; model?: string }, holder: string): DeviceBusyError {
    return new DeviceBusyError(
      device.id,
      device.model ?? device.name,
      holder,
      `${device.model ?? device.name} is in use by the Pane "${this.options.paneName(holder)}", and every ${device.name.includes('Android') ? 'emulator' : 'simulator'} Pane may boot here is held. Pane waited ${BUSY_WAIT_MS / 1000} seconds.`,
    );
  }

  private requireReady(capabilities: DeviceCapabilities, platform: DevicePlatform): void {
    const state = capabilities[platform];
    if (state.ready) return;
    throw new PaneError(platform === 'ios' ? 'ERR_DEVICE_NO_XCODE' : 'ERR_DEVICE_NO_ANDROID_SDK', `${this.options.machineName()} cannot run ${platform === 'ios' ? 'iOS simulators' : 'Android emulators'}: ${state.reason}`, state.reason);
  }

  private async create(platform: DevicePlatform): Promise<HubDevice> {
    const hub = await this.ensureHub();
    const options = decodeBoundary(await (await hub.request('/api/new-device-options')).json(), boundary.object({
      ios: boundary.object({ runtimes: boundary.array(boundary.object({ value: boundary.string, label: boundary.string, models: boundary.array(boundary.object({ value: boundary.string, label: boundary.string, supported: boundary.optional(boundary.boolean) })) })) }),
      android: boundary.object({ runtimes: boundary.array(boundary.object({ value: boundary.string, label: boundary.string, models: boundary.array(boundary.object({ value: boundary.string, label: boundary.string })) })) }),
    }));
    // The newest runtime the person installed; Pane never downloads one.
    const runtime = options[platform].runtimes[0];
    const model = runtime ? pickModel(platform, runtime.models) : undefined;
    if (!runtime || !model) {
      throw new PaneError(
        'ERR_DEVICE_NO_RUNTIME',
        platform === 'ios'
          ? `${this.options.machineName()} has no iOS runtime Pane can make a simulator from. Nothing was created.`
          : `${this.options.machineName()} has no Android system image, or no Android SDK Command-line Tools, so Pane cannot make an emulator. Nothing was created.`,
        platform === 'ios'
          ? 'Add an iOS runtime in Xcode > Settings > Components, then try again.'
          : 'In Android Studio, open SDK Manager and install a system image and "Android SDK Command-line Tools (latest)". Or name one of your own emulators with device.',
      );
    }
    const name = PANE_DEVICE_NAMES[platform];
    const created = decodeBoundary(await (await hub.request('/api/devices/create', { platform, name, runtime: runtime.value, deviceType: model.value })).json(), boundary.object({ ok: boundary.boolean, id: boundary.optional(boundary.string), error: boundary.optional(boundary.string) }));
    const id = created.id ?? (platform === 'android' ? name : undefined);
    if (!id) throw new PaneError('ERR_DEVICE_CREATE_FAILED', `Pane could not make ${name}: ${created.error ?? 'the hub gave no reason'}. Nothing was opened.`, 'Try again; if it repeats, check that Xcode or Android Studio can create a device.');
    const state = this.readState();
    state.made[id] = { platform, name, model: model.label, createdAt: this.now(), lastUsedAt: this.now(), users: [], slimmed: false };
    this.writeState(state);
    const device = (await this.devices()).find(candidate => candidate.id === id || candidate.name === name && candidate.platform === platform && candidate.paneMade);
    if (!device) throw new PaneError('ERR_DEVICE_CREATE_FAILED', `Pane made ${name} but cannot find it in the device list.`, 'Try again.');
    return device;
  }

  private needsSlim(device: HubDevice, capabilities: DeviceCapabilities): boolean {
    return device.platform === 'ios' && capabilities.simslim !== undefined && this.readState().made[device.id]?.slimmed === false;
  }

  private async boot(device: HubDevice, capabilities: DeviceCapabilities): Promise<void> {
    const hub = await this.ensureHub();
    const state = this.readState();
    const made = state.made[device.id];
    if (device.platform === 'ios' && made && made.slimmed === false && capabilities.simslim) {
      // Slim once (persistent on iOS 18.5 and later). simslim boots and reconfigures the device.
      try {
        await execFileAsync(capabilities.simslim, ['on', device.id], { timeout: 10 * 60_000 });
        made.slimmed = true;
        this.writeState(state);
      } catch (cause) {
        // Tried once; the device works stock. Settings > Devices shows simslim's state.
        delete made.slimmed;
        this.writeState(state);
        this.options.log?.(`[devices] simslim on ${device.id} failed: ${reasonOf(cause)}`);
      }
    }
    const response = decodeBoundary(await (await hub.request('/api/devices/boot', { platform: device.platform, id: device.id, name: device.name })).json(), boundary.object({ ok: boundary.boolean, error: boundary.optional(boundary.string) }));
    if (!response.ok) {
      const already = (await this.devices()).find(candidate => candidate.id === device.id)?.booted;
      if (!already) throw new PaneError('ERR_DEVICE_BOOT_FAILED', `${device.name} did not boot: ${response.error ?? 'no reason given'}.`, 'Try again. If it repeats, open the device once in Xcode or Android Studio.');
    }
  }

  /** The leased device of `paneId` on this machine, or a refusal naming device_open. */
  held(paneId: string, platform?: DevicePlatform): string {
    const id = this.lifecycle.leaseOf(paneId, platform);
    if (!id) throw new PaneError('ERR_DEVICE_NOT_OPEN', 'This Pane has no device open, so there is nothing to act on.', 'Call device_open first.');
    return id;
  }

  async screenshot(caller: DeviceCaller): Promise<DeviceScreenshot> {
    const device = await this.leasedDevice(caller.paneId);
    const folder = path.join(this.options.root, 'screenshots');
    mkdirSync(folder, { recursive: true });
    const file = path.join(folder, `${caller.paneId}-${this.now()}.png`);
    const result = await this.agentDevice(caller.paneId, device, ['screenshot', file, '--json']);
    const shot: DeviceScreenshot = { path: file };
    const size = parseAgentDeviceJson(result.stdout, screenshotDataSchema);
    if (size?.width !== undefined) shot.width = size.width;
    if (size?.height !== undefined) shot.height = size.height;
    return shot;
  }

  async act(caller: DeviceCaller, args: readonly string[]): Promise<{ exitCode: number; output: string }> {
    if (args.length === 0) throw new PaneError('ERR_DEVICE_ACT_EMPTY', 'device_act needs an agent-device command, such as ["snapshot", "-i"].', 'Pass the command as args.');
    refuseRetarget(args);
    const device = await this.leasedDevice(caller.paneId);
    const result = await runAgentDevice(this.paths().agentDevice, args, this.target(caller.paneId, device), { node: this.node, stateDir: this.stateDir() });
    return { exitCode: result.code, output: `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`.trim() };
  }

  /** Runs `command` for `owner` in `cwd`: the worktree here, or a synced checkout on a Mac. */
  run(owner: string, command: string, cwd: string, options: { background: boolean; waitMs: number }): Promise<DeviceJobResult> {
    return this.jobs.start(owner, command, cwd, options.background ? Math.min(options.waitMs, 5_000) : options.waitMs);
  }

  async close(caller: DeviceCaller): Promise<{ closed: string[]; jobsStopped: number }> {
    const ids = this.lifecycle.leasesOf(caller.paneId);
    const devices = ids.length > 0 ? await this.devices() : [];
    for (const id of ids) {
      const device = devices.find(candidate => candidate.id === id);
      if (device) await this.agentDevice(caller.paneId, device, ['close']).catch(() => undefined);
      this.lifecycle.release(caller.paneId, id);
      this.options.onChange?.({ kind: 'released', id, paneId: caller.paneId, reason: 'closed' });
    }
    const jobsStopped = await this.jobs.stopAll(caller.paneId);
    this.scheduleSweep();
    return { closed: ids, jobsStopped };
  }

  /** The person pressed Take over in `paneId`'s device tab. */
  async takeOver(caller: DeviceCaller, id: string): Promise<void> {
    const previous = this.lifecycle.holderOf(id);
    if (previous && previous !== caller.paneId) {
      const device = (await this.devices()).find(candidate => candidate.id === id);
      if (device) await this.agentDevice(previous, device, ['close']).catch(() => undefined);
    }
    this.lifecycle.takeOver(caller.paneId, id);
    if (previous && previous !== caller.paneId) this.options.onChange?.({ kind: 'released', id, paneId: previous, reason: 'taken' });
    const held: DeviceChange = { kind: 'held', id, paneId: caller.paneId };
    if (previous) held.previous = previous;
    this.options.onChange?.(held);
  }

  /** A Pane was archived: its jobs stop, its leases end, and devices only it used are erased. */
  async paneArchived(paneId: string): Promise<void> {
    await this.jobs.stopAll(paneId);
    if (!this.hub && this.lifecycle.leasesOf(paneId).length === 0 && !this.hasUser(paneId)) return;
    const devices = await this.devices();
    const { erase, ended } = this.lifecycle.archived(paneId, devices);
    for (const lease of ended) this.options.onChange?.({ kind: 'released', id: lease.id, paneId, reason: 'archived' });
    const state = this.readState();
    for (const made of Object.values(state.made)) made.users = made.users.filter(user => user !== paneId);
    this.writeState(state);
    for (const id of erase) {
      const device = devices.find(candidate => candidate.id === id);
      if (device) await this.erase(device).catch((cause) => this.options.log?.(`[devices] erase ${id} failed: ${reasonOf(cause)}`));
    }
    this.scheduleSweep();
  }

  /** Where main reads the device's screen and sends input. The token never leaves main. */
  async stream(id: string): Promise<DeviceStreamInfo> {
    const hub = await this.ensureHub();
    const device = (await this.devices()).find(candidate => candidate.id === id);
    if (!device) throw new PaneError('ERR_DEVICE_NOT_FOUND', 'That device is gone from this machine.', 'Open a device again with device_open.');
    const base = `127.0.0.1:${hub.port}`;
    if (device.platform === 'ios') {
      return {
        streamUrl: `http://${base}/vendor/serve-sim/helper/${encodeURIComponent(id)}/stream.mjpeg`,
        inputUrl: `ws://${base}/vendor/serve-sim/helper/ws?device=${encodeURIComponent(id)}`,
        token: hub.token,
      };
    }
    const serial = device.serial ?? id;
    return {
      streamUrl: `http://${base}/vendor/serve-emu/${encodeURIComponent(serial)}/stream.mjpeg`,
      inputUrl: `ws://${base}/vendor/serve-emu/${encodeURIComponent(serial)}/ws`,
      token: hub.token,
    };
  }

  /** The device's live MJPEG stream; the caller cancels it with `signal`. */
  async openStream(id: string, signal: AbortSignal): Promise<Response> {
    const { streamUrl, token } = await this.stream(id);
    return fetch(streamUrl, { signal, headers: { Authorization: `Bearer ${token}` } });
  }

  /** The newest frame: live while the device is booted, else the last one Pane read. */
  async latestFrame(id: string): Promise<Buffer> {
    const cached = this.lastFrames.get(id);
    const device = this.hub ? (await this.devices()).find(candidate => candidate.id === id) : undefined;
    if (device?.booted) return this.frame(id).catch((cause) => { if (cached) return cached; throw cause; });
    if (cached) return cached;
    throw new PaneError('ERR_DEVICE_OFF', 'This device is shut down and Pane has no earlier frame of it.', 'Boot it from the device tab.');
  }

  /** One JPEG frame of the device's screen, read from the hub's MJPEG stream. */
  async frame(id: string): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await this.openStream(id, controller.signal);
      if (!response.ok || !response.body) throw new Error(`the stream answered ${response.status}`);
      const reader = response.body.getReader();
      let buffered = Buffer.alloc(0);
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered = Buffer.concat([buffered, Buffer.from(value)]);
        const start = buffered.indexOf(JPEG_START);
        const end = start === -1 ? -1 : buffered.indexOf(JPEG_END, start + 2);
        if (end !== -1) {
          await reader.cancel().catch(() => undefined);
          const jpeg = Buffer.from(buffered.subarray(start, end + 2));
          this.lastFrames.set(id, jpeg);
          return jpeg;
        }
        if (buffered.length > 16 * 1024 * 1024) break;
      }
      throw new Error('the stream ended before a whole frame');
    } catch (cause) {
      throw new PaneError('ERR_DEVICE_FRAME', `Pane could not read a frame of the device's screen: ${reasonOf(cause)}.`, 'Try again in a moment; a booting device has no screen yet.');
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  /** Usage for machine health: Pane's devices, booted devices, helper memory and checkouts. */
  async usage(checkouts: () => { path: string; bytes: number }[] = () => []): Promise<DeviceUsage> {
    const capabilities = await this.probe();
    const running = this.hub !== undefined;
    const devices = running || this.hasMadeDevices() ? await this.devices() : [];
    const hub = running ? await this.hub : undefined;
    const report: DeviceUsage = {
      machine: this.options.machineName(),
      devices: await Promise.all(devices.filter(device => device.paneMade || device.booted).map(device => this.deviceUsage(device, capabilities))),
      helpers: hub?.pid ? [{ name: 'expo-device-hub', pid: hub.pid, memoryBytes: await processMemory(hub.pid) }] : [],
      checkouts: checkouts(),
      slimSim: capabilities.simslim !== undefined,
    };
    return report;
  }

  private async deviceUsage(device: HubDevice, capabilities: DeviceCapabilities): Promise<DeviceUsage['devices'][number]> {
    const usage: DeviceUsage['devices'][number] = { id: device.id, platform: device.platform, name: device.name, paneMade: device.paneMade, booted: device.booted };
    const holder = this.lifecycle.holderOf(device.id);
    if (holder) usage.heldBy = holder;
    if (device.lastUsedAt) usage.lastUsedAt = new Date(device.lastUsedAt).toISOString();
    if (device.platform === 'ios') {
      if (device.booted) usage.memoryBytes = await iosMemory(device.id, capabilities.simslim);
      usage.diskBytes = await folderBytes(path.join(this.options.probeEnvironment().home, 'Library', 'Developer', 'CoreSimulator', 'Devices', device.id));
    }
    return usage;
  }

  /** Shuts down unleased devices (`idle`), or also erases and deletes Pane's unleased devices (`all`). */
  async free(mode: 'idle' | 'all'): Promise<{ shutdown: string[]; deleted: string[] }> {
    if (!this.hub && !this.hasMadeDevices()) return { shutdown: [], deleted: [] };
    const devices = await this.devices();
    const unleased = devices.filter(device => device.paneMade && !this.lifecycle.holderOf(device.id));
    const shutdown: string[] = [];
    for (const device of unleased.filter(candidate => candidate.booted)) {
      await this.shutdown(device).catch(() => undefined);
      shutdown.push(device.id);
    }
    const deleted: string[] = [];
    if (mode === 'all') {
      for (const device of unleased.filter(candidate => candidate.paneMade)) {
        await this.remove({ ...device, booted: false }).catch(() => undefined);
        deleted.push(device.id);
      }
    }
    await this.stopIfIdle();
    return { shutdown, deleted };
  }

  /** Runs the lifecycle: idle leases, warm windows, stale devices, and stopping the helpers. */
  async sweep(): Promise<void> {
    const devices = await this.devices();
    const { ended, shutdown } = this.lifecycle.sweep(devices);
    for (const lease of ended) {
      const device = devices.find(candidate => candidate.id === lease.id);
      if (device) await this.agentDevice(lease.paneId, device, ['close']).catch(() => undefined);
      this.options.onChange?.({ kind: 'released', id: lease.id, paneId: lease.paneId, reason: 'idle' });
    }
    for (const id of shutdown) {
      const device = devices.find(candidate => candidate.id === id);
      if (device) await this.shutdown(device).catch((cause) => this.options.log?.(`[devices] shutdown ${id} failed: ${reasonOf(cause)}`));
    }
    for (const id of this.lifecycle.stale(devices)) {
      const device = devices.find(candidate => candidate.id === id);
      if (device) await this.remove(device).catch(() => undefined);
    }
    await this.stopIfIdle();
  }

  async dispose(): Promise<void> {
    for (const owner of new Set(this.jobs.running().map(job => job.owner))) await this.jobs.stopAll(owner);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    await this.stopHelpers();
  }

  // ---- internals

  private async leasedDevice(paneId: string): Promise<HubDevice> {
    const id = this.held(paneId);
    this.lifecycle.touch(paneId);
    this.markUsed(id, paneId);
    const device = (await this.devices()).find(candidate => candidate.id === id);
    if (!device) throw new PaneError('ERR_DEVICE_NOT_FOUND', 'The device this Pane opened is gone from this machine.', 'Call device_open again.');
    if (!device.booted) throw new PaneError('ERR_DEVICE_OFF', `${device.name} is shut down.`, 'Call device_open to boot it again.');
    return device;
  }

  private target(paneId: string, device: HubDevice) {
    return { session: `pane-${paneId}`, platform: device.platform, id: device.platform === 'android' ? device.serial ?? device.id : device.id };
  }

  private async agentDevice(paneId: string, device: HubDevice, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const result = await runAgentDevice(this.paths().agentDevice, args, this.target(paneId, device), { node: this.node, stateDir: this.stateDir() });
    if (result.code !== 0 && args[0] !== 'close') {
      const failure = parseAgentDeviceError(result.stdout) ?? (result.stderr.trim() || `exit code ${result.code}`);
      throw new PaneError('ERR_DEVICE_AGENT_DEVICE', `agent-device ${args[0]} failed on ${device.name}: ${failure}`, 'Try again; device_act passes any agent-device command through if you need its diagnostics.');
    }
    return result;
  }

  private paths() {
    const paths = this.helpers.installed();
    if (!paths) throw new PaneError('ERR_DEVICE_NOT_INSTALLED', 'Pane\'s device tools are not installed on this machine yet.', 'Call device_open; it installs them.');
    return paths;
  }

  private stateDir(): string {
    return path.join(this.options.root, 'agent-device');
  }

  private ensureHub(onInstall?: () => void): Promise<RunningHub> {
    this.hub ??= (async () => {
      const paths = await this.helpers.ensure(() => { onInstall?.(); this.options.onInstall?.(); });
      const capabilities = await this.probe();
      const env: NodeJS.ProcessEnv = {};
      if (capabilities.android.ready) {
        env.ANDROID_HOME = capabilities.android.sdk;
        env.ANDROID_SDK_ROOT = capabilities.android.sdk;
      }
      return startHub(paths.hub, { node: this.node, env, onExit: () => { this.hub = undefined; } });
    })().catch((cause) => { this.hub = undefined; throw cause; });
    return this.hub;
  }

  private async devices(onInstall?: () => void): Promise<HubDevice[]> {
    const hub = await this.ensureHub(onInstall);
    const response = await hub.request('/api/devices');
    if (!response.ok) throw new PaneError('ERR_DEVICE_HUB_FAILED', `Pane's device hub answered ${response.status} when listing devices.`, 'Try again.');
    const listed = decodeBoundary(await response.json(), hubDevicesSchema);
    const made = this.readState().made;
    const record = (platform: DevicePlatform, entry: { id: string; name: string; version?: string; booted: boolean; serial?: string }): HubDevice => {
      const mine = made[entry.id];
      const device: HubDevice = { id: entry.id, platform, name: entry.name, os: entry.version ?? '', paneMade: mine !== undefined, booted: entry.booted };
      if (mine) device.lastUsedAt = mine.lastUsedAt;
      if (mine?.model) device.model = mine.model;
      if (entry.serial) device.serial = entry.serial;
      return device;
    };
    return [
      ...listed.simulators.filter(entry => !entry.physical).map(entry => record('ios', entry)),
      ...listed.emulators.map(entry => record('android', entry)),
    ];
  }

  private summary(device: HubDevice): DeviceSummary {
    const holder = this.lifecycle.holderOf(device.id);
    const summary: DeviceSummary = {
      id: device.id,
      platform: device.platform,
      // Pane's own devices go by their model ("iPhone 17 Pro"); the person's by their name.
      name: device.model ?? device.name,
      os: device.os,
      machine: this.options.machineLabel?.() ?? this.options.machineName(),
      state: device.booted ? 'booted' : 'shutdown',
      paneMade: device.paneMade,
    };
    if (holder) summary.heldBy = { paneId: holder, paneName: this.options.paneName(holder) };
    return summary;
  }

  private async shutdown(device: HubDevice): Promise<void> {
    const hub = await this.ensureHub();
    // Keep its last screen for the tab's off state and the chat card.
    await this.frame(device.id).catch(() => undefined);
    await hub.request('/api/devices/shutdown', { platform: device.platform, id: device.serial ?? device.id, name: device.name });
    this.options.onChange?.({ kind: 'shutdown', id: device.id });
  }

  private async erase(device: HubDevice): Promise<void> {
    if (device.booted) await this.shutdown(device);
    if (device.platform === 'ios') {
      const capabilities = await this.probe();
      if (capabilities.ios.ready) await execFileAsync(capabilities.ios.xcrun, ['simctl', 'erase', device.id], { timeout: 120_000 });
    } else {
      // The AVD's data is wiped at its next boot.
      const avd = path.join(this.options.probeEnvironment().home, '.android', 'avd', `${device.name}.avd`);
      for (const file of ['userdata-qemu.img', 'userdata-qemu.img.qcow2', 'snapshots']) rmSync(path.join(avd, file), { recursive: true, force: true });
    }
    const state = this.readState();
    if (state.made[device.id]) {
      state.made[device.id].slimmed = false;
      this.writeState(state);
    }
  }

  private async remove(device: HubDevice): Promise<void> {
    const hub = await this.ensureHub();
    if (device.booted) await this.shutdown(device);
    await hub.request('/api/devices/remove', { platform: device.platform, id: device.id, name: device.name });
    const state = this.readState();
    delete state.made[device.id];
    this.writeState(state);
  }

  private scheduleSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      this.sweep().catch((cause) => this.options.log?.(`[devices] sweep failed: ${reasonOf(cause)}`));
    }, SWEEP_MS);
    this.sweepTimer.unref();
  }

  /** With nothing booted and nothing held, the helpers and the timer stop. */
  private async stopIfIdle(): Promise<void> {
    if (!this.hub || this.lifecycle.active() || this.jobs.running().length > 0) return;
    const devices = await this.devices();
    if (devices.some(device => device.booted && (device.paneMade || this.lifecycle.holderOf(device.id)))) return;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    await this.stopHelpers();
  }

  private async stopHelpers(): Promise<void> {
    const hub = this.hub;
    this.hub = undefined;
    if (hub) await (await hub.catch(() => undefined))?.stop();
    // agent-device's daemon keeps its pid in its state folder.
    const daemon = path.join(this.stateDir(), 'daemon.json');
    if (existsSync(daemon)) {
      try {
        const { pid } = decodeBoundary(JSON.parse(readFileSync(daemon, 'utf8')), boundary.object({ pid: boundary.number }));
        process.kill(pid, 'SIGTERM');
      } catch { /* not running */ }
    }
  }

  private markUsed(id: string, paneId: string): void {
    const state = this.readState();
    const made = state.made[id];
    if (!made) return;
    made.lastUsedAt = this.now();
    if (!made.users.includes(paneId)) made.users.push(paneId);
    this.writeState(state);
  }

  private hasMadeDevices(): boolean {
    return Object.keys(this.readState().made).length > 0;
  }

  private hasUser(paneId: string): boolean {
    return Object.values(this.readState().made).some(made => made.users.includes(paneId));
  }

  private statePath(): string {
    return path.join(this.options.root, 'state.json');
  }

  private readState(): DeviceState {
    try {
      const { made } = decodeBoundary(JSON.parse(readFileSync(this.statePath(), 'utf8')), stateSchema);
      return { made: Object.fromEntries(Object.entries(made).map(([id, device]) => [id, { ...device, users: [...device.users] }])) };
    } catch {
      return { made: {} };
    }
  }

  private writeState(state: DeviceState): void {
    mkdirSync(this.options.root, { recursive: true });
    const temporary = `${this.statePath()}.tmp`;
    writeFileSync(temporary, JSON.stringify(state, null, 2));
    renameSync(temporary, this.statePath());
  }
}

export interface DeviceScreenshot { path: string; width?: number; height?: number }

export interface DeviceUsage {
  machine: string;
  devices: { id: string; platform: DevicePlatform; name: string; paneMade: boolean; booted: boolean; heldBy?: string; lastUsedAt?: string; memoryBytes?: number; diskBytes?: number }[];
  helpers: { name: string; pid: number; memoryBytes: number }[];
  checkouts: { path: string; bytes: number }[];
  slimSim: boolean;
}

function pickModel<Model extends { value: string; label: string; supported?: boolean }>(platform: DevicePlatform, models: Model[]): Model | undefined {
  const usable = models.filter(model => model.supported !== false);
  if (platform === 'ios') return usable.find(model => /iPhone \d+ Pro$/.test(model.label)) ?? usable.find(model => model.label.startsWith('iPhone')) ?? usable[0];
  return usable.find(model => /pixel/i.test(model.label)) ?? usable[0];
}

const screenshotDataSchema = boundary.object({ width: boundary.optional(boundary.number), height: boundary.optional(boundary.number) });
const agentDeviceErrorSchema = boundary.object({ message: boundary.string, code: boundary.optional(boundary.string) });

/** The `data` of agent-device's `--json` output, when it matches `schema`. */
function parseAgentDeviceJson<Data>(stdout: string, schema: BoundarySchema<Data>): Data | undefined {
  try {
    return decodeOptionalBoundary(JSON.parse(stdout), boundary.object({ data: schema }))?.data;
  } catch {
    return undefined;
  }
}

function parseAgentDeviceError(stdout: string): string | undefined {
  try {
    const error = decodeOptionalBoundary(JSON.parse(stdout), boundary.object({ error: agentDeviceErrorSchema }))?.error;
    return error ? `${error.message}${error.code ? ` (${error.code})` : ''}` : undefined;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processMemory(pid: number): Promise<number> {
  if (process.platform === 'win32') return 0;
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)]);
    return Number(stdout.trim()) * 1024 || 0;
  } catch {
    return 0;
  }
}

/** A booted simulator's memory: simslim measure when present, else its launchd_sim process tree. */
async function iosMemory(udid: string, simslim: string | undefined): Promise<number> {
  if (simslim) {
    try {
      const { stdout } = await execFileAsync(simslim, ['measure', udid, '--json'], { timeout: 60_000 });
      // simslim measure --json: { processes, bytes, cpu } (phys_footprint of the simulator's processes).
      const measured = decodeOptionalBoundary(JSON.parse(stdout), boundary.object({ bytes: boundary.number }));
      if (measured) return measured.bytes;
    } catch { /* fall through */ }
  }
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'rss=,command=']);
    return stdout.split('\n').filter(line => line.includes(udid)).reduce((sum, line) => sum + (Number(line.trim().split(/\s+/)[0]) || 0) * 1024, 0);
  } catch {
    return 0;
  }
}

async function folderBytes(folder: string): Promise<number> {
  if (process.platform === 'win32' || !existsSync(folder)) return 0;
  try {
    const { stdout } = await execFileAsync('du', ['-sk', folder], { timeout: 60_000 });
    return (Number(stdout.trim().split(/\s+/)[0]) || 0) * 1024;
  } catch {
    return 0;
  }
}
