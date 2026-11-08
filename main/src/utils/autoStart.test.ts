import type { App } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { syncAutoStartOnBoot } from './autoStart';

describe.skipIf(process.platform === 'linux')('syncAutoStartOnBoot', () => {
  function fakeApp() {
    const setLoginItemSettings = vi.fn<App['setLoginItemSettings']>();
    return { app: { setLoginItemSettings }, setLoginItemSettings };
  }

  it('registers the installed Pane as a login item', () => {
    const { app, setLoginItemSettings } = fakeApp();
    syncAutoStartOnBoot(app, true, { installed: true, env: {} });
    expect(setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });
  });

  it('leaves the login item alone for a dev build, a PANE_DIR instance or disabled OS integration', () => {
    const { app, setLoginItemSettings } = fakeApp();
    syncAutoStartOnBoot(app, true, { installed: false, env: {} });
    syncAutoStartOnBoot(app, false, { installed: false, env: {} });
    syncAutoStartOnBoot(app, true, { installed: true, env: { PANE_DISABLE_OS_INTEGRATION: '1' } });
    expect(setLoginItemSettings).not.toHaveBeenCalled();
  });
});
