import { customCommandResumeSchema } from '../../../shared/types/customCommandResume';
import { listWSLDistributions } from '../utils/wslUtils';
import type { IpcMain } from 'electron';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import type { AppServices } from './types';
import type {
  OrchestrationAssociationInput,
  OrchestrationSessionArchiveResult,
  OrchestrationSessionOpenResult,
  OrchestrationSessionSelector,
  OrchestrationSessionView,
} from '../../../shared/types/orchestrationSession';
import type { Session } from '../types/session';
import { getChatTabManager } from '../services/chatTabs';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { PaneError, paneErrorText } from '../../../shared/paneError';
import { previewOrchestrationSessionArchive, updateOrchestrationSession } from './runpane';
import { clientShowsChatTab, panelsForClient, storedPanelLayout } from './panels';
import {
  decodeOrchestrationSessionPayload,
  orchestrationExpectedRevisionSchema,
  orchestrationLinksSchema,
  orchestrationReportSchema,
  orchestrationTextArraySchema,
  orchestrationTextSchema,
} from '../services/orchestrationSessionPayload';
import { configuredAgentSchema } from '../../../shared/agents';

const openOptionsSchema = boundary.object({ select: boundary.optional(boundary.boolean) });
/** Newest chat messages an open or peek returns, as the desktop's chat viewer reads them. */
const OPEN_CHAT_LIMIT = 200;

const selectorSchema = boundary.object({
  sessionId: boundary.optional(boundary.nonEmptyString),
  name: boundary.optional(boundary.nonEmptyString),
});
const createSchema = boundary.object({
  runtime: boundary.optional(boundary.enumeration('windows', 'wsl')),
  wslDistribution: boundary.optional(boundary.nonEmptyString),
  name: boundary.nonEmptyString,
  nameFromFirstMessage: boundary.optional(boundary.boolean),
  isPinned: boundary.optional(boundary.boolean),
  agent: boundary.optional(configuredAgentSchema),
  launchCommand: boundary.optional(orchestrationTextSchema),
  customResume: boundary.optional(boundary.nullable(customCommandResumeSchema)),
  openingPrompt: boundary.optional(orchestrationTextSchema),
  profile: boundary.optional(orchestrationTextSchema),
  goal: boundary.optional(orchestrationTextSchema),
  context: boundary.optional(orchestrationTextSchema),
  decisions: boundary.optional(orchestrationTextArraySchema),
  blockers: boundary.optional(orchestrationTextArraySchema),
  nextAction: boundary.optional(orchestrationTextSchema),
  evidence: boundary.optional(orchestrationLinksSchema),
  outputs: boundary.optional(orchestrationLinksSchema),
});
const updateSchema = boundary.object({
  name: boundary.optional(orchestrationTextSchema),
  archived: boundary.optional(boundary.boolean),
  isPinned: boundary.optional(boundary.boolean),
  agent: boundary.optional(configuredAgentSchema),
  launchCommand: boundary.optional(orchestrationTextSchema),
  customResume: boundary.optional(boundary.nullable(customCommandResumeSchema)),
  profile: boundary.optional(orchestrationTextSchema),
  goal: boundary.optional(orchestrationTextSchema),
  context: boundary.optional(orchestrationTextSchema),
  decisions: boundary.optional(orchestrationTextArraySchema),
  blockers: boundary.optional(orchestrationTextArraySchema),
  nextAction: boundary.optional(orchestrationTextSchema),
  evidence: boundary.optional(orchestrationLinksSchema),
  outputs: boundary.optional(orchestrationLinksSchema),
  report: boundary.optional(boundary.nullable(orchestrationReportSchema)),
  expectedRevision: boundary.optional(orchestrationExpectedRevisionSchema),
  source: boundary.optional(boundary.enumeration('user', 'agent')),
});
const archiveSelectionSchema = boundary.object({
  archivePaneIds: boundary.array(boundary.nonEmptyString),
  forcePaneIds: boundary.array(boundary.nonEmptyString),
});
const agentSchema = boundary.object({
  ...selectorSchemaFields(),
  agent: configuredAgentSchema,
});
const associationSchema = boundary.object({
  ...selectorSchemaFields(),
  paneId: boundary.nonEmptyString,
  panelIds: boundary.optional(boundary.array(boundary.nonEmptyString)),
});
const reorderSchema = boundary.object({
  sessionIds: boundary.array(boundary.nonEmptyString),
});
const detachSchema = boundary.object({
  ...selectorSchemaFields(),
  paneId: boundary.optional(boundary.nonEmptyString),
});

export function registerOrchestrationSessionHandlers(
  ipcMain: IpcMain,
  services: AppServices,
  commandRegistry: PaneCommandRegistry,
): void {
  const manager = services.orchestrationSessionManager;
  commandRegistry.register('orchestration-sessions:runtimes', async () => invokeSafely(async () => ({
    distributions: process.platform === 'win32' ? await listWSLDistributions().catch(() => []) : [],
  })));
  commandRegistry.bindChannel(ipcMain, 'orchestration-sessions:runtimes');
  const requireManager = () => {
    if (!manager) throw new Error('Sessions manager is not initialized');
    return manager;
  };

  commandRegistry.register('orchestration-sessions:promote', async (value: PaneCommandValue) => {
    return invokeSafely(() => {
      const input = decodeBoundary(value, boundary.object({ panelId: boundary.nonEmptyString, name: boundary.nonEmptyString }));
      return requireManager().create({ name: input.name }, input.panelId);
    });
  });
  commandRegistry.bindChannel(ipcMain, 'orchestration-sessions:promote');


  commandRegistry.register('orchestration-sessions:list', async () => {
    return invokeSafely(() => requireManager().list());
  });
  commandRegistry.bindChannel(ipcMain, 'orchestration-sessions:list');

  commandRegistry.register('orchestration-sessions:select', async (value: PaneCommandValue) => {
    return invokeSafely(() => requireManager().select(decodeSelector(value)));
  });
  commandRegistry.bindChannel(ipcMain, 'orchestration-sessions:select');

  // Phone apps released before chat tabs crash on a tab kind they do not know (D-100, D-203):
  // their new Sessions start in a terminal, and a Session whose orchestrator is a chat tells them to update.
  commandRegistry.register('orchestration-sessions:create', async (value: PaneCommandValue, options?: PaneCommandValue) => {
    return invokeSafely(() => requireManager().create(
      decodeOrchestrationSessionPayload(value, createSchema, 'create'),
      undefined,
      { terminal: agent => !clientShowsChatTab(options, agent) },
    ));
  });
  commandRegistry.bindChannel(ipcMain, 'orchestration-sessions:create');

  commandRegistry.register('orchestration-sessions:get', async (value: PaneCommandValue, options?: PaneCommandValue) => {
    return invokeSafely(async () => {
      const view = await requireManager().getView(decodeSelector(value));
      if (view.panel.type === 'chat' && !clientShowsChatTab(options, view.agent)) {
        throw new PaneError('CHAT_TAB_CLIENT_OUTDATED', 'This Session runs as a chat, which this version of Pane on your phone can\'t open.', 'Update Pane on your phone, then open the Session again.');
      }
      return view;
    });
  });
  commandRegistry.bindChannel(ipcMain, 'orchestration-sessions:get');

  /**
   * One call per Session shown (T-87), for the desktop's sidebar cursor. Each returns
   * the view, the tabs, the stored layout and the chat, which a client read one after
   * another before. `peek` only reads: it never creates a tab, saves anything or starts
   * an agent. `open` is `get` plus the same, starting the chat's agent as `chat-tab:get`
   * does, and saving the selection when `select` is set.
   */
  const openResult = (
    view: OrchestrationSessionView<Session> | null,
    options: PaneCommandValue | undefined,
    start: boolean,
  ): OrchestrationSessionOpenResult<Session> => {
    if (!view) return { view: null, panels: [], layout: null };
    if (view.panel.type === 'chat' && !clientShowsChatTab(options, view.agent)) {
      throw new PaneError('CHAT_TAB_CLIENT_OUTDATED', 'This Session runs as a chat, which this version of Pane on your phone can\'t open.', 'Update Pane on your phone, then open the Session again.');
    }
    const internalId = view.internalSession.id;
    const result: OrchestrationSessionOpenResult<Session> = {
      view,
      panels: panelsForClient(internalId, options),
      layout: storedPanelLayout(internalId),
    };
    if (view.panel.type === 'chat') result.chat = getChatTabManager().view(view.panel.id, OPEN_CHAT_LIMIT, start);
    return result;
  };

  commandRegistry.register('orchestration-sessions:peek', async (value: PaneCommandValue, options?: PaneCommandValue) => {
    return invokeSafely(async () => openResult(await requireManager().peekView(decodeSelector(value)), options, false));
  });
  commandRegistry.bindChannel(ipcMain, 'orchestration-sessions:peek');

  commandRegistry.register('orchestration-sessions:open', async (value: PaneCommandValue, options?: PaneCommandValue, openOptions?: PaneCommandValue) => {
    return invokeSafely(async () => {
      const selector = decodeSelector(value);
      const list = decodeBoundary(openOptions ?? {}, openOptionsSchema).select === true ? await requireManager().select(selector) : undefined;
      const result = openResult(await requireManager().getView(selector), options, true);
      if (list) result.list = list;
      return result;
    });
  });
  commandRegistry.bindChannel(ipcMain, 'orchestration-sessions:open');

  commandRegistry.register('orchestration-sessions:update', async (value: PaneCommandValue, update?: PaneCommandValue) => {
    return invokeSafely(async () => {
      const input = decodeOrchestrationSessionPayload(update, updateSchema, 'update');
      return (await updateOrchestrationSession(services, commandRegistry, decodeSelector(value), input)).session;
    });
  });
  commandRegistry.bindChannel(ipcMain, 'orchestration-sessions:update');

  commandRegistry.register('orchestration-sessions:archive', async (value: PaneCommandValue, selection?: PaneCommandValue) => {
    return invokeSafely(async (): Promise<OrchestrationSessionArchiveResult> => {
      const { session, panes } = await updateOrchestrationSession(
        services,
        commandRegistry,
        decodeSelector(value),
        { archived: true },
        decodeBoundary(selection, archiveSelectionSchema),
      );
      if (!panes) throw new Error('Archiving the Session returned no Pane result');
      return { session, ...panes };
    });
  });
  commandRegistry.bindChannel(ipcMain, 'orchestration-sessions:archive');

  commandRegistry.register('orchestration-sessions:archive-preview', async (value: PaneCommandValue) => {
    return invokeSafely(() => previewOrchestrationSessionArchive(services, decodeSelector(value)));
  });
  commandRegistry.bindChannel(ipcMain, 'orchestration-sessions:archive-preview');

  commandRegistry.register('orchestration-sessions:reorder', async (value: PaneCommandValue) => {
    return invokeSafely(() => requireManager().reorder(decodeBoundary(value, reorderSchema).sessionIds));
  });
  commandRegistry.bindChannel(ipcMain, 'orchestration-sessions:reorder');

  commandRegistry.register('orchestration-sessions:set-agent', async (value: PaneCommandValue, agent?: PaneCommandValue) => {
    const decoded = agent === undefined
      ? decodeBoundary(value, agentSchema)
      : { ...decodeSelector(value), agent: decodeBoundary(agent, configuredAgentSchema) };
    return invokeSafely(() => requireManager().setAgent(
      { sessionId: decoded.sessionId, name: decoded.name },
      decoded.agent,
    ));
  });
  commandRegistry.bindChannel(ipcMain, 'orchestration-sessions:set-agent');

  commandRegistry.register('orchestration-sessions:associate', async (value: PaneCommandValue, association?: PaneCommandValue) => {
    const decoded = association === undefined
      ? decodeBoundary(value, associationSchema)
      : { ...decodeSelector(value), ...decodeBoundary(association, boundary.object({
        paneId: boundary.nonEmptyString,
        panelIds: boundary.optional(boundary.array(boundary.nonEmptyString)),
      })) };
    return invokeSafely(() => requireManager().associate(
      { sessionId: decoded.sessionId, name: decoded.name },
      { paneId: decoded.paneId, panelIds: decoded.panelIds } satisfies OrchestrationAssociationInput,
    ));
  });
  commandRegistry.bindChannel(ipcMain, 'orchestration-sessions:associate');

  commandRegistry.register('orchestration-sessions:detach', async (value: PaneCommandValue, paneId?: PaneCommandValue) => {
    const decoded = paneId === undefined
      ? decodeBoundary(value, detachSchema)
      : { ...decodeSelector(value), paneId: decodeBoundary(paneId, boundary.optional(boundary.nonEmptyString)) };
    return invokeSafely(() => requireManager().detach(
      { sessionId: decoded.sessionId, name: decoded.name },
      decoded.paneId,
    ));
  });
  commandRegistry.bindChannel(ipcMain, 'orchestration-sessions:detach');

  // The baseline for `orchestration-sessions:activity`: every open Session's current activity.
  commandRegistry.register('orchestration-sessions:activity-list', () => invokeSafely(async () => requireManager().liveActivity.snapshot()));
  commandRegistry.bindChannel(ipcMain, 'orchestration-sessions:activity-list');
  commandRegistry.register('orchestration-sessions:overview', async (value: PaneCommandValue) => {
    return invokeSafely(() => requireManager().overview(decodeSelector(value)));
  });
  commandRegistry.bindChannel(ipcMain, 'orchestration-sessions:overview');
}

function selectorSchemaFields() {
  return {
    sessionId: boundary.optional(boundary.nonEmptyString),
    name: boundary.optional(boundary.nonEmptyString),
  };
}

function decodeSelector(value: PaneCommandValue): OrchestrationSessionSelector {
  return decodeBoundary(value, selectorSchema);
}

async function invokeSafely<Value>(operation: () => Promise<Value>): Promise<object> {
  try {
    return { success: true, data: await operation() };
  } catch (error) {
    return {
      success: false,
      // Electron IPC keeps only text, so a PaneError carries its next step as "Next: ...".
      error: error instanceof PaneError ? paneErrorText(error) : error instanceof Error ? error.message : 'Sessions operation failed',
    };
  }
}
