import { mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';
import type { IpcMain } from 'electron';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { PaneError } from '../../../shared/paneError';
import type { PaneDaemonCaller } from '../../../shared/types/daemon';
import type { DevicePanelState } from '../../../shared/types/devices';
import type { ToolPanel } from '../../../shared/types/panels';
import { PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { panelManager } from '../services/panelManager';
import type { ProbeEnvironment } from '../services/devices/deviceProbe';
import { macDeviceRequestSchema } from '../services/devices/remoteDevices';
import { decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { disposeDevices, registerDeviceHandlers, setDeviceMachines } from './devices';
import type { AppServices } from './types';

// The viewer's side of a device on a linked Mac: this computer has no Xcode, so iOS opens on a
// stand-in Mac that answers the device channel as a Mac's Pane does. The tests check what the
// viewer's device tab says from those answers.
vi.stubEnv('PANE_DIR', mkdtempSync(path.join(os.tmpdir(), 'pane-device-mac-')));

const panels = new Map<string, ToolPanel>();
vi.spyOn(panelManager, 'getPanel').mockImplementation(id => panels.get(id));
vi.spyOn(panelManager, 'getPanelsBySessionAndType').mockImplementation((sessionId, type) => [...panels.values()].filter(panel => panel.sessionId === sessionId && panel.type === type));
vi.spyOn(panelManager, 'createPanel').mockImplementation(async (request) => {
  const panel: ToolPanel = { id: `tab-${panels.size + 1}`, sessionId: request.sessionId, type: request.type, title: request.title ?? '', state: { isActive: true, customState: request.initialState?.customState }, metadata: { createdAt: '', lastActiveAt: '', position: 0 } };
  panels.set(panel.id, panel);
  return panel;
});
vi.spyOn(panelManager, 'updatePanel').mockImplementation(async (id, update) => {
  const current = panels.get(id);
  if (current) panels.set(id, { ...current, ...update });
});
vi.spyOn(panelManager, 'setActivePanel').mockImplementation(async () => undefined);

/** A PC without Xcode. */
const pc = (): ProbeEnvironment => ({ platform: 'win32', env: {}, home: os.tmpdir(), findExecutable: () => null, exists: () => false, run: async () => '{}' });

const RECORDING = '/Users/me/.pane/devices/recordings/pc-pane-a.mp4';
/** What the stand-in Mac answers to `status` and `close`, and whether it is an older Mac without `status`. */
interface StandInMac { status: PaneCommandValue; shutDown: string[] | undefined; old: boolean; requests: ReturnType<typeof decodeBoundary<typeof macDeviceRequestSchema>>[] }
const mac: StandInMac = { status: { held: true, booted: true }, shutDown: ['SIM'], old: false, requests: [] };
setDeviceMachines({
  machineState: () => ({ status: 'online' }),
  openPortStream: () => { throw new Error('no stream in these tests'); },
  invokeOn: async (_machineId, _channel, [raw]) => {
    const request = decodeBoundary(raw, macDeviceRequestSchema);
    mac.requests.push(request);
    switch (request.op) {
      case 'probe': return { ios: true, android: false };
      case 'open': return { device: { id: 'SIM', platform: 'ios', name: 'iPhone 12', os: 'iOS 26.5', machine: 'This Mac', state: 'booted', paneMade: false } };
      case 'act': return request.args?.[1] === 'stop' ? { exitCode: 0, output: JSON.stringify({ path: RECORDING }) } : { exitCode: 0, output: '' };
      case 'close': return mac.shutDown ? { closed: ['SIM'], jobsStopped: 0, shutDown: mac.shutDown } : { closed: ['SIM'], jobsStopped: 0 };
      case 'status':
        if (mac.old) throw new PaneError('ERR_HOST_OUTDATED', 'The Mac runs an older Pane.', 'Update it.');
        return mac.status;
      default: return { ok: true };
    }
  },
});

const registry = new PaneCommandRegistry();
const services = {
  sessionManager: { getSession: (id: string) => (id === 'pane-a' ? { name: 'qa', worktreePath: os.tmpdir() } : undefined), getAllSessions: () => [], on: vi.fn() },
  configManager: { getConfig: () => ({ devices: { enabled: true }, remoteDaemon: { client: { computers: [{ id: 'mac-1', label: 'Studio Mac', os: 'macOS' }] } } }) },
};
// SAFETY: the fixture supplies the AppServices members the device channels read.
registerDeviceHandlers({ handle: vi.fn() } as Pick<IpcMain, 'handle'>, services as AppServices, registry, { probeEnvironment: pc });
afterAll(async () => {
  await disposeDevices();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const signal = new AbortController().signal;
const agent: PaneDaemonCaller = { paneId: 'pane-a', panelId: 'agent-tab' };
const tool = (channel: string, request: PaneCommandValue) => registry.invokeConnected(channel, [request], signal, agent);
async function tab(channel: string, ...args: PaneCommandValue[]): Promise<void> {
  // SAFETY: tab channels answer with this envelope; the tests read the tab's state.
  const answer = await registry.invokeConnected(channel, args, signal) as { success: boolean; error?: string };
  if (!answer.success) throw new Error(answer.error);
}
const tabId = () => [...panels.values()].find(panel => panel.type === 'device')?.id ?? '';
// SAFETY: device tabs carry DevicePanelState as their custom state.
const tabState = () => panels.get(tabId())?.state.customState as DevicePanelState;
async function openAndRecord(): Promise<void> {
  await tool('runpane:devices:open', { platform: 'ios' });
  expect(tabState()).toMatchObject({ phase: 'live', machineId: 'mac-1' });
  await tab('devices:record', tabId(), 'start');
}

describe('a device on a linked Mac, as the viewer\'s tab tells it', () => {
  it('saves the recording when the agent closes the device, and names the agent', async () => {
    await openAndRecord();
    await tool('runpane:devices:close', {});
    expect(tabState()).toMatchObject({ phase: 'closed', stoppedBy: 'agent', recordingEnded: { by: 'agent', recording: { path: RECORDING, machine: 'Studio Mac' } } });
  });

  it('clears the old cause when the device opens again', async () => {
    await tool('runpane:devices:open', { platform: 'ios' });
    expect(tabState().stoppedBy).toBeUndefined();
  });

  it('says the person shut it down only when the Mac did, and sends the Mac the person as the cause', async () => {
    await openAndRecord();
    mac.shutDown = ['SIM'];
    await tab('devices:power', tabId(), 'shutdown');
    expect(tabState()).toMatchObject({ phase: 'off', stoppedBy: 'person', recordingEnded: { by: 'device', recording: { path: RECORDING } } });
    expect(mac.requests.filter(request => request.op === 'close').at(-1)).toMatchObject({ shutdownBy: 'person' });
    await tool('runpane:devices:open', { platform: 'ios' });
    mac.shutDown = [];
    await tab('devices:power', tabId(), 'shutdown');
    expect(tabState()).toMatchObject({ phase: 'closed', stoppedBy: 'person' });
  });

  it('shows the cause the Mac gives for a stop that happened there, and ends the recording', async () => {
    await openAndRecord();
    mac.status = { held: false, booted: false, stoppedBy: 'idle' };
    await tab('devices:controls', tabId());
    expect(tabState()).toMatchObject({ phase: 'off', stoppedBy: 'idle', recordingEnded: { by: 'device' } });
    await tool('runpane:devices:open', { platform: 'ios' });
    mac.status = { held: true, booted: false, stoppedBy: 'outside' };
    await tab('devices:controls', tabId());
    expect(tabState()).toMatchObject({ phase: 'off', stoppedBy: 'outside' });
  });

  it('leaves the tab as it is when an older Mac cannot say', async () => {
    await tool('runpane:devices:open', { platform: 'ios' });
    mac.old = true;
    await tab('devices:controls', tabId()).catch(() => undefined);
    expect(tabState()).toMatchObject({ phase: 'live' });
    expect(tabState().stoppedBy).toBeUndefined();
    mac.old = false;
  });

  it('tells the Mac this computer is quitting and marks its tabs off', async () => {
    await tool('runpane:devices:open', { platform: 'ios' });
    await disposeDevices();
    expect(mac.requests.filter(request => request.op === 'close').at(-1)).toMatchObject({ shutdownBy: 'quit' });
    expect(tabState()).toMatchObject({ phase: 'off', stoppedBy: 'quit' });
  });
});
