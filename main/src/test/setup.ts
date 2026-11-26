// Test setup file for Vitest
import { EventEmitter } from 'events';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, vi } from 'vitest';
import type { ToolPanel } from '../../../shared/types/panels';
import { guardFileState } from '../../../shared/testing/fileStateGuard';

// Isolation is off (vitest.config.ts), so one worker runs many test files and
// this file runs at the start of each. Do the module reset isolation would have
// done: every module an earlier file evaluated is evaluated again, including
// the cached results of its vi.mock factories ('mock:' entries), which
// vi.resetModules() keeps. Vitest 2 exposes the cache only on its worker state.
// This file is skipped because it is the module running now.
interface CachedModule {
  exports?: unknown;
}
interface ModuleCache {
  forEach(fn: (mod: CachedModule, id: string) => void): void;
  invalidateModule(mod: CachedModule): boolean;
}
// SAFETY: Vitest 2 sets __vitest_worker__ in every test worker before setup
// files run; its moduleCache is vite-node's ModuleCacheMap, typed here to the
// two members used.
const workerState = (globalThis as { __vitest_worker__?: { moduleCache: ModuleCache } }).__vitest_worker__;
workerState?.moduleCache.forEach((mod, id) => {
  if (/\/(vitest|vite-node)\/dist\/|\/src\/test\/setup\.ts$/.test(id)) return;
  workerState.moduleCache.invalidateModule(mod);
});

// Every module that imports services/database opens `${PANE_DIR}/sessions.db`
// and runs the startup migrations at import time. Point that at a scratch
// directory so a test run can never touch the developer's live ~/.pane.
process.env.PANE_DIR = mkdtempSync(join(tmpdir(), 'pane-vitest-'));

// Voice and model provider keys fall back to these variables when config has
// none, so a key in the developer's shell would change what tests observe.
for (const name of ['OPENROUTER_API_KEY', 'DEEPGRAM_API_KEY', 'FAL_KEY']) {
  delete process.env[name];
}

export const app = {
  getPath: vi.fn(() => '/mock/path'),
  getName: vi.fn(() => 'Pane'),
  getVersion: vi.fn(() => '0.1.0'),
  on: vi.fn(),
  focus: vi.fn(),
  setBadgeCount: vi.fn(),
};

export const globalShortcut = {
  register: vi.fn(() => true),
  unregister: vi.fn(),
};

export const Notification = { isSupported: vi.fn(() => false) };

export class Tray {
  setImage = vi.fn();
  setToolTip = vi.fn();
  setContextMenu = vi.fn();
  destroy = vi.fn();
}

export const Menu = {
  buildFromTemplate: vi.fn(() => ({})),
  setApplicationMenu: vi.fn(),
};

export const nativeImage = {
  createFromPath: vi.fn(() => ({})),
};

export const ipcMain = {
  handle: vi.fn(),
  on: vi.fn(),
  removeHandler: vi.fn(),
};

export const powerSaveBlocker = {
  start: vi.fn(() => 1),
  stop: vi.fn(),
  isStarted: vi.fn(() => false),
};

export const powerMonitor = Object.assign(new EventEmitter(), {
  isOnBatteryPower: vi.fn(() => false),
});

export const BrowserWindow = Object.assign(vi.fn(), { getAllWindows: vi.fn(() => []), fromWebContents: vi.fn(() => null) });

export const nativeTheme = {
  // SAFETY: Test stub models Electron's writable three-value themeSource property.
  themeSource: 'system' as 'system' | 'light' | 'dark',
  shouldUseDarkColors: false,
  on: vi.fn(),
  removeListener: vi.fn(),
};

export const panelManager = {
  emitPanelEvent: vi.fn(),
  getPanel: vi.fn(),
  getPanelsForSession: vi.fn((): ToolPanel[] => []),
  updatePanel: vi.fn(),
  commitPaused: vi.fn(),
};

// Set up global test environment
global.console = {
  ...console,
  // Suppress logs during tests unless debugging
  log: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

guardFileState({ afterAll, vi });
