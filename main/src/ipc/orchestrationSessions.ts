import { customCommandResumeSchema } from '../../../shared/types/customCommandResume';
import { listWSLDistributions } from '../utils/wslUtils';
import type { IpcMain } from 'electron';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import type { AppServices } from './types';
import type {
  OrchestrationAssociationInput,
  OrchestrationSessionSelector,
} from '../../../shared/types/orchestrationSession';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { PaneError, paneErrorText } from '../../../shared/paneError';
import {
  decodeOrchestrationSessionPayload,
  orchestrationExpectedRevisionSchema,
  orchestrationLinksSchema,
  orchestrationReportSchema,
  orchestrationTextArraySchema,
  orchestrationTextSchema,
} from '../services/orchestrationSessionPayload';

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
  agent: boundary.optional(boundary.enumeration('claude', 'codex', 'cursor', 'opencode')),
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
});
const updateSchema = boundary.object({
  name: boundary.optional(orchestrationTextSchema),
  archived: boundary.optional(boundary.boolean),
  isPinned: boundary.optional(boundary.boolean),
  agent: boundary.optional(boundary.enumeration('claude', 'codex', 'cursor', 'opencode')),
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
const agentSchema = boundary.object({
  ...selectorSchemaFields(),
  agent: boundary.enumeration('claude', 'codex', 'cursor', 'opencode'),
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

  commandRegistry.register('orchestration-sessions:create', async (value: PaneCommandValue) => {
    return invokeSafely(() => requireManager().create(decodeOrchestrationSessionPayload(value, createSchema, 'create')));
  });
  commandRegistry.bindChannel(ipcMain, 'orchestration-sessions:create');

  commandRegistry.register('orchestration-sessions:get', async (value: PaneCommandValue) => {
    return invokeSafely(() => requireManager().getView(decodeSelector(value)));
  });
  commandRegistry.bindChannel(ipcMain, 'orchestration-sessions:get');

  commandRegistry.register('orchestration-sessions:update', async (value: PaneCommandValue, update?: PaneCommandValue) => {
    return invokeSafely(() => requireManager().update(
      decodeSelector(value),
      decodeOrchestrationSessionPayload(update, updateSchema, 'update'),
    ));
  });
  commandRegistry.bindChannel(ipcMain, 'orchestration-sessions:update');

  commandRegistry.register('orchestration-sessions:reorder', async (value: PaneCommandValue) => {
    return invokeSafely(() => requireManager().reorder(decodeBoundary(value, reorderSchema).sessionIds));
  });
  commandRegistry.bindChannel(ipcMain, 'orchestration-sessions:reorder');

  commandRegistry.register('orchestration-sessions:set-agent', async (value: PaneCommandValue, agent?: PaneCommandValue) => {
    const decoded = agent === undefined
      ? decodeBoundary(value, agentSchema)
      : { ...decodeSelector(value), agent: decodeBoundary(agent, boundary.enumeration('claude', 'codex', 'cursor', 'opencode')) };
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
