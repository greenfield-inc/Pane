import { IpcMain, dialog } from 'electron';
import { readFile } from 'fs/promises';
import path from 'path';
import type { AppServices } from './types';

export function registerDialogHandlers(ipcMain: IpcMain, { getMainWindow }: AppServices): void {
  ipcMain.handle('dialog:open-file', async (_event, options?: Electron.OpenDialogOptions) => {
    try {
      const mainWindow = getMainWindow();
      if (!mainWindow) {
        return { success: false, error: 'No main window available' };
      }

      const defaultOptions: Electron.OpenDialogOptions = {
        properties: ['openFile'],
        ...options
      };

      const result = await dialog.showOpenDialog(mainWindow, defaultOptions);

      if (result.canceled) {
        return { success: true, data: null };
      }

      return { success: true, data: result.filePaths[0] };
    } catch (error) {
      console.error('Failed to open file dialog:', error);
      return { success: false, error: 'Failed to open file dialog' };
    }
  });

  // Returns the key's contents so the renderer never handles a path it would have to read itself.
  ipcMain.handle('dialog:open-apns-key', async () => {
    try {
      const mainWindow = getMainWindow();
      if (!mainWindow) return { success: false, error: 'No main window available' };
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Choose your APNs key',
        properties: ['openFile'],
        filters: [{ name: 'APNs key', extensions: ['p8'] }],
      });
      const filePath = result.filePaths[0];
      if (result.canceled || !filePath) return { success: true, data: null };
      const privateKey = await readFile(filePath, 'utf8');
      if (!privateKey.includes('PRIVATE KEY')) return { success: false, error: 'That file is not an APNs .p8 key.' };
      // Apple names the file AuthKey_<key ID>.p8.
      const keyId = /^AuthKey_([A-Z0-9]+)\.p8$/i.exec(path.basename(filePath))?.[1] ?? null;
      return { success: true, data: { privateKey, keyId } };
    } catch {
      return { success: false, error: 'Could not read that key file.' };
    }
  });

  ipcMain.handle('dialog:open-directory', async (_event, options?: Electron.OpenDialogOptions) => {
    try {
      const mainWindow = getMainWindow();
      if (!mainWindow) {
        return { success: false, error: 'No main window available' };
      }

      const defaultOptions: Electron.OpenDialogOptions = {
        properties: ['openDirectory'],
        ...options
      };

      const result = await dialog.showOpenDialog(mainWindow, defaultOptions);

      if (result.canceled) {
        return { success: true, data: null };
      }

      return { success: true, data: result.filePaths[0] };
    } catch (error) {
      console.error('Failed to open directory dialog:', error);
      return { success: false, error: 'Failed to open directory dialog' };
    }
  });
} 