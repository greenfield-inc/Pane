import type { IpcMain } from 'electron';
import type { PaneCommandRegistry } from '../daemon/commandRegistry';
import { browseHostDirectories, createHostDirectory, hostPathFailure } from '../services/hostPaths';
import type { BrowseDirectoriesRequest, CreateDirectoryRequest } from '../../../shared/types/hostPaths';

const DAEMON_HOST_FS_CHANNELS = [
  'fs:browse-directories',
  'fs:create-directory',
] as const;

/**
 * Folder browsing for repo dialogs. These run on the daemon of the active
 * host, so a remote host's dialogs list that host's folders, not this computer's.
 */
export function registerHostFsHandlers(ipcMain: IpcMain, commandRegistry: PaneCommandRegistry): void {
  commandRegistry.register('fs:browse-directories', async (request?: BrowseDirectoriesRequest) => {
    try {
      return { success: true, data: await browseHostDirectories(request ?? {}, { hostLabel: request?.hostLabel }) };
    } catch (error) {
      return hostPathFailure(error) ?? { success: false, error: 'Failed to list folders' };
    }
  });

  commandRegistry.register('fs:create-directory', async (request: CreateDirectoryRequest) => {
    try {
      return { success: true, data: await createHostDirectory(request, { hostLabel: request.hostLabel }) };
    } catch (error) {
      return hostPathFailure(error) ?? { success: false, error: 'Failed to create folder' };
    }
  });

  commandRegistry.bindChannels(ipcMain, DAEMON_HOST_FS_CHANNELS);
}
