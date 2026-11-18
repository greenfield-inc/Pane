import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import type { IpcMain } from 'electron';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { PaneDaemonCaller } from '../../../shared/types/daemon';
import type { DevicePanelState } from '../../../shared/types/devices';
import type { ToolPanel } from '../../../shared/types/panels';
import { PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { panelManager } from '../services/panelManager';
import type { ProbeEnvironment } from '../services/devices/deviceProbe';
import { disposeDevices, registerDeviceHandlers } from './devices';
import type { AppServices } from './types';

// The device tab's channels and the agent's device tools, run for real against stand-in helpers: a
// hub serving one Pane iPhone (booting and shutting it down as asked, kept in a file as a real
// simulator outlives the hub) and an agent-device that saves a recording on `record stop`.
const root = mkdtempSync(path.join(os.tmpdir(), 'pane-device-causes-'));
vi.stubEnv('PANE_DIR', root);

/** The Pane's tabs, as the panel manager keeps them. */
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

/** A Mac with Xcode, as the device service probes it. */
const machine = (): ProbeEnvironment => ({
  platform: 'darwin',
  env: {},
  home: root,
  findExecutable: (name: string) => (name === 'xcrun' ? '/usr/bin/false' : null),
  exists: () => false,
  run: async () => JSON.stringify({ runtimes: [{ platform: 'iOS', isAvailable: true }] }),
});

const HUB = `
const fs = require('fs');
const http = require('http');
const file = require('path').join(__dirname, 'booted.json');
if (!fs.existsSync(file)) fs.writeFileSync(file, 'false');
const server = http.createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.url === '/api/devices/boot') fs.writeFileSync(file, 'true');
  if (request.url === '/api/devices/shutdown') fs.writeFileSync(file, 'false');
  const booted = JSON.parse(fs.readFileSync(file, 'utf8'));
  response.end(request.url === '/api/devices'
    ? JSON.stringify({ simulators: [{ id: 'D1', name: 'Pane iPhone', version: 'iOS 27.0', booted }], emulators: [] })
    : JSON.stringify({ ok: true }));
});
server.listen(0, '127.0.0.1', () => console.log('Local: http://localhost:' + server.address().port + '/?token=test'));
process.on('SIGTERM', () => process.exit(0));
`;
const RECORDING = '/tmp/pane-test/recordings/pane-a-1.mp4';
const AGENT_DEVICE = `const args = process.argv.slice(2); console.log(args[0] === 'record' && args[1] === 'stop' ? JSON.stringify({ path: '${RECORDING}' }) : '{}');`;

const helpers = path.join(root, 'devices', 'helpers', 'agent-device-0.21.36_hub-0.22.1');
mkdirSync(helpers, { recursive: true });
writeFileSync(path.join(helpers, 'hub.js'), HUB);
writeFileSync(path.join(helpers, 'agent-device.js'), AGENT_DEVICE);
writeFileSync(path.join(helpers, 'installed.json'), JSON.stringify({ hub: path.join(helpers, 'hub.js'), agentDevice: path.join(helpers, 'agent-device.js') }));
writeFileSync(path.join(root, 'devices', 'state.json'), JSON.stringify({ made: { D1: { platform: 'ios', name: 'Pane iPhone', createdAt: 0, lastUsedAt: 0, users: [] } } }));

const registry = new PaneCommandRegistry();
const serviceFixture = {
  sessionManager: { getSession: (id: string) => (id === 'pane-a' ? { name: 'qa', worktreePath: mkdtempSync(path.join(os.tmpdir(), 'pane-wt-')) } : undefined), getAllSessions: () => [], on: vi.fn() },
  configManager: { getConfig: () => ({ devices: { enabled: true } }) },
};
// SAFETY: the fixture supplies the AppServices members the device channels read.
// The stand-in simulator stays in one boot for these tests while it runs.
const bootIdentity = async () => (readFileSync(path.join(helpers, 'booted.json'), 'utf8') === 'true' ? 'boot-1' : undefined);
// SAFETY: the stub only records Settings registrations, and the fixture supplies the AppServices members the device channels read.
registerDeviceHandlers({ handle: vi.fn() } as Pick<IpcMain, 'handle'>, serviceFixture as AppServices, registry, { probeEnvironment: machine, bootIdentity });
afterAll(async () => {
  await disposeDevices();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const signal = new AbortController().signal;
const agent: PaneDaemonCaller = { paneId: 'pane-a', panelId: 'agent-tab' };
/** An agent's device tool call. */
const tool = (channel: string, request: PaneCommandValue) => registry.invokeConnected(channel, [request], signal, agent);
/** The person's device tab: runs the channel, throwing its error. */
async function tab(channel: string, ...args: PaneCommandValue[]): Promise<void> {
  // SAFETY: tab channels answer with this envelope; the tests read the tab's state, not the data.
  const answer = await registry.invokeConnected(channel, args, signal) as { success: boolean; error?: string };
  if (!answer.success) throw new Error(answer.error);
}
const tabState = (): DevicePanelState => {
  const panel = [...panels.values()].find(candidate => candidate.type === 'device');
  // SAFETY: device tabs carry DevicePanelState as their custom state.
  return panel?.state.customState as DevicePanelState;
};
const tabId = () => [...panels.values()].find(candidate => candidate.type === 'device')?.id ?? '';
/** The agent opens the iPhone, booting it, and the person starts recording. */
async function openAndRecord(): Promise<void> {
  await tool('runpane:devices:open', { platform: 'ios' });
  expect(tabState().phase).toBe('live');
  await tab('devices:record', tabId(), 'start');
  expect(tabState().recording?.startedAt).toEqual(expect.any(Number));
}

describe('what main records as the cause of each stop', () => {
  it('records the person\'s Stop, with the saved video', async () => {
    await openAndRecord();
    await tab('devices:record', tabId(), 'stop');
    expect(tabState().recordingEnded).toMatchObject({ by: 'person', recording: { path: RECORDING } });
    expect(tabState().recording).toBeUndefined();
  }, 30_000);

  it('records the 10-minute limit only when the limit stopped it', async () => {
    const timers = vi.spyOn(globalThis, 'setTimeout');
    await openAndRecord();
    const cap = timers.mock.calls.find(([, delay]) => delay === 10 * 60_000)?.[0];
    timers.mockRestore();
    expect(cap).toEqual(expect.any(Function));
    // SAFETY: the cap is the callback main gave setTimeout.
    (cap as () => void)();
    await vi.waitFor(() => expect(tabState().recordingEnded).toMatchObject({ by: 'limit', recording: { path: RECORDING } }));
  }, 30_000);

  it('records the agent\'s device_close, saving the recording before the lease ends', async () => {
    await openAndRecord();
    await tool('runpane:devices:close', {});
    expect(tabState()).toMatchObject({ phase: 'closed', stoppedBy: 'agent', recordingEnded: { by: 'agent', recording: { path: RECORDING } } });
  }, 30_000);

  it('records the agent\'s record stop as the agent\'s', async () => {
    await openAndRecord();
    await tool('runpane:devices:act', { args: ['record', 'stop', '--json'] });
    expect(tabState().recordingEnded).toMatchObject({ by: 'agent', recording: { path: RECORDING } });
  }, 30_000);

  it('records the person\'s Shut down, and the recording it cut short as the device\'s, saved', async () => {
    await openAndRecord();
    await tab('devices:power', tabId(), 'shutdown');
    expect(tabState()).toMatchObject({ phase: 'off', stoppedBy: 'person', recordingEnded: { by: 'device', recording: { path: RECORDING } } });
  }, 30_000);

  it('records a device that stopped outside Pane when the tab next reads its controls', async () => {
    await tool('runpane:devices:open', { platform: 'ios' });
    writeFileSync(path.join(helpers, 'booted.json'), 'false');
    // The tab reads its controls every 2 s; the device listing it checks is at most 5 s old.
    await vi.waitFor(async () => {
      await tab('devices:controls', tabId());
      expect(tabState()).toMatchObject({ phase: 'off', stoppedBy: 'outside' });
    }, { timeout: 12_000, interval: 2_000 });
  }, 30_000);

  it('records Pane quitting, for the device it booted and the recording that did not save', async () => {
    await openAndRecord();
    await disposeDevices();
    expect(tabState()).toMatchObject({ phase: 'off', stoppedBy: 'quit', recordingEnded: { by: 'quit' } });
  }, 30_000);
});
