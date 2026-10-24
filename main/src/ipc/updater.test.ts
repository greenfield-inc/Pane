import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import type { AppServices } from './types';
import { registerUpdaterHandlers } from './updater';

const updater = { autoInstallOnAppQuit: false, checkForUpdatesAndNotify: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn() };

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-updater-ipc-'));
  vi.stubEnv('PANE_DIR', root);
  updater.quitAndInstall.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

/** Install a stand-in for the managed runpane engine, then click "Install". */
async function install(engine: string): Promise<{ success: boolean; error?: string }> {
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin', 'runpane.cjs'), engine);
  const handlers = new Map<string, () => Promise<{ success: boolean; error?: string }>>();
  // SAFETY: the handler under test only reads these two members.
  const services = { app: { isPackaged: true }, versionChecker: {} } as AppServices;
  // SAFETY: Electron calls the registered listener with the invoke event, which this handler ignores.
  const ipc = { handle: (name: string, handler: () => Promise<{ success: boolean; error?: string }>) => handlers.set(name, handler) } as IpcMain;
  registerUpdaterHandlers(ipc, services, () => updater);
  return handlers.get('updater:install-update')!();
}

const preflightFailure = (message: string) => `process.stderr.write(${JSON.stringify(message)}); process.exit(1);`;

describe('updater:install-update', () => {
  it('installs with electron-updater when no standalone Node is available', async () => {
    const result = await install(preflightFailure('No independent Node runtime is available; the managed CLI is running inside Electron. Nothing was changed.'));
    expect(result.success).toBe(true);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('installs with electron-updater when a per-machine Windows install is not writable', async () => {
    const result = await install(preflightFailure('The update target is not writable with the current account: C:\\Program Files. Nothing was changed.'));
    expect(result.success).toBe(true);
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
  });

  it('leaves an operation that already reported its status in charge', async () => {
    const result = await install(`console.log(JSON.stringify({ id: 'op', phase: 'needs-attention' })); process.exit(1);`);
    expect(result.success).toBe(false);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('uses the independent update when it starts', async () => {
    const result = await install(`console.log(JSON.stringify({ id: 'op', phase: 'accepted' }));`);
    expect(result).toMatchObject({ success: true, data: { id: 'op' } });
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });
});
