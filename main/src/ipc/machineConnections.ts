import type { IpcMain, WebContents } from 'electron';
import { rejectWithPaneErrorText, type PaneCommandValue } from '../daemon/commandRegistry';
import type { MachineConnections } from '../services/machineConnections';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

const readSchema = boundary.object({
  machineId: boundary.nonEmptyString,
  channel: boundary.nonEmptyString,
  args: boundary.array(boundary.json),
});

/**
 * The renderer's channels for every machine: `machines:list`, `machines:read`, `machines:run`,
 * `machines:retry`, and `machines:event` pushed to each window that sent `machines:subscribe`.
 */
export function registerMachineConnectionHandlers(ipcMain: IpcMain, machines: MachineConnections): void {
  // Only windows showing every machine pay for its events.
  const subscribers = new Set<WebContents>();
  machines.subscribe((event) => {
    for (const contents of subscribers) {
      if (contents.isDestroyed()) subscribers.delete(contents);
      else contents.send('machines:event', event);
    }
  });
  ipcMain.on('machines:subscribe', (event, on: PaneCommandValue) => {
    if (decodeBoundary(on, boundary.boolean)) subscribers.add(event.sender);
    else subscribers.delete(event.sender);
  });
  ipcMain.handle('machines:list', () => machines.list());
  ipcMain.handle('machines:read', (_event, machineId: PaneCommandValue, channel: PaneCommandValue, args: PaneCommandValue) => {
    const request = decodeBoundary({ machineId, channel, args: args ?? [] }, readSchema);
    return rejectWithPaneErrorText(machines.read(request.machineId, request.channel, request.args));
  });
  ipcMain.handle('machines:run', (_event, machineId: PaneCommandValue, command: PaneCommandValue) =>
    rejectWithPaneErrorText(machines.run(decodeBoundary(machineId, boundary.nonEmptyString), command)));
  ipcMain.handle('machines:retry', (_event, machineId: PaneCommandValue) =>
    rejectWithPaneErrorText(machines.retry(decodeBoundary(machineId, boundary.nonEmptyString))));
}
