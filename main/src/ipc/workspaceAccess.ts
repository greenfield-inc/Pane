import type { AppServices } from './types';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import type { AppConfig } from '../types/config';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { normalizeRemoteDaemonConfig, type RemotePaneConnectionProfile } from '../../../shared/types/remoteDaemon';
import type { TailnetMachineList } from '../../../shared/types/workspaceAccess';
import { allRouteProfiles, findComputer, routeProfile, upsertComputer, withRoutes, type ComputerRoute, type RemoteComputer } from '../../../shared/types/remoteComputers';
import { GLASSES_COMMANDS, type GlassesRevokeEverywhereResult } from '../../../shared/types/glasses';
import { PaneError, paneErrorText } from '../../../shared/paneError';
import { glassesListSchema } from '../../../shared/glassesRevoke';
import { revokeGlassesEverywhere } from '../services/glassesVouch';
import {
  callWorkspace,
  discoverTailnetMachines,
  probeWorkspace,
  readTailscaleStatus,
  locateTailnetMachine,
  savedSecretKey,
  savedWorkspaceSecrets,
  type WorkspaceCall,
  type WorkspaceProbe,
} from '../services/tailnetMachines';

interface IpcMainHandleLike {
  handle(
    channel: string,
    listener: (_event: { readonly sender: object }, ...args: PaneCommandValue[]) => Promise<PaneCommandValue>,
  ): void;
}

interface WorkspaceAccessServices {
  configManager: {
    getConfig(): Pick<AppConfig, 'remoteDaemon'>;
    updateConfig(updates: Pick<AppConfig, 'remoteDaemon'>): Promise<object>;
  };
}

interface WorkspaceAccessDependencies {
  readStatus: () => Promise<string | null>;
  probe: WorkspaceProbe;
  call: WorkspaceCall;
}

const saveMachineSchema = boundary.object({
  name: boundary.nonEmptyString,
  password: boundary.optional(boundary.string),
});

type ConfigManager = AppServices['configManager'];

/** Your Tailscale network's machines, each marked with the saved computer it is, if any. */
export async function listTailnetMachines(
  configManager: Pick<ConfigManager, 'getConfig'>,
  dependencies: Pick<WorkspaceAccessDependencies, 'readStatus' | 'probe'> = { readStatus: readTailscaleStatus, probe: probeWorkspace },
): Promise<TailnetMachineList> {
  const { computers } = normalizeRemoteDaemonConfig(configManager.getConfig().remoteDaemon).client;
  const list = await discoverTailnetMachines({
    ...dependencies,
    savedSecrets: savedWorkspaceSecrets(allRouteProfiles(computers)),
    includeRefused: true,
  });
  if (!list.ok) return list;
  return {
    ...list,
    machines: list.machines.map((machine) => {
      const computer = savedComputerFor(computers, list.domain, machine);
      return computer ? { ...machine, profileId: computer.id } : machine;
    }),
  };
}

/** The saved computer a Tailscale machine is: one with its Tailscale route, else by install id or (no id known) its name. */
function savedComputerFor(computers: readonly RemoteComputer[], domain: string, machine: { name: string; machineId?: string }): RemoteComputer | undefined {
  const key = savedSecretKey(domain, machine.name);
  const byRoute = computers.find((computer) => computer.routes.some((route) => route.tailnetMachine && route.tailnetDomain
    && savedSecretKey(route.tailnetDomain, route.tailnetMachine) === key)
    && (!machine.machineId || !computer.machineId || computer.machineId === machine.machineId));
  return byRoute ?? findComputer(computers, { machineId: machine.machineId, tailnetName: machine.name });
}

/**
 * Settings → Remote Access on this machine: who may connect to it (visibility and password), and
 * the machines it can connect to without a code. These always act on this machine, even while the
 * app is connected to a remote host, so they are plain IPC rather than daemon commands.
 */
export function registerWorkspaceAccessHandlers(
  ipcMain: IpcMainHandleLike,
  { configManager }: WorkspaceAccessServices,
  commandRegistry: Pick<PaneCommandRegistry, 'invoke'>,
  dependencies: WorkspaceAccessDependencies = { readStatus: readTailscaleStatus, probe: probeWorkspace, call: callWorkspace },
): void {
  const routeProfiles = () => allRouteProfiles(normalizeRemoteDaemonConfig(configManager.getConfig().remoteDaemon).client.computers);

  ipcMain.handle('remote-daemon:get-workspace-access', () => respond('read remote access settings', () =>
    commandRegistry.invoke('runpane:workspaces:access')));

  ipcMain.handle('remote-daemon:update-workspace-access', (_event, update) => respond('change remote access settings', () =>
    commandRegistry.invoke('runpane:workspaces:set-access', [update])));

  ipcMain.handle('remote-daemon:list-tailnet-machines', () => respond('list your machines', () => listTailnetMachines(configManager, dependencies)));

  // Glasses paired with this machine, and the Even app origins it accepts for them.
  ipcMain.handle('remote-daemon:get-glasses', () => respond('read glasses access', () =>
    commandRegistry.invoke(GLASSES_COMMANDS.state)));
  ipcMain.handle('remote-daemon:revoke-glasses', (_event, id) => respond('revoke the glasses', async () => {
    await commandRegistry.invoke(GLASSES_COMMANDS.revoke, [{ id: decodeBoundary(id, boundary.nonEmptyString) }]);
    return commandRegistry.invoke(GLASSES_COMMANDS.state);
  }));
  // The phone's revoke-everywhere, from this computer: here, then each of your computers that answers.
  // A phone already revoked here can be sent again, to reach the computers the first try missed.
  ipcMain.handle('remote-daemon:revoke-glasses-everywhere', (_event, id) => respond('revoke the glasses on your computers', async (): Promise<GlassesRevokeEverywhereResult> => {
    const phoneId = decodeBoundary(id, boundary.nonEmptyString);
    const { devices, revokedPhoneIds = [] } = decodeBoundary(await commandRegistry.invoke(GLASSES_COMMANDS.list), glassesListSchema);
    if (!devices.some((device) => device.phoneId === phoneId) && !revokedPhoneIds.includes(phoneId)) {
      throw new PaneError(
        'ERR_GLASSES_NOT_FROM_PHONE',
        'No glasses from this phone are paired or revoked here, so no computer was asked to revoke them.',
        'Revoke them from the Pane phone app: Settings › Glasses › Revoke.',
      );
    }
    const access = decodeBoundary(await commandRegistry.invoke('runpane:workspaces:access'), boundary.object({ machineName: boundary.optional(boundary.string) }));
    return revokeGlassesEverywhere(phoneId, {
      name: access.machineName || 'this computer',
      invoke: (channel, args) => commandRegistry.invoke(channel, args),
    }, { ...dependencies, savedSecrets: savedWorkspaceSecrets(routeProfiles()) });
  }));
  ipcMain.handle('remote-daemon:set-glasses-origin', (_event, update) => respond('change glasses origins', () =>
    commandRegistry.invoke(GLASSES_COMMANDS.setOrigin, [update])));

  // Saves the machine's Tailscale route on its computer; the caller then activates that computer.
  ipcMain.handle('remote-daemon:save-tailnet-machine', (_event, input) => respond('save the machine', async (): Promise<RemotePaneConnectionProfile> => {
    const { name, password } = decodeBoundary(input, saveMachineSchema);
    const located = await locateTailnetMachine(name, dependencies.readStatus);
    const current = normalizeRemoteDaemonConfig(configManager.getConfig().remoteDaemon);
    // Its install id arrives on the first connect; until then a computer of the same name is this one.
    const existing = savedComputerFor(current.client.computers, located.domain, { name });
    const existingRoute = existing?.routes.find((route) => route.kind === 'tailscale');
    const route: ComputerRoute = {
      id: `tailscale:${located.url}`,
      kind: 'tailscale',
      source: existingRoute?.source ?? 'found',
      baseUrl: located.url,
      token: password ?? existingRoute?.token ?? '',
      tailnetMachine: name,
      tailnetDomain: located.domain,
    };
    const saved = existing
      ? {
          id: existing.id,
          computers: current.client.computers.map((computer) => (computer.id === existing.id
            ? { ...computer, routes: withRoutes(computer.routes.filter((candidate) => candidate.kind !== 'tailscale' || candidate.id === route.id), [route]) }
            : computer)),
        }
      : upsertComputer(current.client.computers, { id: tailnetComputerId(located.domain, name), tailnetName: name, label: name, routes: [route] });
    await configManager.updateConfig({
      remoteDaemon: normalizeRemoteDaemonConfig({ ...current, client: { ...current.client, computers: saved.computers } }),
    });
    const computer = saved.computers.find((candidate) => candidate.id === saved.id);
    if (!computer) throw new PaneError('ERR_COMPUTER_NOT_SAVED', `${name} was not saved.`, 'Try again from Settings › Remote Access.');
    return routeProfile(computer, computer.routes.find((candidate) => candidate.id === route.id) ?? route);
  }));
}

/** The id of a computer first saved from Tailscale: the same as before computers, so per-computer state carries over. */
function tailnetComputerId(domain: string, name: string): string {
  return `tailnet-${domain.toLowerCase()}-${name.toLowerCase()}`;
}

async function respond<Result>(action: string, work: () => Promise<Result>): Promise<PaneCommandValue> {
  try {
    return { success: true, data: await work() };
  } catch (error) {
    if (error instanceof PaneError) return { success: false, error: paneErrorText(error) };
    return { success: false, error: error instanceof Error ? error.message : `Failed to ${action}` };
  }
}
