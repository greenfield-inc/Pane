import type { IpcMain, WebContents } from 'electron';
import { rejectWithPaneErrorText, type PaneCommandValue } from '../daemon/commandRegistry';
import type { MachineConnections } from '../services/machineConnections';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';

const readSchema = boundary.object({
  machineId: boundary.nonEmptyString,
  channel: boundary.nonEmptyString,
  args: boundary.array(boundary.json),
});

/**
 * The renderer's channels for every machine: `machines:list`, `machines:read`, `machines:run`,
 * `machines:retry`, `machines:latency`, and `machines:event` pushed to each window that sent `machines:subscribe`.
 */
const createSessionSchema = boundary.object({ type: boundary.literal('create-session'), input: boundary.object({ agentProfile: boundary.optional(boundary.string) }) });

export interface MachineConnectionHooks {
  /** Before a Session with a profile starts on another machine: bring that profile's plugin up to date there (T-63 PR 6). */
  beforeCreateSession?: (machineId: string, plugin: string) => Promise<void>;
}

export function registerMachineConnectionHandlers(ipcMain: IpcMain, machines: MachineConnections, hooks: MachineConnectionHooks = {}): void {
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
  ipcMain.handle('machines:run', async (_event, machineId: PaneCommandValue, command: PaneCommandValue) => {
    const machine = decodeBoundary(machineId, boundary.nonEmptyString);
    const plugin = decodeOptionalBoundary(command, createSessionSchema)?.input.agentProfile?.split('/')[0];
    if (plugin && hooks.beforeCreateSession) await hooks.beforeCreateSession(machine, plugin);
    return rejectWithPaneErrorText(machines.run(machine, command));
  });
  ipcMain.handle('machines:latency', (_event, machineId: PaneCommandValue) =>
    rejectWithPaneErrorText(machines.measureLatency(decodeBoundary(machineId, boundary.nonEmptyString))));
  ipcMain.handle('machines:retry', (_event, machineId: PaneCommandValue) =>
    rejectWithPaneErrorText(machines.retry(decodeBoundary(machineId, boundary.nonEmptyString))));
}
