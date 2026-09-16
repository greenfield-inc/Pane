// Test setup file for Vitest
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { vi } from 'vitest';

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

export const BrowserWindow = vi.fn();

export const nativeTheme = {
  // SAFETY: Test stub models Electron's writable three-value themeSource property.
  themeSource: 'system' as 'system' | 'light' | 'dark',
  shouldUseDarkColors: false,
  on: vi.fn(),
  removeListener: vi.fn(),
};

// Minimal `MessagePortMain` / `MessageChannelMain` stand-ins. Real ports need a
// live Electron runtime; `PtyHostSupervisor.attachWindow` only exercises
// start/on/postMessage/close, so a recording stub is enough to assert the
// port-pair lifecycle.

/** Frames the supervisor and renderer exchange over a ptyHost data port. */
export interface FakePortFrame {
  type: string;
  ptyId?: string;
  data?: string;
  bytes?: number;
  exitCode?: number | null;
  signal?: number | null;
}

/** Shape of the `message` event Electron delivers on a `MessagePortMain`. */
export interface FakePortMessageEvent {
  data: FakePortFrame;
}

export type FakePortListener = (event: FakePortMessageEvent) => void;

export class FakeMessagePortMain {
  started = false;
  closed = false;
  readonly posted: FakePortFrame[] = [];
  readonly listeners = new Map<string, FakePortListener[]>();

  start(): void {
    this.started = true;
  }

  on(event: string, listener: FakePortListener): this {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return this;
  }

  postMessage(message: FakePortFrame): void {
    this.posted.push(message);
  }

  close(): void {
    this.closed = true;
  }
}

export class MessageChannelMain {
  /** Every channel built during a test, so specs can inspect the main-side end. */
  static readonly instances: MessageChannelMain[] = [];

  readonly port1 = new FakeMessagePortMain();
  readonly port2 = new FakeMessagePortMain();

  constructor() {
    MessageChannelMain.instances.push(this);
  }
}

export const panelManager = {
  emitPanelEvent: vi.fn(),
  getPanel: vi.fn(),
  updatePanel: vi.fn(),
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
