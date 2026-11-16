import type { IpcMain } from 'electron';
import os from 'os';
import path from 'path';
import { PaneError, paneErrorText, reasonOf } from '../../../shared/paneError';
import type { DeviceInput, DeviceMac, DeviceOpenMarker, DevicePanelState, DevicePlatform, DeviceSettings, DeviceSettingsView } from '../../../shared/types/devices';
import type { MachineConnections } from '../services/machineConnections';
import { DEFAULT_DEVICE_SETTINGS } from '../../../shared/types/devices';
import type { ToolPanel } from '../../../shared/types/panels';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import { isRemotePaneCommand, paneCommandCaller, teammatePaneCaller, type PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { panelManager } from '../services/panelManager';
import { defaultProbeEnvironment } from '../services/devices/deviceProbe';
import { DeviceBusyError, DeviceService, type DeviceCaller, type DeviceChange } from '../services/devices/deviceService';
import { findExecutableInPath } from '../utils/shellPath';
import { DeviceInputSockets, inputMessages } from '../services/devices/deviceInput';
import { refuseRetarget } from '../services/devices/deviceHelpers';
import { MacUnavailableError, RemoteDevices } from '../services/devices/remoteDevices';
import { registerMacDeviceHandler, remotePaneName } from './macDevices';
import { registerMediaRoute } from '../services/mediaPreview';
import { getAppDirectory } from '../utils/appDirectory';
import type { AppServices } from './types';

const RUN_WAIT_MS = 120_000;

/** What device_run returns: the contract's devicesRunResult. */
interface DeviceRunResult { ok: true; synced?: boolean; cwd?: string; machine: string; jobId?: string; state?: 'running' | 'exited'; exitCode?: number; logTail?: string }

const openSchema = boundary.object({ platform: boundary.enumeration('ios', 'android'), device: boundary.optional(boundary.string) });
const platformField = boundary.optional(boundary.enumeration('ios', 'android'));
const targetSchema = boundary.object({ platform: platformField });
const actSchema = boundary.object({ args: boundary.array(boundary.string), platform: platformField });
const runSchema = boundary.object({ command: boundary.optional(boundary.string), background: boundary.optional(boundary.boolean), waitMs: boundary.optional(boundary.number), platform: platformField });
const freeSchema = boundary.object({ mode: boundary.enumeration('idle', 'all') });
const inputSchema = boundary.union(
  boundary.object({ kind: boundary.literal('touch'), phase: boundary.enumeration('begin', 'move', 'end'), x: boundary.number, y: boundary.number }),
  boundary.object({ kind: boundary.literal('button'), button: boundary.enumeration('home', 'back') }),
);
const inputSockets = new DeviceInputSockets();

/** How device tabs and results name this machine. */
function localMachineLabel(): string {
  return process.platform === 'darwin' ? 'This Mac' : process.platform === 'win32' ? 'This PC' : 'This computer';
}

function localMachineName(): string {
  return os.hostname().replace(/\.local$/i, '');
}

function decode<Value>(value: PaneCommandValue, schema: Parameters<typeof decodeBoundary<Value>>[1], command: string): Value {
  try {
    return decodeBoundary(value ?? {}, schema);
  } catch (cause) {
    throw new PaneError('ERR_DEVICE_INVALID_REQUEST', `The ${command} request is malformed: ${reasonOf(cause)}. Nothing ran.`, `See \`runpane help ${command}\`.`);
  }
}

let service: DeviceService | undefined;
/** The platform each Pane opened last; screenshot, act, run and close act on it when they name none. */
const lastPlatform = new Map<string, DevicePlatform>();

/** Whether the Pane's device for `platform` (or the one it opened last) is on a linked Mac. */
function onMac(paneId: string, platform: DevicePlatform | undefined): boolean {
  const lease = remote?.leaseOf(paneId);
  if (!lease) return false;
  const wanted = platform ?? lastPlatform.get(paneId);
  return wanted === undefined || wanted === lease.platform;
}
let remote: RemoteDevices | undefined;
let machines: MachineConnections | undefined;

/** iOS on a linked Mac for a computer without Xcode. */
function remoteDevices(services: AppServices): RemoteDevices {
  remote ??= new RemoteDevices({
    macs: () => savedMacs(services),
    pinned: () => deviceSettings(services).iosMachineId,
    invoke: (machineId, channel, args) => {
      if (!machines) throw new PaneError('ERR_DEVICE_MAC_OFFLINE', 'Pane has not connected to its saved computers yet.', 'Wait a moment, then try again.');
      return machines.invokeOn(machineId, channel, args).then(result => decodeBoundary(result ?? null, boundary.json));
    },
    openPortStream: (machineId, port) => {
      if (!machines) throw new PaneError('ERR_DEVICE_MAC_OFFLINE', 'Pane has not connected to its saved computers yet.', 'Wait a moment, then try again.');
      return machines.openPortStream(machineId, port);
    },
    self: () => ({ id: services.configManager.getConfig().machineId ?? localMachineName(), name: localMachineName() }),
  }, path.join(getAppDirectory(), 'devices'));
  return remote;
}

/** Main hands over the saved machines' connections once they exist; iOS on a PC routes through them. */
export function setDeviceMachines(connections: MachineConnections): void {
  machines = connections;
}

/** Saved Macs, in the order the person saved them, with whether each answers now. */
function savedMacs(services: Pick<AppServices, 'configManager'>): DeviceMac[] {
  const computers = services.configManager.getConfig().remoteDaemon?.client.computers ?? [];
  return computers
    .filter(computer => computer.os === 'macOS')
    .map(computer => ({ id: computer.id, name: computer.label, online: machines?.machineState(computer.id)?.status === 'online' }));
}
let appServices: AppServices | undefined;

function paneNameOf(services: AppServices, paneId: string): string {
  return services.sessionManager.getSession(paneId)?.name ?? remotePaneName(paneId) ?? paneId;
}

/** The devices service on this machine; created on the first device call. */
function deviceService(services: AppServices): DeviceService {
  service ??= new DeviceService({
    root: path.join(getAppDirectory(), 'devices'),
    machineName: localMachineName,
    machineLabel: localMachineLabel,
    findExecutable: findExecutableInPath,
    probeEnvironment: () => defaultProbeEnvironment(findExecutableInPath),
    maxBooted: () => deviceSettings(services).maxBooted,
    paneName: (paneId) => paneNameOf(services, paneId),
    onChange: (change) => { void followDeviceChange(change); },
    log: (message) => console.log(message),
  });
  return service;
}

function deviceSettings(services: Pick<AppServices, 'configManager'>): DeviceSettings {
  return { ...DEFAULT_DEVICE_SETTINGS, ...services.configManager.getConfig().devices };
}

/**
 * The caller of a device tool: an agent's Pane. Device tools act only on devices leased to the
 * calling tab's Pane, so a call with no Pane (a shell outside Pane, or Pane's own UI) or from
 * another machine is refused before anything runs.
 */
function deviceCaller(services: AppServices): DeviceCaller {
  if (isRemotePaneCommand()) {
    throw new PaneError('ERR_DEVICE_LOCAL_ONLY', 'Device tools answer only agents running on this machine. Nothing ran.', 'Run the agent in a Pane on this machine; a machine without Xcode reaches a linked Mac on its own.');
  }
  const caller = paneCommandCaller();
  const session = caller?.paneId ? services.sessionManager.getSession(caller.paneId) : undefined;
  if (!caller?.paneId || !session) {
    throw new PaneError('ERR_DEVICE_NO_PANE', 'Device tools work only for agents running in a Pane tab, and this call came from outside one. Nothing ran.', 'Run the command from a terminal or agent tab inside a Pane.');
  }
  if (!deviceSettings(services).enabled) {
    throw new PaneError('ERR_DEVICE_TOOLS_OFF', 'Agent device tools are turned off in Settings > Devices. Nothing ran.', 'Turn on Settings > Devices > Agent device tools, then try again.');
  }
  const deviceCaller: DeviceCaller = { paneId: caller.paneId, paneName: session.name };
  if (caller.panelId) deviceCaller.panelId = caller.panelId;
  return deviceCaller;
}

function devicePanels(paneId: string): ToolPanel[] {
  return panelManager.getPanelsBySessionAndType(paneId, 'device');
}

/** The device tabs that have shown each device since Pane started, so a lease change reaches all of them. */
const tabsByDevice = new Map<string, Set<string>>();

function rememberTab(deviceId: string, panelId: string): void {
  const tabs = tabsByDevice.get(deviceId) ?? new Set<string>();
  tabs.add(panelId);
  tabsByDevice.set(deviceId, tabs);
}

const holderSchema = boundary.object({ paneId: boundary.string, paneName: boundary.string });
const panelStateSchema = boundary.object({
  deviceId: boundary.optional(boundary.string),
  platform: boundary.enumeration('ios', 'android'),
  name: boundary.string,
  os: boundary.optional(boundary.string),
  machine: boundary.string,
  machineId: boundary.optional(boundary.string),
  machineReason: boundary.optional(boundary.object({ kind: boundary.enumeration('local', 'automatic', 'pinned'), text: boundary.string })),
  phase: boundary.enumeration('installing', 'booting', 'live', 'off', 'in-use', 'closed', 'no-mac', 'mac-offline', 'error'),
  heldBy: boundary.optional(holderSchema),
  macName: boundary.optional(boundary.string),
  openedBy: boundary.optional(boundary.string),
});

/** A device tab's state, or undefined for any other tab. */
function panelState(panel: ToolPanel): DevicePanelState | undefined {
  if (panel.type !== 'device') return undefined;
  const state = decodeOptionalBoundary(panel.state.customState, panelStateSchema);
  return state && { ...state };
}

/** Applies `patch` to a device tab's state; a `heldBy` of undefined clears the holder. */
async function setPanelState(panel: ToolPanel, patch: Partial<DevicePanelState>, title?: string): Promise<void> {
  const current = panelManager.getPanel(panel.id) ?? panel;
  const previous = panelState(current);
  if (!previous) return;
  const next: DevicePanelState = { ...previous, ...patch };
  if (next.deviceId) rememberTab(next.deviceId, panel.id);
  if (patch.heldBy === undefined && 'heldBy' in patch) delete next.heldBy;
  const update: Partial<ToolPanel> = { state: { ...current.state, customState: next } };
  if (title) update.title = title;
  await panelManager.updatePanel(panel.id, update);
}

/** Device tabs follow their device: live while their Pane holds it, in use or off otherwise. */
async function followDeviceChange(change: DeviceChange): Promise<void> {
  for (const panelId of tabsByDevice.get(change.id) ?? []) {
    const panel = panelManager.getPanel(panelId);
    if (!panel) continue;
    const state = panelState(panel);
    if (!state || state.deviceId !== change.id) continue;
    if (change.kind === 'held') {
      if (panel.sessionId === change.paneId) await setPanelState(panel, { phase: 'live', heldBy: undefined });
      else await setPanelState(panel, { phase: 'in-use', heldBy: { paneId: change.paneId, paneName: appServices ? paneNameOf(appServices, change.paneId) : change.paneId } });
    } else if (change.kind === 'released' && panel.sessionId === change.paneId) {
      await setPanelState(panel, { phase: change.reason === 'closed' ? 'closed' : change.reason === 'taken' ? state.phase : 'off' });
    } else if (change.kind === 'released' && change.reason !== 'taken' && state.phase === 'in-use') {
      // The other Pane let go, so this tab's Boot can open the device again.
      await setPanelState(panel, { phase: 'closed', heldBy: undefined });
    } else if (change.kind === 'shutdown') {
      await setPanelState(panel, { phase: 'off' });
    }
  }
}

/** The Pane's device tab for `platform`, created in a split beside the caller without focus. */
async function ensureDeviceTab(caller: DeviceCaller, platform: DevicePlatform, initial: Partial<DevicePanelState>): Promise<ToolPanel> {
  const existing = devicePanels(caller.paneId).find(panel => panelState(panel)?.platform === platform);
  const name = platform === 'ios' ? 'iPhone' : 'Android';
  const state: DevicePanelState = { platform, name, machine: localMachineLabel(), phase: 'booting', ...initial };
  if (caller.panelId) state.openedBy = caller.panelId;
  if (existing) {
    await setPanelState(existing, state);
    return panelManager.getPanel(existing.id) ?? existing;
  }
  return panelManager.createPanel({
    sessionId: caller.paneId,
    type: 'device',
    title: state.name,
    initialState: { customState: state },
    metadata: caller.panelId ? { openPlacement: 'split', openedBy: { source: 'agent', panelId: caller.panelId } } : { openPlacement: 'split' },
    activate: false,
    announceActivation: false,
  });
}

/** iOS for a computer without Xcode: the device opens on a linked Mac Pane picks (or the pinned one). */
async function openOnMac(services: AppServices, caller: DeviceCaller, device: string | undefined) {
  const panel = await ensureDeviceTab(caller, 'ios', { phase: 'booting' });
  try {
    const { lease, device: summary } = await remoteDevices(services).open(caller.paneId, caller.paneName, 'ios', device);
    const why = lease.reason === 'pinned'
      ? `Runs on ${lease.macName}, pinned in Settings > Devices. This computer has no Xcode.`
      : `Runs on ${lease.macName}. This computer has no Xcode.`;
    await setPanelState(panel, { deviceId: summary.id, name: summary.name, os: summary.os, machine: lease.macName, machineId: lease.macId, machineReason: { kind: lease.reason, text: why }, phase: 'live', heldBy: undefined }, summary.name);
    const marker: DeviceOpenMarker = { kind: 'pane-device', panelId: panel.id, name: summary.name, machine: lease.macName };
    if (summary.os) marker.os = summary.os;
    return {
      ok: true,
      device: summary,
      machine: {
        name: lease.macName,
        reason: lease.reason === 'pinned'
          ? `${lease.macName} is pinned in Settings > Devices to run iOS for this computer, which has no Xcode.`
          : `This computer has no Xcode, so Pane picked ${lease.macName}, the first online Mac with Xcode.`,
      },
      panelId: panel.id,
      paneDevice: marker,
      next: `See it with device_screenshot and drive it with device_act as on this computer. device_run syncs this worktree (uncommitted edits included) to Pane's checkout on ${lease.macName} and runs the command there, such as \`npx expo run:ios\`; pass --background for Metro. Call device_close when done.`,
    };
  } catch (cause) {
    if (cause instanceof PaneError && cause.code === 'ERR_DEVICE_NO_MAC') await setPanelState(panel, { phase: 'no-mac' });
    else if (cause instanceof MacUnavailableError) await setPanelState(panel, { phase: 'mac-offline', macName: cause.macName });
    else if (cause instanceof PaneError && cause.code === 'ERR_DEVICE_BUSY') await setPanelState(panel, { phase: 'in-use' });
    else await setPanelState(panel, { phase: 'error' });
    throw cause;
  }
}

export function registerDeviceHandlers(ipcMain: Pick<IpcMain, 'handle'>, services: AppServices, commandRegistry: PaneCommandRegistry): void {
  appServices = services;
  const devices = () => deviceService(services);

  commandRegistry.register('runpane:devices:list', async () => {
    deviceCaller(services);
    const local = await devices().list();
    // Without Xcode here, iOS comes from the Mac Pane would pick.
    const onMac = (await devices().probe()).ios.ready ? [] : await remoteDevices(services).list();
    return { ok: true, devices: [...local, ...onMac] };
  });

  commandRegistry.register('runpane:devices:open', async (request: PaneCommandValue) => {
    const caller = deviceCaller(services);
    const { platform, device } = decode(request, openSchema, 'devices open');
    lastPlatform.set(caller.paneId, platform);
    if (platform === 'ios' && !(await devices().probe()).ios.ready) return openOnMac(services, caller, device);
    const panel = await ensureDeviceTab(caller, platform, { phase: devices().helpersInstalled() ? 'booting' : 'installing' });
    try {
      const opened = await devices().open(caller, device ? { platform, device } : { platform }, (phase) => { void setPanelState(panel, { phase }); });
      const summary = opened.device;
      await setPanelState(panel, { deviceId: summary.id, name: summary.name, os: summary.os, machine: summary.machine, phase: 'live', heldBy: undefined, machineReason: { kind: 'local', text: `Runs on ${summary.machine}.` } }, summary.name);
      const marker: DeviceOpenMarker = { kind: 'pane-device', panelId: panel.id, name: summary.name, machine: summary.machine };
      if (summary.os) marker.os = summary.os;
      return {
        ok: true,
        device: summary,
        machine: { name: localMachineName(), reason: `${localMachineName()} is this machine and can run ${platform === 'ios' ? 'iOS simulators' : 'Android emulators'}.` },
        panelId: panel.id,
        paneDevice: marker,
        next: 'See it with device_screenshot. Drive it with device_act: `open <app id>`, then `snapshot -i` for @refs, then `press @eN --settle`. Build and run your app with device_run. Call device_close when done.',
      };
    } catch (cause) {
      if (cause instanceof DeviceBusyError) {
        await setPanelState(panel, { phase: 'in-use', deviceId: cause.deviceId, name: cause.deviceName, heldBy: { paneId: cause.holder, paneName: paneNameOf(services, cause.holder) } });
      } else {
        await setPanelState(panel, { phase: 'error' });
      }
      throw cause;
    }
  });

  commandRegistry.register('runpane:devices:screenshot', async (request: PaneCommandValue) => {
    const caller = deviceCaller(services);
    const { platform } = decode(request, targetSchema, 'devices screenshot');
    const shot = onMac(caller.paneId, platform) ? await remoteDevices(services).screenshot(caller.paneId) : await devices().screenshot(caller, platform);
    return { ok: true, ...shot, mimeType: 'image/png' };
  });

  commandRegistry.register('runpane:devices:act', async (request: PaneCommandValue) => {
    const caller = deviceCaller(services);
    const { args, platform } = decode(request, actSchema, 'devices act');
    refuseRetarget(args);
    return { ok: true, ...(onMac(caller.paneId, platform) ? await remoteDevices(services).act(caller.paneId, args) : await devices().act(caller, args, platform)) };
  });

  commandRegistry.register('runpane:devices:run', async (request: PaneCommandValue) => {
    const caller = deviceCaller(services);
    const { command, background, waitMs, platform } = decode(request, runSchema, 'devices run');
    const session = services.sessionManager.getSession(caller.paneId);
    const macLease = onMac(caller.paneId, platform) ? remote?.leaseOf(caller.paneId) : undefined;
    if (macLease) {
      // Builds for a Mac run in Pane's checkout there, synced from this worktree (uncommitted edits included).
      const ran = await remoteDevices(services).run(caller.paneId, session?.worktreePath ?? process.cwd(), command, { background: background === true, waitMs: waitMs ?? RUN_WAIT_MS });
      const result: DeviceRunResult = { ok: true, synced: ran.synced, machine: macLease.macName };
      if (ran.job) {
        result.cwd = ran.job.cwd;
        result.jobId = ran.job.jobId;
        result.state = ran.job.state;
        result.logTail = ran.job.logTail;
        if (ran.job.exitCode !== undefined) result.exitCode = ran.job.exitCode;
      }
      return result;
    }
    devices().held(caller.paneId, platform);
    if (!command) return { ok: true, synced: false, cwd: session?.worktreePath };
    const { jobId, state, exitCode, logTail } = await devices().run(caller.paneId, command, session?.worktreePath ?? process.cwd(), { background: background === true, waitMs: waitMs ?? RUN_WAIT_MS });
    const result: DeviceRunResult = { ok: true, cwd: session?.worktreePath ?? process.cwd(), machine: localMachineName(), jobId, state, logTail };
    if (exitCode !== undefined) result.exitCode = exitCode;
    return result;
  });

  commandRegistry.register('runpane:devices:close', async (request: PaneCommandValue) => {
    const caller = deviceCaller(services);
    const { platform } = decode(request, targetSchema, 'devices close');
    // No platform closes every device the Pane holds, here and on a linked Mac.
    const closed: string[] = [];
    let jobsStopped = 0;
    const macLease = remote?.leaseOf(caller.paneId);
    if (macLease && (platform === undefined || platform === macLease.platform)) {
      const onTheMac = await remoteDevices(services).close(caller.paneId);
      closed.push(...onTheMac.closed);
      jobsStopped += onTheMac.jobsStopped;
      for (const panel of devicePanels(caller.paneId)) if (panelState(panel)?.machineId) await setPanelState(panel, { phase: 'closed' });
    }
    if (platform === undefined || !macLease || platform !== macLease.platform) {
      const here = await devices().close(caller, platform);
      closed.push(...here.closed);
      jobsStopped += here.jobsStopped;
    }
    return { ok: true, closed, jobsStopped };
  });

  commandRegistry.register('runpane:devices:usage', async () => {
    if (isRemotePaneCommand()) throw new PaneError('ERR_DEVICE_LOCAL_ONLY', 'Device usage answers only callers on this machine.', 'Run it on that machine.');
    return { ok: true, machines: [await devices().usage()] };
  });

  commandRegistry.register('runpane:devices:free', async (request: PaneCommandValue) => {
    if (isRemotePaneCommand()) throw new PaneError('ERR_DEVICE_LOCAL_ONLY', 'Freeing devices answers only callers on this machine.', 'Run it on that machine.');
    const { mode } = decode(request, freeSchema, 'devices free');
    return { ok: true, machine: localMachineName(), ...(await devices().free(mode)) };
  });

  registerDeviceTabChannels(ipcMain, services, commandRegistry);

  // Both read what they saved, so archiving after a restart still erases Pane's devices and cleans the Mac's checkout.
  services.sessionManager.on('session-deleted', ({ id }: { id: string }) => {
    lastPlatform.delete(id);
    devices().paneArchived(id).catch((cause) => console.warn(`[devices] archive cleanup for ${id} failed: ${reasonOf(cause)}`));
    remoteDevices(services).archived(id).catch((cause) => console.warn(`[devices] archive cleanup on the Mac for ${id} failed: ${reasonOf(cause)}`));
  });

  registerMacDeviceHandler(commandRegistry, devices, path.join(getAppDirectory(), 'devices'));
}

type IpcResponse<Data> = { success: true; data: Data } | { success: false; error: string };

async function respond<Data>(work: () => Promise<Data> | Data): Promise<IpcResponse<Data>> {
  try {
    return { success: true, data: await work() };
  } catch (cause) {
    return { success: false, error: cause instanceof PaneError ? paneErrorText(cause) : reasonOf(cause) };
  }
}

/**
 * The person's device tab. `devices:*` are host channels, so a desktop switched to another
 * computer, the browser app and phones reach the device on the Pane they show. They are the UI's
 * own (agents reach runpane commands), so the person can drive any device their tab shows.
 * Settings > Devices is about this computer, so its channels stay local.
 */
/** Where each emulator's current touch began: a touch becomes a tap, or a swipe when it moved. */
const touchStarts = new Map<string, { x: number; y: number }>();
const TAP_SLOP = 0.02;

async function emulatorInput(service: DeviceService, deviceId: string, input: DeviceInput): Promise<void> {
  if (input.kind === 'button') {
    await service.emulatorCall(deviceId, 'key', { key: input.button });
    return;
  }
  if (input.phase === 'begin') {
    touchStarts.set(deviceId, { x: input.x, y: input.y });
    return;
  }
  if (input.phase !== 'end') return;
  const start = touchStarts.get(deviceId) ?? { x: input.x, y: input.y };
  touchStarts.delete(deviceId);
  if (Math.hypot(input.x - start.x, input.y - start.y) < TAP_SLOP) await service.emulatorCall(deviceId, 'tap', { x: input.x, y: input.y });
  else await service.emulatorCall(deviceId, 'swipe', { x1: start.x, y1: start.y, x2: input.x, y2: input.y });
}

/** A frame as a data URL: PNG from an emulator, JPEG from a simulator's stream. */
function imageDataUrl(frame: Buffer): string {
  const png = frame.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return `data:image/${png ? 'png' : 'jpeg'};base64,${frame.toString('base64')}`;
}

function registerDeviceTabChannels(ipcMain: Pick<IpcMain, 'handle'>, services: AppServices, commandRegistry: PaneCommandRegistry): void {
  const devices = () => deviceService(services);
  const panelOf = (panelId: PaneCommandValue) => {
    // The person's tab only: an agent or a teammate drives devices through the guarded device tools.
    if (paneCommandCaller() || teammatePaneCaller()) {
      throw new PaneError('ERR_DEVICE_TAB_ONLY', 'This channel belongs to the person\'s device tab. Nothing ran.', 'Agents use device_screenshot, device_act and the other device tools.');
    }
    const id = decodeOptionalBoundary(panelId, boundary.string);
    const panel = id === undefined ? undefined : panelManager.getPanel(id);
    const state = panel ? panelState(panel) : undefined;
    if (!panel || !state) throw new PaneError('ERR_DEVICE_TAB_GONE', 'That device tab is gone.', 'Close it and open the device again.');
    return { panel, state };
  };

  /** The person's touches and buttons, sent from main so the hub token never reaches the renderer. */
  commandRegistry.register('devices:input', (panelId: PaneCommandValue, input: PaneCommandValue) => respond(async () => {
    const { panel, state } = panelOf(panelId);
    if (!state.deviceId || state.phase !== 'live') return false;
    const decoded = decodeBoundary(input, inputSchema);
    if (state.platform === 'android' && !state.machineId) {
      await emulatorInput(devices(), state.deviceId, decoded);
      return true;
    }
    const deviceId = state.deviceId;
    // Asked once per input socket, not per touch, so a drag's moves keep their order.
    const stream = () => state.machineId ? remoteDevices(services).stream(panel.sessionId) : devices().stream(deviceId);
    inputSockets.send(`${state.machineId ?? 'local'}:${deviceId}`, inputMessages(decoded, state.platform), stream);
    return true;
  }));

  /** `pane-media://device/<panelId>`: the device's live MJPEG stream, proxied with the hub token. */
  registerMediaRoute('device', async (request, url) => {
    const { panel, state } = panelOf(url.pathname.slice(1));
    if (!state.deviceId || state.phase !== 'live') return new Response(null, { status: 404 });
    let upstream: Response;
    if (state.machineId) {
      // A linked Mac's hub, through the one-port tunnel; the token stays in main.
      const { streamUrl, token } = await remoteDevices(services).stream(panel.sessionId);
      upstream = await fetch(streamUrl, { signal: request.signal, headers: { Authorization: `Bearer ${token}` } });
    } else {
      upstream = await devices().openStream(state.deviceId, request.signal);
    }
    if (!upstream.ok || !upstream.body) return new Response(null, { status: 502 });
    return new Response(upstream.body, { headers: { 'Content-Type': upstream.headers.get('content-type') ?? 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  });

  /** One frame as a data URL: the chat card's thumbnail, and the frame view on phones and in the browser app. */
  commandRegistry.register('devices:frame', (panelId: PaneCommandValue) => respond(async () => {
    const { panel, state } = panelOf(panelId);
    if (!state.deviceId) throw new PaneError('ERR_DEVICE_NOT_OPEN', 'This tab has no device yet.', 'Wait for it to boot.');
    const frame = state.machineId ? await remoteDevices(services).frame(panel.sessionId) : await devices().latestFrame(state.deviceId);
    return imageDataUrl(frame);
  }));

  commandRegistry.register('devices:visible', (panelId: PaneCommandValue, clientId: PaneCommandValue, visible: PaneCommandValue) => respond(async () => {
    const { panel, state } = panelOf(panelId);
    if (state.machineId) await remoteDevices(services).visible(panel.sessionId, visible === true);
    else if (state.deviceId && service) service.lifecycle.setVisible(panel.sessionId, state.deviceId, String(clientId), visible === true);
    return true;
  }));

  commandRegistry.register('devices:take-over', (panelId: PaneCommandValue) => respond(async () => {
    const { panel, state } = panelOf(panelId);
    if (!state.deviceId) return false;
    const session = services.sessionManager.getSession(panel.sessionId);
    await devices().takeOver({ paneId: panel.sessionId, paneName: session?.name ?? panel.sessionId }, state.deviceId, state.platform);
    return true;
  }));

  /** Boot (off after idle), Restart and Shut down from the device tab. */
  commandRegistry.register('devices:power', (panelId: PaneCommandValue, action: PaneCommandValue) => respond(async () => {
    const { panel, state } = panelOf(panelId);
    const session = services.sessionManager.getSession(panel.sessionId);
    const caller = { paneId: panel.sessionId, paneName: session?.name ?? panel.sessionId };
    // iOS on a computer without Xcode always runs on a Mac, including Try again after the Mac was offline.
    if (state.machineId || (state.platform === 'ios' && !(await devices().probe()).ios.ready)) {
      // On a linked Mac: Shut down ends the lease there (the Mac shuts it down after its warm window); Boot opens it again.
      await remoteDevices(services).close(caller.paneId).catch(() => undefined);
      if (action === 'shutdown') {
        await setPanelState(panel, { phase: 'off' });
        return true;
      }
      if (!state.machineId) {
        await openOnMac(services, caller, undefined);
        return true;
      }
      await setPanelState(panel, { phase: 'booting' });
      const { lease, device } = await remoteDevices(services).open(caller.paneId, caller.paneName, state.platform, state.deviceId);
      await setPanelState(panel, { deviceId: device.id, machineId: lease.macId, phase: 'live', heldBy: undefined });
      return true;
    }
    if (state.deviceId && (action === 'shutdown' || action === 'restart')) await devices().shutdownDevice(state.deviceId);
    if (action === 'shutdown') {
      await setPanelState(panel, { phase: 'off' });
      return true;
    }
    await setPanelState(panel, { phase: 'booting' });
    const opened = await devices().open(caller, state.deviceId ? { platform: state.platform, device: state.deviceId } : { platform: state.platform });
    await setPanelState(panel, { deviceId: opened.device.id, phase: 'live', heldBy: undefined });
    return true;
  }));

  ipcMain.handle('device-settings:get', () => respond(async () => {
    const capabilities = await devices().probe(true);
    const view: DeviceSettingsView = {
      settings: deviceSettings(services),
      capabilities: { ios: capabilities.ios.ready ? { ready: true } : capabilities.ios, android: capabilities.android.ready ? { ready: true } : capabilities.android, simslim: capabilities.simslim !== undefined, npm: capabilities.npm },
      helpersInstalled: devices().helpersInstalled(),
      macs: savedMacs(services),
    };
    return view;
  }));

  ipcMain.handle('device-settings:update', (_event, patch: PaneCommandValue) => respond(async () => {
    const update = decodeBoundary(patch ?? {}, boundary.object({ enabled: boundary.optional(boundary.boolean), iosMachineId: boundary.optional(boundary.nullable(boundary.string)), maxBooted: boundary.optional(boundary.number) }));
    const next: DeviceSettings = { ...deviceSettings(services) };
    if (update.enabled !== undefined) next.enabled = update.enabled;
    if (update.maxBooted !== undefined) next.maxBooted = Math.min(4, Math.max(1, Math.round(update.maxBooted)));
    if (update.iosMachineId === null) delete next.iosMachineId;
    else if (update.iosMachineId !== undefined) next.iosMachineId = update.iosMachineId;
    await services.configManager.updateConfig({ devices: next });
    return next;
  }));
}

export async function disposeDevices(): Promise<void> {
  inputSockets.closeAll();
  await remote?.dispose();
  await service?.dispose();
}
