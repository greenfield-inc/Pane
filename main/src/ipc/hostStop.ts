import { isRemotePaneCommand, type PaneCommandRegistry } from '../daemon/commandRegistry';
import { panelManager } from '../services/panelManager';
import { terminalPanelManager } from '../services/terminalPanelManager';
import { PaneError } from '../../../shared/paneError';
import type { RemoteDaemonConnectedClient } from '../../../shared/types/remoteDaemon';
import type {
  RunpaneHostPrepareStopResult,
  RunpaneHostStatusResult,
  RunpaneHostStopBlocker,
} from '../../../shared/types/runpaneOrchestration';
import { isAgentPanel } from './runpane';
import type { AppServices } from './types';

/** How long a prepared stop holds new work back before Pane carries on by itself. */
const PREPARED_STOP_HOLD_MS = 60_000;

/** A client with an event stream open, and the listener it came in on. */
export interface HostConnectedClient {
  listener: 'paired' | 'workspace';
  client: RemoteDaemonConnectedClient;
}

/**
 * `runpane host status` and `runpane host prepare-stop`: whether this machine can stop now, and
 * letting Pane finish writing before it does. Both read live state only; nothing is stored.
 */
export function registerHostStopCommands(
  registry: PaneCommandRegistry,
  services: Pick<AppServices, 'databaseService' | 'archiveProgressManager'>,
  connectedClients: () => HostConnectedClient[],
): void {
  registry.register('runpane:host:status', (): RunpaneHostStatusResult => {
    const blockers: RunpaneHostStopBlocker[] = [];
    const agents = { working: 0, blocked: 0, idle: 0 };
    for (const pane of services.databaseService.getAllSessions(undefined, { includeHidden: true })) {
      for (const panel of panelManager.getPanelsForSession(pane.id)) {
        // Pane reports any terminal printing output as working; only agent tabs count.
        if (!isAgentPanel(panel)) continue;
        const reported = terminalPanelManager.getAgentStatus(panel.id);
        const state = reported === 'working' || reported === 'blocked' ? reported : 'idle';
        agents[state] += 1;
        // An agent waiting for an answer is still waiting after the machine resumes from its snapshot.
        if (state === 'working') blockers.push({ code: 'agent-working', paneId: pane.id, panelId: panel.id, title: `${pane.name} · ${panel.title}` });
      }
    }
    const clients = connectedClients().map(({ listener, client }) => ({
      id: client.id, person: client.person, device: client.deviceLabel, listener, connectedAt: client.connectedAt,
    }));
    for (const client of clients) blockers.push({ code: 'client-connected', person: client.person, device: client.device });
    const { mutations, quiescing } = registry.inFlight();
    if (mutations > 0) blockers.push({ code: 'work-in-flight', mutations });
    if (services.archiveProgressManager?.hasActiveTasks()) blockers.push({ code: 'worktree-removal' });
    if (quiescing) blockers.push({ code: 'update-in-progress' });
    return { safeToStop: blockers.length === 0, blockers, agents, clients, checkedAt: new Date().toISOString() };
  });

  registry.register('runpane:host:prepare-stop', async (): Promise<RunpaneHostPrepareStopResult> => {
    if (isRemotePaneCommand()) {
      throw new PaneError('ERR_HOST_PREPARE_STOP_LOCAL_ONLY', 'Preparing a stop needs a command run on this machine. Nothing was changed.', 'Run runpane host prepare-stop in a shell on the machine.');
    }
    const settledMutations = registry.inFlight().mutations;
    try {
      await registry.quiesceForUpdate();
    } catch {
      throw new PaneError('ERR_HOST_PREPARE_STOP_BUSY', 'Work still running in Pane did not finish within 10 seconds, so the machine is not ready to stop. Pane keeps running and accepts new work.', 'Run runpane host status to see what is running, then try again.');
    }
    try {
      await terminalPanelManager.saveAllTerminalStates();
    } catch (error) {
      registry.cancelUpdateQuiescence();
      throw error;
    }
    // After a resume from a memory snapshot this fires and Pane carries on; a cold boot starts a new process.
    setTimeout(() => registry.cancelUpdateQuiescence(), PREPARED_STOP_HOLD_MS).unref?.();
    return { ready: true, settledMutations };
  });
}
