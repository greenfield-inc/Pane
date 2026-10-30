import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import type { AppConfig } from '../types/config';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { normalizeRemoteDaemonConfig, type RemotePaneConnectionProfile } from '../../../shared/types/remoteDaemon';
import type { TailnetMachineList } from '../../../shared/types/workspaceAccess';
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

/** The profile id of a machine's codeless connection; one per machine on each tailnet. */
function tailnetProfileId(domain: string, name: string): string {
  return `tailnet-${domain.toLowerCase()}-${name.toLowerCase()}`;
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
  const profiles = () => normalizeRemoteDaemonConfig(configManager.getConfig().remoteDaemon).client.profiles;

  ipcMain.handle('remote-daemon:get-workspace-access', () => respond('read remote access settings', () =>
    commandRegistry.invoke('runpane:workspaces:access')));

  ipcMain.handle('remote-daemon:update-workspace-access', (_event, update) => respond('change remote access settings', () =>
    commandRegistry.invoke('runpane:workspaces:set-access', [update])));

  ipcMain.handle('remote-daemon:list-tailnet-machines', () => respond('list your machines', async (): Promise<TailnetMachineList> => {
    const codeless = profiles().flatMap((profile) => (profile.tailnetMachine && profile.tailnetDomain
      ? [{ id: profile.id, key: savedSecretKey(profile.tailnetDomain, profile.tailnetMachine) }]
      : []));
    const list = await discoverTailnetMachines({
      ...dependencies,
      savedSecrets: savedWorkspaceSecrets(profiles()),
      includeRefused: true,
    });
    if (!list.ok) return list;
    const saved = new Map(codeless.map((profile) => [profile.key, profile.id]));
    return {
      ...list,
      machines: list.machines.map((machine) => {
        const profileId = saved.get(savedSecretKey(list.domain, machine.name));
        return profileId ? { ...machine, profileId } : machine;
      }),
    };
  }));

  // Glasses paired with this machine, and the Even app origins it accepts for them.
  ipcMain.handle('remote-daemon:get-glasses', () => respond('read glasses access', () =>
    commandRegistry.invoke(GLASSES_COMMANDS.state)));
  ipcMain.handle('remote-daemon:revoke-glasses', (_event, id) => respond('revoke the glasses', async () => {
    await commandRegistry.invoke(GLASSES_COMMANDS.revoke, [{ id: decodeBoundary(id, boundary.nonEmptyString) }]);
    return commandRegistry.invoke(GLASSES_COMMANDS.state);
  }));
  // The phone's revoke-everywhere, from this computer: here, then each of your computers that answers.
  ipcMain.handle('remote-daemon:revoke-glasses-everywhere', (_event, id) => respond('revoke the glasses on your computers', async (): Promise<GlassesRevokeEverywhereResult> => {
    const deviceId = decodeBoundary(id, boundary.nonEmptyString);
    const { devices } = decodeBoundary(await commandRegistry.invoke(GLASSES_COMMANDS.list), glassesListSchema);
    const phoneId = devices.find((device) => device.id === deviceId)?.phoneId;
    if (!phoneId) {
      throw new PaneError(
        'ERR_GLASSES_NOT_FROM_PHONE',
        'These glasses are no longer paired here, or were paired before Pane recorded which phone paired them, so no computer was asked to revoke them.',
        'Revoke them from the Pane phone app: Settings › Glasses › Revoke.',
      );
    }
    const access = decodeBoundary(await commandRegistry.invoke('runpane:workspaces:access'), boundary.object({ machineName: boundary.optional(boundary.string) }));
    return revokeGlassesEverywhere(phoneId, {
      name: access.machineName || 'this computer',
      invoke: (channel, args) => commandRegistry.invoke(channel, args),
    }, { ...dependencies, savedSecrets: savedWorkspaceSecrets(profiles()) });
  }));
  ipcMain.handle('remote-daemon:set-glasses-origin', (_event, update) => respond('change glasses origins', () =>
    commandRegistry.invoke(GLASSES_COMMANDS.setOrigin, [update])));

  // Saves the codeless profile; the caller then activates it like any saved profile.
  ipcMain.handle('remote-daemon:save-tailnet-machine', (_event, input) => respond('save the machine', async (): Promise<RemotePaneConnectionProfile> => {
    const { name, password } = decodeBoundary(input, saveMachineSchema);
    const located = await locateTailnetMachine(name, dependencies.readStatus);
    const id = tailnetProfileId(located.domain, name);
    const current = normalizeRemoteDaemonConfig(configManager.getConfig().remoteDaemon);
    const existing = current.client.profiles.find((profile) => profile.id === id);
    const profile: RemotePaneConnectionProfile = {
      id,
      label: name,
      baseUrl: located.url,
      token: password ?? existing?.token ?? '',
      transport: 'http+sse',
      tailnetMachine: name,
      tailnetDomain: located.domain,
    };
    await configManager.updateConfig({
      remoteDaemon: normalizeRemoteDaemonConfig({
        ...current,
        client: {
          ...current.client,
          profiles: existing
            ? current.client.profiles.map((candidate) => (candidate.id === id ? profile : candidate))
            : [...current.client.profiles, profile],
        },
      }),
    });
    return profile;
  }));
}

async function respond<Result>(action: string, work: () => Promise<Result>): Promise<PaneCommandValue> {
  try {
    return { success: true, data: await work() };
  } catch (error) {
    if (error instanceof PaneError) return { success: false, error: paneErrorText(error) };
    return { success: false, error: error instanceof Error ? error.message : `Failed to ${action}` };
  }
}
