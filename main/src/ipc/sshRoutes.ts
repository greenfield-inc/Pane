import os from 'os';
import type { IpcMain } from 'electron';
import { isRemotePaneCommand, type PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { connectSshRoute, listSshRouteHosts, saveSshRoute, type SshRouteProgress } from '../daemon/sshRouteSetup';
import { ensureSshRoute, systemSshRunner } from '../daemon/sshRoute';
import { listSshConfigHosts } from '../services/sshConfigHosts';
import { getPaneEventSink } from '../core/runtime';
import { PaneError } from '../../../shared/paneError';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import type { AppServices } from './types';

const SSH_ROUTE_COMMANDS = {
  hosts: 'ssh:route-hosts',
  connect: 'ssh:route-connect',
} as const;

const SSH_ROUTE_PROGRESS_EVENT = 'ssh:route-progress';

/** SSH config and installs on SSH hosts belong to the person at this computer, never a remote caller. */
function onThisComputerOnly(): void {
  if (isRemotePaneCommand()) {
    throw new PaneError(
      'ERR_SSH_ROUTE_LOCAL_ONLY',
      'SSH hosts can be added only on the computer whose SSH config they are in, so nothing changed.',
      'Open Pane on that computer: Settings › Remote Access › Add a device › SSH.',
    );
  }
}

/** Hosts with a connect in progress; a second click on the same host waits for the first. */
const connecting = new Map<string, Promise<{ computerId: string }>>();

export function registerSshRouteHandlers(
  ipcMain: IpcMain,
  { configManager }: AppServices,
  commandRegistry: PaneCommandRegistry,
): void {
  commandRegistry.register(SSH_ROUTE_COMMANDS.hosts, async () => {
    onThisComputerOnly();
    return listSshRouteHosts(systemSshRunner, await listSshConfigHosts());
  });

  commandRegistry.register(SSH_ROUTE_COMMANDS.connect, async (request: PaneCommandValue) => {
    onThisComputerOnly();
    const host = decodeBoundary(request, boundary.object({ host: boundary.nonEmptyString })).host.trim();
    const inFlight = connecting.get(host);
    if (inFlight) return inFlight;
    const attempt = connectSshRoute(host, {
      runner: systemSshRunner,
      tunnels: { ensure: ensureSshRoute },
      save: (alias, route) => saveSshRoute(configManager, alias, route),
      clientLabel: os.hostname().split('.')[0] ?? 'Pane',
      onProgress: (progress: SshRouteProgress) => getPaneEventSink().send(SSH_ROUTE_PROGRESS_EVENT, progress),
    }).finally(() => connecting.delete(host));
    connecting.set(host, attempt);
    return attempt;
  });

  commandRegistry.bindChannels(ipcMain, [SSH_ROUTE_COMMANDS.hosts, SSH_ROUTE_COMMANDS.connect]);
}
