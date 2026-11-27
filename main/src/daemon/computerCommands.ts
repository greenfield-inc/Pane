import { computerName } from '../utils/computerName';
import type { PaneCommandRegistry, PaneCommandValue } from './commandRegistry';
import { isRemotePaneCommand } from './commandRegistry';
import { PaneError } from '../../../shared/paneError';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { normalizeRemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import { isWatchedComputer, type ComputerOs, type ComputerRoutesReport, type RemoteComputer } from '../../../shared/types/remoteComputers';
import type { RelayComputer } from '../../../shared/types/relay';
import type { AppConfig } from '../types/config';
import { stopSshRoute } from './sshRoute';

/** Where this computer's routes come from: the relay while phone access is on, the Tailscale listener while it serves. */
export interface RoutesReportSources {
  relay(): RelayComputer | undefined;
  tailnet(): { dnsName: string; machineName: string; port: number } | null;
}

interface ComputerCommandsConfig {
  getConfig(): Pick<AppConfig, 'machineId' | 'remoteDaemon'>;
  updateConfigWith(update: (current: AppConfig) => Partial<AppConfig>): Promise<object>;
}

const COMPUTER_COMMANDS = {
  list: 'computers:list',
  reorderRoutes: 'computers:reorder-routes',
  removeRoute: 'computers:remove-route',
  routesReport: 'computers:routes-report',
  setPublicUrl: 'computers:set-public-url',
  setMine: 'computers:set-mine',
} as const;

let currentSources: { config: ComputerCommandsConfig; sources: RoutesReportSources } | null = null;

function thisOs(): ComputerOs | undefined {
  if (process.platform === 'darwin') return 'macOS';
  if (process.platform === 'win32') return 'Windows';
  if (process.platform === 'linux') return 'Linux';
  return undefined;
}

/** This computer's name as the relay gives it. */
function thisName(): string {
  return computerName() || 'This computer';
}

/** What this computer says about itself on every `ready` event and in a link's answer. Undefined before it has an install id. */
export function buildRoutesReport(): ComputerRoutesReport | undefined {
  if (!currentSources) return undefined;
  const { config, sources } = currentSources;
  const machineId = config.getConfig().machineId;
  if (!machineId) return undefined;
  const report: ComputerRoutesReport = { machineId, name: thisName() };
  const os = thisOs();
  if (os) report.os = os;
  const relay = sources.relay();
  if (relay) report.relay = { id: relay.id, address: relay.address, fingerprint: relay.fingerprint, local: relay.local };
  const tailnet = sources.tailnet();
  if (tailnet) {
    const dnsName = tailnet.dnsName.replace(/\.$/u, '');
    report.tailnet = { dnsName, machine: tailnet.machineName, domain: dnsName.split('.').slice(1).join('.'), port: tailnet.port };
  }
  const publicUrl = normalizeRemoteDaemonConfig(config.getConfig().remoteDaemon).host.publicUrl;
  if (publicUrl) report.publicUrl = publicUrl;
  return report;
}

function onThisComputerOnly(): void {
  if (isRemotePaneCommand()) {
    throw new PaneError('ERR_COMPUTERS_LOCAL_ONLY', 'Saved computers can be read and changed only on the computer itself, so nothing changed.', 'Open Pane on that computer: Settings › Remote Access.');
  }
}

function checkPublicUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new PaneError('ERR_PUBLIC_URL_INVALID', `"${value}" is not an address.`, 'Enter the full HTTPS address, such as https://pane.example.com.');
  }
  if (url.protocol !== 'https:') {
    throw new PaneError('ERR_PUBLIC_URL_NOT_HTTPS', `${url.origin} is not HTTPS, so it was not saved.`, 'Put your HTTPS reverse proxy in front of Pane and enter its https:// address.');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`;
}

/** `computers:*`: the saved computers and this computer's own routes. */
export function registerComputerCommands(registry: PaneCommandRegistry, config: ComputerCommandsConfig, sources: RoutesReportSources): void {
  currentSources = { config, sources };
  const computers = () => normalizeRemoteDaemonConfig(config.getConfig().remoteDaemon).client.computers;
  const updateComputers = async (change: (list: RemoteComputer[]) => RemoteComputer[]): Promise<void> => {
    await config.updateConfigWith((current) => {
      const remote = normalizeRemoteDaemonConfig(current.remoteDaemon);
      const next = change(remote.client.computers);
      const forgetsActive = remote.client.activeProfileId !== null && !next.some((computer) => computer.id === remote.client.activeProfileId);
      return {
        remoteDaemon: {
          ...remote,
          client: {
            ...remote.client,
            computers: next,
            activeProfileId: forgetsActive ? null : remote.client.activeProfileId,
            mode: forgetsActive ? 'local' : remote.client.mode,
          },
        },
      };
    });
  };
  const find = (computerId: string): RemoteComputer => {
    const computer = computers().find((candidate) => candidate.id === computerId);
    if (!computer) throw new PaneError('ERR_COMPUTER_UNKNOWN', `No saved computer has the id "${computerId}", so nothing changed.`, 'List your computers with runpane workspace list.');
    return computer;
  };

  registry.register(COMPUTER_COMMANDS.list, () => {
    onThisComputerOnly();
    return computers();
  });

  registry.register(COMPUTER_COMMANDS.reorderRoutes, async (request: PaneCommandValue) => {
    onThisComputerOnly();
    const { computerId, routeIds } = decodeBoundary(request, boundary.object({ computerId: boundary.nonEmptyString, routeIds: boundary.array(boundary.string) }));
    const computer = find(computerId);
    const ordered = [
      ...routeIds.flatMap((id) => computer.routes.filter((route) => route.id === id)),
      ...computer.routes.filter((route) => !routeIds.includes(route.id)),
    ];
    const updated = { ...computer, routes: ordered };
    await updateComputers((list) => list.map((candidate) => (candidate.id === computerId ? updated : candidate)));
    return updated;
  });

  registry.register(COMPUTER_COMMANDS.removeRoute, async (request: PaneCommandValue) => {
    onThisComputerOnly();
    const { computerId, routeId } = decodeBoundary(request, boundary.object({ computerId: boundary.nonEmptyString, routeId: boundary.nonEmptyString }));
    const computer = find(computerId);
    const removed = computer.routes.find((route) => route.id === routeId);
    if (removed?.kind === 'ssh') stopSshRoute(removed);
    const routes = computer.routes.filter((route) => route.id !== routeId);
    const updated = routes.length ? { ...computer, routes } : null;
    await updateComputers((list) => (updated
      ? list.map((candidate) => (candidate.id === computerId ? updated : candidate))
      : list.filter((candidate) => candidate.id !== computerId)));
    return updated;
  });

  // "This is my computer" (D-500): true or false wins over the Tailscale check; null goes back to it.
  registry.register(COMPUTER_COMMANDS.setMine, async (request: PaneCommandValue) => {
    onThisComputerOnly();
    const { computerId, mine } = decodeBoundary(request, boundary.object({ computerId: boundary.nonEmptyString, mine: boundary.nullable(boundary.boolean) }));
    const computer = find(computerId);
    if (isWatchedComputer(computer)) {
      throw new PaneError('ERR_COMPUTER_READ_ONLY', `This computer only watches ${computer.label}, so it can't be marked as yours and nothing changed.`, `Ask ${computer.label}'s owner for full access first.`);
    }
    const updated: RemoteComputer = { ...computer };
    if (mine === null) delete updated.mineOverride;
    else updated.mineOverride = mine;
    await updateComputers((list) => list.map((candidate) => (candidate.id === computerId ? updated : candidate)));
    return updated;
  });

  registry.register(COMPUTER_COMMANDS.routesReport, () => buildRoutesReport() ?? null);

  registry.register(COMPUTER_COMMANDS.setPublicUrl, async (request: PaneCommandValue) => {
    onThisComputerOnly();
    const { url } = decodeBoundary(request, boundary.object({ url: boundary.nullable(boundary.string) }));
    const publicUrl = url?.trim() ? checkPublicUrl(url) : undefined;
    await config.updateConfigWith((current) => {
      const remote = normalizeRemoteDaemonConfig(current.remoteDaemon);
      const host = { ...remote.host };
      if (publicUrl) host.publicUrl = publicUrl;
      else delete host.publicUrl;
      return { remoteDaemon: { ...remote, host } };
    });
    return buildRoutesReport() ?? null;
  });
}
