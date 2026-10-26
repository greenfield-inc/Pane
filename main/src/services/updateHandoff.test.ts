import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { PaneDaemonServer } from '../daemon/server';
import { PaneError } from '../../../shared/paneError';
import { main } from '../../../packages/runpane/src/cli';

// Drives `runpane update` through the CLI entry point against a real daemon
// socket, for hosts where the independent update refuses to start.
let root: string;
let paneDir: string;
let server: PaneDaemonServer | null;
let output: string[];
const inApp = vi.fn();
const electronVersion = Object.getOwnPropertyDescriptor(process.versions, 'electron');
const argv1 = process.argv[1];

function host(executable: string) {
  return { protocol: 1, machine: os.hostname(), bootId: 'boot', pid: process.pid, executable, version: '2.4.201', paneDir, userData: path.join(root, 'profile'), packaged: true, remoteEnabled: false, remoteHealthy: true, endpointFingerprint: 'fingerprint', active: 0, idle: 0, blocked: 0 };
}

async function startDesktop({ inAppUpdate = true, executable = path.join(root, 'Pane.app/Contents/MacOS/Pane') } = {}) {
  const registry = new PaneCommandRegistry();
  registry.register('runpane:update:host', () => host(executable));
  if (inAppUpdate) registry.register('runpane:update:in-app', () => inApp());
  server = new PaneDaemonServer(registry, paneDir);
  await server.start();
}

/** The Electron-hosted managed CLI, as Pane's terminal shim runs it. */
function runAsManagedCli(pathDirectory: string) {
  Object.defineProperty(process.versions, 'electron', { value: '43.8.3', configurable: true });
  fs.mkdirSync(path.join(paneDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(paneDir, 'bin/runpane.cjs'), '');
  fs.writeFileSync(path.join(paneDir, 'bin/runpane'), '#!/bin/sh\n# pane-managed-runpane-shim v1\n');
  process.argv[1] = path.join(paneDir, 'bin/runpane.cjs');
  vi.stubEnv('PATH', pathDirectory);
}

const update = (...args: string[]) => main(['update', '--json', '--pane-dir', paneDir, ...args]);
const printed = () => JSON.parse(output.join('\n'));

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pane-update-handoff-')));
  paneDir = path.join(root, 'pane');
  fs.mkdirSync(paneDir);
  server = null;
  output = [];
  inApp.mockReset().mockReturnValue({ state: 'installing', fromVersion: '2.4.201', version: '2.4.202' });
  vi.stubEnv('RUNPANE_TELEMETRY_DISABLED', '1');
  vi.spyOn(console, 'log').mockImplementation((line: string) => { output.push(line); });
});

afterEach(async () => {
  await server?.stop();
  if (electronVersion) Object.defineProperty(process.versions, 'electron', electronVersion);
  else Reflect.deleteProperty(process.versions, 'electron');
  process.argv[1] = argv1;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('runpane update hands off to the in-app updater', () => {
  it('installs through the running desktop when no standalone Node is available', async () => {
    await startDesktop();
    runAsManagedCli(path.join(root, 'empty'));
    expect(await update()).toBe(0);
    expect(inApp).toHaveBeenCalledOnce();
    expect(printed()).toMatchObject({
      mode: 'in-app', phase: 'installing', fromVersion: '2.4.201', version: '2.4.202', cliUpdated: true,
      independentRefusal: { code: 'ERR_UPDATE_PREFLIGHT', message: expect.stringContaining('No independent Node runtime') },
    });
  });

  it.skipIf(process.platform === 'win32')('installs through the running desktop when standalone Node is too old', async () => {
    await startDesktop();
    const bin = path.join(root, 'old-node');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\necho 20.18.0\n', { mode: 0o755 });
    runAsManagedCli(bin);
    expect(await update()).toBe(0);
    expect(printed()).toMatchObject({ mode: 'in-app', phase: 'installing', independentRefusal: { code: 'ERR_NODE_RUNTIME' } });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('installs through the running desktop when the installation is not writable', async () => {
    const executable = path.join(root, 'Pane.app/Contents/MacOS/Pane');
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, '', { mode: 0o555 });
    await startDesktop({ executable });
    expect(await update('--pane-only')).toBe(0);
    expect(printed()).toMatchObject({ mode: 'in-app', phase: 'installing', cliUpdated: true, independentRefusal: { code: 'EACCES' } });
  });

  it('says when this CLI is a separate installation the desktop update leaves behind', async () => {
    await startDesktop();
    Object.defineProperty(process.versions, 'electron', { value: '43.8.3', configurable: true });
    vi.stubEnv('PATH', path.join(root, 'empty'));
    expect(await update()).toBe(0);
    expect(printed()).toMatchObject({ cliUpdated: false, next: expect.stringContaining('npm install --global runpane@latest') });
  });

  it('reports a current desktop without restarting it', async () => {
    inApp.mockReturnValue({ state: 'current', fromVersion: '2.4.202', version: '2.4.202' });
    await startDesktop();
    runAsManagedCli(path.join(root, 'empty'));
    expect(await update()).toBe(0);
    expect(printed()).toMatchObject({ phase: 'current', cliUpdated: false, next: 'Pane 2.4.202 is the latest release.' });
  });

  it('tells the caller to open Pane when the desktop is not running', async () => {
    runAsManagedCli(path.join(root, 'empty'));
    await expect(update()).rejects.toMatchObject({ next: expect.stringContaining('Open Pane on this machine') });
  });

  it('points a desktop older than the handoff at its Settings Update button', async () => {
    await startDesktop({ inAppUpdate: false });
    runAsManagedCli(path.join(root, 'empty'));
    await expect(update()).rejects.toMatchObject({ code: 'ERR_UPDATE_IN_APP_UNAVAILABLE', next: expect.stringContaining('Settings') });
  });

  it('relays a desktop that cannot install updates itself', async () => {
    inApp.mockImplementation(() => { throw new PaneError('ERR_UPDATE_IN_APP_UNAVAILABLE', 'In-app update is unsupported in a development build. Nothing was changed.', 'Use a packaged Pane installation.'); });
    await startDesktop();
    runAsManagedCli(path.join(root, 'empty'));
    await expect(update()).rejects.toMatchObject({ code: 'ERR_UPDATE_IN_APP_UNAVAILABLE', next: 'Use a packaged Pane installation.' });
  });

  it('keeps reporting the refusal for requests the in-app updater cannot honor', async () => {
    await startDesktop();
    runAsManagedCli(path.join(root, 'empty'));
    await expect(update('--version', '2.4.190')).rejects.toMatchObject({ code: 'ERR_UPDATE_PREFLIGHT' });
    await expect(update('--cli-only')).rejects.toMatchObject({ code: 'ERR_UPDATE_PREFLIGHT' });
    expect(inApp).not.toHaveBeenCalled();
  });
});
