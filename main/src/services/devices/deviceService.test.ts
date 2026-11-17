import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { DeviceService } from './deviceService';

// Stand-ins installed where Pane looks for its helpers: a hub that serves one booted Pane iPhone
// on loopback, and an agent-device that answers every command.
const HUB = `
const http = require('http');
const server = http.createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  response.end(request.url === '/api/devices'
    ? JSON.stringify({ simulators: [{ id: 'D1', name: 'Pane iPhone', version: 'iOS 27.0', booted: true }], emulators: [] })
    : JSON.stringify({ ok: true }));
});
server.listen(0, '127.0.0.1', () => console.log('Local: http://localhost:' + server.address().port + '/?token=test'));
process.on('SIGTERM', () => process.exit(0));
`;
const AGENT_DEVICE = 'console.log("{}");';

const services: DeviceService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.dispose(); });

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pane-device-service-'));
  const helpers = path.join(root, 'helpers', 'agent-device-0.21.36_hub-0.22.1');
  mkdirSync(helpers, { recursive: true });
  writeFileSync(path.join(helpers, 'hub.js'), HUB);
  writeFileSync(path.join(helpers, 'agent-device.js'), AGENT_DEVICE);
  writeFileSync(path.join(helpers, 'installed.json'), JSON.stringify({ hub: path.join(helpers, 'hub.js'), agentDevice: path.join(helpers, 'agent-device.js') }));
  writeFileSync(path.join(root, 'state.json'), JSON.stringify({ made: { D1: { platform: 'ios', name: 'Pane iPhone', model: 'iPhone 17 Pro', createdAt: 0, lastUsedAt: 0, users: [] } } }));
  const clock = { now: 0 };
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
  });
  services.push(service);
  return { service, clock };
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
