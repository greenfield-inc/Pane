import path from 'path';
import type { IpcMain } from 'electron';
import { openExternalUrl } from '../utils/openExternalUrl';
import { isRemotePaneCommand, type PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { PANE_CLOUD_MACHINE_CHANNEL, paneCloudMachine } from '../../../shared/utils/paneCloudMachine';
import type { MachineConnections } from '../services/machineConnections';
import type { ConfigManager } from '../services/configManager';
import { DEFAULT_PANE_CLOUD_URL, PaneCloudFailure, PaneCloudManager } from '../services/paneCloud';
import { getAppDirectory } from '../utils/appDirectory';
import { PaneError } from '../../../shared/paneError';
import { computerRelayId } from '../../../shared/types/remoteComputers';
import { normalizeRemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import type { PaneCloudSnapshot } from '../../../shared/types/paneCloud';
import { LEGACY_ORCHESTRATION_SESSION_ID } from '../../../shared/types/orchestrationSession';
import { RELAY_DEVICE_COMMANDS } from '../../../shared/types/relay';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

/** How long a newly paired VM may take to answer on its saved connection. */
const CONNECT_DEADLINE_MS = 60_000;

const pairedSchema = boundary.object({ computerId: boundary.nonEmptyString });
const sessionListSchema = boundary.object({
  data: boundary.optional(boundary.object({ sessions: boundary.array(boundary.object({ id: boundary.nonEmptyString, archived: boundary.optional(boundary.boolean) })) })),
});
/** How long one Session call on a cloud machine may take. */
const SESSION_CALL_MS = 30_000;
const createdSchema = boundary.object({
  success: boundary.boolean,
  error: boundary.optional(boundary.string),
  data: boundary.optional(boundary.object({ session: boundary.object({ id: boundary.nonEmptyString }) })),
});

let manager: PaneCloudManager | null = null;

/** Pane Cloud's create and delete, for Session Move to Pane Cloud; null until the handlers are registered. */
export function paneCloudForMoves(): Pick<PaneCloudManager, 'createMachine' | 'remove'> | null {
  return manager;
}

/**
 * Pane Cloud's channels. They run on this computer even while the window shows another one: the
 * service session, pairing and the saved computers are this desktop's.
 */
export function registerPaneCloudHandlers(ipcMain: IpcMain, deps: {
  commands: Pick<PaneCommandRegistry, 'invoke' | 'register'>;
  machines: Pick<MachineConnections, 'machineState' | 'run' | 'invokeOn'>;
  configManager: Pick<ConfigManager, 'getConfig' | 'updateConfigWith'>;
  send: (channel: string, snapshot: PaneCloudSnapshot) => void;
}): void {
  manager?.dispose();
  const { commands, machines, configManager } = deps;
  const cloud = new PaneCloudManager({
    serviceUrl: process.env.PANE_CLOUD_URL || DEFAULT_PANE_CLOUD_URL,
    tokenFile: path.join(getAppDirectory(), 'pane-cloud', 'session.json'),
    // Pane's own allowlist (http, https, mailto) as well as the manager's web-address check.
    openExternal: (url) => openExternalUrl(url),
    pair: async ({ link, relay }) => {
      const request = { link, relay: { computerId: relay.computerId, fingerprint: relay.fingerprint, domain: relay.domain } };
      return decodeBoundary(await commands.invoke('relay:redeem-vouched', [request]), pairedSchema).computerId;
    },
    computerFor: (relayId) => normalizeRemoteDaemonConfig(configManager.getConfig().remoteDaemon).client.computers.find((computer) => computerRelayId(computer) === relayId)?.id ?? null,
    startSession: async (machineId, input) => {
      await waitUntilOnline(machines, machineId);
      const { data } = await machines.run(machineId, { type: 'create-session', input });
      const reply = decodeBoundary(data, createdSchema);
      if (!reply.success || !reply.data) {
        throw new PaneError('ERR_CLOUD_SESSION_NOT_CREATED', `The cloud machine did not create the Session: ${reply.error ?? 'it gave no reason'}.`, 'Try New cloud Session again.');
      }
      return reply.data.session.id;
    },
    // Only this computer forgets it: a cloud VM is never linked with the person's other computers, so none is told.
    forget: async (machineId) => {
      await configManager.updateConfigWith((current) => {
        const remote = normalizeRemoteDaemonConfig(current.remoteDaemon);
        const client = { ...remote.client, computers: remote.client.computers.filter((computer) => computer.id !== machineId) };
        if (client.activeProfileId === machineId) Object.assign(client, { activeProfileId: null, mode: 'local' });
        return { remoteDaemon: { ...remote, client } };
      });
    },
    unlink: async (machineId) => { await commands.invoke(RELAY_DEVICE_COMMANDS.unlinkComputerEverywhere, [{ computerId: machineId }]); },
    archiveSessions: async (machineId, archived) => {
      await waitUntilOnline(machines, machineId);
      const listed = decodeBoundary(await machines.invokeOn(machineId, 'orchestration-sessions:list', [], SESSION_CALL_MS), sessionListSchema);
      const targets = (listed.data?.sessions ?? []).filter((session) => session.id !== LEGACY_ORCHESTRATION_SESSION_ID && (session.archived === true) !== archived);
      for (const session of targets) {
        await machines.invokeOn(machineId, 'orchestration-sessions:update', [{ sessionId: session.id }, { archived }], SESSION_CALL_MS);
      }
    },
    onChange: (snapshot) => deps.send('pane-cloud:changed', snapshot),
  });
  manager = cloud;

  const vmId = (value: PaneCommandValue) => decodeBoundary(value, boundary.nonEmptyString);
  // The "Pane Cloud" machine (D-90): runpane and the pane MCP name a person's cloud Session VMs by it.
  // It answers on this computer only, where the Pane Cloud sign-in and the paired computers are.
  commands.register(PANE_CLOUD_MACHINE_CHANNEL, async () => {
    if (isRemotePaneCommand()) {
      throw new PaneError('ERR_PANE_CLOUD_HERE_ONLY', 'Pane Cloud answers only on the computer signed in to it, so another computer can\'t read its machines.', 'Run this on the computer signed in to Pane Cloud.');
    }
    const machine = paneCloudMachine((await cloud.refresh({ background: true })).sessions);
    return machine === null ? null : { id: machine.id, name: machine.name, members: machine.members.map((member) => ({ ...member })) };
  });
  ipcMain.handle('pane-cloud:get', () => answer(() => cloud.refresh()));
  ipcMain.handle('pane-cloud:sign-in', () => answer(() => cloud.startSignIn()));
  ipcMain.handle('pane-cloud:sign-out', () => answer(() => cloud.signOut()));
  ipcMain.handle('pane-cloud:stop', (_event, id: PaneCommandValue) => answer(() => cloud.stop(vmId(id))));
  ipcMain.handle('pane-cloud:start', (_event, id: PaneCommandValue) => answer(() => cloud.start(vmId(id))));
  ipcMain.handle('pane-cloud:delete', (_event, id: PaneCommandValue) => answer(() => cloud.remove(vmId(id))));
  ipcMain.handle('pane-cloud:archive', (_event, id: PaneCommandValue) => answer(() => cloud.archive(vmId(id))));
  ipcMain.handle('pane-cloud:restore', (_event, id: PaneCommandValue) => answer(() => cloud.restore(vmId(id))));
  ipcMain.handle('pane-cloud:update-pane', (_event, id: PaneCommandValue) => answer(() => cloud.updatePane(vmId(id))));
  ipcMain.handle('pane-cloud:actions', async (_event, id: PaneCommandValue) => answer(() => cloud.actions(vmId(id))));
  ipcMain.handle('pane-cloud:create', async (_event, input: PaneCommandValue) =>
    answer(() => cloud.createSession(decodeBoundary(input, boundary.jsonObject))));
}

/** A call's IPC answer: its data, or what failed and the next step. */
async function answer<T>(call: () => Promise<T>) {
  try {
    return { success: true, data: await call() };
  } catch (error) {
    if (error instanceof PaneCloudFailure) return { success: false, error: error.message, details: error.next ?? undefined, code: error.code };
    if (error instanceof PaneError) return { success: false, error: error.message, details: error.next, code: error.code };
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** A computer saved a moment ago is connected by MachineConnections on the config change; this waits for it to answer. */
async function waitUntilOnline(machines: Pick<MachineConnections, 'machineState'>, machineId: string): Promise<void> {
  const deadline = Date.now() + CONNECT_DEADLINE_MS;
  while (machines.machineState(machineId)?.status !== 'online') {
    if (Date.now() > deadline) {
      throw new PaneError('ERR_CLOUD_SESSION_UNREACHABLE', 'This computer paired with the cloud machine but could not connect to it.', 'Check this computer is online, then try New cloud Session again.');
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
