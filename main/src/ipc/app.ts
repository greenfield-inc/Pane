import { IpcMain, shell } from 'electron';
import { execFile } from 'child_process';
import type { AppServices } from './types';
import { revealInFileManager } from '../utils/revealInFileManager';
import type { PaneCommandValue } from '../daemon/commandRegistry';
import { decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import {
  overlayColorsSchema,
  WINDOW_CONTROLS_OVERLAY_COLORS_KEY,
  WINDOW_CONTROLS_OVERLAY_HEIGHT,
  type WindowControlsOverlayColors,
} from '../utils/windowControlsOverlay';
import {
  parseStoredBackgroundColors,
  windowBackgroundColorSchema,
  WINDOW_BACKGROUND_COLORS_KEY,
} from '../utils/windowBackgroundColor';

async function openExternalUrl(url: string): Promise<void> {
  if (process.platform === 'darwin') {
    // On macOS, shell.openExternal can fail silently due to permission/entitlement issues.
    // Use the native `open` command which works reliably.
    await new Promise<void>((resolve, reject) => {
      execFile('open', [url], (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  } else {
    await shell.openExternal(url);
  }
}

export function registerAppHandlers(ipcMain: IpcMain, services: AppServices, openExternal: (url: string) => Promise<void> = openExternalUrl): void {
  const { app } = services;

  // Basic app info handlers
  ipcMain.handle('get-app-version', () => {
    return app.getVersion();
  });

  ipcMain.handle('get-platform', () => {
    return process.platform;
  });

  ipcMain.handle('is-packaged', () => {
    return app.isPackaged;
  });

  // The Window Controls Overlay buttons are drawn by the OS, so they cannot pick
  // up our CSS. The renderer resolves the active theme's tokens to hex and posts
  // them here on every theme switch; we also persist the pair so the next window
  // is created already wearing them instead of the system default.
  ipcMain.handle('window:set-title-bar-overlay', (_event, colors: PaneCommandValue) => {
    let normalized: WindowControlsOverlayColors;
    try {
      normalized = decodeBoundary(colors, overlayColorsSchema);
    } catch {
      return { success: false, error: 'Invalid overlay colors' };
    }

    try {
      services.databaseService.setUserPreference(
        WINDOW_CONTROLS_OVERLAY_COLORS_KEY,
        JSON.stringify(normalized)
      );
    } catch (error) {
      // Losing the cache only costs a themed plate on the next cold start.
      console.error('Failed to persist window controls overlay colors:', error);
    }

    const window = services.getMainWindow();
    if (!window || window.isDestroyed()) {
      return { success: false, error: 'No window' };
    }

    try {
      // Throws on platforms without an overlay (macOS, or a Linux desktop that
      // failed the gate), so the renderer can call this unconditionally.
      window.setTitleBarOverlay({ ...normalized, height: WINDOW_CONTROLS_OVERLAY_HEIGHT });
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set title bar overlay',
      };
    }
  });

  ipcMain.handle('window:set-background-color', (_event, payload: PaneCommandValue) => {
    let normalized;
    try {
      normalized = decodeBoundary(payload, windowBackgroundColorSchema);
    } catch {
      return { success: false, error: 'Invalid background color' };
    }
    let stored;
    try {
      stored = parseStoredBackgroundColors(
        services.databaseService.getUserPreference(WINDOW_BACKGROUND_COLORS_KEY) ?? null,
      );
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to read window background colors',
      };
    }
    try {
      services.databaseService.setUserPreference(
        WINDOW_BACKGROUND_COLORS_KEY,
        JSON.stringify({ ...stored, [normalized.theme]: normalized.color }),
      );
    } catch (error) {
      console.error('Failed to persist window background color:', error);
    }
    const window = services.getMainWindow();
    if (!window || window.isDestroyed()) return { success: false, error: 'No window' };
    try {
      window.setBackgroundColor(normalized.color);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to set window background color',
      };
    }
  });

  // System utilities
  ipcMain.handle('openExternal', async (_event, url: string) => {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
        throw new Error('Only HTTP, HTTPS, and mailto URLs can be opened externally');
      }
      await openExternal(parsed.href);
      return { success: true };
    } catch (error) {
      console.error('Failed to open external URL:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to open URL' };
    }
  });

  ipcMain.handle('app:showItemInFolder', async (_event, filePath: string, sessionId?: string) => {
    try {
      let targetPath = filePath;

      // When the caller knows the session, convert stored paths (e.g. in-distro
      // POSIX paths for WSL projects) to ones this process's fs can reach.
      if (sessionId) {
        try {
          const ctx = services.sessionManager.getProjectContext(sessionId);
          if (ctx) {
            targetPath = ctx.pathResolver.toFileSystem(filePath);
          }
        } catch {
          // Fall back to the raw path
        }
      }

      // Validate path exists before showing
      const fs = await import('fs/promises');
      const exists = await fs.access(targetPath).then(() => true).catch(() => false);

      if (!exists) {
        return { success: false, error: 'File does not exist' };
      }

      await revealInFileManager(targetPath);
      return { success: true };
    } catch (error) {
      console.error('Failed to show item in folder:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to show item' };
    }
  });

  // Welcome tracking handler (for compatibility)
  ipcMain.handle('track-welcome-dismissed', () => {
    // This handler exists for compatibility with other parts of the codebase
    // Our Discord popup logic handles this differently
    console.log('[App] Welcome dismissed (tracked for compatibility)');
    return { success: true };
  });

  // App opens tracking
  ipcMain.handle('app:record-open', (_event, welcomeHidden: boolean, discordShown: boolean = false) => {
    try {
      services.databaseService.recordAppOpen(welcomeHidden, discordShown);
      return { success: true };
    } catch (error) {
      console.error('Failed to record app open:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to record app open' };
    }
  });

  ipcMain.handle('app:get-last-open', () => {
    try {
      const lastOpen = services.databaseService.getLastAppOpen();
      return { success: true, data: lastOpen };
    } catch (error) {
      console.error('Failed to get last app open:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get last app open' };
    }
  });

  ipcMain.handle('app:update-discord-shown', () => {
    try {
      services.databaseService.updateLastAppOpenDiscordShown();
      return { success: true };
    } catch (error) {
      console.error('Failed to update discord shown:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update discord shown' };
    }
  });

  // User preferences handlers
  ipcMain.handle('preferences:get', (_event, key: string) => {
    try {
      const value = services.databaseService.getUserPreference(key);
      return { success: true, data: value };
    } catch (error) {
      console.error('Failed to get preference:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get preference' };
    }
  });

  ipcMain.handle('preferences:set', (_event, key: string, value: string) => {
    try {
      services.databaseService.setUserPreference(key, value);
      return { success: true };
    } catch (error) {
      console.error('Failed to set preference:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to set preference' };
    }
  });

  ipcMain.handle('preferences:get-all', () => {
    try {
      const preferences = services.databaseService.getUserPreferences();
      return { success: true, data: preferences };
    } catch (error) {
      console.error('Failed to get all preferences:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to get all preferences' };
    }
  });
}
