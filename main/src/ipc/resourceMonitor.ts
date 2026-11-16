import os from 'node:os';
import type { IpcMain } from 'electron';
import { PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import type { AppServices } from './types';
import { resourceMonitorService } from '../services/resourceMonitorService';
import { RECLAIM_KINDS, MACHINE_HEALTH_ASK_AGENT_CHANNEL, MACHINE_HEALTH_IGNORE_LEAK_CHANNEL, MACHINE_HEALTH_PAUSE_IDLE_CHANNEL, MACHINE_HEALTH_RELIEF_CHANNEL, MACHINE_HEALTH_RESTART_PROCESS_CHANNEL, MACHINE_HEALTH_STOP_PROCESSES_CHANNEL, MACHINE_HEALTH_ARCHIVE_FINISHED_CHANNEL, MACHINE_HEALTH_FINISHED_CHANNEL, MACHINE_HEALTH_CLEANUP_CHANNEL, MACHINE_HEALTH_HISTORY_CHANNEL, MACHINE_HEALTH_INVENTORY_CHANNEL, MACHINE_HEALTH_SNAPSHOT_CHANNEL } from '../../../shared/types/machineHealth';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import { PANE_ONE_TIME_PROMPT_OPENING } from '../../../shared/types/paneChat';
import { terminalPanelManager } from '../services/terminalPanelManager';
import { bracketedPaste, normalizePromptNewlines, stripTrailingNewlines } from '../services/agents/promptDelivery';
import { PaneError } from '../../../shared/paneError';
import { logsManager } from '../services/panels/logPanel/logsManager';
import { canRestartProcess } from '../services/machineHealth/memoryRelief';

const inventoryRequestSchema = boundary.object({ refresh: boundary.optional(boundary.boolean) });
const archiveFinishedSchema = boundary.object({
  ids: boundary.array(boundary.string),
  source: boundary.enumeration('ui', 'card', 'cli'),
});
const sourceSchema = boundary.object({ source: boundary.enumeration('ui', 'card', 'cli') });
const identitySchema = boundary.object({ pid: boundary.number, started: boundary.string });
const stopProcessesSchema = boundary.object({ processes: boundary.array(identitySchema), source: boundary.enumeration('ui', 'card', 'cli') });
const cleanupRequestSchema = boundary.object({
  ids: boundary.optional(boundary.array(boundary.string)),
  kinds: boundary.optional(boundary.array(boundary.enumeration(...RECLAIM_KINDS))),
  source: boundary.enumeration('ui', 'card', 'cli'),
});

const DAEMON_RESOURCE_MONITOR_CHANNELS = [
  'resource-monitor:get-snapshot',
  MACHINE_HEALTH_SNAPSHOT_CHANNEL,
  MACHINE_HEALTH_INVENTORY_CHANNEL,
  MACHINE_HEALTH_CLEANUP_CHANNEL,
  MACHINE_HEALTH_HISTORY_CHANNEL,
  MACHINE_HEALTH_FINISHED_CHANNEL,
  MACHINE_HEALTH_ARCHIVE_FINISHED_CHANNEL,
  MACHINE_HEALTH_RELIEF_CHANNEL,
  MACHINE_HEALTH_PAUSE_IDLE_CHANNEL,
  MACHINE_HEALTH_STOP_PROCESSES_CHANNEL,
  MACHINE_HEALTH_RESTART_PROCESS_CHANNEL,
  MACHINE_HEALTH_IGNORE_LEAK_CHANNEL,
  MACHINE_HEALTH_ASK_AGENT_CHANNEL,
] as const;

/** How long an agent that missed the first 30 s may take to start before its request is dropped. */
const LATE_AGENT_WAIT_MS = 10 * 60_000;
/** Requests waiting for an agent that missed the first 30 s, by panel. */
const lateRequests = new Map<string, string>();
/**
 * Finding or creating the machine's Session runs one request at a time: a quick second click would
 * otherwise race the first create and fail with "A Session named ... already exists".
 */
let sessionLookup: Promise<unknown> = Promise.resolve();
function oneAtATime<Result>(task: () => Promise<Result>): Promise<Result> {
  const run = sessionLookup.then(task, task);
  sessionLookup = run.catch(() => undefined);
  return run;
}

export function registerResourceMonitorHandlers(
  ipcMain: IpcMain,
  services: AppServices,
  commandRegistry: PaneCommandRegistry,
): void {
  commandRegistry.register('resource-monitor:get-snapshot', async () => {
    try {
      const snapshot = await resourceMonitorService.getSnapshot();
      return { success: true, data: snapshot };
    } catch (error) {
      console.error('[IPC] Failed to get resource snapshot:', error);
      return { success: false, error: (error instanceof Error) ? error.message : String(error) };
    }
  });

  const machineHealth = () => {
    if (!services.machineHealth) {
      throw new PaneError('ERR_MACHINE_HEALTH_UNAVAILABLE', 'Machine health is not running in this Pane process.', 'Restart Pane, then try again.');
    }
    return services.machineHealth;
  };
  commandRegistry.register(MACHINE_HEALTH_SNAPSHOT_CHANNEL, async () => machineHealth().getSnapshot());
  /** The last storage inventory, or null before the first scan; `{ refresh: true }` also starts a new scan in the background. */
  commandRegistry.register(MACHINE_HEALTH_INVENTORY_CHANNEL, async (value: PaneCommandValue) =>
    machineHealth().getInventory(decodeBoundary(value ?? {}, inventoryRequestSchema).refresh === true));
  const cleanup = () => {
    if (!services.machineCleanup) {
      throw new PaneError('ERR_MACHINE_HEALTH_UNAVAILABLE', 'Cleanup does not run in this Pane process: another Pane serves this data folder.', 'Run the cleanup from the Pane that owns this data folder.');
    }
    return services.machineCleanup;
  };
  commandRegistry.register(MACHINE_HEALTH_CLEANUP_CHANNEL, async (value: PaneCommandValue) => {
    const request = decodeBoundary(value, cleanupRequestSchema);
    const run = await cleanup().run({ ...request, tiers: [1, 2] });
    // Refresh in the background so Resources shows what is left.
    void machineHealth().scanInventory().catch(() => undefined);
    return run;
  });
  commandRegistry.register(MACHINE_HEALTH_HISTORY_CHANNEL, async () => cleanup().history());
  const finished = () => {
    if (!services.finishedPanes) {
      throw new PaneError('ERR_MACHINE_HEALTH_UNAVAILABLE', 'Finished-Pane checks do not run in this Pane process.', 'Restart Pane, then try again.');
    }
    return services.finishedPanes;
  };
  commandRegistry.register(MACHINE_HEALTH_FINISHED_CHANNEL, async (value: PaneCommandValue) =>
    finished().list(decodeBoundary(value ?? {}, inventoryRequestSchema).refresh === true));
  commandRegistry.register(MACHINE_HEALTH_ARCHIVE_FINISHED_CHANNEL, async (value: PaneCommandValue) => {
    const request = decodeBoundary(value, archiveFinishedSchema);
    return finished().archive(request.ids, request.source);
  });

  const relief = () => {
    if (!services.memoryRelief) {
      throw new PaneError('ERR_MACHINE_HEALTH_UNAVAILABLE', 'Memory relief does not run in this Pane process.', 'Restart Pane, then try again.');
    }
    return services.memoryRelief;
  };
  /** Only processes the latest sample credits to a Pane may be stopped or restarted from outside. */
  const attributed = async (identity: { pid: number; started: string }) => {
    const snapshot = await machineHealth().getSnapshot();
    const proc = snapshot.panes.flatMap(pane => pane.processes).find(item => item.pid === identity.pid && item.started === identity.started);
    if (!proc) {
      throw new PaneError('ERR_MACHINE_PROCESS_NOT_PANES', `Process ${identity.pid} is not one Pane started, or it has exited. Nothing was stopped.`, 'Refresh Resources and pick the process again.');
    }
    return proc;
  };
  /** The Pause offer, leftovers, the leaks Restart can serve (run-script processes whose script is running), and whether this Pane cleans up at all. */
  commandRegistry.register(MACHINE_HEALTH_RELIEF_CHANNEL, async () => {
    const snapshot = machineHealth().latestSnapshot();
    const isRunning = (paneId: string) => logsManager.isRunning(paneId);
    const restartable = await Promise.all((snapshot?.leaks ?? []).map(async leak => (await canRestartProcess(snapshot, leak, isRunning) ? [leak.pid] : [])));
    return {
      idle: { ...relief().idleOffer(), hours: services.configManager.getConfig().machineHealth?.pauseIdleHours ?? 2 },
      leftBehind: relief().leftBehind(),
      restartable: restartable.flat(),
      // Only the Pane that owns its data folder cleans up; another one on that folder refuses every action.
      housekeeping: services.machineCleanup !== undefined,
    };
  });
  commandRegistry.register(MACHINE_HEALTH_PAUSE_IDLE_CHANNEL, async (value: PaneCommandValue) =>
    relief().pauseIdle(decodeBoundary(value, sourceSchema).source));
  commandRegistry.register(MACHINE_HEALTH_STOP_PROCESSES_CHANNEL, async (value: PaneCommandValue) => {
    const request = decodeBoundary(value, stopProcessesSchema);
    const processes = await Promise.all(request.processes.map(attributed));
    return relief().stopProcesses(processes, request.source);
  });
  commandRegistry.register(MACHINE_HEALTH_RESTART_PROCESS_CHANNEL, async (value: PaneCommandValue) => {
    const proc = await attributed(decodeBoundary(value, identitySchema));
    if (!(await canRestartProcess(machineHealth().latestSnapshot(), proc, paneId => logsManager.isRunning(paneId)))) {
      throw new PaneError('ERR_MACHINE_RESTART_UNSUPPORTED', `${proc.name} does not belong to this Pane's run script, so Pane cannot start it again. Nothing was changed.`, 'Stop it instead, then start it again in its tab.');
    }
    await commandRegistry.invoke('sessions:stop-script', [proc.sessionId]);
    await commandRegistry.invoke('sessions:run-script', [proc.sessionId]);
    return { restarted: proc.sessionId };
  });
  commandRegistry.register(MACHINE_HEALTH_IGNORE_LEAK_CHANNEL, async (value: PaneCommandValue) => {
    const identity = decodeBoundary(value, identitySchema);
    machineHealth().ignoreLeak(identity.pid, identity.started);
    return { ignored: identity.pid };
  });

  // The request goes to a Session named for the machine, started and shown, so it never depends
  // on a tab the window has not opened yet. A second request reuses that Session while it is open.
  commandRegistry.register(MACHINE_HEALTH_ASK_AGENT_CHANNEL, async (value: PaneCommandValue) => {
    const request = decodeBoundary(value, boundary.object({ name: boundary.optional(boundary.nonEmptyString), prompt: boundary.nonEmptyString }));
    const { prompt } = request;
    // A desktop older than this host sends no name: the Session is named for this machine.
    const name = request.name ?? `Clean up ${services.machineHealth?.latestSnapshot()?.hostname ?? os.hostname()}`;
    const sessions = services.orchestrationSessionManager;
    if (!sessions) {
      throw new PaneError('ERR_MACHINE_HEALTH_UNAVAILABLE', 'Sessions are not running in this Pane process, so no agent was asked.', 'Restart Pane, then try Ask an agent again.');
    }
    const submit = (panelId: string) => {
      // A request sent now replaces one still waiting for this agent to start.
      lateRequests.delete(panelId);
      return commandRegistry.invoke('runpane:panels:submit', [{ panelId, input: prompt, source: 'user', expectReport: false }]);
    };
    const ready = async (panelId: string, timeoutMs?: number) =>
      decodeOptionalBoundary(await commandRegistry.invoke('runpane:panels:wait', [{ panelId, condition: 'ready', timeoutMs }]), boundary.object({ ok: boundary.boolean }))?.ok === true;
    /**
     * Types the request once the agent is ready (30 s). An agent still starting gets it later: a
     * terminal agent in its input box, for the person to send; a chat tab as a queued message.
     */
    const typeWhenReady = async (panelId: string, panelType: string): Promise<boolean> => {
      if (await ready(panelId)) {
        await submit(panelId);
        return true;
      }
      void services.notifyService?.queue.ask({
        question: {
          ui: 'info',
          title: 'The agent is still starting',
          // A chat tab sends the queued request itself; a terminal agent leaves it for the person.
          context: panelType === 'chat'
            ? 'Your cleanup request is queued and will be sent to the agent when it is ready.'
            : 'Your cleanup request will appear in its input box when it is ready. Press Enter there to send it.',
        },
        source: { name: 'Pane', agent: 'Pane' },
      });
      // One late delivery per agent: a later click while it waits only updates the request.
      const waiting = lateRequests.has(panelId);
      lateRequests.set(panelId, prompt);
      if (waiting) return false;
      void (async () => {
        if (!(await ready(panelId, LATE_AGENT_WAIT_MS))) {
          // Given up: forget the request so the next slow start waits for its own.
          lateRequests.delete(panelId);
          return;
        }
        const late = lateRequests.get(panelId);
        lateRequests.delete(panelId);
        if (late === undefined) return;
        if (panelType === 'chat') {
          await commandRegistry.invoke('runpane:panels:submit', [{ panelId, input: late, source: 'user', expectReport: false }]);
          return;
        }
        // Never into a draft the person is typing.
        const screen = decodeOptionalBoundary(await commandRegistry.invoke('runpane:panels:screen', [{ panelId }]), boundary.object({ composer: boundary.object({ hasUndeliveredText: boundary.boolean }) }));
        if (screen?.composer.hasUndeliveredText !== false) return;
        // As runpane stages composer text: newlines stay text inside one bracketed paste, never Enter.
        const text = stripTrailingNewlines(normalizePromptNewlines(late));
        terminalPanelManager.writeToTerminal(panelId, terminalPanelManager.isBracketedPasteEnabled(panelId) ? bracketedPaste(text) : text.replace(/\n+/gu, ' '));
      })().catch(error => {
        lateRequests.delete(panelId);
        console.warn('[MachineHealth] Ask an agent: the late agent did not get the request:', error);
      });
      return false;
    };
    const key = (sessionName: string) => sessionName.trim().toLocaleLowerCase();
    // The machine's Session, or the numbered one that replaced it after it was archived.
    const ours = (sessionName: string) => key(sessionName) === key(name) || (key(sessionName).startsWith(`${key(name)} `) && /^\d+$/.test(key(sessionName).slice(key(name).length + 1)));
    const found = await oneAtATime(async () => {
      const { sessions: all } = await sessions.list();
      const open = all.find(session => ours(session.name) && session.archived !== true);
      if (open) return { created: false, atLaunch: false, view: await sessions.getView({ sessionId: open.id }) };
      // An archived Session keeps its name, so the new one takes the next free number.
      let fresh = name;
      for (let n = 2; all.some(session => key(session.name) === key(fresh)); n += 1) fresh = `${name} ${n}`;
      // As the Pane Chat offer does: the request rides on the agent's launch line when the shell allows it.
      const atLaunch = terminalPanelManager.launchShellIsPosix();
      const view = await sessions.create({
        name: fresh, launchCommand: '', customResume: null,
        openingPrompt: atLaunch ? `${PANE_ONE_TIME_PROMPT_OPENING}, when you clicked Ask an agent in Resources: ${prompt}` : undefined,
      });
      if (view.panel.type === 'terminal') await terminalPanelManager.initializeTerminal(view.panel, view.internalSession.worktreePath);
      return { created: true, atLaunch, view };
    });
    const { view } = found;
    if (!found.created) {
      const resumed = decodeOptionalBoundary(await commandRegistry.invoke('runpane:panels:resume', [{ panelId: view.panel.id }]), boundary.object({ action: boundary.string }));
      // A running agent queues the request behind its turn; one just started gets it once it is ready.
      if (resumed?.action === 'already-running') {
        await submit(view.panel.id);
        return { sessionId: view.session.id, panelId: view.panel.id, typed: true };
      }
      return { sessionId: view.session.id, panelId: view.panel.id, typed: await typeWhenReady(view.panel.id, view.panel.type) };
    }
    // PowerShell and cmd cannot carry it on the launch line: type it once the agent is ready.
    const typed = found.atLaunch || await typeWhenReady(view.panel.id, view.panel.type);
    return { sessionId: view.session.id, panelId: view.panel.id, typed };
  });

  commandRegistry.bindChannels(ipcMain, DAEMON_RESOURCE_MONITOR_CHANNELS);
}
