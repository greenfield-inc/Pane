import fs from 'fs';
import path from 'path';
import { normalizeRemoteDaemonConfig, type RemoteDaemonConfig, type RemoteDaemonConnectedClient } from '../../../../shared/types/remoteDaemon';
import type { RunpaneLockRecord } from '../../../../shared/types/runpaneOrchestration';
import type { ToolPanel } from '../../../../shared/types/panels';
import type { AgentState } from '../../../../shared/types/agentStatus';
import type { CloudWalCheckpoint } from '../../../../shared/types/cloudDaemon';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import { resolveAgentTypeFromCommand } from '../../services/agents/agentIdentity';
import type { PaneCommandRegistry, PaneCommandValue } from '../commandRegistry';
import { isPeerClientRecord, type UserClientActivityTracker } from './clientActivity';
import { pairCoordinatorClient, revokeCoordinatorClients } from './coordinatorClients';
import { flushDurableState } from './durableFlush';
import type { CloudDaemonHealthState, ReadinessAgentPanel } from './readiness';
import { findAgentSpawnedShells, readProcessTable, type ProcessEntry } from './processTree';
import {
  runSafeToStop,
  type SafeToStopRunningCommand,
  type SafeToStopSources,
  type SafeToStopTerminal,
  type SafeToStopUserClient,
} from './safeToStop';
import {
  CloudUpgradeError,
  downloadToFile,
  resolveOwnSystemdUnit,
  runCloudUpgrade,
  runDetachedWithSystemd,
} from './upgrade';

/** Channels whose in-flight calls mean someone is watching for work to finish. */
const WATCHER_CHANNELS = ['runpane:workspace:wait', 'runpane:panels:wait'] as const;
/** safe-to-stop re-polls GitHub when the PR monitor's last round is older than this. */
const PR_CHECKS_MAX_AGE_MS = 60_000;

const terminalCustomStateSchema = boundary.object({
  isCliPanel: boundary.optional(boundary.boolean),
  agentType: boundary.optional(boundary.string),
  initialCommand: boundary.optional(boundary.string),
});

interface TerminalReader {
  getAllPanelIds(): string[];
  getPanelPid(panelId: string): number | undefined;
  getForegroundProcess(panelId: string): { name: string; isShell: boolean } | undefined;
  isTerminalInitialized(panelId: string): boolean;
  getAgentStatus(panelId: string): AgentState | undefined;
  getLastOutputAt(panelId: string): string | undefined;
}

export interface CloudDaemonDependencies {
  commandRegistry: PaneCommandRegistry;
  health: CloudDaemonHealthState;
  clientActivity: UserClientActivityTracker;
  terminals: TerminalReader;
  getPanel(panelId: string): ToolPanel | undefined;
  getPanelsForPane(paneId: string): ToolPanel[];
  /** Non-archived Panes. */
  listPaneIds(): string[];
  listLocks(): RunpaneLockRecord[];
  pendingPrChecks(maxAgeMs: number): Promise<Array<{ paneId: string; prNumber: number }>>;
  connectedClients(): RemoteDaemonConnectedClient[];
  remoteConfig(): RemoteDaemonConfig | undefined;
  writeRemoteConfig(config: RemoteDaemonConfig): Promise<void>;
  checkpointWal(): CloudWalCheckpoint | null;
  paneDirectory: string;
  /** The SQLite database file the flush fsyncs with its WAL. */
  databaseFile: string;
  readProcesses?: () => ProcessEntry[];
  now?: () => number;
}

/**
 * Registers the Runpane Cloud channels (`runpane:cloud:safe-to-stop`, `runpane:cloud:upgrade`, and the
 * laptop's `runpane:cloud:coordinator-client:pair|revoke`) and points `/health` readiness at the live
 * panels. Kept out of runpane.ts: these are for the coordinator and the sandbox, not for everyday
 * orchestration. The coordinator's own token reaches only the first two (coordinatorScope.ts).
 */
export function registerCloudDaemonHandlers(dependencies: CloudDaemonDependencies): void {
  const now = dependencies.now ?? Date.now;
  dependencies.health.setAgentPanelSource(() => readinessPanels(dependencies));

  dependencies.commandRegistry.register('runpane:cloud:safe-to-stop', async (request: PaneCommandValue = {}) => {
    return runSafeToStop({
      sources: createSafeToStopSources(dependencies, now),
      flush: () => flushDurableState({
        checkpointWal: dependencies.checkpointWal,
        paneDirectory: dependencies.paneDirectory,
        databaseFile: dependencies.databaseFile,
        now,
      }),
      version: dependencies.health.getVersion() ?? 'unknown',
      now,
    }, request);
  });

  dependencies.commandRegistry.register('runpane:cloud:upgrade', async (request: PaneCommandValue) => {
    const currentVersion = dependencies.health.getVersion();
    if (!currentVersion) {
      throw new CloudUpgradeError('ERR_CLOUD_UPGRADE_UNSUPPORTED', 'This daemon does not know its own version');
    }
    return runCloudUpgrade({
      currentVersion,
      downloadDirectory: path.join(dependencies.paneDirectory, 'cloud-upgrades'),
      resolveServiceUnit: resolveOwnSystemdUnit,
      download: downloadToFile,
      runDetached: runDetachedWithSystemd,
    }, request);
  });

  // Full clients only (the laptop's `runpane cloud coordinator destroy|deploy`): the coordinator scope and
  // peers never reach these. The config is updated in place, so no daemon restart interrupts the Session.
  dependencies.commandRegistry.register('runpane:cloud:coordinator-client:revoke', async () => {
    const revoked = revokeCoordinatorClients(normalizeRemoteDaemonConfig(dependencies.remoteConfig() ?? {}));
    if (revoked.revokedClientIds.length > 0) await dependencies.writeRemoteConfig(revoked.config);
    return { ok: true, revokedClientIds: revoked.revokedClientIds };
  });

  dependencies.commandRegistry.register('runpane:cloud:coordinator-client:pair', async () => {
    const paired = pairCoordinatorClient(normalizeRemoteDaemonConfig(dependencies.remoteConfig() ?? {}), new Date(now()));
    await dependencies.writeRemoteConfig(paired.config);
    return { ok: true, clientId: paired.clientId, token: paired.token, revokedClientIds: paired.revokedClientIds };
  });
}

function createSafeToStopSources(dependencies: CloudDaemonDependencies, now: () => number): SafeToStopSources {
  return {
    terminals: () => dependencies.terminals.getAllPanelIds().map((panelId): SafeToStopTerminal => {
      const lastOutputAt = dependencies.terminals.getLastOutputAt(panelId);
      const panel = dependencies.getPanel(panelId);
      return {
        panelId,
        paneId: panel?.sessionId,
        // The status monitor also tracks shells; a busy shell is covered by recent output, not as an agent.
        agentState: panel && isAgentPanel(panel) ? dependencies.terminals.getAgentStatus(panelId) : undefined,
        lastOutputAt: lastOutputAt ? Date.parse(lastOutputAt) : undefined,
      };
    }),
    runningCommands: () => runningCommands(dependencies),
    locks: () => dependencies.listLocks().map(lock => ({
      name: lock.name,
      ownerLabel: lock.owner.label ?? lock.owner.paneId,
      paneId: lock.owner.paneId,
      panelId: lock.owner.panelId,
    })),
    // Peer waits are left out: a peer must not be able to keep a sandbox awake.
    watchers: () => WATCHER_CHANNELS.map(channel => ({
      channel,
      ...dependencies.commandRegistry.getChannelActivity(channel, ['local', 'remote-user']),
    })),
    pendingPrChecks: () => dependencies.pendingPrChecks(PR_CHECKS_MAX_AGE_MS),
    userClients: (since) => {
      const records = dependencies.remoteConfig()?.host.clients ?? [];
      const streams: SafeToStopUserClient[] = dependencies.connectedClients()
        .filter(client => !isPeerClientRecord(records.find(record => record.id === client.clientId)))
        .map(client => ({ kind: 'events-stream', clientId: client.clientId, label: client.label, at: now() }));
      const streamClientIds = new Set(streams.map(client => client.clientId));
      const invokes: SafeToStopUserClient[] = dependencies.clientActivity.invokedSince(since)
        .filter(client => !streamClientIds.has(client.clientId))
        .map(client => ({ kind: 'recent-invoke', ...client }));
      return [...streams, ...invokes];
    },
  };
}

/**
 * Work that prints nothing still counts: an agent's tool shell (Claude moves long commands to the
 * background and ends its turn, so its screen reads idle) or a program in the foreground of a shell panel.
 */
function runningCommands(dependencies: CloudDaemonDependencies): SafeToStopRunningCommand[] {
  let table: ProcessEntry[] | undefined;
  const commands: SafeToStopRunningCommand[] = [];
  for (const panelId of dependencies.terminals.getAllPanelIds()) {
    const panel = dependencies.getPanel(panelId);
    const paneId = panel?.sessionId;
    if (panel && isAgentPanel(panel)) {
      const ptyPid = dependencies.terminals.getPanelPid(panelId);
      if (ptyPid === undefined) continue;
      table ??= (dependencies.readProcesses ?? readProcessTable)();
      for (const shell of findAgentSpawnedShells(table, ptyPid)) {
        commands.push({ panelId, paneId, kind: 'agent-shell', command: `${shell.name} pid ${shell.pid}` });
      }
      continue;
    }
    const foreground = dependencies.terminals.getForegroundProcess(panelId);
    if (foreground && !foreground.isShell) {
      commands.push({ panelId, paneId, kind: 'foreground', command: foreground.name });
    }
  }
  return commands;
}

function readinessPanels(dependencies: CloudDaemonDependencies): ReadinessAgentPanel[] {
  const panels: ReadinessAgentPanel[] = [];
  for (const paneId of dependencies.listPaneIds()) {
    for (const panel of dependencies.getPanelsForPane(paneId)) {
      if (panel.type !== 'terminal' || !isAgentPanel(panel)) continue;
      const running = dependencies.terminals.isTerminalInitialized(panel.id);
      panels.push({ running, agentState: running ? dependencies.terminals.getAgentStatus(panel.id) : undefined });
    }
  }
  return panels;
}

function isAgentPanel(panel: ToolPanel): boolean {
  const state = decodeOptionalBoundary(panel.state.customState ?? {}, terminalCustomStateSchema);
  if (!state) return false;
  return state.isCliPanel ?? Boolean(state.agentType ?? resolveAgentTypeFromCommand(state.initialCommand));
}

/** The short commit the build was made from (scripts/inject-build-info.js), when packaged. */
export function readBuildCommit(appPath: string): string | null {
  const candidates = [
    path.join(process.resourcesPath ?? '', 'app.asar', 'main', 'dist', 'buildInfo.json'),
    path.join(process.resourcesPath ?? '', 'app', 'main', 'dist', 'buildInfo.json'),
    path.join(appPath, 'main', 'dist', 'buildInfo.json'),
  ];
  for (const candidate of candidates) {
    try {
      const info = decodeOptionalBoundary(
        JSON.parse(fs.readFileSync(candidate, 'utf8')),
        boundary.object({ gitCommit: boundary.optional(boundary.string) }),
      );
      if (info?.gitCommit) return info.gitCommit;
    } catch {
      // Not packaged at this location.
    }
  }
  return null;
}
