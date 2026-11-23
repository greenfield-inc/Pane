// Pane's main-process entry. It sets Electron's switches, then loads the headless daemon
// (`--daemon-headless`) or the desktop app (desktop.ts), so a daemon never loads the window,
// menus or updater.
// Answer --version before any import below logs or touches the database.
import './versionQuery';
// Load ReadableStream polyfill before any other imports
import './polyfills/readablestream';
import { hasHeadlessDaemonLaunchArg, hasRemoteSetupLaunchArg } from './utils/runtimeMode';
import { getAppDirectory } from './utils/appDirectory';
import { readFileSync } from 'fs';
import { join } from 'path';
import { boundary, decodeBoundary } from '../../shared/validation/boundaryDecoder';

const launchHeadlessDaemon = hasHeadlessDaemonLaunchArg();
const launchRemoteSetup = hasRemoteSetupLaunchArg();

// Fix GTK 2/3 and GTK 4 conflict on Linux (Electron 36 issue)
// This MUST be done before importing electron
import { app, protocol } from 'electron';

protocol.registerSchemesAsPrivileged([{
  scheme: 'pane-media',
  privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true },
}]);

if (process.platform === 'darwin') {
  // Work around unrecoverable Skia Graphite rendering glitches on macOS.
  // https://github.com/electron/electron/pull/49608
  app.commandLine.appendSwitch('disable-skia-graphite');
}

function getStartupTerminalPowerMode(): 'performance' | 'batterySaver' {
  try {
    const rawConfig = decodeBoundary(JSON.parse(
      readFileSync(join(getAppDirectory(), 'config.json'), 'utf-8'),
    ), boundary.object({ terminalPowerMode: boundary.optional(boundary.string) }));

    return rawConfig.terminalPowerMode === 'batterySaver'
      ? 'batterySaver'
      : 'performance';
  } catch {
    return 'performance';
  }
}

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('gtk-version', '3');

  if (launchHeadlessDaemon || launchRemoteSetup) {
    // Ozone has already picked its platform by the time this script runs, so
    // appending --ozone-platform here cannot select headless: no-display Linux
    // launches must pass `--ozone-platform=headless` as argv. (Before Electron
    // 38, ELECTRON_OZONE_PLATFORM_HINT=headless did that for us; the variable
    // was removed in 38 and is a no-op from 39 on.) --disable-gpu is still read
    // late enough to take effect here.
    app.commandLine.appendSwitch('disable-gpu');
  }
}

if (getStartupTerminalPowerMode() === 'batterySaver') {
  app.commandLine.appendSwitch('force_low_power_gpu');
}

// Set Windows AUMID to match electron-builder's appId so Windows resolves
// the installed Start Menu shortcut for notification icon and display name.
// Dev builds get their own id: Electron writes a Start Menu shortcut for the
// running exe, and one claiming the installed id makes notification clicks
// launch a bare electron.exe.
if (process.platform === 'win32') {
  app.setAppUserModelId(app.isPackaged ? 'com.dcouple.pane' : 'com.dcouple.pane.dev');
}

// A synchronous require, so a module that throws while loading still fails the launch as it did
// when this file imported everything.
if (launchHeadlessDaemon) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./daemon/headless');
} else {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./desktop');
}
