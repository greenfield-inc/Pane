import type { IpcMain } from 'electron';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import type { AppServices } from './types';
import { HostTerminalManager } from '../services/hostTerminalManager';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import type { HostTerminalOpenRequest } from '../../../shared/types/hostTerminal';

const openRequestSchema = boundary.optional(boundary.nullable(boundary.object({
  input: boundary.optional(boundary.string),
})));

/** A remote client's /invoke sends an omitted request as null; both mean "just open". */
export function decodeHostTerminalOpenRequest(request: PaneCommandValue): HostTerminalOpenRequest {
  return decodeBoundary(request, openRequestSchema) ?? {};
}

export function registerHostTerminalHandlers(
  ipcMain: IpcMain,
  services: AppServices,
  commandRegistry: PaneCommandRegistry,
): void {
  const hostTerminal = new HostTerminalManager(services.sessionManager);

  commandRegistry.register('host-terminal:open', async (request: PaneCommandValue) => {
    try {
      const state = await hostTerminal.open(decodeHostTerminalOpenRequest(request));
      return { success: true, data: state };
    } catch (error) {
      console.error('[HostTerminal IPC] Failed to open the host terminal:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to open the host terminal' };
    }
  });
  commandRegistry.bindChannel(ipcMain, 'host-terminal:open');

  commandRegistry.register('host-terminal:get', () => ({ success: true, data: hostTerminal.get() }));
  commandRegistry.bindChannel(ipcMain, 'host-terminal:get');
}
