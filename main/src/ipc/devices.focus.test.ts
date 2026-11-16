import type { IpcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneError } from '../../../shared/paneError';
import type { PaneDaemonCaller } from '../../../shared/types/daemon';
import type { DevicePlatform } from '../../../shared/types/devices';
import type { CreatePanelRequest, ToolPanel } from '../../../shared/types/panels';
import { PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { DeviceService, type DeviceCaller } from '../services/devices/deviceService';
import { panelManager } from '../services/panelManager';
import type { AppServices } from './types';
import { registerDeviceHandlers } from './devices';

// `runpane devices open` and its device tab: which opens select the tab, and which leave it alone (#1432).

const panels = new Map<string, ToolPanel>();
const created: CreatePanelRequest[] = [];
const activated: string[] = [];

/** The device state `devices open` stores on a new tab, kept as the panel store would. */
function stored(request: CreatePanelRequest): object {
  const initial = request.initialState;
  return initial && 'customState' in initial && initial.customState instanceof Object ? initial.customState : {};
}

function setup() {
  const registry = new PaneCommandRegistry();
  const serviceFixture = {
    sessionManager: { getSession: (id: string) => (id === 'pane-a' ? { name: 'qa', worktreePath: '/nonexistent' } : undefined), on: vi.fn() },
    configManager: { getConfig: () => ({ devices: { enabled: true } }) },
  };
  // SAFETY: The fixture supplies the AppServices members `devices open` reads on this machine.
  const services = serviceFixture as AppServices;
  // SAFETY: The stub only records Settings registrations, which these tests do not call.
  registerDeviceHandlers({ handle: vi.fn() } as Pick<IpcMain, 'handle'>, services, registry);
  return registry;
}

const inPaneA: PaneDaemonCaller = { paneId: 'pane-a', panelId: 'agent-tab' };
const signal = new AbortController().signal;

function open(registry: PaneCommandRegistry, request: PaneCommandValue): Promise<PaneCommandValue> {
  return registry.invokeConnected('runpane:devices:open', [request], signal, inPaneA);
}

beforeEach(() => {
  panels.clear();
  created.length = 0;
  activated.length = 0;
  vi.spyOn(panelManager, 'getPanelsBySessionAndType').mockImplementation((paneId, type) => [...panels.values()].filter(panel => panel.sessionId === paneId && panel.type === type));
  vi.spyOn(panelManager, 'getPanel').mockImplementation(id => panels.get(id));
  vi.spyOn(panelManager, 'updatePanel').mockImplementation(async (id, update) => {
    const panel = panels.get(id);
    if (panel) panels.set(id, { ...panel, ...update });
  });
  vi.spyOn(panelManager, 'setActivePanel').mockImplementation(async (_paneId, id) => {
    activated.push(id);
  });
  vi.spyOn(panelManager, 'createPanel').mockImplementation(async (request) => {
    created.push(request);
    const panel: ToolPanel = {
      id: `device-${panels.size + 1}`,
      sessionId: request.sessionId,
      type: request.type,
      title: request.title ?? 'Device',
      state: { isActive: request.activate !== false, customState: stored(request) },
      metadata: { createdAt: '', lastActiveAt: '', position: panels.size },
    };
    panels.set(panel.id, panel);
    return panel;
  });
  // This machine runs both platforms and has the helpers; the boot itself is the service's own concern.
  vi.spyOn(DeviceService.prototype, 'probe').mockResolvedValue({
    ios: { ready: true, xcrun: '/usr/bin/xcrun' },
    android: { ready: true, sdk: '/sdk', adb: '/sdk/adb', emulator: '/sdk/emulator', avdmanager: '/sdk/avdmanager' },
    npm: true,
  });
  vi.spyOn(DeviceService.prototype, 'helpersInstalled').mockReturnValue(true);
  vi.spyOn(DeviceService.prototype, 'open').mockImplementation(async (_caller: DeviceCaller, request: { platform: DevicePlatform }) => ({
    device: { id: `${request.platform}-1`, platform: request.platform, name: 'Pane_Android', os: '15', machine: 'This computer', state: 'booted', paneMade: true },
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('devices open: selecting the device tab', () => {
  it('selects a new device tab by default', async () => {
    await open(setup(), { platform: 'android' });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ type: 'device', activate: true, announceActivation: true });
  });

  it('opens a new device tab in the background with noFocus', async () => {
    await open(setup(), { platform: 'android', noFocus: true });
    expect(created[0]).toMatchObject({ activate: false, announceActivation: false });
  });

  it('leaves an open device tab where it is on a repeated open', async () => {
    const registry = setup();
    await open(registry, { platform: 'android' });
    await open(registry, { platform: 'android' });
    await open(registry, { platform: 'android', noFocus: true });
    expect(created).toHaveLength(1);
    expect(activated).toEqual([]);
  });

  it('reselects an open device tab when focus is asked for', async () => {
    const registry = setup();
    await open(registry, { platform: 'android', noFocus: true });
    await open(registry, { platform: 'android', focus: true });
    expect(created).toHaveLength(1);
    expect(activated).toEqual(['device-1']);
  });

  it('refuses a request with both focus and noFocus before opening anything', async () => {
    const failure = await open(setup(), { platform: 'android', focus: true, noFocus: true }).then(() => undefined, (cause: unknown) => cause);
    expect(failure).toBeInstanceOf(PaneError);
    expect(failure).toMatchObject({ code: 'ERR_DEVICE_INVALID_REQUEST' });
    expect(created).toEqual([]);
  });
});
