import { execFile } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { lstat, readdir } from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { PaneError, reasonOf } from '../../../../shared/paneError';
import type { DevicePlatform, DeviceStreamInfo, DeviceSummary } from '../../../../shared/types/devices';
import { boundary, decodeBoundary, decodeOptionalBoundary, type BoundarySchema } from '../../../../shared/validation/boundaryDecoder';
import { DeviceHelpers, paneNode, refuseRetarget, runAgentDevice, startHub, type NodeRunner, type RunningHub } from './deviceHelpers';
import { DeviceJobs, type DeviceJobResult } from './deviceJobs';
import { DeviceLifecycle, type DeviceRecord } from './deviceLifecycle';
import { probeDevices, type DeviceCapabilities, type ProbeEnvironment } from './deviceProbe';
import { getShellPath } from '../../utils/shellPath';

const execFileAsync = promisify(execFile);

const BUSY_WAIT_MS = 60_000;
const SWEEP_MS = 30_000;
const SHUTDOWN_WAIT_MS = 60_000;
const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);
/** How long a device listing answers the device tab's frequent lookups. */
const RECENT_LISTING_MS = 5_000;
const PANE_DEVICE_NAMES = { ios: 'Pane iPhone', android: 'Pane_Android' } satisfies Record<DevicePlatform, string>;

/** A Pane-made device, as the state file keeps it. */
interface MadeDevice { platform: DevicePlatform; name: string; model?: string; createdAt: number; lastUsedAt: number; users: string[]; slimmed?: boolean; lastPane?: string }
const stateSchema = boundary.object({
  made: boundary.record(boundary.object({
    platform: boundary.enumeration('ios', 'android'),
    name: boundary.string,
    model: boundary.optional(boundary.string),
    createdAt: boundary.number,
    lastUsedAt: boundary.number,
    users: boundary.array(boundary.string),
    slimmed: boundary.optional(boundary.boolean),
    lastPane: boundary.optional(boundary.string),
  })),
});

/** The devices state file: Pane-made devices, who used them and when. */
interface DeviceState { made: Record<string, MadeDevice> }

/** The hub's device list entries Pane reads. */
const simctlDevicesSchema = boundary.object({ devices: boundary.record(boundary.array(boundary.object({ udid: boundary.string, name: boundary.string, state: boundary.string, isAvailable: boundary.optional(boundary.boolean) }))) });

/** The hub's answer to boot, shutdown and remove. */
const hubActionSchema = boundary.object({ ok: boundary.boolean, errors: boundary.optional(boundary.array(boundary.object({ message: boundary.optional(boundary.string) }))) });

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
  /** The emulator serve-emu acts on; it acts on one selected emulator at a time. */
  private selectedEmulator?: string;
  /** The last frame read of each device, kept for its off and closed states. */
  private readonly lastFrames = new Map<string, Buffer>();
  private listed?: { at: number; devices: Promise<HubDevice[]> };
  /** The platform each Pane opened last: calls without a platform act on it. */
  private readonly lastOpened = new Map<string, DevicePlatform>();
  /** The pick-and-lease in progress for each platform. */
  private readonly picking = new Map<DevicePlatform, Promise<void>>();

  constructor(private readonly options: DeviceServiceOptions) {
    this.now = options.now ?? Date.now;
    this.node = options.node ?? paneNode();
    this.helpers = new DeviceHelpers({ root: options.root, findExecutable: options.findExecutable, machineName: options.machineName });
    this.lifecycle = new DeviceLifecycle({ now: this.now, cap: () => Math.min(4, Math.max(1, options.maxBooted())) });
    this.jobs = new DeviceJobs({ shell: () => process.platform === 'win32' ? { executable: 'cmd.exe', args: (command) => ['/d', '/s', '/c', `"${command}"`], verbatim: true } : { executable: process.env.SHELL || '/bin/sh', args: (command) => ['-lc', command] } });
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
    return (await this.devices({ inventory: true })).map(device => this.summary(device));
  }

  /** Leases and boots a device for `caller`, waiting up to `BUSY_WAIT_MS` when every one is held. */
  async open(caller: DeviceCaller, request: { platform: DevicePlatform; device?: string }, onPhase?: (phase: 'installing' | 'booting') => void): Promise<DeviceOpenResult> {
    const capabilities = await this.probe();
    this.requireReady(capabilities, request.platform);
    const deadline = this.now() + BUSY_WAIT_MS;
    let leased: { chosen: HubDevice; fresh: boolean } | undefined;
    while (!leased) {
      // One Pane at a time picks and leases per platform, so two opens never both create or both take the last slot.
      leased = await this.oneAtATime(request.platform, async () => {
        const devices = await this.devices({ inventory: true, onInstall: () => onPhase?.('installing') });
        const chosen = request.device ? this.named(devices, request) : await this.choose(caller, request.platform, devices, deadline);
        if (!chosen) return undefined;
        const holder = this.lifecycle.holderOf(chosen.id);
        if (holder && holder !== caller.paneId) {
          if (this.now() < deadline) return undefined;
          throw this.busy(chosen, holder);
        }
        if (holder === caller.paneId) return { chosen, fresh: false };
        this.lifecycle.lease(caller.paneId, chosen.id, chosen.platform, { bootedByPane: !chosen.booted && !chosen.paneMade });
        this.options.onChange?.({ kind: 'held', id: chosen.id, paneId: caller.paneId });
        return { chosen, fresh: true };
      });
      if (!leased) await sleep(2_000);
    }
    const { chosen, fresh } = leased;
    this.scheduleSweep();
    try {
      const previousPane = this.markUsed(chosen.id, caller.paneId);
      const booting = !chosen.booted || this.needsSlim(chosen, capabilities);
      if (booting) {
        onPhase?.('booting');
        await this.boot(chosen, capabilities);
      }
      // A pooled device moves between Panes: the next Pane gets it without the last one's apps (D-84).
      if (previousPane && previousPane !== caller.paneId) {
        await this.wipeApps(chosen, capabilities).catch((cause) => this.options.log?.(`[devices] clearing apps on ${chosen.id} failed: ${reasonOf(cause)}`));
      }
      // agent-device's session for this Pane: started on a new lease or boot, kept on a repeat open.
      if (fresh || booting) await this.openSession(caller.paneId, chosen);
    } catch (cause) {
      // A device that did not start is not held, so other Panes can open it.
      if (fresh) {
        this.lifecycle.release(caller.paneId, chosen.id);
        this.options.onChange?.({ kind: 'released', id: chosen.id, paneId: caller.paneId, reason: 'closed' });
      }
      throw cause;
    }
    this.lastOpened.set(caller.paneId, request.platform);
    return { device: this.summary({ ...chosen, booted: true }) };
  }

  /** Runs `work` after every earlier call for `platform` has finished. */
  private oneAtATime<Result>(platform: DevicePlatform, work: () => Promise<Result>): Promise<Result> {
    const result = (this.picking.get(platform) ?? Promise.resolve()).then(work);
    this.picking.set(platform, result.then(() => undefined, () => undefined));
    return result;
  }

  /** The device to lease, undefined to wait and pick again, or a busy error once the wait is over. */
  private async choose(caller: DeviceCaller, platform: DevicePlatform, devices: HubDevice[], deadline: number): Promise<HubDevice | undefined> {
    const pick = this.lifecycle.pick(caller.paneId, platform, devices);
    if (pick.kind === 'device') return devices.find(device => device.id === pick.id);
    if (pick.kind === 'create') return this.create(platform, devices);
    if (this.now() >= deadline) throw this.busy(devices.find(device => device.id === pick.id) ?? { id: pick.id, name: PANE_DEVICE_NAMES[platform] }, pick.holder);
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

  private async create(platform: DevicePlatform, devices: readonly HubDevice[]): Promise<HubDevice> {
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
          : `${this.options.machineName()} has no Android system image, so Pane cannot make an emulator. Nothing was created.`,
        platform === 'ios'
          ? 'Add an iOS runtime in Xcode > Settings > Components, then try again.'
          : 'In Android Studio, open SDK Manager and install a system image. Or name one of your own emulators with device.',
      );
    }
    // The pool's devices: "Pane iPhone", then "Pane iPhone 2" when the cap allows more at once.
    const taken = new Set([...Object.values(this.readState().made).map(made => made.name), ...devices.map(device => device.name)]);
    const nameFor = (index: number) => index === 1 ? PANE_DEVICE_NAMES[platform] : `${PANE_DEVICE_NAMES[platform]}${platform === 'ios' ? ' ' : '_'}${index}`;
    let index = 1;
    while (taken.has(nameFor(index))) index += 1;
    const name = nameFor(index);
    const created = decodeBoundary(await (await hub.request('/api/devices/create', { platform, name, runtime: runtime.value, deviceType: model.value })).json(), boundary.object({ ok: boundary.boolean, id: boundary.optional(boundary.string), error: boundary.optional(boundary.string) }));
    // The hub answers an emulator's serial once it boots; Pane keys emulators by AVD name.
    const id = !created.ok ? undefined : platform === 'android' ? name : created.id;
    if (!id) throw new PaneError('ERR_DEVICE_CREATE_FAILED', `Pane could not make ${name}: ${created.error ?? 'the hub gave no reason'}. Nothing was opened.`, 'Try again; if it repeats, check that Xcode or Android Studio can create a device.');
    const state = this.readState();
    state.made[id] = { platform, name, model: model.label, createdAt: this.now(), lastUsedAt: this.now(), users: [], slimmed: false };
    this.writeState(state);
    const device = (await this.devices({ inventory: true })).find(candidate => candidate.platform === platform && candidate.id === id);
    if (!device) throw new PaneError('ERR_DEVICE_CREATE_FAILED', `Pane made ${name} but cannot find it on this machine.`, 'Try again.');
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
    // Without a platform, the device this Pane opened last.
    const id = platform ? this.lifecycle.leaseOf(paneId, platform) : this.lifecycle.leaseOf(paneId, this.lastOpened.get(paneId)) ?? this.lifecycle.leaseOf(paneId);
    if (!id) {
      throw new PaneError('ERR_DEVICE_NOT_OPEN', `This Pane has no ${platform === 'ios' ? 'iOS ' : platform === 'android' ? 'Android ' : ''}device open, so there is nothing to act on.`, platform ? `Call device_open with platform ${platform} first.` : 'Call device_open first.');
    }
    return id;
  }

  async screenshot(caller: DeviceCaller, platform?: DevicePlatform): Promise<DeviceScreenshot> {
    const device = await this.leasedDevice(caller.paneId, platform);
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

  async act(caller: DeviceCaller, args: readonly string[], platform?: DevicePlatform): Promise<{ exitCode: number; output: string }> {
    if (args.length === 0) throw new PaneError('ERR_DEVICE_ACT_EMPTY', 'device_act needs an agent-device command, such as ["snapshot", "-i"].', 'Pass the command as args.');
    refuseRetarget(args);
    const device = await this.leasedDevice(caller.paneId, platform);
    const result = await runAgentDevice(this.paths().agentDevice, args, this.target(caller.paneId, device), { node: this.node, stateDir: this.stateDir() });
    return { exitCode: result.code, output: `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`.trim() };
  }

  /** Runs `command` for `owner` in `cwd`: the worktree here, or a synced checkout on a Mac. */
  run(owner: string, command: string, cwd: string, options: { background: boolean; waitMs: number }): Promise<DeviceJobResult> {
    // A build is use of the device; the sweep also counts a running job as use.
    this.lifecycle.touch(owner);
    // The PATH an agent tab gets: a login shell alone misses Node set up in .zshrc (nvm) when Pane starts from Finder.
    return this.jobs.start(owner, command, cwd, options.background ? Math.min(options.waitMs, 5_000) : options.waitMs, { PATH: process.platform === 'linux' ? (process.env.PATH ?? '') : getShellPath() });
  }

  /** Ends the Pane's lease on `platform`'s device, or on all of them; its jobs stop with its last lease. */
  async close(caller: DeviceCaller, platform?: DevicePlatform): Promise<{ closed: string[]; jobsStopped: number }> {
    const one = platform ? this.lifecycle.leaseOf(caller.paneId, platform) : undefined;
    const ids = platform ? (one ? [one] : []) : this.lifecycle.leasesOf(caller.paneId);
    const devices = ids.length > 0 ? await this.devices() : [];
    for (const id of ids) {
      const device = devices.find(candidate => candidate.id === id);
      if (device) await this.agentDevice(caller.paneId, device, ['close']).catch(() => undefined);
      this.lifecycle.release(caller.paneId, id);
      this.options.onChange?.({ kind: 'released', id, paneId: caller.paneId, reason: 'closed' });
    }
    const jobsStopped = this.lifecycle.leasesOf(caller.paneId).length === 0 ? await this.jobs.stopAll(caller.paneId) : 0;
    if (ids.length > 0) this.scheduleSweep();
    return { closed: ids, jobsStopped };
  }

  /** The person pressed Take over in `paneId`'s device tab. */
  async takeOver(caller: DeviceCaller, id: string, platform: DevicePlatform): Promise<void> {
    const previous = this.lifecycle.holderOf(id);
    if (previous && previous !== caller.paneId) {
      const device = (await this.devices()).find(candidate => candidate.id === id);
      if (device) await this.agentDevice(previous, device, ['close']).catch(() => undefined);
    }
    this.lifecycle.takeOver(caller.paneId, id, platform);
    if (previous && previous !== caller.paneId) this.options.onChange?.({ kind: 'released', id, paneId: previous, reason: 'taken' });
    const held: DeviceChange = { kind: 'held', id, paneId: caller.paneId };
    if (previous) held.previous = previous;
    this.options.onChange?.(held);
  }

  /** A Pane was archived: its jobs stop, its leases end, and devices only it used are erased. */
  async paneArchived(paneId: string): Promise<void> {
    await this.jobs.stopAll(paneId);
    if (!this.hub && this.lifecycle.leasesOf(paneId).length === 0 && !this.hasUser(paneId)) return;
    const devices = await this.devices({ inventory: true });
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
    const device = await this.recentDevice(id);
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

  /** An Android emulator's REST call on the hub (serve-emu), after selecting that emulator; a GET when `body` is undefined. */
  async emulatorCall(id: string, route: 'screenshot' | 'tap' | 'swipe' | 'key' | 'text' | 'orientation' | 'fold', body?: EmulatorRequest): Promise<Response> {
    const hub = await this.ensureHub();
    const found = await this.recentDevice(id);
    const device = found?.platform === 'android' ? found : undefined;
    if (!device?.serial) throw new PaneError('ERR_DEVICE_OFF', 'That emulator is not running.', 'Boot it from the device tab or with device_open.');
    if (this.selectedEmulator !== device.serial) {
      await hub.post('/vendor/serve-emu/api/devices/select', { serial: device.serial });
      this.selectedEmulator = device.serial;
    }
    return body === undefined ? hub.request(`/vendor/serve-emu/api/${route}`) : hub.post(`/vendor/serve-emu/api/${route}`, body);
  }

  /** One frame of the device's screen: JPEG from an iOS simulator's MJPEG stream, PNG from an emulator. */
  async frame(id: string): Promise<Buffer> {
    if ((await this.devices()).find(candidate => candidate.id === id)?.platform === 'android') {
      const response = await this.emulatorCall(id, 'screenshot', {});
      if (!response.ok) throw new PaneError('ERR_DEVICE_FRAME', `The emulator's screenshot failed with HTTP ${response.status}.`, 'Try again in a moment.');
      const png = Buffer.from(await response.arrayBuffer());
      this.lastFrames.set(id, png);
      return png;
    }
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

  /** Usage for machine health: every device, the runtimes they come from, helper memory and Pane's build checkouts. */
  async usage(): Promise<DeviceUsage> {
    const capabilities = await this.probe();
    const running = this.hub !== undefined;
    const devices = running || this.hasMadeDevices() ? await this.devices({ inventory: true }) : await this.machineDevices().then(entries => entries.map(entry => ({ id: entry.id, platform: entry.platform, name: entry.name, os: entry.version ?? '', paneMade: false, booted: entry.booted }))).catch(() => []);
    const hub = running ? await this.hub : undefined;
    const folders = await this.simulatorFolders(capabilities);
    const report: DeviceUsage = {
      machine: this.options.machineName(),
      // Every simulator and emulator here, Pane's and the person's, so machine health sees them all (D-84).
      devices: await Promise.all(devices.map(device => this.deviceUsage(device, capabilities, folders))),
      helpers: hub?.pid ? [{ name: 'expo-device-hub', pid: hub.pid, memoryBytes: await processMemory(hub.pid) }] : [],
      checkouts: await Promise.all(this.checkoutFolders().map(async folder => ({ path: folder, bytes: await folderBytes(folder) }))),
      runtimes: await this.runtimes(capabilities),
      slimSim: capabilities.simslim !== undefined,
    };
    return report;
  }

  private async deviceUsage(device: HubDevice, capabilities: DeviceCapabilities, folders: ReadonlyMap<string, string>): Promise<DeviceUsage['devices'][number]> {
    const usage: DeviceUsage['devices'][number] = { id: device.id, platform: device.platform, name: device.name, os: device.os, paneMade: device.paneMade, booted: device.booted };
    const holder = this.lifecycle.holderOf(device.id);
    if (holder) usage.heldBy = holder;
    if (device.lastUsedAt) usage.lastUsedAt = new Date(device.lastUsedAt).toISOString();
    if (device.platform === 'ios') {
      if (device.booted) usage.memoryBytes = await iosMemory(device.id, capabilities.simslim);
      const folder = folders.get(device.id);
      if (folder) usage.diskBytes = await folderBytes(folder);
    }
    return usage;
  }

  /** Build checkouts linked computers sync to this machine (on a Mac, for iOS). */
  private checkoutFolders(): string[] {
    const root = path.join(this.options.root, 'checkouts');
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(root, entry.name));
  }

  /** The iOS runtimes and Android system images devices are made from. */
  private async runtimes(capabilities: DeviceCapabilities): Promise<DeviceUsage['runtimes']> {
    const found: DeviceUsage['runtimes'] = [];
    if (capabilities.ios.ready) {
      try {
        const { stdout } = await execFileAsync(capabilities.ios.xcrun, ['simctl', 'runtime', 'list', '-j'], { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 });
        const listed = decodeBoundary(JSON.parse(stdout), boundary.record(boundary.object({ version: boundary.string, sizeBytes: boundary.optional(boundary.number), platformIdentifier: boundary.string })));
        for (const runtime of Object.values(listed)) {
          if (!runtime.platformIdentifier.includes('iphone')) continue;
          const entry: DeviceUsage['runtimes'][number] = { platform: 'ios', name: `iOS ${runtime.version}` };
          if (runtime.sizeBytes !== undefined) entry.bytes = runtime.sizeBytes;
          found.push(entry);
        }
      } catch (cause) {
        this.options.log?.(`[devices] listing iOS runtimes failed: ${reasonOf(cause)}`);
      }
    }
    if (capabilities.android.ready) {
      const images = path.join(capabilities.android.sdk, 'system-images');
      if (existsSync(images)) {
        for (const api of readdirSync(images, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
          const folder = path.join(images, api.name);
          found.push({ platform: 'android', name: api.name, bytes: await folderBytes(folder) });
        }
      }
    }
    return found;
  }

  /** Each simulator's folder, from simctl (its dataPath's parent), wherever CoreSimulator keeps it. */
  private async simulatorFolders(capabilities: DeviceCapabilities): Promise<Map<string, string>> {
    if (!capabilities.ios.ready) return new Map();
    const { stdout } = await execFileAsync(capabilities.ios.xcrun, ['simctl', 'list', 'devices', '--json'], { maxBuffer: 16 * 1024 * 1024 });
    const listed = decodeBoundary(JSON.parse(stdout), boundary.object({ devices: boundary.record(boundary.array(boundary.object({ udid: boundary.string, dataPath: boundary.optional(boundary.string) }))) }));
    return new Map(Object.values(listed.devices).flat().flatMap(entry => entry.dataPath ? [[entry.udid, path.dirname(entry.dataPath)] as const] : []));
  }

  /** Shuts one device down now (the device tab's Shut down), ending any lease on it. */
  async shutdownDevice(id: string): Promise<void> {
    const device = (await this.devices()).find(candidate => candidate.id === id);
    if (!device?.booted) return;
    const holder = this.lifecycle.holderOf(id);
    if (holder) {
      await this.agentDevice(holder, device, ['close']).catch(() => undefined);
      this.lifecycle.release(holder, id);
      this.options.onChange?.({ kind: 'released', id, paneId: holder, reason: 'closed' });
    }
    await this.shutdown(device);
    await this.stopIfIdle();
  }

  /**
   * Shuts down unleased devices (`idle`), or also deletes Pane's unleased devices and the build
   * checkouts no Pane holds a device for (`all`), reporting the disk freed.
   */
  async free(mode: 'idle' | 'all'): Promise<{ shutdown: string[]; deleted: string[]; checkouts: string[]; freedBytes: number }> {
    const checkouts: string[] = [];
    let freedBytes = 0;
    if (mode === 'all') {
      // A checkout is `<computer>-<pane>`; the Mac keys that Pane's lease and jobs `<computer>:<pane>`.
      const live = new Set([...this.lifecycle.holders(), ...this.jobs.running().map(job => job.owner)].map(owner => owner.replace(':', '-')));
      for (const folder of this.checkoutFolders()) {
        if (live.has(path.basename(folder))) continue;
        freedBytes += await folderBytes(folder);
        rmSync(folder, { recursive: true, force: true });
        rmSync(`${folder}.bundle`, { force: true });
        checkouts.push(folder);
      }
    }
    if (!this.hub && !this.hasMadeDevices()) return { shutdown: [], deleted: [], checkouts, freedBytes };
    const devices = await this.devices({ inventory: true });
    const unleased = devices.filter(device => device.paneMade && !this.lifecycle.holderOf(device.id));
    const shutdown: string[] = [];
    for (const device of unleased.filter(candidate => candidate.booted)) {
      await this.shutdown(device).catch(() => undefined);
      shutdown.push(device.id);
    }
    const deleted: string[] = [];
    if (mode === 'all') {
      const capabilities = await this.probe();
      const folders = await this.simulatorFolders(capabilities);
      for (const device of unleased.filter(candidate => candidate.paneMade)) {
        try {
          const folder = device.platform === 'ios' ? folders.get(device.id) : path.join(this.options.probeEnvironment().home, '.android', 'avd', `${device.name}.avd`);
          const bytes = folder ? await folderBytes(folder) : 0;
          await this.remove({ ...device, booted: false });
          freedBytes += bytes;
          deleted.push(device.id);
        } catch (cause) {
          this.options.log?.(`[devices] delete ${device.id} failed: ${reasonOf(cause)}`);
        }
      }
    }
    await this.stopIfIdle();
    return { shutdown, deleted, checkouts, freedBytes };
  }

  /** Runs the lifecycle: idle leases, warm windows, stale devices, and stopping the helpers. */
  async sweep(): Promise<void> {
    // A running build or Metro is use of the Pane's device.
    for (const owner of new Set(this.jobs.running().map(job => job.owner))) this.lifecycle.touch(owner);
    const devices = await this.devices({ inventory: true });
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

  private async leasedDevice(paneId: string, platform?: DevicePlatform): Promise<HubDevice> {
    const id = this.held(paneId, platform);
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

  private async openSession(paneId: string, device: HubDevice): Promise<void> {
    try {
      await this.agentDevice(paneId, device, ['open']);
    } catch (cause) {
      // Another Pane's session outlived its lease (this Pane restarted while the daemon kept it):
      // the lease is this Pane's now, so that session closes and this one opens.
      const stale = cause instanceof PaneError ? /in use by session "(pane-[^"]+)"/.exec(cause.message)?.[1] : undefined;
      if (stale && stale !== `pane-${paneId}` && this.lifecycle.holderOf(device.id) === paneId) {
        await runAgentDevice(this.paths().agentDevice, ['close'], { ...this.target(paneId, device), session: stale }, { node: this.node, stateDir: this.stateDir() });
        await this.agentDevice(paneId, device, ['open']);
        return;
      }
      // A session that outlived Pane's own lease (a restart) is the one this Pane would open.
      if (!(cause instanceof PaneError && /Session already active/i.test(cause.message))) throw cause;
    }
  }

  private paths() {
    const paths = this.helpers.installed();
    if (!paths) throw new PaneError('ERR_DEVICE_NOT_INSTALLED', 'Pane\'s device tools are not installed on this machine yet.', 'Call device_open; it installs them.');
    return paths;
  }

  private hubStateDir(): string {
    return path.join(this.options.root, 'hub-state');
  }

  private stateDir(): string {
    return path.join(this.options.root, 'agent-device');
  }

  /**
   * A device from a listing at most a few seconds old: the device tab's controls, logs and frames
   * ask several times a second, and each listing makes the hub ask simctl and adb. A device missing
   * from it (one just booted) is looked up again.
   */
  private async recentDevice(id: string): Promise<HubDevice | undefined> {
    const now = this.now();
    if (!this.listed || now - this.listed.at > RECENT_LISTING_MS) this.listed = { at: now, devices: this.devices() };
    const listing = this.listed;
    const cached = (await listing.devices.catch((cause) => { if (this.listed === listing) this.listed = undefined; throw cause; })).find(candidate => candidate.id === id);
    if (cached) return cached;
    this.listed = { at: this.now(), devices: this.devices() };
    return (await this.listed.devices).find(candidate => candidate.id === id);
  }

  private ensureHub(onInstall?: () => void): Promise<RunningHub> {
    this.hub ??= (async () => {
      const paths = await this.helpers.ensure(() => { onInstall?.(); this.options.onInstall?.(); });
      const capabilities = await this.probe();
      // The hub publishes its port and token to a state file; keep it in Pane's own folder, not the shared temp folder.
      const hubState = this.hubStateDir();
      rmSync(hubState, { recursive: true, force: true });
      mkdirSync(hubState, { recursive: true, mode: 0o700 });
      const env: NodeJS.ProcessEnv = { EXPO_DEVICE_HUB_STATE_DIR: hubState };
      if (capabilities.android.ready) {
        env.ANDROID_HOME = capabilities.android.sdk;
        env.ANDROID_SDK_ROOT = capabilities.android.sdk;
        if (capabilities.android.javaHome) env.JAVA_HOME = capabilities.android.javaHome;
      }
      return startHub(paths.hub, { node: this.node, env, onExit: () => { this.hub = undefined; } });
    })().catch((cause) => { this.hub = undefined; throw cause; });
    return this.hub;
  }

  /**
   * The hub's devices. The hub leaves out devices that have never booted, so `inventory` adds them
   * from the machine's own lists: what usage, free, the sweep and the pool must see (D-84).
   */
  private async devices(options: { inventory?: boolean; onInstall?: () => void } = {}): Promise<HubDevice[]> {
    const hub = await this.ensureHub(options.onInstall);
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
    const devices = [
      ...listed.simulators.filter(entry => !entry.physical).map(entry => record('ios', entry)),
      // The hub lists a running emulator by its serial; Pane keys it by AVD name.
      ...listed.emulators.map(entry => record('android', { ...entry, id: entry.name, serial: entry.serial ?? (entry.id === entry.name ? undefined : entry.id) })),
    ];
    if (!options.inventory) return devices;
    const known = new Set(devices.map(device => `${device.platform}:${device.id}`));
    const machine = await this.machineDevices().catch((cause) => {
      this.options.log?.(`[devices] listing this machine's devices failed: ${reasonOf(cause)}`);
      return [];
    });
    const unlisted = machine.filter(entry => !known.has(`${entry.platform}:${entry.id}`));
    return [...devices, ...unlisted.map(entry => record(entry.platform, entry))];
  }

  /** Every simulator and AVD on this machine, booted or not, from simctl and the emulator. */
  private async machineDevices(): Promise<{ platform: DevicePlatform; id: string; name: string; version?: string; booted: boolean }[]> {
    const capabilities = await this.probe();
    const found: { platform: DevicePlatform; id: string; name: string; version?: string; booted: boolean }[] = [];
    if (capabilities.ios.ready) {
      const { stdout } = await execFileAsync(capabilities.ios.xcrun, ['simctl', 'list', 'devices', '--json'], { maxBuffer: 16 * 1024 * 1024 });
      const listed = decodeBoundary(JSON.parse(stdout), simctlDevicesSchema);
      for (const [runtime, entries] of Object.entries(listed.devices)) {
        // com.apple.CoreSimulator.SimRuntime.iOS-27-0 is "iOS 27.0".
        const version = runtime.split('.').pop()?.replace('-', ' ').replace(/-/g, '.');
        for (const entry of entries) {
          if (entry.isAvailable !== false && version?.startsWith('iOS')) found.push({ platform: 'ios', id: entry.udid, name: entry.name, version, booted: entry.state === 'Booted' });
        }
      }
    }
    if (capabilities.android.ready) {
      const { stdout } = await execFileAsync(capabilities.android.emulator, ['-list-avds'], { timeout: 30_000 });
      for (const name of stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('INFO'))) found.push({ platform: 'android', id: name, name, booted: false });
    }
    return found;
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
    // The hub answers before the device stops; erasing or deleting it earlier fails on locked files.
    const deadline = this.now() + SHUTDOWN_WAIT_MS;
    while ((await this.devices()).some(candidate => candidate.id === device.id && candidate.booted) && this.now() < deadline) {
      await sleep(1_000);
    }
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
    if (device.platform === 'android') {
      // The hub's remove shuts the emulator down by serial first, which fails once it is off.
      await this.deleteAvd(device.name);
    } else {
      const removed = decodeBoundary(await (await hub.request('/api/devices/remove', { platform: device.platform, id: device.id, name: device.name })).json(), hubActionSchema);
      // Keep the record when the delete fails, so the next sweep tries again.
      if (!removed.ok) throw new PaneError('ERR_DEVICE_REMOVE_FAILED', `Pane could not delete ${device.name}: ${removed.errors?.[0]?.message ?? 'the hub gave no reason'}.`, 'Try `runpane devices free --all` again in a minute.');
    }
    const state = this.readState();
    delete state.made[device.id];
    this.writeState(state);
  }

  /** Deletes one of Pane's AVDs with avdmanager (a .bat on Windows, run through cmd). */
  private async deleteAvd(name: string): Promise<void> {
    const capabilities = await this.probe();
    if (!capabilities.android.ready || !/^Pane_Android(_\d+)?$/.test(name)) throw new PaneError('ERR_DEVICE_REMOVE_FAILED', `Pane could not delete ${name}: it deletes only its own emulators, with the Android SDK's avdmanager.`, 'Delete it in Android Studio\'s Device Manager.');
    const env = capabilities.android.javaHome ? { ...process.env, JAVA_HOME: capabilities.android.javaHome } : process.env;
    try {
      if (process.platform === 'win32') await execFileAsync('cmd.exe', ['/d', '/s', '/c', `"${capabilities.android.avdmanager}" delete avd -n ${name}`], { env, timeout: 120_000, windowsVerbatimArguments: true });
      else await execFileAsync(capabilities.android.avdmanager, ['delete', 'avd', '-n', name], { env, timeout: 120_000 });
    } catch (cause) {
      throw new PaneError('ERR_DEVICE_REMOVE_FAILED', `Pane could not delete ${name}: ${reasonOf(cause)}`, 'Try `runpane devices free --all` again in a minute.');
    }
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
    rmSync(this.hubStateDir(), { recursive: true, force: true });
    // agent-device's daemon keeps its pid in its state folder.
    const daemon = path.join(this.stateDir(), 'daemon.json');
    if (existsSync(daemon)) {
      try {
        const { pid } = decodeBoundary(JSON.parse(readFileSync(daemon, 'utf8')), boundary.object({ pid: boundary.number }));
        process.kill(pid, 'SIGTERM');
      } catch { /* not running */ }
    }
  }

  /** Records that `paneId` uses a Pane-made device; returns the Pane that used it last. */
  private markUsed(id: string, paneId: string): string | undefined {
    const state = this.readState();
    const made = state.made[id];
    if (!made) return undefined;
    const previous = made.lastPane;
    made.lastUsedAt = this.now();
    made.lastPane = paneId;
    if (!made.users.includes(paneId)) made.users.push(paneId);
    this.writeState(state);
    return previous;
  }

  /** Uninstalls the apps someone installed on a Pane-made device, keeping the system's; no reboot. */
  private async wipeApps(device: HubDevice, capabilities: DeviceCapabilities): Promise<void> {
    if (device.platform === 'ios') {
      if (!capabilities.ios.ready) return;
      const xcrun = capabilities.ios.xcrun;
      const { stdout: listing } = await execFileAsync(xcrun, ['simctl', 'listapps', device.id], { maxBuffer: 16 * 1024 * 1024 });
      const apps = decodeBoundary(JSON.parse(await plistToJson(listing)), boundary.record(boundary.object({ ApplicationType: boundary.optional(boundary.string) })));
      for (const [bundleId, app] of Object.entries(apps)) {
        if (app.ApplicationType === 'User') await execFileAsync(xcrun, ['simctl', 'uninstall', device.id, bundleId], { timeout: 60_000 });
      }
      return;
    }
    if (!capabilities.android.ready) return;
    const serial = device.serial ?? device.id;
    const { stdout } = await execFileAsync(capabilities.android.adb, ['-s', serial, 'shell', 'pm', 'list', 'packages', '-3'], { timeout: 60_000 });
    for (const line of stdout.split('\n')) {
      const pkg = line.trim().replace(/^package:/, '');
      if (pkg) await execFileAsync(capabilities.android.adb, ['-s', serial, 'uninstall', pkg], { timeout: 60_000 });
    }
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

/** serve-emu's REST bodies: a normalized tap or swipe, a key, or nothing for a screenshot. */
/** A body for serve-emu's REST routes: a tap or swipe, a key, typed text, a turn, a fold, or nothing. */
export type EmulatorRequest =
  | { x: number; y: number }
  | { x1: number; y1: number; x2: number; y2: number }
  | { key: 'home' | 'back' }
  | { keycode: number }
  | { text: string }
  | { orientation: string }
  | { posture: 'closed' | 'opened' }
  | { hingeAngle: number }
  | Record<string, never>;

export interface DeviceScreenshot { path: string; width?: number; height?: number }

export interface DeviceUsage {
  machine: string;
  devices: { id: string; platform: DevicePlatform; name: string; os: string; paneMade: boolean; booted: boolean; heldBy?: string; lastUsedAt?: string; memoryBytes?: number; diskBytes?: number }[];
  helpers: { name: string; pid: number; memoryBytes: number }[];
  checkouts: { path: string; bytes: number }[];
  runtimes: { platform: DevicePlatform; name: string; bytes?: number }[];
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

/** simctl prints an old-style plist; plutil reads it from stdin and writes JSON. */
function plistToJson(plist: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('plutil', ['-convert', 'json', '-o', '-', '-'], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    child.stdin?.end(plist);
  });
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
  if (!existsSync(folder)) return 0;
  if (process.platform === 'win32') return walkBytes(folder);
  try {
    const { stdout } = await execFileAsync('du', ['-sk', folder], { timeout: 60_000 });
    return (Number(stdout.trim().split(/\s+/)[0]) || 0) * 1024;
  } catch {
    return 0;
  }
}

/** A folder's size without `du` (Windows): every file under it, links not followed. */
async function walkBytes(folder: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) total += await walkBytes(full);
    else total += (await lstat(full).catch(() => undefined))?.size ?? 0;
  }
  return total;
}
