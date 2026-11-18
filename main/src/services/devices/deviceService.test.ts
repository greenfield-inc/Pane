import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';
import { DeviceService, type DeviceChange } from './deviceService';

// Stand-ins installed where Pane looks for its helpers: a hub that serves one Pane iPhone on
// loopback, booting and shutting it down as asked (kept in a file beside it, so the simulator
// outlives the hub as a real one does), and an agent-device that answers every command.
const hub = (booted: boolean, stuck = false) => `
const fs = require('fs');
const http = require('http');
const file = require('path').join(__dirname, 'booted.json');
if (!fs.existsSync(file)) fs.writeFileSync(file, '${booted}');
const server = http.createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.url === '/api/devices/boot') fs.writeFileSync(file, 'true');
  if (request.url === '/api/devices/shutdown' && !${stuck}) fs.writeFileSync(file, 'false');
  const booted = JSON.parse(fs.readFileSync(file, 'utf8'));
  response.end(request.url === '/api/devices'
    ? JSON.stringify({ simulators: [{ id: 'D1', name: 'Pane iPhone', version: 'iOS 27.0', booted }], emulators: [] })
    : JSON.stringify({ ok: true }));
});
server.listen(0, '127.0.0.1', () => console.log('Local: http://localhost:' + server.address().port + '/?token=test'));
process.on('SIGTERM', () => process.exit(0));
`;
const AGENT_DEVICE = 'console.log("{}");';

const services: DeviceService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.dispose(); });

function setup(options: { booted?: boolean; root?: string; stuck?: boolean } = {}) {
  const root = options.root ?? mkdtempSync(path.join(os.tmpdir(), 'pane-device-service-'));
  const helpers = path.join(root, 'helpers', 'agent-device-0.21.36_hub-0.22.1');
  if (!options.root) {
    mkdirSync(helpers, { recursive: true });
    writeFileSync(path.join(helpers, 'hub.js'), hub(options.booted ?? true, options.stuck));
    writeFileSync(path.join(helpers, 'agent-device.js'), AGENT_DEVICE);
    writeFileSync(path.join(helpers, 'installed.json'), JSON.stringify({ hub: path.join(helpers, 'hub.js'), agentDevice: path.join(helpers, 'agent-device.js') }));
    writeFileSync(path.join(root, 'state.json'), JSON.stringify({ made: { D1: { platform: 'ios', name: 'Pane iPhone', model: 'iPhone 17 Pro', createdAt: 0, lastUsedAt: 0, users: [] } } }));
  }
  const clock = { now: 0 };
  const changes: DeviceChange[] = [];
  const service = new DeviceService({
    root,
    machineName: () => 'Test Mac',
    findExecutable: () => null,
    node: { executable: process.execPath, env: {} },
    now: () => clock.now,
    probeEnvironment: () => ({
      platform: 'darwin',
      env: {},
      home: root,
      findExecutable: (name) => (name === 'xcrun' ? '/usr/bin/false' : null),
      exists: () => false,
      run: async () => JSON.stringify({ runtimes: [{ platform: 'iOS', isAvailable: true }] }),
    }),
    maxBooted: () => 1,
    paneName: (paneId) => paneId,
    onChange: (change) => changes.push(change),
  });
  services.push(service);
  /** Why each shutdown and release happened, in order. */
  const stops = () => changes.flatMap(change => change.kind === 'shutdown' ? [`shutdown by ${change.by}`] : change.kind === 'released' ? [`released ${change.reason}${change.by ? ` by ${change.by}` : ''}`] : []);
  return { service, clock, root, stops };
}

const paneA = { paneId: 'pane-a', paneName: 'pane-a' };
const paneB = { paneId: 'pane-b', paneName: 'pane-b' };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a device another Pane holds', () => {
  it('keeps the second Pane waiting until 60 seconds pass, then names the holder', async () => {
    const { service, clock } = setup();
    await service.open(paneA, { platform: 'ios' });
    let failure: unknown;
    const waiting = service.open(paneB, { platform: 'ios' }).catch((cause: unknown) => { failure = cause; });
    await pause(500);
    clock.now = 59_000;
    await pause(2_500);
    expect(failure).toBeUndefined();
    clock.now = 61_000;
    await waiting;
    expect(failure).toMatchObject({ code: 'ERR_DEVICE_BUSY', holder: 'pane-a' });
  }, 20_000);

  it('goes to the waiting Pane once the holder closes it', async () => {
    const { service } = setup();
    await service.open(paneA, { platform: 'ios' });
    const waiting = service.open(paneB, { platform: 'ios' });
    await pause(500);
    await service.close(paneA);
    await expect(waiting).resolves.toMatchObject({ device: { id: 'D1' } });
    expect(service.lifecycle.holderOf('D1')).toBe('pane-b');
  }, 20_000);
});

describe('why a device stopped', () => {
  it('says the person shut it down from the tab', async () => {
    const { service, stops } = setup({ booted: false });
    await service.open(paneA, { platform: 'ios' });
    await service.shutdownDevice('D1');
    expect(stops()).toEqual(['released closed by person', 'shutdown by person']);
  }, 20_000);

  it('says an agent\'s device_close let it go, and leaves it running for the next open', async () => {
    const { service, stops } = setup({ booted: false });
    await service.open(paneA, { platform: 'ios' });
    await service.close(paneA);
    expect(stops()).toEqual(['released closed by agent']);
    expect(await service.isBooted('D1')).toBe(true);
  }, 20_000);

  it('says the idle timer shut down a device Pane booted, after 10 minutes unwatched', async () => {
    const { service, clock, stops } = setup({ booted: false });
    await service.open(paneA, { platform: 'ios' });
    clock.now = 11 * 60_000;
    await service.sweep();
    expect(stops()).toEqual(['released idle', 'shutdown by idle']);
  }, 20_000);

  it('never shuts down a device the person booted, idle or on quit', async () => {
    const { service, clock, stops } = setup({ booted: true });
    await service.open(paneA, { platform: 'ios' });
    clock.now = 60 * 60_000;
    await service.sweep();
    await service.dispose();
    expect(stops()).toEqual(['released idle']);
  }, 20_000);
});

describe('devices Pane booted, when Pane stops', () => {
  it('shuts them down when Pane quits', async () => {
    const { service, stops } = setup({ booted: false });
    await service.open(paneA, { platform: 'ios' });
    await service.dispose();
    expect(stops()).toEqual(['shutdown by quit']);
  }, 20_000);

  it('shuts down at the next start what a crash left running', async () => {
    const first = setup({ booted: false });
    await first.service.open(paneA, { platform: 'ios' });
    // A crash: no dispose. The next run reads what Pane booted from its state file.
    const next = setup({ root: first.root });
    expect(await next.service.shutDownLeftovers()).toEqual(['D1']);
    expect(next.stops()).toEqual(['shutdown by quit']);
    expect(await next.service.shutDownLeftovers()).toEqual([]);
  }, 20_000);

  it('stops the device hub a crashed run left running', async () => {
    const first = setup({ booted: false });
    await first.service.open(paneA, { platform: 'ios' });
    const { pid } = decodeBoundary(JSON.parse(readFileSync(path.join(first.root, 'hub.json'), 'utf8')), boundary.object({ pid: boundary.number }));
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    expect(alive()).toBe(true);
    const next = setup({ root: first.root });
    await next.service.shutDownLeftovers();
    await expect.poll(alive, { timeout: 5_000 }).toBe(false);
  }, 20_000);

  it('leaves running a leftover that an agent in this run has opened again', async () => {
    const first = setup({ booted: false });
    await first.service.open(paneA, { platform: 'ios' });
    const next = setup({ root: first.root });
    await next.service.open(paneA, { platform: 'ios' });
    expect(await next.service.shutDownLeftovers()).toEqual([]);
    expect(await next.service.isBooted('D1')).toBe(true);
    // It is still Pane's to shut down: quitting does.
    await next.service.dispose();
    expect(next.stops()).toEqual(['shutdown by quit']);
  }, 20_000);

  it('shuts down a Pane-made device an earlier version left running, whose state file has no list yet', async () => {
    const { service, stops } = setup({ booted: true });
    expect(await service.shutDownLeftovers()).toEqual(['D1']);
    expect(stops()).toEqual(['shutdown by quit']);
  }, 20_000);

  it('keeps a device that would not shut down on its list, so the next start tries again', async () => {
    const { service, clock, stops } = setup({ booted: false, stuck: true });
    await service.open(paneA, { platform: 'ios' });
    const shuttingDown = service.shutdownDevice('D1');
    await pause(1_500);
    clock.now += 61_000;
    await expect(shuttingDown).rejects.toMatchObject({ code: 'ERR_DEVICE_SHUTDOWN_TIMEOUT' });
    expect(stops()).not.toContain('shutdown by person');
    expect(service.lifecycle.booted()).toEqual(['D1']);
    // Quitting tries once more; the stuck device times out again, against the same clock.
    const quitting = service.dispose();
    await pause(1_500);
    clock.now += 61_000;
    await quitting;
  }, 20_000);

  it('shuts it down at once when its Pane is archived', async () => {
    const { service, stops } = setup({ booted: false });
    await service.open(paneA, { platform: 'ios' });
    await service.paneArchived('pane-a');
    expect(stops()).toEqual(['released archived', 'shutdown by archived']);
  }, 20_000);

  it('shuts it down at once when a linked computer quitting closes its Pane\'s device', async () => {
    const { service, stops } = setup({ booted: false });
    await service.open(paneA, { platform: 'ios' });
    await service.close(paneA, undefined, { shutdownBy: 'quit' });
    expect(stops()).toEqual(['released closed by agent', 'shutdown by quit']);
  }, 20_000);

  it('leaves a device the person booted running when their linked computer quits', async () => {
    const { service, stops } = setup({ booted: true });
    await service.open(paneA, { platform: 'ios' });
    expect(await service.close(paneA, undefined, { shutdownBy: 'quit' })).toMatchObject({ shutDown: [] });
    expect(stops()).toEqual(['released closed by agent']);
  }, 20_000);

  it('shuts down even a device the person booted when they press Shut down on a linked computer, and says so when asked', async () => {
    const { service, stops } = setup({ booted: true });
    await service.open(paneA, { platform: 'ios' });
    expect(await service.status('pane-a')).toEqual({ held: true, booted: true });
    expect(await service.close(paneA, undefined, { shutdownBy: 'person' })).toMatchObject({ closed: ['D1'], shutDown: ['D1'] });
    expect(stops()).toEqual(['released closed by person', 'shutdown by person']);
    expect(await service.status('pane-a')).toEqual({ held: false, booted: false, stoppedBy: 'person' });
  }, 20_000);

  it('tells a linked computer its device idled out here', async () => {
    const { service, clock } = setup({ booted: false });
    await service.open(paneA, { platform: 'ios' });
    clock.now = 11 * 60_000;
    await service.sweep();
    expect(await service.status('pane-a')).toEqual({ held: false, booted: false, stoppedBy: 'idle' });
  }, 20_000);
});
