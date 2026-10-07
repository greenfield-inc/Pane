import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import type { AppConfig } from '../types/config';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { normalizeRemoteDaemonConfig, type RemotePaneConnectionProfile } from '../../../shared/types/remoteDaemon';
import type { TailnetMachineList } from '../../../shared/types/workspaceAccess';
import {
  discoverTailnetMachines,
  probeWorkspace,
  readTailscaleStatus,
  locateTailnetMachine,
  savedSecretKey,
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
  dependencies: WorkspaceAccessDependencies = { readStatus: readTailscaleStatus, probe: probeWorkspace },
): void {
  const profiles = () => normalizeRemoteDaemonConfig(configManager.getConfig().remoteDaemon).client.profiles;

  ipcMain.handle('remote-daemon:get-workspace-access', () => respond('read remote access settings', () =>
    commandRegistry.invoke('runpane:workspaces:access')));

  ipcMain.handle('remote-daemon:update-workspace-access', (_event, update) => respond('change remote access settings', () =>
    commandRegistry.invoke('runpane:workspaces:set-access', [update])));

  ipcMain.handle('remote-daemon:list-tailnet-machines', () => respond('list your machines', async (): Promise<TailnetMachineList> => {
    const codeless = profiles().flatMap((profile) => (profile.tailnetMachine && profile.tailnetDomain
      ? [{ id: profile.id, token: profile.token, key: savedSecretKey(profile.tailnetDomain, profile.tailnetMachine) }]
      : []));
    const list = await discoverTailnetMachines({
      ...dependencies,
      savedSecrets: new Map(codeless.flatMap((profile) => (profile.token ? [[profile.key, profile.token]] : []))),
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
    return { success: false, error: error instanceof Error ? error.message : `Failed to ${action}` };
  }
}
