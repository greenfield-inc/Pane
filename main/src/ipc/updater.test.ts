import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import type { AppServices } from './types';
import { registerUpdaterHandlers } from './updater';
import { printFailure, RunpaneError } from '../../../packages/runpane/src/errors';

const updater = { autoInstallOnAppQuit: false, checkForUpdatesAndNotify: vi.fn(), downloadUpdate: vi.fn(), quitAndInstall: vi.fn() };

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-updater-ipc-'));
  vi.stubEnv('PANE_DIR', root);
  updater.quitAndInstall.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

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

/** An engine that exits 1 after writing exactly what runpane's `--json` error writer writes. */
function failingEngine(error: RunpaneError): string {
  const output = { stdout: '', stderr: '' };
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output.stdout += String(chunk); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { output.stderr += String(chunk); return true; });
  printFailure(error, true);
  vi.restoreAllMocks();
  return `process.stdout.write(${JSON.stringify(output.stdout)}); process.stderr.write(${JSON.stringify(output.stderr)}); process.exit(1);`;
}

describe('updater:install-update', () => {
  it.each([
    ['no standalone Node is on PATH', new RunpaneError('ERR_UPDATE_PREFLIGHT', 'No independent Node runtime is available; the managed CLI is running inside Electron. Nothing was changed.')],
    ['a per-machine Windows install is not writable', new RunpaneError('ERR_UPDATE_PREFLIGHT', 'The update target is not writable with the current account: C:\\Program Files. Nothing was changed.')],
    ['the standalone Node is unpatched', new RunpaneError('ERR_NODE_RUNTIME', 'Node 26.10.0 is outside runpane\'s patched supported runtimes. No command was run.')],
  ])('installs with electron-updater when %s', async (_case, error) => {
    const result = await install(failingEngine(error));
    expect(result.success).toBe(true);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('leaves an operation that already reported its status in charge', async () => {
    const result = await install(`console.log(JSON.stringify({ id: 'op', phase: 'needs-attention' })); process.exit(1);`);
    expect(result.success).toBe(false);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('reports other runpane failures without a second installer', async () => {
    const result = await install(failingEngine(new RunpaneError('ERR_UPDATE_HELPER_NOT_READY', 'The supervisor did not acknowledge startup. Pane was not shut down.')));
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('did not acknowledge startup') });
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('uses the independent update when it starts', async () => {
    const result = await install(`console.log(JSON.stringify({ id: 'op', phase: 'accepted' }));`);
    expect(result).toMatchObject({ success: true, data: { id: 'op' } });
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });
});
