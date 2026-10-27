import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppUpdater } from 'electron-updater';

export function setupTestUpdater(autoUpdater: AppUpdater) {
  const url = process.env.UPDATE_SERVER_URL || 'http://localhost:8080';
  // Point to local server for testing
  autoUpdater.setFeedURL({ provider: 'generic', url });
  
  // Configure for testing
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  // electron-updater skips every check in an unpackaged build unless forced,
  // and downloads need the update config a packaged build carries.
  autoUpdater.forceDevUpdateConfig = true;
  const devUpdateConfigPath = path.join(os.tmpdir(), 'pane-test-app-update.yml');
  fs.writeFileSync(devUpdateConfigPath, `provider: generic\nurl: ${url}\nupdaterCacheDirName: pane-test-updater\n`);
  autoUpdater.updateConfigPath = devUpdateConfigPath;
  
  // Log all events for debugging
  autoUpdater.logger = console;
  // Set debug level for winston-based loggers if available
  // SAFETY: electron-updater accepts Logger but exposes the configured winston transport only at runtime.
  const logger = autoUpdater.logger as { transports?: { file?: { level: string } } };
  if (logger && logger.transports && logger.transports.file) {
    logger.transports.file.level = 'debug';
  }
}
