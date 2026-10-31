import { app, BrowserWindow, type IpcMain } from 'electron';
import os from 'os';
import type { AppServices } from './types';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import { paneCommandSignal } from '../daemon/commandRegistry';
import { remotePaneClientController } from '../daemon/client/remotePaneClient';
import { getPaneEventSink } from '../core/runtime';
import { hasHeadlessDaemonLaunchArg } from '../utils/runtimeMode';
import { getMobilePushSender } from '../daemon/mobilePushSender';
import { panelManager } from '../services/panelManager';
import { terminalPanelManager } from '../services/terminalPanelManager';
import { NotifyService } from '../services/notify/notifyService';
import { ClaudePromptBridge } from '../services/claudePrompts/claudePromptBridge';
import { setClaudePromptBridge } from '../services/claudePrompts';
import type { MachineConnections } from '../services/machineConnections';
import { LOCAL_MACHINE_ID, type MachineState } from '../../../shared/types/machineConnections';
import { buildWindowAppearanceOptions } from '../services/appearanceService';
import { normalizeAppearance } from '../../../shared/types/appearance';
import { PaneError } from '../../../shared/paneError';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import type { PaneLinkTarget } from '../../../shared/types/paneLinks';
import type { NotifyCommand, NotifyRemoteCommand, NotifyRequest, NotifyResult, NotifySharedState } from '../../../shared/types/notify';
import type { AgentState } from '../../../shared/types/agentStatus';

const MAX_CHOICES = 9;
const MAX_TEXT = 4_000;
const MAX_DETAIL = 20_000;
const MAX_DETAIL_LABEL = 40;

const notifyRequestSchema = boundary.object({
  ui: boundary.optional(boundary.enumeration('options', 'approve', 'ask', 'info')),
  title: boundary.optional(boundary.string),
  context: boundary.optional(boundary.string),
  choices: boundary.optional(boundary.array(boundary.object({
    label: boundary.nonEmptyString,
    detail: boundary.optional(boundary.string),
    recommended: boundary.optional(boundary.boolean),
  }))),
  detail: boundary.optional(boundary.string),
  detailLabel: boundary.optional(boundary.string),
  suggestions: boundary.optional(boundary.array(boundary.string)),
  action: boundary.optional(boundary.object({ label: boundary.nonEmptyString, url: boundary.nonEmptyString })),
  resume: boundary.optional(boundary.nonEmptyString),
  returnAfterMs: boundary.optional(boundary.number),
  caller: boundary.object({
    paneId: boundary.optional(boundary.string),
    panelId: boundary.optional(boundary.string),
    cwd: boundary.optional(boundary.string),
    agent: boundary.optional(boundary.string),
  }),
});

const answerSchema = boundary.union(
  boundary.object({ choice: boundary.nonEmptyString, note: boundary.optional(boundary.string) }),
  boundary.object({ approved: boundary.boolean, note: boundary.optional(boundary.string) }),
  boundary.object({ text: boundary.string }),
);
const idCommand = <const T extends string>(type: T) => boundary.object({ type: boundary.literal(type), id: boundary.nonEmptyString });
const notifyCommandSchema = boundary.union(
  boundary.object({ type: boundary.literal('answer'), id: boundary.nonEmptyString, answer: answerSchema }),
  idCommand('undo'),
  idCommand('dismiss'),
  idCommand('skip'),
  idCommand('open-in-pane'),
  boundary.object({ type: boundary.literal('remind'), id: boundary.nonEmptyString, after: boundary.enumeration('3m', '5m', '15m', '10m', '1h', 'pane') }),
  boundary.object({ type: boundary.literal('hover-info'), id: boundary.nonEmptyString, hovering: boundary.boolean }),
  boundary.object({ type: boundary.literal('pause'), minutes: boundary.number }),
  boundary.object({ type: boundary.literal('resume') }),
  boundary.object({ type: boundary.literal('open-round'), id: boundary.optional(boundary.nonEmptyString) }),
  boundary.object({ type: boundary.literal('close-round') }),
  boundary.object({ type: boundary.literal('open-inbox') }),
  boundary.object({ type: boundary.literal('show-details'), shown: boundary.boolean }),
);
const notifyRemoteCommandSchema = boundary.union(
  boundary.object({ type: boundary.literal('answer'), id: boundary.nonEmptyString, answer: answerSchema }),
  idCommand('undo'),
  idCommand('dismiss'),
  idCommand('skip'),
  boundary.object({ type: boundary.literal('remind'), id: boundary.nonEmptyString, after: boundary.enumeration('3m', '5m', '15m', '10m', '1h') }),
);
/** The server's name for the sender (httpApiServer fills it in), never the caller's own claim. */
const remoteSenderSchema = boundary.object({ device: boundary.nonEmptyString });
const notifyItemSchema = boundary.object({
  id: boundary.nonEmptyString,
  ui: boundary.enumeration('options', 'approve', 'ask', 'info'),
  title: boundary.string,
  context: boundary.optional(boundary.string),
  choices: boundary.optional(boundary.array(boundary.object({
    label: boundary.nonEmptyString,
    detail: boundary.optional(boundary.string),
    recommended: boundary.optional(boundary.boolean),
  }))),
  detail: boundary.optional(boundary.string),
  detailLabel: boundary.optional(boundary.string),
  suggestions: boundary.optional(boundary.array(boundary.string)),
  action: boundary.optional(boundary.object({ label: boundary.nonEmptyString, url: boundary.nonEmptyString })),
  agentPrompt: boundary.optional(boundary.object({ yes: boundary.string, no: boundary.string, inTerminal: boundary.optional(boundary.boolean) })),
  source: boundary.object({
    paneId: boundary.optional(boundary.string),
    panelId: boundary.optional(boundary.string),
    name: boundary.string,
    agent: boundary.string,
  }),
  state: boundary.enumeration('waiting', 'sent', 'answered', 'expired', 'info'),
  createdAt: boundary.number,
  resolvedAt: boundary.optional(boundary.number),
  answerSummary: boundary.optional(boundary.string),
  answeredOn: boundary.optional(boundary.string),
  snoozedUntil: boundary.optional(boundary.number),
});
const notifySharedStateSchema = boundary.object({
  machine: boundary.string,
  epoch: boundary.string,
  revision: boundary.number,
  enabled: boundary.boolean,
  items: boundary.array(notifyItemSchema),
  queue: boundary.array(boundary.string),
  hidden: boundary.array(boundary.string),
});
const windowSizeSchema = boundary.object({ width: boundary.number, height: boundary.number });
const panelAgentSchema = boundary.object({ agentType: boundary.optional(boundary.string) });

/** What Notify reads from the app's services: the config, Panes by id, and the main window. */
type NotifyServices = Pick<AppServices, 'configManager' | 'getMainWindow'> & {
  sessionManager: Pick<AppServices['sessionManager'], 'getSession'>;
  databaseService?: Pick<AppServices['databaseService'], 'getAllProjects'>;
};

export function registerNotifyHandlers(ipcMain: IpcMain, services: NotifyServices, commandRegistry: PaneCommandRegistry): NotifyService {
  const notify = new NotifyService({
    configManager: services.configManager,
    getMainWindow: services.getMainWindow,
    findPane: (caller) => {
      const panel = caller.panelId ? panelManager.getPanel(caller.panelId) : undefined;
      const paneId = caller.paneId || panel?.sessionId;
      const pane = paneId ? services.sessionManager.getSession(paneId) : undefined;
      // The same ownership rule as `runpane report` and locks: the panel must belong to the Pane.
      if (!pane || pane.archived || (panel && panel.sessionId !== pane.id)) return undefined;
      const agentType = decodeOptionalBoundary(panel?.state.customState, panelAgentSchema)?.agentType;
      return { paneId: pane.id, panelId: panel?.id, name: pane.name, agentType };
    },
    focusPanel: async (paneId, panelId) => {
      await commandRegistry.invoke('runpane:panes:focus', [{ paneId, panelId, source: 'user' }]);
    },
    rendererArguments: () => buildWindowAppearanceOptions(normalizeAppearance(services.configManager.getConfig()).appearance, false, {}).additionalArguments,
    headless: hasHeadlessDaemonLaunchArg(),
    machine: machineName(),
    publish: (state) => getPaneEventSink().send('notify:shared-changed', state),
    sendToMachine: async (machineId, command) => {
      if (!saved) throw new PaneError('ERR_MACHINE_UNKNOWN', 'Pane is still starting its machine connections. Nothing was sent.', 'Answer again in a moment.');
      const { machines } = saved;
      const send = () => machines.run(machineId, { type: 'notify', command });
      try {
        await send();
      } catch (error) {
        // While a machine connects, its questions already show but commands wait.
        // ERR_MACHINE_OFFLINE means nothing was sent, so the answer goes once it is connected.
        if (!(error instanceof PaneError && error.code === 'ERR_MACHINE_OFFLINE') || !(await saved.onlineSoon(machineId))) throw error;
        await send();
      }
    },
    refreshMachine: (machineId) => void saved?.read(machineId),
    // Every question buzzes each phone with Needs Input on (D-7), on a desktop or a headless host.
    onQuestion: (event) => {
      // Optional delivery: a failed send or config write must never take the host down.
      getMobilePushSender(services.configManager).observeQuestion(event).catch((error: Error) => {
        console.warn('[Notify] The phone alert for a question was not sent:', error);
      });
    },
    // A connected desktop ignores the host's pane:focus-requested; it opens Panes as pane:// links.
    wslDistros: () => (services.databaseService?.getAllProjects() ?? [])
      .flatMap(project => project.wsl_enabled && project.wsl_distribution ? [project.wsl_distribution] : []),
    showHostPane: (paneId, panelId) => {
      const window = services.getMainWindow();
      const target: PaneLinkTarget = panelId ? { kind: 'pane', paneId, panelId } : { kind: 'pane', paneId };
      if (window && !window.isDestroyed()) window.webContents.send('pane:open-link', target);
    },
  });

  /** Set once the machine connections start: every saved machine's questions then show here. */
  let saved: SavedMachinesLink | null = null;
  followMachines = (machines) => { saved = linkSavedMachines(notify, machines); };

  // Open in Pane works for the machine the app is on; another machine's card would need a switch.
  const showActiveMachine = () => {
    const state = remotePaneClientController.getConnectionState();
    notify.queue.setActiveMachine(state.mode === 'remote' && state.activeProfileId ? state.activeProfileId : LOCAL_MACHINE_ID);
  };
  remotePaneClientController.on('state-changed', showActiveMachine);
  showActiveMachine();

  commandRegistry.register('runpane:notify', async (request: PaneCommandValue): Promise<NotifyResult> => {
    return notify.ask(parseNotifyRequest(request), paneCommandSignal());
  });

  commandRegistry.register('notify:remote-snapshot', async () => notify.sharedState());
  commandRegistry.register('notify:remote-command', async (command: PaneCommandValue, sender: PaneCommandValue) => {
    // A Mac names itself "studio.local" on its event stream; cards call it "studio".
    const device = decodeBoundary(sender, remoteSenderSchema).device.replace(/\.local$/i, '');
    notify.runRemote(decodeBoundary(command, notifyRemoteCommandSchema) satisfies NotifyRemoteCommand, device);
    return null;
  });

  ipcMain.handle('notify:snapshot', () => notify.snapshot());
  ipcMain.handle('notify:command', (_event, command: PaneCommandValue) => notify.run(decodeBoundary(command, notifyCommandSchema) satisfies NotifyCommand));
  ipcMain.on('notify:window-size', (event, size: PaneCommandValue) => notify.resizeWindow(event.sender, decodeBoundary(size, windowSizeSchema)));
  ipcMain.handle('notify:window-focus', (event) => notify.focusWindow(event.sender));

  app.on('browser-window-focus', (_event, window: BrowserWindow) => {
    if (window === services.getMainWindow()) notify.setMainWindowFocused(true);
  });
  app.on('browser-window-blur', (_event, window: BrowserWindow) => {
    if (window === services.getMainWindow()) notify.setMainWindowFocused(false);
  });
  // Codex 0.164's Esc drops the call without telling the server: a Codex panel idle at its prompt
  // with a call still open has stopped waiting. Other clients cancel the call themselves, and a
  // shell running `runpane notify` reads as idle while it waits, so only Codex panels count.
  terminalPanelManager.on('agent-status', (change: { panelId: string; state: AgentState }) => {
    const agentType = decodeOptionalBoundary(panelManager.getPanel(change.panelId)?.state.customState, panelAgentSchema)?.agentType;
    if (agentType === 'codex') notify.queue.panelStatus(change.panelId, change.state === 'idle');
  });
  app.on('browser-window-created', (_event, window: BrowserWindow) => {
    window.on('closed', () => notify.closeFloatingWindowsIfAlone());
  });
  for (const window of BrowserWindow.getAllWindows()) window.on('closed', () => notify.closeFloatingWindowsIfAlone());
  app.on('will-quit', () => notify.dispose());
  startClaudePrompts(notify, services);
  return notify;
}

/** Seconds Claude holds a prompt's hook before it stops waiting on Pane; tests shorten it. */
const CLAUDE_PROMPT_TIMEOUT_SECONDS = Number(process.env.PANE_CLAUDE_PROMPT_TIMEOUT_SECONDS) || 600;

/** Claude tabs Pane starts ask their permission and plan prompts here too (Settings → AI agents). */
function startClaudePrompts(notify: NotifyService, services: NotifyServices): void {
  const { configManager } = services;
  const bridge = new ClaudePromptBridge({
    queue: notify.queue,
    tab: (panelId) => {
      const panel = panelManager.getPanel(panelId);
      const pane = panel ? services.sessionManager.getSession(panel.sessionId) : undefined;
      if (!panel || !pane || pane.archived) return undefined;
      // Claude keeps a worktree's "don't ask again" rules in its repository, which is the Pane project.
      const project = services.databaseService?.getAllProjects().find(candidate => candidate.id === pane.projectId)?.name;
      return { source: { paneId: pane.id, panelId, name: pane.name, agent: 'Claude' }, project };
    },
    enabled: () => configManager.getConfig().answerPromptsFromPane !== false,
    hookTimeoutSeconds: CLAUDE_PROMPT_TIMEOUT_SECONDS,
    onPrompt: () => {
      // The switch starts on for everyone (D-120), so the first prompt says where it came from once.
      if (configManager.getConfig().claudePromptsNoteShown) return;
      void configManager.updateConfig({ claudePromptsNoteShown: true });
      void notify.queue.ask({
        question: {
          ui: 'info',
          title: "Claude's prompts now show here",
          context: 'Pane asks the permission and plan prompts of the Claude tabs it starts in Notify and on your phone. The terminal still asks too; the first answer wins. Turn it off in Settings → AI agents → Answer prompts from Pane.',
        },
        source: { name: 'Pane', agent: 'Pane' },
      });
    },
  });
  terminalPanelManager.on('agent-status', (change: { panelId: string; state: AgentState }) => bridge.panelStatus(change.panelId, change.state));
  bridge.start().then(() => setClaudePromptBridge(bridge)).catch((error: Error) => {
    console.warn("[Claude prompts] Pane couldn't listen for Claude's prompts; they stay in the terminal:", error);
  });
  app.on('will-quit', () => {
    setClaudePromptBridge(undefined);
    void bridge.stop();
  });
}

/** What Notify uses of the machine connections (main/src/services/machineConnections.ts). */
export type NotifyMachines = Pick<MachineConnections, 'subscribe' | 'list' | 'read' | 'run'>;

interface SavedMachinesLink {
  machines: NotifyMachines;
  /** Reads one saved machine's questions again. */
  read: (machineId: string) => Promise<void>;
  /** Waits up to 15 s for a machine that is still connecting to answer; false if it isn't connecting or doesn't. */
  onlineSoon: (machineId: string) => Promise<boolean>;
}

let followMachines: ((machines: NotifyMachines) => void) | null = null;

/**
 * Shows every saved machine's questions beside this computer's, in any mode, each slot fed by
 * that machine's own connection, for as long as the connections run. Call after `registerNotifyHandlers`.
 */
export function followSavedMachines(machines: NotifyMachines): void {
  followMachines?.(machines);
}

/** One Notify slot per saved machine: read on first sight, on reconnect and resync; kept, unanswerable, while offline. */
function linkSavedMachines(notify: NotifyService, machines: NotifyMachines): SavedMachinesLink {
  const queue = notify.queue;
  const known = new Map<string, MachineState>();
  /** `state` is undefined when the machine sent a Notify state this Pane cannot read. */
  const show = (machineId: string, state: NotifySharedState | undefined) => {
    const machine = known.get(machineId);
    if (!machine) return;
    if (!state) {
      console.warn(`[Notify] ${machine.label} sent a Notify state this Pane cannot read; its questions are not shown here.`);
      return;
    }
    // A read finishing after the machine went offline must not mark its cards answerable again.
    queue.setRemote(machineId, { machine: machine.label, online: machine.status !== 'offline', state });
  };
  const read = async (machineId: string) => {
    if (!known.has(machineId)) return;
    try {
      show(machineId, decodeOptionalBoundary((await machines.read(machineId, 'notify:remote-snapshot')).data, notifySharedStateSchema));
    } catch (error) {
      // An older machine has no remote Notify, and one that is off can't answer; its questions stay on its own screen.
      console.warn(`[Notify] Could not read ${known.get(machineId)?.label ?? machineId}'s questions:`, error);
    }
  };
  const apply = (list: MachineState[]) => {
    const listed = new Set<string>();
    for (const machine of list) {
      if (machine.kind === 'local') continue;
      listed.add(machine.id);
      const before = known.get(machine.id);
      known.set(machine.id, { ...machine });
      if (machine.status === 'offline') queue.setRemote(machine.id, { machine: machine.label, online: false });
      // A stream can recover without a resync here yet: read the machine again.
      else if (!before || (machine.status === 'online' && before.status !== 'online')) void read(machine.id);
      else if (before.label !== machine.label) queue.setRemote(machine.id, { machine: machine.label, online: true });
    }
    for (const id of [...known.keys()]) {
      if (listed.has(id)) continue;
      known.delete(id);
      queue.setRemote(id, null);
    }
  };
  machines.subscribe((event) => {
    if (event.type === 'machines') apply(event.machines);
    // This computer's own questions are already in the queue.
    else if (event.machineId === LOCAL_MACHINE_ID) return;
    else if (event.type === 'resync') void read(event.machineId);
    else if (event.channel === 'notify:shared-changed') show(event.machineId, decodeOptionalBoundary(event.args[0], notifySharedStateSchema));
  });
  apply(machines.list());
  return {
    machines,
    read,
    onlineSoon: (machineId) => new Promise<boolean>((resolve) => {
      if (known.get(machineId)?.status !== 'connecting') {
        resolve(false);
        return;
      }
      let stopWaiting: () => void = () => undefined;
      const timer = setTimeout(() => done(false), 15_000);
      const done = (online: boolean) => {
        clearTimeout(timer);
        stopWaiting();
        resolve(online);
      };
      stopWaiting = machines.subscribe((event) => {
        if (event.type !== 'machines') return;
        const status = event.machines.find(machine => machine.id === machineId)?.status;
        if (status === 'online') done(true);
        else if (status !== 'connecting') done(false);
      });
    }),
  };
}

/** Checks a notify call the way the tool's schema promises, naming the field that's wrong. */
function parseNotifyRequest(value: PaneCommandValue): NotifyRequest {
  let request: NotifyRequest;
  try {
    request = decodeBoundary(value, notifyRequestSchema);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : String(error));
  }
  if (request.resume) return request;
  const { ui } = request;
  if (!ui) throw invalid('ui is required: options, approve, ask or info.');
  if (!request.title?.trim()) throw invalid('title is required.');
  if (request.title.length > MAX_TEXT || (request.context?.length ?? 0) > MAX_TEXT) throw invalid(`title and context take up to ${MAX_TEXT} characters.`);
  if ((request.detail?.length ?? 0) > MAX_DETAIL) throw invalid(`detail takes up to ${MAX_DETAIL} characters.`);
  if (ui === 'options') {
    const count = request.choices?.length ?? 0;
    if (count < 1 || count > MAX_CHOICES) throw invalid(`choices needs 1 to ${MAX_CHOICES} entries for an options question; it has ${count}.`);
    const labels = new Set(request.choices?.map(choice => choice.label.trim()));
    if (labels.size !== count) throw invalid('choices need different labels.');
  } else if (request.choices) {
    throw invalid(`choices only goes with ui: options, not ${ui}.`);
  }
  if (request.detail !== undefined && ui !== 'approve') throw invalid(`detail only goes with ui: approve, not ${ui}.`);
  if (request.detailLabel !== undefined && request.detail === undefined) throw invalid('detailLabel needs detail: it labels the button that shows it.');
  // Code points, as the CLIs count them.
  if ([...request.detailLabel ?? ''].length > MAX_DETAIL_LABEL) throw invalid(`detailLabel takes up to ${MAX_DETAIL_LABEL} characters.`);
  if (request.suggestions !== undefined && ui !== 'ask') throw invalid(`suggestions only goes with ui: ask, not ${ui}.`);
  if (request.action !== undefined && ui !== 'info') throw invalid(`action only goes with ui: info, not ${ui}.`);
  if (request.action && !/^https?:\/\//i.test(request.action.url)) throw invalid('action.url must be an http(s) URL.');
  return request;
}

/** The name other screens and phones show for this machine, as a connected client labels itself. */
function machineName(): string {
  return os.hostname().trim().replace(/\.local$/i, '').slice(0, 80) || 'this computer';
}

function invalid(reason: string): PaneError {
  return new PaneError('ERR_NOTIFY_INVALID', `Pane can't show this notify call: ${reason} Nothing was shown.`, 'Fix the field named above and call notify again.');
}
