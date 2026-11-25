import { EventEmitter } from 'events';
import { globalShortcut } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { ConfigManager } from '../configManager';
import type { AppConfig } from '../../types/config';
import { DEFAULT_NOTIFY_SETTINGS } from '../../../../shared/types/notify';
import { NotifyService } from './notifyService';

// The one system-wide key Pane holds is the person's answer-all setting (⌃⇧Space by default). The
// approvals catalog keys (⇧⌘A, ⌥⌘A and the rest) are renderer commands that work only while Pane
// is in front (D-381), so starting Approvals must never register them with the OS.
describe('system-wide keys', () => {
  let config: AppConfig;
  let configManager: EventEmitter;
  let service: NotifyService;
  const sent = vi.fn();

  function start(): void {
    class FakeConfigManager extends EventEmitter {
      getConfig(): AppConfig { return config; }
    }
    configManager = new FakeConfigManager();
    // SAFETY: navigate() reads only these members of the main window.
    const window = { isDestroyed: () => false, setOverlayIcon: () => {}, isMinimized: () => false, restore: vi.fn(), show: vi.fn(), focus: vi.fn(), webContents: { send: sent } } as BrowserWindow;
    service = new NotifyService({
      // SAFETY: NotifyService reads only getConfig() and 'config-updated' from its ConfigManager.
      configManager: configManager as ConfigManager,
      getMainWindow: () => window,
      findPane: () => undefined,
      rendererArguments: () => [],
      headless: false,
      machine: 'mini',
      publish: () => {},
      sendToMachine: async () => {},
      refreshMachine: async () => {},
      idleSeconds: () => 0,
    });
  }

  const registered = () => vi.mocked(globalShortcut.register).mock.calls.map(([accelerator]) => accelerator);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv('PANE_DISABLE_OS_INTEGRATION', '1');
    vi.mocked(globalShortcut.register).mockClear();
    vi.mocked(globalShortcut.unregister).mockClear();
    sent.mockClear();
    config = { machineId: 'mini' };
  });

  afterEach(() => {
    service.dispose();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('registers only the answer-all key when Approvals start, none of the in-app approvals keys', () => {
    start();
    expect(DEFAULT_NOTIFY_SETTINGS.shortcut).toBe('Control+Shift+Space');
    expect(registered()).toEqual(['Control+Shift+Space']);
  });

  it('follows the person\'s answer-all setting and releases the old key', () => {
    start();
    config = { ...config, notify: { shortcut: 'Control+Alt+J' } };
    configManager.emit('config-updated', config);
    expect(globalShortcut.unregister).toHaveBeenCalledWith('Control+Shift+Space');
    expect(registered()).toEqual(['Control+Shift+Space', 'Control+Alt+J']);
  });

  it('registers nothing while Approvals are off', () => {
    config = { ...config, notify: { enabled: false } };
    start();
    expect(registered()).toEqual([]);
  });

  it('pressed while Pane is in front, the key opens or closes Approvals in the window', () => {
    start();
    service.setMainWindowFocused(true);
    const [, onPress] = vi.mocked(globalShortcut.register).mock.calls[0];
    onPress();
    expect(sent).toHaveBeenCalledWith('notify:navigate', 'toggle-inbox');
  });
});
