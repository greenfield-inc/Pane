import type { IpcMain } from 'electron';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import type { AppServices } from './types';
import type {
  OrchestrationAssociationInput,
  OrchestrationSessionSelector,
} from '../../../shared/types/orchestrationSession';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

const selectorSchema = boundary.object({
  sessionId: boundary.optional(boundary.nonEmptyString),
  name: boundary.optional(boundary.nonEmptyString),
});
const linkSchema = boundary.object({
  label: boundary.nonEmptyString,
  url: boundary.nonEmptyString,
  kind: boundary.optional(boundary.enumeration('evidence', 'output', 'ticket', 'pull-request', 'other')),
  provenance: boundary.optional(boundary.string),
  addedAt: boundary.nonEmptyString,
});
const reportSchema = boundary.object({
  summary: boundary.nonEmptyString,
  status: boundary.enumeration('reported', 'verified'),
  evidence: boundary.array(linkSchema),
  reportedAt: boundary.nonEmptyString,
  provenance: boundary.nonEmptyString,
});
const createSchema = boundary.object({
  name: boundary.nonEmptyString,
  agent: boundary.optional(boundary.enumeration('claude', 'codex', 'cursor')),
  goal: boundary.optional(boundary.string),
  context: boundary.optional(boundary.string),
  decisions: boundary.optional(boundary.array(boundary.string)),
  blockers: boundary.optional(boundary.array(boundary.string)),
  nextAction: boundary.optional(boundary.string),
  evidence: boundary.optional(boundary.array(linkSchema)),
  outputs: boundary.optional(boundary.array(linkSchema)),
});
const updateSchema = boundary.object({
  name: boundary.optional(boundary.string),
  archived: boundary.optional(boundary.boolean),
  isPinned: boundary.optional(boundary.boolean),
  agent: boundary.optional(boundary.enumeration('claude', 'codex', 'cursor')),
  goal: boundary.optional(boundary.string),
  context: boundary.optional(boundary.string),
  decisions: boundary.optional(boundary.array(boundary.string)),
  blockers: boundary.optional(boundary.array(boundary.string)),
  nextAction: boundary.optional(boundary.string),
  evidence: boundary.optional(boundary.array(linkSchema)),
  outputs: boundary.optional(boundary.array(linkSchema)),
  report: boundary.optional(boundary.nullable(reportSchema)),
  expectedRevision: boundary.optional(boundary.number),
  source: boundary.optional(boundary.enumeration('user', 'agent')),
});
const agentSchema = boundary.object({
  ...selectorSchemaFields(),
  agent: boundary.enumeration('claude', 'codex', 'cursor'),
});
const associationSchema = boundary.object({
  ...selectorSchemaFields(),
  paneId: boundary.nonEmptyString,
  panelIds: boundary.optional(boundary.array(boundary.nonEmptyString)),
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
  const requireManager = () => {
    if (!manager) throw new Error('Sessions manager is not initialized');
    return manager;
  };

  commandRegistry.register('orchestration-sessions:list', async () => {
    return invokeSafely(() => requireManager().list());
  });
  commandRegistry.bindChannel(ipcMain, 'orchestration-sessions:list');

  commandRegistry.register('orchestration-sessions:select', async (value: PaneCommandValue) => {
    return invokeSafely(() => requireManager().select(decodeSelector(value)));
  });
  commandRegistry.bindChannel(ipcMain, 'orchestration-sessions:select');

  commandRegistry.register('orchestration-sessions:create', async (value: PaneCommandValue) => {
    return invokeSafely(() => requireManager().create(decodeBoundary(value, createSchema)));
  });
  commandRegistry.bindChannel(ipcMain, 'orchestration-sessions:create');

  commandRegistry.register('orchestration-sessions:get', async (value: PaneCommandValue) => {
    return invokeSafely(() => requireManager().getView(decodeSelector(value)));
  });
  commandRegistry.bindChannel(ipcMain, 'orchestration-sessions:get');

  commandRegistry.register('orchestration-sessions:update', async (value: PaneCommandValue, update?: PaneCommandValue) => {
    return invokeSafely(() => requireManager().update(
      decodeSelector(value),
      decodeBoundary(update, updateSchema),
    ));
  });
  commandRegistry.bindChannel(ipcMain, 'orchestration-sessions:update');

  commandRegistry.register('orchestration-sessions:set-agent', async (value: PaneCommandValue, agent?: PaneCommandValue) => {
    const decoded = agent === undefined
      ? decodeBoundary(value, agentSchema)
      : { ...decodeSelector(value), agent: decodeBoundary(agent, boundary.enumeration('claude', 'codex', 'cursor')) };
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
      error: error instanceof Error ? error.message : 'Sessions operation failed',
    };
  }
}
