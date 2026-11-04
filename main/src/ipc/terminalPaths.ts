import type { IpcMain } from 'electron';
import { homedir } from 'os';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import type { TerminalPathContext } from '../../../shared/types/terminalPaths';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import type { AppServices } from './types';

export function registerTerminalPathHandlers(
  ipcMain: IpcMain,
  services: Pick<AppServices, 'sessionManager'>,
  registry: PaneCommandRegistry,
): void {
  registry.register('terminal:getPathContext', async (input: PaneCommandValue): Promise<TerminalPathContext> => {
    const sessionId = decodeBoundary(input, boundary.string);
    const session = services.sessionManager.getSession(sessionId);
    const context = services.sessionManager.getProjectContext(sessionId);
    if (!session || !context) throw new Error('Session not found');
    const { commandRunner, pathResolver } = context;
    let homeDirectory: string | null = homedir();
    if (commandRunner.wslContext) {
      try {
        const result = await commandRunner.execFile('printenv', ['HOME'], session.worktreePath, { timeout: 5000 });
        const home = result.stdout.trim();
        homeDirectory = home.startsWith('/') ? home : null;
      } catch {
        homeDirectory = null;
      }
    }
    return {
      workingDirectory: pathResolver.toFileSystem(session.worktreePath),
      homeDirectory: homeDirectory ? pathResolver.toFileSystem(homeDirectory) : null,
    };
  });
  registry.bindChannels(ipcMain, ['terminal:getPathContext']);
}
