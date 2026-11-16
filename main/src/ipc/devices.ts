import type { IpcMain } from 'electron';
import os from 'os';
import path from 'path';
import { PaneError, paneErrorText, reasonOf } from '../../../shared/paneError';
import type { DeviceMac, DeviceOpenMarker, DevicePanelState, DevicePlatform, DeviceSettings, DeviceSettingsView } from '../../../shared/types/devices';
import type { MachineConnections } from '../services/machineConnections';
import { DEFAULT_DEVICE_SETTINGS } from '../../../shared/types/devices';
import type { ToolPanel } from '../../../shared/types/panels';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import { isRemotePaneCommand, paneCommandCaller, type PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { panelManager } from '../services/panelManager';
import { defaultProbeEnvironment } from '../services/devices/deviceProbe';
import { DeviceBusyError, DeviceService, type DeviceCaller, type DeviceChange } from '../services/devices/deviceService';
import { findExecutableInPath } from '../utils/shellPath';
import { DeviceInputSockets, inputMessages } from '../services/devices/deviceInput';
import { registerMediaRoute } from '../services/mediaPreview';
import { getAppDirectory } from '../utils/appDirectory';
import type { AppServices } from './types';

const RUN_WAIT_MS = 120_000;

/** What device_run returns: the contract's devicesRunResult. */
interface DeviceRunResult { ok: true; synced?: boolean; cwd: string; machine: string; jobId: string; state: 'running' | 'exited'; exitCode?: number; logTail: string }

const openSchema = boundary.object({ platform: boundary.enumeration('ios', 'android'), device: boundary.optional(boundary.string) });
const actSchema = boundary.object({ args: boundary.array(boundary.string) });
const runSchema = boundary.object({ command: boundary.optional(boundary.string), background: boundary.optional(boundary.boolean), waitMs: boundary.optional(boundary.number) });
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
let machines: MachineConnections | undefined;

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
  return services.sessionManager.getSession(paneId)?.name ?? paneId;
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
    throw new PaneError('ERR_DEVICE_TOOLS_OFF', 'Agent device tools are turned off in this Pane. Nothing ran.', 'Turn on Settings > Devices > Agent device tools, then try again.');
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

export function registerDeviceHandlers(ipcMain: Pick<IpcMain, 'handle'>, services: AppServices, commandRegistry: PaneCommandRegistry): void {
  appServices = services;
  const devices = () => deviceService(services);

  commandRegistry.register('runpane:devices:list', async () => {
    deviceCaller(services);
    return { ok: true, devices: await devices().list() };
  });

  commandRegistry.register('runpane:devices:open', async (request: PaneCommandValue) => {
    const caller = deviceCaller(services);
    const { platform, device } = decode(request, openSchema, 'devices open');
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

  commandRegistry.register('runpane:devices:screenshot', async () => {
    const caller = deviceCaller(services);
    const shot = await devices().screenshot(caller);
    return { ok: true, ...shot, mimeType: 'image/png' };
  });

  commandRegistry.register('runpane:devices:act', async (request: PaneCommandValue) => {
    const caller = deviceCaller(services);
    const { args } = decode(request, actSchema, 'devices act');
    return { ok: true, ...(await devices().act(caller, args)) };
  });

  commandRegistry.register('runpane:devices:run', async (request: PaneCommandValue) => {
    const caller = deviceCaller(services);
    const { command, background, waitMs } = decode(request, runSchema, 'devices run');
    devices().held(caller.paneId);
    const session = services.sessionManager.getSession(caller.paneId);
    if (!command) return { ok: true, synced: false, cwd: session?.worktreePath };
    const { jobId, state, exitCode, logTail } = await devices().run(caller.paneId, command, session?.worktreePath ?? process.cwd(), { background: background === true, waitMs: waitMs ?? RUN_WAIT_MS });
    const result: DeviceRunResult = { ok: true, cwd: session?.worktreePath ?? process.cwd(), machine: localMachineName(), jobId, state, logTail };
    if (exitCode !== undefined) result.exitCode = exitCode;
    return result;
  });

  commandRegistry.register('runpane:devices:close', async () => {
    const caller = deviceCaller(services);
    return { ok: true, ...(await devices().close(caller)) };
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

  services.sessionManager.on('session-deleted', ({ id }: { id: string }) => {
    if (!service) return;
    service.paneArchived(id).catch((cause) => console.warn(`[devices] archive cleanup for ${id} failed: ${reasonOf(cause)}`));
  });
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
function registerDeviceTabChannels(ipcMain: Pick<IpcMain, 'handle'>, services: AppServices, commandRegistry: PaneCommandRegistry): void {
  const devices = () => deviceService(services);
  const panelOf = (panelId: PaneCommandValue) => {
    const id = decodeOptionalBoundary(panelId, boundary.string);
    const panel = id === undefined ? undefined : panelManager.getPanel(id);
    const state = panel ? panelState(panel) : undefined;
    if (!panel || !state) throw new PaneError('ERR_DEVICE_TAB_GONE', 'That device tab is gone.', 'Close it and open the device again.');
    return { panel, state };
  };

  /** The person's touches and buttons, sent from main so the hub token never reaches the renderer. */
  commandRegistry.register('devices:input', (panelId: PaneCommandValue, input: PaneCommandValue) => respond(async () => {
    const { state } = panelOf(panelId);
    if (!state.deviceId || state.phase !== 'live') return false;
    const decoded = decodeBoundary(input, inputSchema);
    inputSockets.send(state.deviceId, await devices().stream(state.deviceId), inputMessages(decoded, state.platform));
    return true;
  }));

  /** `pane-media://device/<panelId>`: the device's live MJPEG stream, proxied with the hub token. */
  registerMediaRoute('device', async (request, url) => {
    const { state } = panelOf(url.pathname.slice(1));
    if (!state.deviceId || state.phase !== 'live') return new Response(null, { status: 404 });
    const upstream = await devices().openStream(state.deviceId, request.signal);
    if (!upstream.ok || !upstream.body) return new Response(null, { status: 502 });
    return new Response(upstream.body, { headers: { 'Content-Type': upstream.headers.get('content-type') ?? 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  });

  /** One frame as a data URL: the chat card's thumbnail, and the frame view on phones and in the browser app. */
  commandRegistry.register('devices:frame', (panelId: PaneCommandValue) => respond(async () => {
    const { state } = panelOf(panelId);
    if (!state.deviceId) throw new PaneError('ERR_DEVICE_NOT_OPEN', 'This tab has no device yet.', 'Wait for it to boot.');
    return `data:image/jpeg;base64,${(await devices().latestFrame(state.deviceId)).toString('base64')}`;
  }));

  commandRegistry.register('devices:visible', (panelId: PaneCommandValue, clientId: PaneCommandValue, visible: PaneCommandValue) => respond(() => {
    const { panel, state } = panelOf(panelId);
    if (state.deviceId && service) service.lifecycle.setVisible(panel.sessionId, state.deviceId, String(clientId), visible === true);
    return true;
  }));

  commandRegistry.register('devices:take-over', (panelId: PaneCommandValue) => respond(async () => {
    const { panel, state } = panelOf(panelId);
    if (!state.deviceId) return false;
    const session = services.sessionManager.getSession(panel.sessionId);
    await devices().takeOver({ paneId: panel.sessionId, paneName: session?.name ?? panel.sessionId }, state.deviceId);
    return true;
  }));

  /** Boot (off after idle), Restart and Shut down from the device tab. */
  commandRegistry.register('devices:power', (panelId: PaneCommandValue, action: PaneCommandValue) => respond(async () => {
    const { panel, state } = panelOf(panelId);
    const session = services.sessionManager.getSession(panel.sessionId);
    const caller = { paneId: panel.sessionId, paneName: session?.name ?? panel.sessionId };
    if (action === 'shutdown') {
      await devices().close(caller);
      await devices().free('idle');
      await setPanelState(panel, { phase: 'off' });
      return true;
    }
    if (action === 'restart') {
      await devices().close(caller);
      await devices().free('idle');
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
  await service?.dispose();
}
