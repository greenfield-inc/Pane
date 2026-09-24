import { clipboard, IpcMain } from 'electron';
import type { AppServices } from './types';
import { getAutoUpdater } from '../autoUpdater';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { commandExecutor } from '../utils/commandExecutor';
import { getCurrentWorktreeName } from '../utils/worktreeUtils';
import { getAppDirectory } from '../utils/appDirectory';
import { getUpdateCapabilities } from '../utils/updateCapabilities';

const MAC_UPDATE_COMMAND = 'curl -fsSL https://runpane.com/install.sh | sh';

export function registerUpdaterHandlers(ipcMain: IpcMain, { app, versionChecker }: AppServices): void {
  ipcMain.handle('updater:get-capabilities', async () => ({
    success: true,
    data: await getUpdateCapabilities({
      platform: process.platform,
      isPackaged: app.isPackaged,
      executablePath: process.execPath,
    }),
  }));

  // Version checking handlers
  ipcMain.handle('version:check-for-updates', async () => {
    try {
      const versionInfo = await versionChecker.checkForUpdates();
      return { success: true, data: versionInfo };
    } catch (error) {
      console.error('Failed to check for updates:', error);
      return { success: false, error: 'Failed to check for updates' };
    }
  });

  ipcMain.handle('version:get-info', async () => {
    try {
      console.log('🚀 [WORKTREE DEBUG] version:get-info called - NEW BUILD!');
      console.log('🚀 [WORKTREE DEBUG] app.isPackaged:', app.isPackaged);
      console.log('🚀 [WORKTREE DEBUG] process.cwd():', process.cwd());
      
      let buildDate: string | undefined;
      let gitCommit: string | undefined;
      let buildTimestamp: number | undefined;
      let worktreeName: string | undefined;
      
      // Try to read build info if in packaged app
      if (app.isPackaged) {
        try {
          // Packaged builds are asar-archived by default (Resources/app.asar), but
          // asar can be disabled (Resources/app); check both so this works either way.
          const buildInfoCandidates = [
            path.join(process.resourcesPath, 'app.asar', 'main', 'dist', 'buildInfo.json'),
            path.join(process.resourcesPath, 'app', 'main', 'dist', 'buildInfo.json'),
          ];
          const buildInfoPath = buildInfoCandidates.find((candidate) => fs.existsSync(candidate));
          if (buildInfoPath) {
            const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'));
            buildDate = buildInfo.buildDate;
            gitCommit = buildInfo.gitCommit;
            buildTimestamp = buildInfo.buildTimestamp;
          }
        } catch (err) {
          console.log('Could not read build info:', err);
        }
      }

      // For development builds, try to get git commit hash dynamically
      if (!app.isPackaged) {
        console.log('[Version Debug] Development mode detected, getting git info...');
        try {
          const gitHash = (await commandExecutor.execAsync('git rev-parse --short HEAD', {
            cwd: process.cwd()
          })).stdout.trim();
          
          // Check if the working directory is clean (no uncommitted changes)
          try {
            await commandExecutor.execAsync('git diff-index --quiet HEAD --', {
              cwd: process.cwd(),
              silent: true
            });
            gitCommit = gitHash;
          } catch {
            // Working directory has uncommitted changes
            gitCommit = `${gitHash} (modified)`;
          }
          console.log('[Version Debug] Git commit:', gitCommit);
        } catch (err) {
          console.log('Could not get git commit:', err);
          gitCommit = 'unknown';
        }

        // Detect current worktree name for development builds only
        worktreeName = getCurrentWorktreeName(process.cwd());
        console.log('[Version Debug] Worktree name:', worktreeName);
      }

      interface VersionResponseData {
        current: string;
        name: string;
        workingDirectory: string;
        appDirectory: string;
        buildDate?: string;
        gitCommit?: string;
        buildTimestamp?: number;
        worktreeName?: string;
      }

      const responseData: VersionResponseData = {
        current: app.getVersion(),
        name: app.getName(),
        workingDirectory: process.cwd(),
        appDirectory: getAppDirectory(),
        buildDate,
        gitCommit,
        buildTimestamp
      };

      // Only include worktreeName in development builds and when defined
      if (!app.isPackaged && worktreeName) {
        responseData.worktreeName = worktreeName;
        console.log('[Version Debug] Adding worktreeName to response:', worktreeName);
      } else {
        console.log('[Version Debug] Not adding worktreeName. isPackaged:', app.isPackaged, 'worktreeName:', worktreeName);
      }

      console.log('[Version Debug] Final response data:', responseData);
      return {
        success: true,
        data: responseData
      };
    } catch (error) {
      console.error('Failed to get version info:', error);
      return { success: false, error: 'Failed to get version info' };
    }
  });

  // Auto-updater handlers
  ipcMain.handle('updater:check-and-download', async () => {
    try {
      if (!app.isPackaged && !process.env.TEST_UPDATES) {
        return { success: false, error: 'Auto-update is only available in packaged apps' };
      }

      // Check for updates using autoUpdater
      const result = await getAutoUpdater().checkForUpdatesAndNotify();

      return { success: true, message: 'Checking for updates...', data: result };
    } catch (error) {
      console.error('Failed to check for updates with autoUpdater:', error);
      return { success: false, error: 'Failed to check for updates' };
    }
  });

  ipcMain.handle('updater:download-update', async () => {
    try {
      if (!app.isPackaged && !process.env.TEST_UPDATES) {
        return { success: false, error: 'Auto-update is only available in packaged apps' };
      }

      // Start downloading the update
      const result = await getAutoUpdater().downloadUpdate();

      return { success: true, message: 'Downloading update...', data: result };
    } catch (error) {
      console.error('Failed to download update:', error);
      return { success: false, error: 'Failed to download update' };
    }
  });

  ipcMain.handle('updater:copy-update-command', () => {
    try {
      clipboard.writeText(MAC_UPDATE_COMMAND);
      return { success: true, data: { command: MAC_UPDATE_COMMAND } };
    } catch (error) {
      console.error('Failed to copy update command:', error);
      return { success: false, error: 'Failed to copy update command' };
    }
  });

  ipcMain.handle('updater:open-terminal-with-command', async () => {
    try {
      if (process.platform !== 'darwin') {
        return { success: false, error: 'Opening Terminal is only available on macOS' };
      }

      clipboard.writeText(MAC_UPDATE_COMMAND);
      await new Promise<void>((resolve, reject) => {
        execFile('open', ['-a', 'Terminal'], (error) => {
          if (error) reject(error);
          else resolve();
        });
      });

      return { success: true, data: { command: MAC_UPDATE_COMMAND } };
    } catch (error) {
      console.error('Failed to open Terminal with update command:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to open Terminal' };
    }
  });

  ipcMain.handle('updater:install-update', () => {
    try {
      if (!app.isPackaged && !process.env.TEST_UPDATES) {
        return { success: false, error: 'Auto-update is only available in packaged apps' };
      }

      // Quit and install the update
      getAutoUpdater().quitAndInstall(false, true);

      return { success: true, message: 'Installing update...' };
    } catch (error) {
      console.error('Failed to install update:', error);
      return { success: false, error: 'Failed to install update' };
    }
  });
}
