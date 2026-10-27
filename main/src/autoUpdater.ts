import { app, BrowserWindow } from 'electron';
import { createRequire } from 'node:module';
import type { AppUpdater } from 'electron-updater';
import { setupTestUpdater } from './test-updater';
import { getUpdateCapabilities } from './utils/updateCapabilities';
import type { ConfigManager } from './services/configManager';

/** How often a running Pane looks for a new build to download in the background. */
const BACKGROUND_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

const loadUpdaterDependency = createRequire(__filename);

// electron-updater loads ~140 modules and nothing needs it before the window
// is up, so it is required on first use rather than at launch.
export function getAutoUpdater(): AppUpdater {
  const { autoUpdater }: typeof import('electron-updater') = loadUpdaterDependency('electron-updater');
  return autoUpdater;
}

interface AutoUpdaterOptions {
  getMainWindow: () => BrowserWindow | null;
  configManager: ConfigManager;
  onUpdateDownloaded: (version: string) => void;
}

export function setupAutoUpdater({ getMainWindow, configManager, onUpdateDownloaded }: AutoUpdaterOptions): void {
  // Only setup auto-updater for packaged apps (not development)
  if (!app.isPackaged && !process.env.TEST_UPDATES) {
    console.log('[AutoUpdater] App is not packaged, skipping auto-updater setup');
    return;
  }

  const autoUpdater = getAutoUpdater();

  // TEST MODE: Use local server for testing
  if (process.env.TEST_UPDATES === 'true') {
    setupTestUpdater(autoUpdater);
    console.log('[AutoUpdater] Using test update server at:', process.env.UPDATE_SERVER_URL || 'http://localhost:8080');
  } else {
    // Configure electron-updater for production
    autoUpdater.autoDownload = false; // startBackgroundDownloads turns this on when the install can update itself
    autoUpdater.autoInstallOnAppQuit = true;

    // The publish configuration in package.json will be used automatically
    // No need to manually set feed URL with electron-updater
  }

  // Error handling
  autoUpdater.on('error', (error) => {
    console.error('[AutoUpdater] Error:', error);
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:error', {
        message: error.message,
        stack: error.stack
      });
    }
  });

  // Update checking
  autoUpdater.on('checking-for-update', () => {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:checking-for-update');
    }
  });

  // Update available
  autoUpdater.on('update-available', (info) => {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:update-available', info);
    }
  });

  // No update available
  autoUpdater.on('update-not-available', (info) => {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:update-not-available', info);
    }
  });

  // Download progress
  autoUpdater.on('download-progress', (progressInfo) => {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:download-progress', progressInfo);
    }
  });

  // Update downloaded
  autoUpdater.on('update-downloaded', (info) => {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:update-downloaded', info);
      // Let the renderer handle the UI - no native dialog
    }
    onUpdateDownloaded(info.version);
  });

  void startBackgroundDownloads(autoUpdater, configManager);
}

/**
 * Installs that can update themselves check at launch and every 4 hours and
 * download without asking. "Check for updates automatically" turns this off.
 */
async function startBackgroundDownloads(autoUpdater: AppUpdater, configManager: ConfigManager): Promise<void> {
  const testFeed = process.env.TEST_UPDATES === 'true';
  const capabilities = await getUpdateCapabilities({
    platform: process.platform,
    isPackaged: app.isPackaged,
    executablePath: process.execPath,
  });
  if (!testFeed && capabilities.mode !== 'seamless') {
    console.log(`[AutoUpdater] Background downloads off: update mode is ${capabilities.mode} (${capabilities.reason})`);
    return;
  }
  autoUpdater.autoDownload = true;
  const check = () => {
    if (configManager.getConfig().autoCheckUpdates === false) return;
    autoUpdater.checkForUpdates().catch((error: Error) => {
      console.warn('[AutoUpdater] Background update check failed:', error);
    });
  };
  check();
  setInterval(check, BACKGROUND_CHECK_INTERVAL_MS).unref();
}
