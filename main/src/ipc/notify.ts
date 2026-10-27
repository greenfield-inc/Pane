import { app, BrowserWindow, type IpcMain } from 'electron';
import type { AppServices } from './types';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import { paneCommandSignal } from '../daemon/commandRegistry';
import { panelManager } from '../services/panelManager';
import { terminalPanelManager } from '../services/terminalPanelManager';
import { NotifyService } from '../services/notify/notifyService';
import { buildWindowAppearanceOptions } from '../services/appearanceService';
import { normalizeAppearance } from '../../../shared/types/appearance';
import { PaneError } from '../../../shared/paneError';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import type { NotifyCommand, NotifyRequest, NotifyResult } from '../../../shared/types/notify';
import type { AgentState } from '../../../shared/types/agentStatus';

const MAX_CHOICES = 9;
const MAX_TEXT = 4_000;
const MAX_DETAIL = 20_000;

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
  boundary.object({ type: boundary.literal('remind'), id: boundary.nonEmptyString, after: boundary.enumeration('10m', '1h', 'pane') }),
  boundary.object({ type: boundary.literal('hover-info'), id: boundary.nonEmptyString, hovering: boundary.boolean }),
  boundary.object({ type: boundary.literal('pause'), minutes: boundary.number }),
  boundary.object({ type: boundary.literal('resume') }),
  boundary.object({ type: boundary.literal('open-round'), id: boundary.optional(boundary.nonEmptyString) }),
  boundary.object({ type: boundary.literal('close-round') }),
  boundary.object({ type: boundary.literal('open-inbox') }),
);
const windowSizeSchema = boundary.object({ width: boundary.number, height: boundary.number });
const panelAgentSchema = boundary.object({ agentType: boundary.optional(boundary.string) });

export function registerNotifyHandlers(ipcMain: IpcMain, services: AppServices, commandRegistry: PaneCommandRegistry): NotifyService {
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
  });

  commandRegistry.register('runpane:notify', async (request: PaneCommandValue): Promise<NotifyResult> => {
    return notify.ask(parseNotifyRequest(request), paneCommandSignal());
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
  app.on('will-quit', () => notify.dispose());
  return notify;
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
  if (request.suggestions !== undefined && ui !== 'ask') throw invalid(`suggestions only goes with ui: ask, not ${ui}.`);
  if (request.action !== undefined && ui !== 'info') throw invalid(`action only goes with ui: info, not ${ui}.`);
  if (request.action && !/^https?:\/\//i.test(request.action.url)) throw invalid('action.url must be an http(s) URL.');
  return request;
}

function invalid(reason: string): PaneError {
  return new PaneError('ERR_NOTIFY_INVALID', `Pane can't show this notify call: ${reason} Nothing was shown.`, 'Fix the field named above and call notify again.');
}
