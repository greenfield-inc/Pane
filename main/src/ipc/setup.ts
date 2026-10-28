import { type IpcMain, dialog } from 'electron';
import { readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppServices } from './types';
import { PaneError, paneErrorText } from '../../../shared/paneError';
import { boundary, decodeBoundary, type JsonValue } from '../../../shared/validation/boundaryDecoder';
import { SETUP_PREFERENCE_KEYS, SETUP_SECTION_IDS, type SetupPreferenceKey } from '../../../shared/types/setupTransfer';
import { detectProjectConfig } from '../services/projectConfigDetector';
import {
  assertSetupFileSize,
  exportSetup,
  previewSetupImport,
  readSetupFile,
  type SetupSources,
} from '../services/setupTransfer';

const ORIGIN_TIMEOUT_MS = 5000;

function failure(error: Error | null, fallback: string) {
  console.error(`[Setup] ${fallback}:`, error);
  return { success: false, error: error instanceof PaneError ? paneErrorText(error) : error?.message || fallback };
}

function todayStamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Settings › Import & Export. These channels are not daemon-owned, so they always read and
 * write this computer's setup; the renderer disables the card while connected to a remote host.
 */
export function registerSetupHandlers(ipcMain: IpcMain, { app, configManager, databaseService, sessionManager, getMainWindow }: AppServices): void {
  const sources = (): SetupSources => {
    const storedPreferences = databaseService.getUserPreferences();
    const preferences: Partial<Record<SetupPreferenceKey, string>> = {};
    for (const key of SETUP_PREFERENCE_KEYS) {
      const value = storedPreferences[key];
      if (value !== undefined) preferences[key] = value;
    }
    const projectById = new Map(databaseService.getAllProjects().map(project => [project.id, project]));
    return {
      config: configManager.getConfig(),
      preferences,
      projects: [...projectById.values()],
      async readOrigin(project) {
        const saved = projectById.get(project.id);
        const ctx = sessionManager.getProjectContextByProjectId(project.id);
        if (!saved || !ctx) return null;
        try {
          const result = await ctx.commandRunner.execAsync('git config --get remote.origin.url', saved.path, { timeout: ORIGIN_TIMEOUT_MS, silent: true });
          return result.stdout.trim() || null;
        } catch {
          return null;
        }
      },
      async detectConfig(project) {
        const saved = projectById.get(project.id);
        const ctx = sessionManager.getProjectContextByProjectId(project.id);
        if (!saved || !ctx) return null;
        return detectProjectConfig(saved.path, ctx.pathResolver.environment, ctx.commandRunner);
      },
      home: os.homedir(),
      platform: process.platform,
      appVersion: app.getVersion(),
    };
  };

  ipcMain.handle('setup:summary', async () => {
    try {
      const { rows } = await exportSetup(sources(), SETUP_SECTION_IDS, new Date());
      return { success: true, data: { rows } };
    } catch (error) {
      return failure(error instanceof Error ? error : null, 'Failed to read this computer\'s setup');
    }
  });

  ipcMain.handle('setup:export', async (_event, rawSections: JsonValue) => {
    try {
      const sections = decodeBoundary(rawSections, boundary.array(boundary.enumeration(...SETUP_SECTION_IDS)));
      const mainWindow = getMainWindow();
      if (!mainWindow) return { success: false, error: 'No main window available' };
      const now = new Date();
      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: `pane-setup-${todayStamp(now)}.json`,
        filters: [{ name: 'Pane setup', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePath) return { success: true, data: null };
      const { file, leftOut } = await exportSetup(sources(), sections, now);
      await writeFile(result.filePath, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
      return { success: true, data: { fileName: path.basename(result.filePath), filePath: result.filePath, leftOut } };
    } catch (error) {
      return failure(error instanceof Error ? error : null, 'Failed to export the setup');
    }
  });

  ipcMain.handle('setup:choose-import', async () => {
    try {
      const mainWindow = getMainWindow();
      if (!mainWindow) return { success: false, error: 'No main window available' };
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Import a Pane setup file',
        properties: ['openFile'],
        filters: [{ name: 'Pane setup', extensions: ['json'] }, { name: 'All files', extensions: ['*'] }],
      });
      const filePath = result.filePaths[0];
      if (result.canceled || !filePath) return { success: true, data: null };
      const fileName = path.basename(filePath);
      assertSetupFileSize((await stat(filePath)).size, fileName);
      const file = readSetupFile(await readFile(filePath, 'utf8'), fileName);
      return { success: true, data: await previewSetupImport(file, fileName, sources()) };
    } catch (error) {
      return failure(error instanceof Error ? error : null, 'Failed to read the setup file');
    }
  });

  ipcMain.handle('setup:preview', async (_event, rawFile: JsonValue, rawFileName: JsonValue) => {
    try {
      const fileName = decodeBoundary(rawFileName, boundary.string);
      // The renderer sends back the file it previewed; validate it again like a new file.
      const file = readSetupFile(JSON.stringify(rawFile), fileName);
      return { success: true, data: await previewSetupImport(file, fileName, sources()) };
    } catch (error) {
      return failure(error instanceof Error ? error : null, 'Failed to preview the setup file');
    }
  });
}
