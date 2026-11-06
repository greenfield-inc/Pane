import os from 'os';
import type { IpcMain } from 'electron';
import { rejectWithPaneErrorText, type PaneCommandValue } from '../daemon/commandRegistry';
import type { MachineConnections } from '../services/machineConnections';
import { getAppDirectory } from '../utils/appDirectory';
import { moveWorkspaces, scanConductorMove, type MoveTarget } from '../services/sessionImport/conductorMove';
import { localReaderContext } from './sessionImport';
import { PaneError, reasonOf } from '../../../shared/paneError';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import type { ConductorMoveProgress, ConductorMoveRequest, ConductorMoveResult, ConductorMoveScan } from '../../../shared/types/conductorMove';

const requestSchema = boundary.object({ machineId: boundary.nonEmptyString, workspaces: boundary.array(boundary.string) });
const UNKNOWN_COMMAND = 'No Pane daemon command registered';

/**
 * "Move from Conductor": reads Conductor on this Mac and moves chosen workspaces to a saved
 * machine. These channels always run here, even while the window shows another machine.
 */
export function registerConductorMoveHandlers(ipcMain: IpcMain, machines: MachineConnections): void {
  let progress: ConductorMoveProgress = { running: false, done: 0, total: 0 };

  ipcMain.handle('conductor-move:scan', (): Promise<ConductorMoveScan> =>
    rejectWithPaneErrorText(scanConductorMove(localReaderContext()).then(outcome => outcome.scan)));

  ipcMain.handle('conductor-move:progress', (): ConductorMoveProgress => progress);

  ipcMain.handle('conductor-move:run', (_event, request: PaneCommandValue) => rejectWithPaneErrorText((async (): Promise<ConductorMoveResult> => {
    const { machineId, workspaces: keys }: ConductorMoveRequest = decodeBoundary(request, requestSchema);
    if (progress.running) {
      throw new PaneError('ERR_CONDUCTOR_MOVE_RUNNING', 'Pane is already moving Conductor workspaces, so this move was not started.', 'Wait for it to finish, then open Move from Conductor again.');
    }
    const machine = machines.list().find(candidate => candidate.id === machineId && candidate.kind === 'remote');
    const remote = machines.remotes().find(candidate => candidate.id === machineId);
    if (!machine || !remote) {
      throw new PaneError('ERR_CONDUCTOR_MOVE_MACHINE', `No saved machine has the id "${machineId}", so nothing was moved.`, 'Add the machine under Settings → Remote Access, then try again.');
    }
    if (machine.status !== 'online') {
      throw new PaneError('ERR_CONDUCTOR_MOVE_OFFLINE', `${machine.label} is not connected, so nothing was moved.`, `Use Retry on ${machine.label}, then try again once it is back.`);
    }
    progress = { running: true, done: 0, total: keys.length };
    try {
      // Rescan so a chat that started since the dialog was drawn is left alone.
      const fresh = await scanConductorMove(localReaderContext());
      const chosen = keys.flatMap(key => fresh.workspaces.get(key) ?? []);
      const target: MoveTarget = {
        label: machine.label,
        invoke: async (channel, args) => {
          try {
            // SAFETY: every argument the move sends is JSON built from decoded values.
            return await remote.invoke(channel, args as PaneCommandValue[]);
          } catch (error) {
            if (reasonOf(error).includes(UNKNOWN_COMMAND)) {
              throw new PaneError('ERR_CONDUCTOR_MOVE_HOST_OUTDATED', `${machine.label} runs a Pane that can't receive moved workspaces`, `Update Pane on ${machine.label}, then try again.`);
            }
            throw error;
          }
        },
      };
      return await moveWorkspaces({
        workspaces: chosen,
        target,
        machineName: os.hostname(),
        paneDir: getAppDirectory(),
        onProgress: next => { progress = next; },
      });
    } finally {
      progress = { ...progress, running: false };
    }
  })()));
}
