import { isDaemonOwnedChannel } from '../daemon/daemonChannels';
import { rejectWithPaneErrorText, type PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { remotePaneClientController } from '../daemon/client/remotePaneClient';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

interface IpcMainHandleLike {
  // Keep the daemon boundary independent from Electron while retaining the
  // structural portion of IpcMainInvokeEvent needed for handler compatibility.
  handle(
    channel: string,
    listener: (_event: { readonly sender: object }, channel: PaneCommandValue, ...args: PaneCommandValue[]) => Promise<PaneCommandValue>,
  ): void;
}

interface PaneDaemonBridgeRouter {
  invoke(channel: string, args: PaneCommandValue[]): Promise<PaneCommandValue>;
}

export function createDaemonBridgeRouter(commandRegistry: PaneCommandRegistry): PaneDaemonBridgeRouter {
  return {
    async invoke(channel: string, args: PaneCommandValue[]): Promise<PaneCommandValue> {
      return remotePaneClientController.invoke(channel, args, () => commandRegistry.invoke(channel, args));
    },
  };
}

export function registerDaemonBridgeHandlers(
  ipcMain: IpcMainHandleLike,
  bridgeRouter: PaneDaemonBridgeRouter,
): void {
  ipcMain.handle('daemon:invoke', async (_event, channel, ...args) => {
    let decodedChannel: string;
    try {
      decodedChannel = decodeBoundary(channel, boundary.string);
    } catch {
      throw new Error('Pane daemon bridge requires a string channel');
    }

    if (!isDaemonOwnedChannel(decodedChannel)) {
      throw new Error(`Channel "${decodedChannel}" is not daemon-owned`);
    }

    return rejectWithPaneErrorText(bridgeRouter.invoke(decodedChannel, args));
  });
}
