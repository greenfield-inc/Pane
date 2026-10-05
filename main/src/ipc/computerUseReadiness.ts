import { shell, type IpcMain } from 'electron';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import type { ComputerUseReadinessService } from '../services/computerUse/readiness';
import { requestCuaDriverPermissions } from '../services/computerUse/cuaDriver';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import {
  COMPUTER_USE_ENGINE_CHOICES,
  computerUseStatusText,
  type ComputerUsePermission,
  type ComputerUseReadiness,
} from '../../../shared/types/computerUse';

const COMPUTER_USE_READINESS_CHANNELS = [
  'computer-use:readiness',
  'computer-use:set',
  'computer-use:recheck',
  'computer-use:open-permission-settings',
] as const;

const setRequestSchema = boundary.object({
  enabled: boundary.boolean,
  engine: boundary.optional(boundary.enumeration(...COMPUTER_USE_ENGINE_CHOICES)),
});

const MAC_PRIVACY_PANES = {
  'Screen Recording': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  Accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
} satisfies Record<ComputerUsePermission, string>;

/** Adds the status line as of now, for the runpane CLI; the desktop renders its own so "checked" stays live. */
function withStatusText(readiness: ComputerUseReadiness): ComputerUseReadiness & { statusText: string } {
  return { ...readiness, statusText: computerUseStatusText(readiness, Date.now()) };
}

/**
 * Computer use is per machine, so these channels are daemon-owned: from the
 * host switcher they read and change the connected host. They are never MCP
 * tools, so an agent cannot turn computer use on for itself.
 */
export function registerComputerUseReadinessHandlers(
  ipcMain: IpcMain,
  commandRegistry: PaneCommandRegistry,
  readiness: ComputerUseReadinessService,
): void {
  commandRegistry.register('computer-use:readiness', () => withStatusText(readiness.get()));
  commandRegistry.register('computer-use:set', async (request: PaneCommandValue) =>
    withStatusText(await readiness.set(decodeBoundary(request, setRequestSchema))));
  commandRegistry.register('computer-use:recheck', async () => withStatusText(await readiness.check()));
  // Opens the pane on the machine that needs the grant, which may be a remote host.
  commandRegistry.register('computer-use:open-permission-settings', async () => {
    const current = readiness.get();
    if (process.platform !== 'darwin' || current.state !== 'needs-permission') return false;
    // Cua Driver appears in the Privacy lists only after it has asked once.
    await requestCuaDriverPermissions();
    await shell.openExternal(MAC_PRIVACY_PANES[current.permission]);
    return true;
  });
  commandRegistry.bindChannels(ipcMain, COMPUTER_USE_READINESS_CHANNELS);
}
