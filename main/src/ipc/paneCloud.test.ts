import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { registerPaneCloudHandlers } from './paneCloud';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pane-cloud-ipc-'));
  vi.stubEnv('PANE_DIR', dir);
  // Nothing listens here: a signed-out manager never calls it.
  vi.stubEnv('PANE_CLOUD_URL', 'http://127.0.0.1:9');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe('Pane Cloud on the daemon', () => {
  it('registers the Pane Cloud machine command that runpane and the MCP call, which answers null while signed out', async () => {
    const commands = new PaneCommandRegistry();
    const ipcMain = { handle: vi.fn() };
    registerPaneCloudHandlers(ipcMain, {
      commands,
      machines: { machineState: () => undefined, run: vi.fn(), invokeOn: vi.fn() },
      configManager: { getConfig: vi.fn(), updateConfigWith: vi.fn() },
      send: () => undefined,
    });

    await expect(commands.invoke('pane-cloud:machine', [])).resolves.toBeNull();
  });
});
