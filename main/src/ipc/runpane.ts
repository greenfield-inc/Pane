import { ownsRemovableWorktree } from '../utils/owns-removable-worktree';
import { resolveProjectRegistration, projectRegistrationKey, validateProjectRepository } from '../services/projectRegistration';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { browserFileContext } from '../services/browserFileContext';
import { isOrchestrationInternalSessionId } from '../../../shared/types/orchestrationSession';
import type { IpcMain } from 'electron';
import type { AppServices } from './types';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import { PathResolver, ProjectEnvironment, expandUserRepoPath } from '../utils/pathResolver';
import { sanitizeTerminalOutput } from '../utils/terminalOutputSanitizer';
import { escapeShellArg } from '../utils/shellEscape';
import { panelManager } from '../services/panelManager';
import { terminalPanelManager, type TerminalPanelSnapshot } from '../services/terminalPanelManager';
import { databaseService as panelDatabase } from '../services/database';
import type { PanelBuffers } from '../database/panelBuffers';
import { ensureProjectAgentContext } from '../services/agentContextManager';
import { getPaneEventSink } from '../core/runtime';
import { syncPaneHomeSkill } from '../services/paneHomeSkill';
import { fastCheckWorkingDirectory, listCommitsAhead } from '../services/gitPlumbingCommands';
import { assertNewBranchName } from '../services/worktreeManager';
import { assessComposerEvidence, isSlashCommandInput, looksLikePendingComposer } from './runpaneComposerEvidence';
import { projectWorkspaceEntry } from '../services/workspaceJournal';
import { detectAgentState } from '../services/agentStatus/manifestEngine';
import { getManifestForAgent } from '../services/agentStatus/manifests';
import { detectAgentComposer, detectAgentFromScreen, screenShowsQueuedMessage } from '../services/agents/agentScreenSignature';
import { agentTranscripts, type TranscriptLocator } from '../services/agentTranscript';
import {
  AGENT_REPORT_STATES,
  journalAgentReport,
  normalizeAgentReport,
  readPanelAgentReport,
} from '../services/agentReport';
import { resolveAgentTypeFromCommand } from '../services/agents/agentIdentity';
import {
  bracketedPaste,
  claudePromptWarnings,
  filePointerPrompt,
  isLongPrompt,
  normalizePromptNewlines,
  promptFileShellWord,
  stripTrailingNewlines,
  writePromptFile,
} from '../services/agents/promptDelivery';
import type { ArchiveProgressManager } from '../services/archiveProgressManager';
import type { ArchiveProgressTask } from '../../../shared/types/archiveProgress';
import { classifyWorktree } from '../services/worktreeTrash';
import type { CommandRunner } from '../utils/commandRunner';
import type { Project } from '../database/models';
import type { Session, SessionOutput } from '../types/session';
import type { BrowserPanelState, CreatePanelRequest, EditorPanelState, TerminalAgentReport, TerminalPanelState, ToolPanel } from '../../../shared/types/panels';
import { RUNPANE_CONTRACT } from '../../../shared/types/generatedRunpaneContract';
import { isAgentSupportedOnPlatform } from '../../../shared/constants/agentLaunchPresets';
import {
  TERMINAL_IMAGE_OPTIONS,
  terminalGraphicsProtocols,
} from '../../../shared/constants/terminalGraphics';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import type {
  RunpaneAgentId,
  RunpaneAgentDoctorRequest,
  RunpaneAgentDoctorResult,
  RunpaneDoctorResult,
  RunpaneInitialInputDeliveryResult,
  RunpanePaneArchiveBlockCode,
  RunpanePaneArchiveBlockedResult,
  RunpanePaneArchiveBulkItem,
  RunpanePaneArchiveBulkRequest,
  RunpanePaneArchiveBulkResult,
  RunpanePaneArchiveMergedPr,
  RunpanePaneArchiveRequest,
  RunpanePaneArchiveResult,
  RunpanePaneArchiveSafetyCheck,
  RunpanePaneArchiveSafetyCheckReason,
  RunpanePaneArchiveSuccessResult,
  RunpanePaneAdoptRequest,
  RunpanePaneAdoptResult,
  RunpanePaneCostRequest,
  RunpanePaneCostResult,
  RunpanePaneListRequest,
  RunpanePaneListResult,
  RunpanePanePinRequest,
  RunpanePanePinResult,
  RunpanePaneRenameRequest,
  RunpanePaneRenameResult,
  RunpanePaneFocusRequest,
  RunpanePaneFocusRequestedEvent,
  RunpanePaneFocusResult,
  RunpanePaneCreateFailureItem,
  RunpanePaneCreateItem,
  RunpanePaneCreateRequest,
  RunpanePaneCreateResult,
  RunpanePaneCreateResultItem,
  RunpanePaneAssociationOutcome,
  RunpanePaneReadiness,
  RunpanePaneSummary,
  RunpanePromptWarning,
  RunpanePanelActivityStatus,
  RunpanePaneAgentState,
  RunpaneAgentDetection,
  RunpanePanelBlockedState,
  RunpaneDelivery,
  RunpanePanelCreateRequest,
  RunpanePanelCreateResult,
  RunpanePanelOpenRequest,
  RunpanePanelOpenResult,
  RunpanePanelInputRequest,
  RunpanePanelInputResult,
  RunpanePanelLastMessageRequest,
  RunpanePanelLastMessageResult,
  RunpanePanelListRequest,
  RunpanePanelListResult,
  RunpanePanelOutputRecord,
  RunpanePanelOutputRequest,
  RunpanePanelOutputResult,
  RunpanePanelScreenRequest,
  RunpanePanelScreenResult,
  RunpanePanelScreenSource,
  RunpanePanelStateSummary,
  RunpanePanelSubmitComposerRequest,
  RunpanePanelSubmitComposerResult,
  RunpanePanelSubmitComposerStrategy,
  RunpanePanelSubmitRequest,
  RunpanePanelSubmitResult,
  RunpanePanelWaitCondition,
  RunpanePanelWaitRequest,
  RunpanePanelWaitResult,
  RunpaneRepoAddRequest,
  RunpaneRepoAddResult,
  RunpaneRepoListResult,
  RunpaneRepoSelector,
  RunpaneRepoSummary,
  RunpaneReportRequest,
  RunpaneReportResult,
  RunpaneResolvedTool,
  RunpaneToolSpec,
  RunpaneWorktreeCleanupState,
  RunpaneWorktreeTrashDeletion,
  RunpaneWorkspaceEntry,
  RunpaneWorkspaceEntryKind,
  RunpaneWorkspaceStateResult,
  RunpaneWorkspaceWaitRequest,
  RunpaneWorkspaceWaitResult,
  RunpaneSessionListResult,
  RunpaneSessionResult,
  RunpaneSessionOverviewResult,
  RunpaneSessionSelector,
  RunpaneLockAcquireRequest,
  RunpaneLockAcquireResult,
  RunpaneLockListRequest,
  RunpaneLockListResult,
  RunpaneLockOwner,
  RunpaneLockOwnerInput,
  RunpaneLockReleaseRequest,
  RunpaneLockReleaseResult,
} from '../../../shared/types/runpaneOrchestration';
import type {
  OrchestrationAssociationInput,
  OrchestrationSessionCreateInput,
  OrchestrationSessionUpdateInput,
} from '../../../shared/types/orchestrationSession';
import type { PaneChatAgent } from '../../../shared/types/paneChat';
import { getAppDirectory } from '../utils/appDirectory';
import { collectRemoteDaemonExecutableHealthAsync } from '../daemon/remoteDaemonExecutableHealth';
import { getMobilePushSender } from '../daemon/mobilePushSender';
import {
  WorkspaceJournal,
  workspaceFilterKey,
  type WorkspaceJournalFilter,
} from '../services/workspaceJournal';
import { WatchCadence, type WatchCadenceOptions } from '../services/workspaceWatchCadence';
import { WorkspaceStateReader } from '../services/workspaceStateReader';
import { WorkspaceCursorStore } from '../services/workspaceCursorStore';
import { NamedLockService } from '../services/namedLockService';
import { NamedLockStore } from '../services/namedLockStore';
import { usageManager } from '../services/usage/usageManager';
import { parseWSLPath, windowsPathToWSLMount, type WSLContext } from '../utils/wslUtils';
import {
  dueIdleEntries,
  nextIdleDeadline,
  type WorkspaceIdleCandidate,
  type WorkspaceIdleSchedule,
} from '../services/workspaceIdleTracker';

const RUNPANE_CHANNELS = [
  'runpane:doctor',
  'runpane:repos:list',
  'runpane:repos:add',
  'runpane:sessions:list',
  'runpane:sessions:create',
  'runpane:sessions:get',
  'runpane:sessions:update',
  'runpane:sessions:set-agent',
  'runpane:sessions:associate',
  'runpane:sessions:detach',
  'runpane:sessions:overview',
  'runpane:locks:acquire',
  'runpane:locks:release',
  'runpane:locks:list',
  'runpane:panes:list',
  'runpane:panes:cost',
  'runpane:panes:create',
  'runpane:panes:adopt',
  'runpane:panes:pin',
  'runpane:panes:rename',
  'runpane:panes:focus',
  'runpane:panes:archive',
  'runpane:panels:create',
  'runpane:panels:open',
  'runpane:panels:list',
  'runpane:panels:output',
  'runpane:panels:input',
  'runpane:panels:screen',
  'runpane:panels:submit',
  'runpane:panels:submit-composer',
  'runpane:panels:wait',
  'runpane:panels:last-message',
  'runpane:report',
  'runpane:workspace:state',
  'runpane:workspace:wait',
  'runpane:agents:doctor',
] as const;

const AGENT_TEMPLATES = RUNPANE_CONTRACT.agentTemplates;
const AGENT_IDS = new Set<string>(RUNPANE_CONTRACT.enums.agents);
const DEFAULT_PANEL_OUTPUT_LIMIT = 200;
const DEFAULT_PANEL_SCREEN_LIMIT = 80;
const DEFAULT_LAST_MESSAGE_LIMIT = 20_000;
const LAST_MESSAGE_TRUNCATION_MARKER = '[earlier text truncated]\n';
const DEFAULT_PANEL_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_PANEL_WAIT_INTERVAL_MS = 500;
const DEFAULT_COMPOSER_VERIFY_TIMEOUT_MS = 3_000;
const DEFAULT_COMPOSER_VERIFY_INTERVAL_MS = 100;
// The transcript settles a delivery the screen leaves open: polled this often, for this long after Enter.
const TRANSCRIPT_POLL_INTERVAL_MS = 200;
const TRANSCRIPT_DELIVERY_TIMEOUT_MS = 10_000;
// Once the composer has emptied, how long the transcript gets to say taken or queued.
const TRANSCRIPT_CONFIRM_MS = 2_000;
const CODEX_SUBMIT_STAGE_DELAY_MS = 500;
const CLAUDE_INPUT_WAIT_TIMEOUT_MS = 15_000;
const CLAUDE_UI_QUIET_MS = 3_000;
// After a bracketed paste, Enter waits for the agent to stop drawing it.
const PASTE_SETTLE_QUIET_MS = 300;
const PASTE_SETTLE_MAX_MS = 2_000;
const CODEX_PASTE_ECHO_TIMEOUT_MS = 3_000;
const MAX_CREATE_SUBMIT_ATTEMPTS = 3;
const CREATE_SUBMIT_CONFIRMATION_DELAY_MS = 400;
const DEFAULT_ARCHIVE_CLEANUP_TIMEOUT_MS = 30_000;
const DEFAULT_ARCHIVE_CLEANUP_POLL_INTERVAL_MS = 200;
const GH_PR_LOOKUP_TIMEOUT_MS = 10_000;
const DEFAULT_WORKSPACE_WAIT_TIMEOUT_MS = 60_000;
const MAX_WORKSPACE_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_WORKSPACE_WAIT_LIMIT = 256;
// Named cursors are keys in workspace-cursors.json, never file names. 128 fits `session-<id>` for
// any Session ID; runpane shortens the names it derives to 64 for older daemons.
const WORKSPACE_CONSUMER_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;
/** One daemon call waits at most this long for a lock; the CLI chains calls for longer waits. */
const MAX_LOCK_WAIT_PER_CALL_MS = 120_000;
const MUTATING_RUNPANE_ACTIONS = new Set([
  'panes:create',
  'panes:adopt',
  'panes:archive',
  'panes:pin',
  'panes:rename',
  'panels:create',
  'panels:open',
  'panels:input',
  'panels:submit',
  'panels:submit-composer',
  'report',
  'sessions:create',
  'sessions:update',
  'sessions:set-agent',
  'sessions:associate',
  'sessions:detach',
]);

const orchestrationSelectorSchema = boundary.object({
  sessionId: boundary.optional(boundary.nonEmptyString),
  name: boundary.optional(boundary.nonEmptyString),
});
const orchestrationLinkSchema = boundary.object({
  label: boundary.nonEmptyString,
  url: boundary.nonEmptyString,
  kind: boundary.optional(boundary.enumeration('evidence', 'output', 'ticket', 'pull-request', 'other')),
  provenance: boundary.optional(boundary.string),
  addedAt: boundary.nonEmptyString,
});
const orchestrationSessionCreateSchema = boundary.object({
  runtime: boundary.optional(boundary.enumeration('windows', 'wsl')),
  wslDistribution: boundary.optional(boundary.nonEmptyString),
  name: boundary.nonEmptyString,
  agent: boundary.optional(boundary.enumeration('claude', 'codex', 'cursor')),
  launchCommand: boundary.optional(boundary.string),
  profile: boundary.optional(boundary.string),
  goal: boundary.optional(boundary.string),
  context: boundary.optional(boundary.string),
  decisions: boundary.optional(boundary.array(boundary.string)),
  blockers: boundary.optional(boundary.array(boundary.string)),
  nextAction: boundary.optional(boundary.string),
  evidence: boundary.optional(boundary.array(orchestrationLinkSchema)),
  outputs: boundary.optional(boundary.array(orchestrationLinkSchema)),
});
const orchestrationSessionUpdateSchema = boundary.object({
  name: boundary.optional(boundary.string),
  archived: boundary.optional(boundary.boolean),
  isPinned: boundary.optional(boundary.boolean),
  agent: boundary.optional(boundary.enumeration('claude', 'codex', 'cursor')),
  launchCommand: boundary.optional(boundary.string),
  profile: boundary.optional(boundary.string),
  goal: boundary.optional(boundary.string),
  context: boundary.optional(boundary.string),
  decisions: boundary.optional(boundary.array(boundary.string)),
  blockers: boundary.optional(boundary.array(boundary.string)),
  nextAction: boundary.optional(boundary.string),
  evidence: boundary.optional(boundary.array(orchestrationLinkSchema)),
  outputs: boundary.optional(boundary.array(orchestrationLinkSchema)),
  report: boundary.optional(boundary.nullable(boundary.object({
    summary: boundary.nonEmptyString,
    status: boundary.enumeration('reported', 'verified'),
    evidence: boundary.array(orchestrationLinkSchema),
    reportedAt: boundary.nonEmptyString,
    provenance: boundary.nonEmptyString,
  }))),
  expectedRevision: boundary.optional(boundary.number),
  source: boundary.optional(boundary.enumeration('user', 'agent')),
});
const lockOwnerInputSchema = boundary.object({
  paneId: boundary.optional(boundary.nonEmptyString),
  panelId: boundary.optional(boundary.nonEmptyString),
  label: boundary.optional(boundary.string),
});
const lockAcquireRequestSchema = boundary.object({
  name: boundary.nonEmptyString,
  ttlMs: boundary.number,
  waitMs: boundary.optional(boundary.number),
  note: boundary.optional(boundary.string),
  owner: lockOwnerInputSchema,
});
const lockReleaseRequestSchema = boundary.object({
  name: boundary.nonEmptyString,
  force: boundary.optional(boundary.boolean),
  sessionId: boundary.optional(boundary.nonEmptyString),
  owner: lockOwnerInputSchema,
});
const lockListRequestSchema = boundary.object({
  sessionId: boundary.optional(boundary.nonEmptyString),
});

export function registerRunpaneHandlers(
  _ipcMain: IpcMain,
  services: AppServices,
  commandRegistry: PaneCommandRegistry,
): void {
  const { databaseService, sessionManager, taskQueue, configManager } = services;
  const workspaceJournal = services.workspaceJournal ?? createWorkspaceJournal(services);
  const workspaceStateReader = services.workspaceStateReader ?? new WorkspaceStateReader(
    sessionManager,
    () => workspaceJournal.epoch,
    () => workspaceJournal.generation,
  );
  const workspaceCursorStore = services.workspaceCursorStore ?? new WorkspaceCursorStore(
    path.join(getAppDirectory(), 'workspace-cursors.json'),
  );
  const namedLocks = services.namedLockService ?? createNamedLockService(services);
  const consumerRuntime = new Map<string, { lastReadAt?: number; cadence?: WatchCadence }>();
  services.namedLockService = namedLocks;
  services.workspaceJournal = workspaceJournal;
  services.workspaceStateReader = workspaceStateReader;
  services.workspaceCursorStore = workspaceCursorStore;

  commandRegistry.register('runpane:doctor', async (): Promise<RunpaneDoctorResult> => {
    return withRunpaneAction(services, 'doctor', {}, async () => {
      const repos = databaseService.getAllProjects().map((project) =>
        projectToRepoSummary(project, sessionManager.getSessionsForProject(project.id).length)
      );
      return {
        ok: true,
        app: {
          version: services.app.getVersion(),
          isPackaged: services.app.isPackaged,
          platform: process.platform,
          electronVersion: process.versions.electron,
          nodeVersion: process.versions.node,
        },
        daemon: {
          channels: [...runpaneDaemonChannels()],
          executableHealth: await collectRemoteDaemonExecutableHealthAsync(getAppDirectory()),
        },
        repos: {
          count: repos.length,
          active: repos.find(repo => repo.active),
        },
        terminal: {
          graphicsProtocols: terminalGraphicsProtocols(),
          sizeReports: TERMINAL_IMAGE_OPTIONS.enableSizeReports,
          imageLimits: {
            storageLimitMb: TERMINAL_IMAGE_OPTIONS.storageLimit,
            pixelLimit: TERMINAL_IMAGE_OPTIONS.pixelLimit,
          },
        },
        agentContext: {
          recommendedFirstCommands: [
            'runpane doctor --json',
            'runpane agent-context --json',
            'runpane agent-context --command "<command>" --json',
          ],
        },
      };
    }, result => ({ resultCount: result.repos.count }));
  });

  commandRegistry.register('runpane:repos:list', async (): Promise<RunpaneRepoListResult> => {
    return withRunpaneAction(services, 'repos:list', {}, () => {
      const repos = databaseService.getAllProjects().map((project) =>
        projectToRepoSummary(project, sessionManager.getSessionsForProject(project.id).length)
      );
      return { ok: true, repos };
    }, result => ({ resultCount: result.repos.length }));
  });

  commandRegistry.register('runpane:repos:add', async (request: PaneCommandValue): Promise<RunpaneRepoAddResult> => {
    return withRunpaneAction(services, 'repos:add', {}, async () => {
      const normalized = parseRepoAddRequest(request);
      const existing = resolveProjectByPath(databaseService.getAllProjects(), normalized.path);

      if (existing) {
        return {
          ok: true,
          created: false,
          dryRun: normalized.dryRun || undefined,
          repo: projectToRepoSummary(existing, sessionManager.getSessionsForProject(existing.id).length),
          preview: normalized.dryRun
            ? {
                name: existing.name,
                path: existing.path,
                alreadyExists: true,
                wouldCreate: false,
                environment: new PathResolver(existing).environment,
              }
            : undefined,
        };
      }

      const registration = resolveProjectRegistration(normalized.path);
      await validateProjectRepository(registration);

      const preview = {
        name: normalized.name,
        path: registration.path,
        alreadyExists: false,
        wouldCreate: true,
        environment: registration.pathResolver.environment,
      };

      if (normalized.dryRun) {
        return {
          ok: true,
          created: false,
          dryRun: true,
          preview,
        };
      }

      const project = databaseService.createProject(
        normalized.name,
        registration.path,
        undefined,
        undefined,
        undefined,
        'ignore',
        undefined,
        registration.wsl_enabled || undefined,
        registration.wsl_distribution,
      );

      try {
        await ensureProjectAgentContext(project, configManager.getConfig());
        if (project.wsl_enabled && project.wsl_distribution) {
          await syncPaneHomeSkill(configManager.getConfig(), [], [project.wsl_distribution]);
        }
      } catch (error) {
        console.warn('[Runpane] Failed to update Pane agent context after repo add:', error);
      }

      return {
        ok: true,
        created: true,
        repo: projectToRepoSummary(project, 0),
      };
    }, result => ({ repoId: result.repo?.id, resultCount: result.created ? 1 : 0 }));
  });

  commandRegistry.register('runpane:sessions:list', async (): Promise<RunpaneSessionListResult> => {
    return withRunpaneAction(services, 'sessions:list', {}, async () => {
      const manager = requireOrchestrationSessionManager(services);
      const result = await manager.list();
      return { ok: true, ...result };
    }, result => ({ resultCount: result.sessions.length }));
  });

  commandRegistry.register('runpane:sessions:create', async (request: PaneCommandValue): Promise<RunpaneSessionResult> => {
    return withRunpaneAction(services, 'sessions:create', {}, async () => {
      const manager = requireOrchestrationSessionManager(services);
      const input = parseOrchestrationSessionCreateRequest(request);
      const view = await manager.create(input);
      return { ok: true, session: view.session, panelId: view.panel.id, internalSessionId: view.internalSession.id };
    }, result => ({ resultCount: 1, panelId: result.panelId }));
  });

  commandRegistry.register('runpane:sessions:get', async (request: PaneCommandValue): Promise<RunpaneSessionResult> => {
    return withRunpaneAction(services, 'sessions:get', {}, async () => {
      const manager = requireOrchestrationSessionManager(services);
      const session = await manager.get(parseOrchestrationSessionSelector(request));
      return { ok: true, session };
    }, result => ({ resultCount: 1 }));
  });

  commandRegistry.register('runpane:sessions:update', async (request: PaneCommandValue): Promise<RunpaneSessionResult> => {
    return withRunpaneAction(services, 'sessions:update', {}, async () => {
      const manager = requireOrchestrationSessionManager(services);
      const normalized = parseOrchestrationSessionUpdateRequest(request);
      const session = await manager.update(normalized.selector, normalized.input);
      return { ok: true, session };
    }, result => ({ resultCount: 1 }));
  });

  commandRegistry.register('runpane:sessions:set-agent', async (request: PaneCommandValue): Promise<RunpaneSessionResult> => {
    return withRunpaneAction(services, 'sessions:set-agent', {}, async () => {
      const manager = requireOrchestrationSessionManager(services);
      const normalized = parseOrchestrationSessionAgentRequest(request);
      const view = await manager.setAgent(normalized.selector, normalized.agent);
      return { ok: true, session: view.session, panelId: view.panel.id, internalSessionId: view.internalSession.id };
    }, result => ({ resultCount: 1, panelId: result.panelId }));
  });

  commandRegistry.register('runpane:sessions:associate', async (request: PaneCommandValue): Promise<RunpaneSessionResult> => {
    return withRunpaneAction(services, 'sessions:associate', {}, async () => {
      const manager = requireOrchestrationSessionManager(services);
      const normalized = parseOrchestrationSessionAssociationRequest(request);
      const session = await manager.associate(normalized.selector, normalized.association);
      return { ok: true, session };
    }, result => ({ resultCount: 1 }));
  });

  commandRegistry.register('runpane:sessions:detach', async (request: PaneCommandValue): Promise<RunpaneSessionResult> => {
    return withRunpaneAction(services, 'sessions:detach', {}, async () => {
      const manager = requireOrchestrationSessionManager(services);
      const normalized = parseOrchestrationSessionDetachRequest(request);
      const session = await manager.detach(normalized.selector, normalized.paneId);
      return { ok: true, session };
    }, result => ({ resultCount: 1 }));
  });

  commandRegistry.register('runpane:sessions:overview', async (request: PaneCommandValue): Promise<RunpaneSessionOverviewResult> => {
    return withRunpaneAction(services, 'sessions:overview', {}, async () => {
      const manager = requireOrchestrationSessionManager(services);
      const overview = await manager.overview(parseOrchestrationSessionSelector(request));
      const locks = namedLocks.list(sessionLockFilter(overview.session));
      return { ok: true, ...overview, locks };
    }, result => ({ resultCount: result.panes.length }));
  });

  commandRegistry.register('runpane:locks:acquire', async (request: PaneCommandValue): Promise<RunpaneLockAcquireResult> => {
    return withRunpaneAction(services, 'locks:acquire', {}, async () => {
      const normalized: RunpaneLockAcquireRequest = decodeBoundary(request, lockAcquireRequestSchema);
      const { owner, sessionId } = await resolveLockOwner(services, normalized.owner);
      return namedLocks.acquire({
        name: normalized.name,
        ttlMs: normalized.ttlMs,
        waitMs: Math.min(Math.max(0, normalized.waitMs ?? 0), MAX_LOCK_WAIT_PER_CALL_MS),
        note: optionalLockText(normalized.note),
        owner,
        sessionId,
      });
    }, result => ({ paneId: result.lock.owner.paneId, panelId: result.lock.owner.panelId, timedOut: result.ok ? undefined : result.timedOut }));
  });

  commandRegistry.register('runpane:locks:release', async (request: PaneCommandValue): Promise<RunpaneLockReleaseResult> => {
    return withRunpaneAction(services, 'locks:release', {}, async () => {
      const normalized: RunpaneLockReleaseRequest = decodeBoundary(request, lockReleaseRequestSchema);
      const resolved = await resolveLockOwner(services, normalized.owner, normalized.force === true);
      const sessionId = normalized.sessionId
        ? (await requireOrchestrationSessionManager(services).get({ sessionId: normalized.sessionId })).id
        : resolved.sessionId;
      return namedLocks.release({ name: normalized.name, owner: resolved.owner, sessionId, force: normalized.force === true });
    }, result => ({ resultCount: result.released ? 1 : 0 }));
  });

  commandRegistry.register('runpane:locks:list', async (request: PaneCommandValue = {}): Promise<RunpaneLockListResult> => {
    return withRunpaneAction(services, 'locks:list', {}, async () => {
      const normalized: RunpaneLockListRequest = decodeBoundary(request, lockListRequestSchema);
      if (!normalized.sessionId) return { ok: true, locks: namedLocks.list() };
      const session = await requireOrchestrationSessionManager(services).get({ sessionId: normalized.sessionId });
      return { ok: true, locks: namedLocks.list(sessionLockFilter(session)) };
    }, result => ({ resultCount: result.locks.length }));
  });

  commandRegistry.register('runpane:panes:list', async (request: PaneCommandValue = {}): Promise<RunpanePaneListResult> => {
    return withRunpaneAction(services, 'panes:list', {}, () => {
      const normalized = parsePaneListRequest(request);
      const projects = databaseService.getAllProjects();
      const scopedProject = normalized.repo ? resolveRepoSelector(projects, normalized.repo) : undefined;
      const targetProjects = scopedProject ? [scopedProject] : projects;

      const panes = targetProjects.flatMap((project) =>
        sessionManager
          .getSessionsForProject(project.id)
          .filter(session => !session.archived)
          .map(session => sessionToPaneSummary(session, project))
      );

      return {
        ok: true,
        repo: scopedProject
          ? projectToRepoSummary(scopedProject, sessionManager.getSessionsForProject(scopedProject.id).length)
          : undefined,
        panes,
      };
    }, result => ({ repoId: result.repo?.id, resultCount: result.panes.length }));
  });

  commandRegistry.register('runpane:panes:cost', async (request: PaneCommandValue = {}): Promise<RunpanePaneCostResult> => {
    let repoId: number | undefined;
    return withRunpaneAction(services, 'panes:cost', {}, (): RunpanePaneCostResult => {
      const normalized = parsePaneCostRequest(request);
      const report = usageManager.getPaneCosts();
      let panes = report.byPane.panes;

      if (normalized.paneId) {
        const pane = panes.find(entry => entry.paneId === normalized.paneId);
        if (pane) {
          panes = [pane];
        } else {
          const session = databaseService.getSession(normalized.paneId);
          if (!session) throw new Error(`No Pane pane found with id ${normalized.paneId}. Run \`runpane panes list\` to see Pane ids.`);
          panes = [{
            paneId: session.id,
            paneName: session.name,
            worktreePath: session.worktree_path,
            repoId: session.project_id ?? null,
            archived: isSessionArchived(session.archived),
            createdAtMs: parseSessionTimestampMs(session.created_at),
            ...emptyPaneCostSlice(),
          }];
        }
      }

      if (normalized.repo) {
        const project = resolveRepoSelector(databaseService.getAllProjects(), normalized.repo);
        repoId = project.id;
        panes = panes.filter(pane => pane.repoId === project.id);
      }

      const scoped = normalized.paneId !== undefined || normalized.repo !== undefined;
      const result: RunpanePaneCostResult = {
        ok: true,
        fromMs: report.fromMs,
        toMs: report.toMs,
        pricingAsOf: report.pricingAsOf,
        panes,
      };
      if (!scoped) {
        result.unattributed = report.byPane.unattributed;
        result.totals = report.totals;
      }
      return result;
    }, result => ({ repoId, resultCount: result.panes.length }));
  });

  commandRegistry.register('runpane:panes:pin', async (request: PaneCommandValue): Promise<RunpanePanePinResult> => {
    return withRunpaneAction(services, 'panes:pin', {}, () => {
      const normalized = parsePanePinRequest(request);
      const pane = resolvePane(sessionManager, normalized.paneId);
      if (normalized.dryRun) {
        return {
          ok: true,
          dryRun: true,
          paneId: normalized.paneId,
          pinned: normalized.pinned,
          favoritePinnedAt: pane.favoritePinnedAt,
        };
      }

      const updatedSession = sessionManager.setFavorite(normalized.paneId, normalized.pinned);

      return {
        ok: true,
        paneId: normalized.paneId,
        pinned: Boolean(updatedSession.isFavorite),
        favoritePinnedAt: updatedSession.favoritePinnedAt,
      };
    }, result => ({ paneId: result.paneId }));
  });

  commandRegistry.register('runpane:panes:rename', async (request: PaneCommandValue): Promise<RunpanePaneRenameResult> => {
    return withRunpaneAction(services, 'panes:rename', {}, () => {
      const normalized = parsePaneRenameRequest(request);
      const pane = resolvePane(sessionManager, normalized.paneId);
      const project = sessionManager.getProjectForSession(pane.id);
      if (!project) {
        throw new Error(`No Pane repo found for pane ${pane.id}`);
      }

      if (normalized.dryRun) {
        return {
          ok: true,
          dryRun: true,
          pane: sessionToPaneSummary({ ...pane, name: normalized.name }, project),
        };
      }

      const renamedPane = sessionManager.renameSession(pane.id, normalized.name);

      return {
        ok: true,
        pane: sessionToPaneSummary(renamedPane, project),
      };
    }, result => ({ paneId: result.pane.paneId }));
  });

  commandRegistry.register('runpane:panes:focus', async (request: PaneCommandValue): Promise<RunpanePaneFocusResult> => {
    return withRunpaneAction(services, 'panes:focus', {}, async () => {
      const normalized = parsePaneFocusRequest(request);
      const pane = resolvePane(sessionManager, normalized.paneId);

      if (pane.archived) {
        throw new Error(`Pane ${normalized.paneId} is archived and cannot be focused`);
      }

      if (normalized.panelId) {
        const panel = resolvePanel(normalized.panelId);
        if (panel.sessionId !== pane.id) {
          throw new Error(`Panel ${normalized.panelId} does not belong to Pane ${pane.id}`);
        }
      }

      if (normalized.panelId) {
        await panelManager.setActivePanel(pane.id, normalized.panelId);
      }

      // A headless host has no window; its connected clients still follow the event.
      const window = services.getMainWindow();
      if (window) {
        if (window.isMinimized()) {
          window.restore();
        }
        window.show();
        window.focus();
      }

      const focusEvent: RunpanePaneFocusRequestedEvent = {
        paneId: pane.id,
        panelId: normalized.panelId,
      };
      getPaneEventSink().send('pane:focus-requested', focusEvent);

      return {
        ok: true,
        paneId: pane.id,
        panelId: normalized.panelId,
        focused: true,
      };
    }, result => ({ paneId: result.paneId, ok: result.ok }));
  });

  commandRegistry.register('runpane:panes:create', async (request: PaneCommandValue): Promise<RunpanePaneCreateResult> => {
    return withRunpaneAction(services, 'panes:create', {}, async () => {
      const normalized = parsePaneCreateRequest(request);
      const repo = resolveRepoSelector(databaseService.getAllProjects(), normalized.repo);
      const repoSummary = projectToRepoSummary(repo, sessionManager.getSessionsForProject(repo.id).length);

      if (normalized.dryRun) {
        const items = await mapSequentially(normalized.panes, async (pane, index): Promise<RunpanePaneCreateResultItem> => {
          try {
            await validateRequestedBranch(services, repo, pane.branch);
          } catch (error) {
            return createFailureItem(index, pane, error);
          }
          return {
            ok: true,
            index,
            name: pane.name,
            pinned: Boolean(pane.pinned),
            tool: describeTool(resolveToolSpec(pane.tool, new PathResolver(repo).environment)),
          };
        });
        return { ok: items.every(item => item.ok), repo: repoSummary, items };
      }

      if (!taskQueue) {
        throw new Error('Task queue not initialized');
      }

      const items = await mapSequentially(
        normalized.panes,
        (item, index) => createPaneItem(services, repo, item, index, {
          timeoutMs: normalized.timeoutMs,
          waitReady: normalized.waitReady,
          readyTimeoutMs: normalized.readyTimeoutMs,
          activate: resolvePaneCreateActivation(normalized, item),
          associateSession: normalized.associateSession,
        }),
      );

      return {
        ok: items.every(isPaneCreateItemSuccessful),
        repo: repoSummary,
        items,
      };
    }, result => ({ repoId: result.repo.id, resultCount: result.items.length }));
  });

  commandRegistry.register('runpane:panes:adopt', async (request: PaneCommandValue): Promise<RunpanePaneAdoptResult> => {
    return withRunpaneAction(services, 'panes:adopt', {}, async () => {
      const normalized = parsePaneAdoptRequest(request);
      const repo = resolveRepoSelector(databaseService.getAllProjects(), normalized.repo);
      const repoSummary = projectToRepoSummary(repo, sessionManager.getSessionsForProject(repo.id).length);
      const items: RunpanePaneCreateResultItem[] = [];

      for (const [index, item] of normalized.panes.entries()) {
        let createdSessionId: string | undefined;
        let storedWorktreePath = item.path;
        try {
          const validatedPath = await validateAdoptedWorktree(services, repo, item.path);
          storedWorktreePath = validatedPath.storagePath;
          await services.archiveCleanupManager?.assertPathAvailable(validatedPath.pathResolver.toFileSystem(storedWorktreePath));
          const existing = findSessionByWorktreeIdentity(
            databaseService.getAllSessionsIncludingArchived({ includeHidden: true }),
            validatedPath.identityPath,
            validatedPath.pathResolver,
          );
          if (existing) {
            throw new Error(`Worktree path is already registered by pane "${existing.name}" (${existing.id})`);
          }
          const tool = resolveToolSpec(item.tool, new PathResolver(repo).environment);
          if (item.resume && tool.launchMode === 'wrapped') {
            throw new Error('--resume needs a built-in agent command; a wrapper command resumes its own way.');
          }
          if (normalized.dryRun) {
            items.push({ ok: true, index, name: item.name, pinned: item.pinned !== false, worktreePath: storedWorktreePath, tool: describeTool(tool) });
            continue;
          }

          const session = await sessionManager.createSession(
            item.name,
            storedWorktreePath,
            '',
            path.basename(storedWorktreePath),
            'ignore',
            repo.id,
            false,
            item.folder
              ? resolveOrCreateAdoptFolder(databaseService, repo.id, item.folder)
              : undefined,
            'none',
            undefined,
            item.baseBranch,
            item.pinned !== false,
            { worktreeOwnership: 'external' },
          );
          createdSessionId = session.id;
          await sessionManager.updateSession(session.id, { status: 'stopped' });
          const stoppedSession = sessionManager.getSession(session.id);
          if (!stoppedSession) throw new Error(`Created session ${session.id} was not found after status update`);
          const association = await associateCreatedPane(services, normalized.associateSession, session.id);
          await Promise.all([
            panelManager.ensureExplorerPanel(session.id),
            panelManager.ensureDiffPanel(session.id),
          ]);

          // Announce the Pane before any readiness wait, as `panes create` does.
          sessionManager.emitSessionCreated(stoppedSession, {
            activateOnCreate: normalized.focus === true,
            createDefaultTerminalOnCreate: false,
          });
          const launch = item.launch === true;
          const { panel, readiness, initialInput } = await createTerminalPanelForSession(services, stoppedSession, tool, {
            activate: normalized.focus === true,
            launch,
            agentSessionId: item.resume,
            waitReady: launch && normalized.waitReady,
            readyTimeoutMs: normalized.readyTimeoutMs,
          });
          items.push({
            ok: Boolean((!readiness || readiness.ok) && (!initialInput || initialInput.submitted)),
            index,
            name: item.name,
            pinned: item.pinned !== false,
            sessionId: session.id,
            paneId: session.id,
            panelId: panel.id,
            worktreePath: storedWorktreePath,
            tool: describeTool(tool),
            active: Boolean(panel.state.isActive),
            focused: Boolean(panel.state.isActive),
            association,
            readiness,
            initialInput,
            nextCommand: initialInput?.nextCommand ?? readiness?.nextCommand ?? panelOutputCommand(panel.id),
          });
        } catch (error) {
          let failureSessionId = createdSessionId;
          if (createdSessionId) {
            try {
              await sessionManager.archiveSession(createdSessionId);
              if (databaseService.deleteArchivedSessionPermanently(createdSessionId)) {
                failureSessionId = undefined;
              }
            } catch (rollbackError) {
              console.error(`[Runpane] Failed to roll back adopted pane ${createdSessionId}:`, rollbackError);
            }
          }
          items.push(createFailureItem(index, item, error, failureSessionId, storedWorktreePath));
        }
      }

      return { ok: items.every(item => item.ok), repo: repoSummary, items };
    }, result => ({ repoId: result.repo.id, resultCount: result.items.length }));
  });

  commandRegistry.register('runpane:panes:archive', async (request: PaneCommandValue): Promise<RunpanePaneArchiveResult | RunpanePaneArchiveBulkResult> => {
    if (isRecord(request) && request.sessionId !== undefined) {
      return withRunpaneAction(services, 'panes:archive', {}, async () => {
        return archiveSessionPanes(services, commandRegistry, parsePaneArchiveBulkRequest(request));
      }, result => ({ resultCount: result.items.length, ok: result.ok }));
    }
    return withRunpaneAction(services, 'panes:archive', {}, async () => {
      const normalized = parsePaneArchiveRequest(request);
      const pane = resolvePane(sessionManager, normalized.paneId);

      if (pane.archived) {
        throw new Error(`Pane ${normalized.paneId} is already archived`);
      }

      const removeWorktree = Boolean(normalized.removeWorktree);
      await assertRemovableWorktree(services, pane, removeWorktree);
      const worktreeCleanupApplicable = ownsRemovableWorktree(databaseService.getSession(pane.id))
        || (removeWorktree && removesPaneWorktree(pane, removeWorktree));
      const cleanupSkipReason = worktreeCleanupApplicable ? undefined : archiveCleanupSkipReason(pane);
      const safetyCheck: RunpanePaneArchiveSafetyCheck = worktreeCleanupApplicable
        ? await computeArchiveSafety(services, pane)
        : { performed: false, reason: cleanupSkipReason, worktreeWillRemain: true };

      const blockCode = classifyArchiveBlock(safetyCheck, worktreeCleanupApplicable);
      if (normalized.dryRun) {
        return {
          ok: true,
          paneId: normalized.paneId,
          dryRun: true,
          wouldArchive: Boolean(normalized.force) || !blockCode,
          forced: Boolean(normalized.force),
          safetyCheck,
          blocked: blockCode
            ? {
                code: blockCode,
                message: describeArchiveBlock(blockCode, safetyCheck),
                safetyCheck,
              }
            : undefined,
        };
      }

      if (!normalized.force) {
        if (blockCode) {
          const blocked: RunpanePaneArchiveBlockedResult = {
            ok: false,
            paneId: normalized.paneId,
            blocked: {
              code: blockCode,
              message: describeArchiveBlock(blockCode, safetyCheck),
              safetyCheck,
            },
            nextCommand: `runpane panes archive --pane ${normalized.paneId}${removeWorktree ? ' --remove-worktree' : ''} --force --yes --json`,
          };
          return blocked;
        }
      }

      const cleanup = await archivePaneAndRemoveWorktree(services, commandRegistry, pane, worktreeCleanupApplicable);
      const success: RunpanePaneArchiveSuccessResult = {
        ok: isArchiveCleanupOk(cleanup.worktreeCleanup),
        paneId: normalized.paneId,
        archived: true,
        forced: Boolean(normalized.force),
        ...cleanup,
        worktreePath: pane.worktreePath,
        safetyCheck,
      };
      return success;
    }, result => ({ paneId: result.paneId, ok: result.ok }));
  });

  commandRegistry.register('runpane:panels:list', async (request: PaneCommandValue): Promise<RunpanePanelListResult> => {
    return withRunpaneAction(services, 'panels:list', {}, () => {
      const normalized = parsePanelListRequest(request);
      const pane = resolvePane(sessionManager, normalized.paneId);
      const panels = panelManager.getPanelsForSession(pane.id).map(panelToSummary);

      return {
        ok: true,
        paneId: pane.id,
        panels,
      };
    }, result => ({ paneId: result.paneId, resultCount: result.panels.length }));
  });

  commandRegistry.register('runpane:panels:create', async (request: PaneCommandValue): Promise<RunpanePanelCreateResult> => {
    return withRunpaneAction(services, 'panels:create', {}, async () => {
      const normalized = parsePanelCreateRequest(request);
      const pane = resolvePane(sessionManager, normalized.paneId);
      const repo = sessionManager.getProjectForSession(pane.id);
      if (!repo) {
        throw new Error(`No Pane repo found for pane ${pane.id}`);
      }
      const tool = resolveToolSpec(normalized.tool, new PathResolver(repo).environment);
      const { panel, readiness, initialInput, promptFile, warnings } = await createTerminalPanelForSession(services, pane, tool, {
        activate: resolvePanelCreateActivation(normalized, tool),
        waitReady: normalized.waitReady,
        readyTimeoutMs: normalized.readyTimeoutMs,
      });

      return {
        ok: Boolean((!readiness || readiness.ok) && (!initialInput || initialInput.submitted)),
        paneId: pane.id,
        panelId: panel.id,
        title: panel.title,
        active: Boolean(panel.state.isActive),
        focused: Boolean(panel.state.isActive),
        tool: describeTool(tool),
        readiness,
        initialInput,
        promptFile,
        warnings,
        nextCommand: initialInput?.nextCommand ?? readiness?.nextCommand ?? panelOutputCommand(panel.id),
      };
    }, result => ({
      paneId: result.paneId,
      panelId: result.panelId,
      ok: result.ok,
      resultCount: 1,
    }));
  });

  commandRegistry.register('runpane:panels:open', async (request: PaneCommandValue): Promise<RunpanePanelOpenResult> => {
    return withRunpaneAction(services, 'panels:open', {}, async () => {
      const normalized = parsePanelOpenRequest(request);
      const pane = resolvePane(sessionManager, normalized.paneId);
      if (pane.archived) {
        throw new Error(`Pane ${pane.id} is archived; panels cannot be opened in it`);
      }
      const target = normalized.url !== undefined
        ? await resolvePanelOpenUrl(normalized.url, services, pane)
        : await resolvePanelOpenFile(services, pane, normalized.filePath ?? '');
      const placement = normalized.placement ?? 'split';
      // Activates the tab inside its Pane; never raises or focuses the window.
      const activate = normalized.noFocus !== true;
      const existing = panelManager.getPanelsForSession(pane.id).find(panel => panelShowsOpenTarget(panel, target));

      let panel: ToolPanel;
      if (existing) {
        const title = normalized.title && normalized.title !== existing.title ? normalized.title : undefined;
        if (activate) {
          await panelManager.setActivePanel(pane.id, existing.id);
        }
        // Publish the final active state and reload signal together for desktop consumers.
        const current = panelManager.getPanel(existing.id) ?? existing;
        const state = {
          ...current.state,
          customState: { ...(current.state.customState ?? {}), reopenedAt: new Date().toISOString(), reopenedWithFocus: activate },
        };
        await panelManager.updatePanel(existing.id, { title, state });
        panel = panelManager.getPanel(existing.id) ?? existing;
      } else {
        panel = await panelManager.createPanel({
          sessionId: pane.id,
          type: target.type,
          title: normalized.title || target.title,
          initialState: { customState: target.customState },
          metadata: { openPlacement: placement },
          activate,
        });
      }

      return {
        ok: true,
        paneId: pane.id,
        panelId: panel.id,
        type: target.type,
        title: panel.title,
        url: target.type === 'browser' ? target.customState.currentUrl : undefined,
        filePath: target.filePath,
        placement,
        active: Boolean(panel.state.isActive),
        reused: Boolean(existing),
      };
    }, result => ({
      paneId: result.paneId,
      panelId: result.panelId,
      ok: result.ok,
      resultCount: 1,
    }));
  });

  commandRegistry.register('runpane:panels:output', async (request: PaneCommandValue): Promise<RunpanePanelOutputResult> => {
    return withRunpaneAction(services, 'panels:output', {}, async () => {
      const normalized = parsePanelOutputRequest(request);
      const panel = resolvePanel(normalized.panelId);
      const limit = normalized.limit ?? DEFAULT_PANEL_OUTPUT_LIMIT;
      const scrollbackResult = panel.type === 'terminal' ? await panelScrollbackOutput(panel, limit) : null;

      if (scrollbackResult) {
        return {
          ok: true,
          panelId: panel.id,
          paneId: panel.sessionId,
          limit,
          returnedCount: scrollbackResult.text ? 1 : 0,
          hasMore: scrollbackResult.hasMore,
          outputs: scrollbackResult.text
            ? [{
                type: 'stdout',
                data: scrollbackResult.text,
                timestamp: scrollbackResult.timestamp,
              }]
            : [],
          text: scrollbackResult.text,
        };
      }

      const fetchedOutputs = sessionManager.getPanelOutputs(panel.id, limit + 1);
      const hasMore = fetchedOutputs.length > limit;
      const outputs = hasMore ? fetchedOutputs.slice(fetchedOutputs.length - limit) : fetchedOutputs;
      const records = outputs.map(outputToRecord);

      return {
        ok: true,
        panelId: panel.id,
        paneId: panel.sessionId,
        limit,
        returnedCount: records.length,
        hasMore,
        outputs: records,
        text: outputs.map(outputToText).join(''),
      };
    }, result => ({
      paneId: result.paneId,
      panelId: result.panelId,
      resultCount: result.outputs.length,
      limit: result.limit,
    }));
  });

  commandRegistry.register('runpane:panels:input', async (request: PaneCommandValue): Promise<RunpanePanelInputResult> => {
    return withRunpaneAction(services, 'panels:input', {}, () => {
      const normalized = parsePanelInputRequest(request);
      const panel = resolvePanel(normalized.panelId);

      if (panel.type !== 'terminal') {
        throw new Error(`Panel ${panel.id} is a ${panel.type} panel, not a terminal panel`);
      }
      if (!terminalPanelManager.isTerminalInitialized(panel.id)) {
        throw new Error(`Terminal panel ${panel.id} is not initialized`);
      }

      if (normalized.source === 'user') getMobilePushSender(configManager).observeInput(panel.id, normalized.input);
      terminalPanelManager.writeToTerminal(panel.id, normalized.input);

      return {
        ok: true,
        panelId: panel.id,
        paneId: panel.sessionId,
        inputBytes: Buffer.byteLength(normalized.input, 'utf8'),
        sentAt: new Date().toISOString(),
        nextCommand: panelOutputCommand(panel.id),
      };
    }, result => ({
      paneId: result.paneId,
      panelId: result.panelId,
      inputBytes: result.inputBytes,
    }));
  });

  commandRegistry.register('runpane:panels:screen', async (request: PaneCommandValue): Promise<RunpanePanelScreenResult> => {
    return withRunpaneAction(services, 'panels:screen', {}, async () => {
      const normalized = parsePanelScreenRequest(request);
      const panel = resolveTerminalPanel(normalized.panelId);
      return await buildPanelScreenResult(panel, normalized.limit ?? DEFAULT_PANEL_SCREEN_LIMIT);
    }, result => ({
      paneId: result.paneId,
      panelId: result.panelId,
      limit: result.limit,
      resultCount: result.returnedLineCount,
    }));
  });

  commandRegistry.register('runpane:panels:submit', async (request: PaneCommandValue): Promise<RunpanePanelSubmitResult> => {
    return withRunpaneAction(services, 'panels:submit', {}, async () => {
      const normalized = parsePanelSubmitRequest(request);
      const panel = resolveTerminalPanel(normalized.panelId);
      if (!terminalPanelManager.isTerminalInitialized(panel.id)) {
        throw new Error(`Terminal panel ${panel.id} is not initialized`);
      }
      if (normalized.source === 'user') getMobilePushSender(configManager).arm(panel.id);

      let beforeScreen = await buildPanelScreenResult(panel, DEFAULT_PANEL_SCREEN_LIMIT);
      const promptFile = normalized.asFilePointer
        ? await writePromptFile(panel.sessionId, stripTrailingNewlines(normalizePromptNewlines(normalized.input)))
        : undefined;
      const submittedText = promptFile
        ? filePointerPrompt(agentVisiblePath(promptFile, sessionWslContext(services, panel.sessionId)))
        : normalized.input;
      // A CR inside the text would be Enter to an agent composer.
      const stagedInput = stripTrailingNewlines(normalizePromptNewlines(submittedText));
      const agentType = screenAgentType(beforeScreen);
      const warnings = agentType === 'claude' ? claudePromptWarnings(stagedInput) : undefined;
      // Claude reads text and Enter arriving in one read as a paste and keeps
      // the Enter as a newline. Terminal readiness can precede Claude drawing
      // its UI or reading input, so wait while it is still drawing for its
      // composer, then for the staged text to show, before sending Enter alone.
      // Claude draws its UI on the alternate screen, so a quiet alternate
      // screen without a composer is a menu or picker and gets the plain
      // write. Startup can pause for seconds before the first frame.
      if (stagedInput.length > 0 && agentType === 'claude' && !beforeScreen.composer.isPresent) {
        beforeScreen = await waitForPanelScreen(
          panel,
          screen => screen.composer.isPresent ||
            (screen.state.isAlternateScreen === true && !panelHasOutputWithin(panel.id, CLAUDE_UI_QUIET_MS)),
        );
      }
      const stagesComposer = beforeScreen.composer.isPresent && (agentType === 'claude' ||
        agentType === 'codex');
      if (stagedInput.length > 0 && stagesComposer && (agentType === 'claude' || agentType === 'codex')) {
        // Claude takes a separately written Enter while it works (it queues
        // the message), so staging never waits for it to be idle.
        const staged = await stageComposerText(panel, agentType, stagedInput);
        const submission = await submitComposerForPanel(panel, 'auto', {
          cwd: sessionManager.getSession(panel.sessionId)?.worktreePath,
          text: stagedInput,
        });
        return {
          ok: submission.ok,
          panelId: panel.id,
          paneId: panel.sessionId,
          inputBytes: staged.inputBytes + submission.inputBytes,
          enter: submission.strategy === 'tab' ? 'tab' : 'cr',
          sequenceName: submission.sequenceName,
          verifiedSubmitted: submission.verifiedSubmitted,
          verification: submission.verification,
          delivery: submission.delivery,
          sentAt: submission.sentAt,
          blocked: submission.blocked,
          promptFile,
          warnings,
          nextCommand: submission.nextCommand,
        };
      }

      if (stagedInput.length > 0 && isComposerUnknown(panel, beforeScreen, agentType)) {
        const suggestedCommand = panelScreenCommand(panel.id);
        return {
          ok: false,
          panelId: panel.id,
          paneId: panel.sessionId,
          inputBytes: 0,
          enter: 'cr',
          sequenceName: 'enter-cr',
          verifiedSubmitted: false,
          sentAt: new Date().toISOString(),
          blocked: {
            kind: 'composer-unknown',
            message: `Pane could not find the ${agentType === 'codex' ? 'Codex' : 'Claude'} composer in this panel, so it sent nothing. The agent may still be starting, or showing a view without its prompt. Check the screen, then submit again or use \`panels input\`.`,
            suggestedCommand,
          },
          promptFile,
          warnings,
          nextCommand: suggestedCommand,
        };
      }

      // An agent's CRs inside the text would each be an Enter; a shell keeps its bytes.
      const input = ensureSubmitEnter(agentType === 'claude' || agentType === 'codex' ? stagedInput : submittedText);
      // A busy Codex takes text and Enter in one write and holds the message
      // for its next turn; its transcript or queue hint says where it went.
      const probeBase = agentType === 'codex' && beforeScreen.composer.isPresent && stagedInput.length > 0
        ? composerDeliveryProbe(panel, sessionManager.getSession(panel.sessionId)?.worktreePath, agentType, stagedInput)
        : undefined;
      const probe = probeBase ? { ...probeBase, sentAtMs: Date.now() } : undefined;
      const outputGenerationBeforeWrite = terminalPanelManager.getOutputGeneration(panel.id);
      terminalPanelManager.writeToTerminal(panel.id, input);
      const verification = probe
        ? await verifyComposerSubmitted(panel, beforeScreen, outputGenerationBeforeWrite, probe)
        : undefined;

      return {
        ok: true,
        panelId: panel.id,
        paneId: panel.sessionId,
        inputBytes: Buffer.byteLength(input, 'utf8'),
        enter: 'cr',
        sequenceName: 'enter-cr',
        verifiedSubmitted: verification?.verifiedSubmitted ?? false,
        delivery: verification?.delivery,
        sentAt: new Date().toISOString(),
        promptFile,
        warnings,
        nextCommand: panelWaitCommand(panel.id),
      };
    }, result => ({
      paneId: result.paneId,
      panelId: result.panelId,
      inputBytes: result.inputBytes,
    }));
  });

  commandRegistry.register('runpane:panels:submit-composer', async (request: PaneCommandValue): Promise<RunpanePanelSubmitComposerResult> => {
    return withRunpaneAction(services, 'panels:submit-composer', {}, async () => {
      const normalized = parsePanelSubmitComposerRequest(request);
      const panel = resolveTerminalPanel(normalized.panelId);
      if (!terminalPanelManager.isTerminalInitialized(panel.id)) {
        throw new Error(`Terminal panel ${panel.id} is not initialized`);
      }

      return submitComposerForPanel(panel, normalized.strategy, {
        cwd: sessionManager.getSession(panel.sessionId)?.worktreePath,
      });
    }, result => ({
      paneId: result.paneId,
      panelId: result.panelId,
      ok: result.ok,
      inputBytes: result.inputBytes,
    }));
  });

  commandRegistry.register('runpane:panels:wait', async (request: PaneCommandValue): Promise<RunpanePanelWaitResult> => {
    return withRunpaneAction(services, 'panels:wait', {}, async () => {
      const normalized = parsePanelWaitRequest(request);
      const panel = resolveTerminalPanel(normalized.panelId);
      return waitForPanel(panel, normalized);
    }, result => ({
      paneId: result.paneId,
      panelId: result.panelId,
      ok: result.ok,
      resultCount: result.matched ? 1 : 0,
      condition: result.condition,
      timedOut: result.timedOut,
    }));
  });

  commandRegistry.register('runpane:panels:last-message', async (request: PaneCommandValue): Promise<RunpanePanelLastMessageResult> => {
    return withRunpaneAction(services, 'panels:last-message', {}, async () => {
      const normalized = parsePanelLastMessageRequest(request);
      const panel = resolveTerminalPanel(normalized.panelId);
      const cwd = sessionManager.getSession(panel.sessionId)?.worktreePath;
      return readPanelLastMessage(panel, cwd, normalized.limit ?? DEFAULT_LAST_MESSAGE_LIMIT);
    }, result => ({
      paneId: result.paneId,
      panelId: result.panelId,
      resultCount: result.ok ? 1 : 0,
    }));
  });

  commandRegistry.register('runpane:report', async (request: PaneCommandValue): Promise<RunpaneReportResult> => {
    return withRunpaneAction(services, 'report', {}, async () => {
      const normalized = parseReportRequest(request);
      const panel = resolveTerminalPanel(normalized.panelId);
      if (normalized.paneId && normalized.paneId !== panel.sessionId) {
        throw new Error(`Panel ${panel.id} belongs to Pane ${panel.sessionId}, not ${normalized.paneId}.`);
      }
      const report = normalizeAgentReport(normalized, new Date().toISOString());
      await storePanelAgentReport(panel, report);
      const panelSummary = panelToSummary(panelManager.getPanel(panel.id) ?? panel);
      workspaceJournal.appendPaneEntry(panel.sessionId, {
        kind: 'agent.report',
        panelId: panel.id,
        panelTitle: panel.title,
        agentType: panelSummary.agentType,
        source: 'agent',
        report: journalAgentReport(report),
      });
      const sessionIds = await services.orchestrationSessionManager?.recordAgentReport(panel.id, report) ?? [];
      return { ok: true, paneId: panel.sessionId, panelId: panel.id, report, sessionIds };
    }, result => ({ paneId: result.paneId, panelId: result.panelId, ok: result.ok }));
  });

  commandRegistry.register('runpane:workspace:state', async (request: PaneCommandValue = {}): Promise<RunpaneWorkspaceStateResult> => {
    return withRunpaneAction(services, 'workspace:state', {}, () => {
      const normalized = parsePaneListRequest(request);
      const project = normalized.repo
        ? resolveRepoSelector(databaseService.getAllProjects(), normalized.repo)
        : undefined;
      return workspaceStateReader.read(project?.id);
    }, result => ({ resultCount: result.entries.length }));
  });

  commandRegistry.register('runpane:workspace:wait', async (request: PaneCommandValue = {}): Promise<RunpaneWorkspaceWaitResult> => {
    return withRunpaneAction(services, 'workspace:wait', {}, async () => {
      const normalized = parseWorkspaceWaitRequest(request);
      const project = normalized.repo
        ? resolveRepoSelector(databaseService.getAllProjects(), normalized.repo)
        : undefined;
      // Resolve the Session (id or exact name) once; its members are re-read on every journal read.
      const sessionRecord = normalized.session
        ? await requireOrchestrationSessionManager(services).get({ sessionId: normalized.session })
        : undefined;
      const session = sessionRecord ? { id: sessionRecord.id, name: sessionRecord.name } : undefined;
      const filter: WorkspaceJournalFilter = {
        kinds: normalized.kinds,
        paneIds: normalized.paneIds,
        sessionId: session?.id,
        excludePaneIds: normalized.excludePaneIds,
        repoId: project?.id,
        nameContains: normalized.nameContains,
        agentsOnly: normalized.agentsOnly,
        includeHeldInput: normalized.includeHeldInput,
        includeHeldInputPresence: normalized.includeHeldInputPresence,
      };
      const timeoutMs = Math.min(normalized.timeoutMs ?? DEFAULT_WORKSPACE_WAIT_TIMEOUT_MS, MAX_WORKSPACE_WAIT_TIMEOUT_MS);
      const limit = normalized.limit ?? DEFAULT_WORKSPACE_WAIT_LIMIT;
      const idleSchedule: WorkspaceIdleSchedule = { idleAfterMs: normalized.idleAfterMs ?? 0, backoff: normalized.idleBackoff ?? false };
      const requestStartedAt = Date.now();
      // Take the consumer's in-memory record now; it is put back only on a non-reset exit.
      const runtime = normalized.as ? consumerRuntime.get(normalized.as) : undefined;
      if (normalized.as) consumerRuntime.delete(normalized.as);
      let idleWindowStart = normalized.idleWindowStartMs ?? (normalized.as
        ? runtime?.lastReadAt ?? 0
        : normalized.since !== undefined ? 0 : requestStartedAt);
      let cursor = normalized.since ?? workspaceJournal.generation;
      let reset: RunpaneWorkspaceWaitResult['reset'];
      const cadenceOptions = normalized.as ? workspaceCadenceOptions(normalized, filter, idleSchedule) : undefined;
      const readFilter = cadenceOptions ? WatchCadence.observeFilter(filter) : filter;
      const currentIdleEntries = (candidates: readonly WorkspaceIdleCandidate[]): RunpaneWorkspaceEntry[] => dueIdleEntries(
        candidates,
        idleSchedule,
        idleWindowStart,
        Date.now(),
        workspaceJournal.generation,
      )
        .filter(workspaceJournal.matcher(filter))
        .map(entry => projectWorkspaceEntry(entry, filter));
      // Baseline entries restate current state after a reset; replay marks them so a consumer never
      // reads a replayed agent.ready as a turn that just ended.
      const baselineEntries = (): RunpaneWorkspaceEntry[] => workspaceStateReader.read(project?.id).entries
        .filter(workspaceJournal.matcher(filter))
        .map(entry => ({ ...projectWorkspaceEntry(entry, filter), replay: true as const }));

      if (normalized.as) {
        const evicted = workspaceCursorStore.evictStale();
        for (const name of evicted) consumerRuntime.delete(name);
        let named = workspaceCursorStore.get(normalized.as);
        if (!named) {
          cursor = normalized.from === 'earliest'
            ? Math.max(0, workspaceJournal.oldestGeneration - 1)
            : workspaceJournal.generation;
          workspaceCursorStore.create(normalized.as, cursor, workspaceJournal.epoch);
          reset = { reason: evicted.includes(normalized.as) ? 'unknown-consumer' : 'first-use' };
        } else if (named.epoch !== workspaceJournal.epoch) {
          cursor = workspaceJournal.generation;
          workspaceCursorStore.create(normalized.as, cursor, workspaceJournal.epoch);
          reset = { reason: 'epoch-changed' };
        } else {
          named = workspaceCursorStore.commitPending(normalized.as) ?? named;
          cursor = named.gen;
        }
      }

      if (reset) {
        const silentBaseline = reset.reason === 'first-use' && normalized.from !== 'earliest';
        const baseline = silentBaseline ? [] : baselineEntries()
          .map(entry => reset?.reason === 'epoch-changed' ? { ...entry, changedWhileAway: true as const } : entry);
        const entries = [...baseline, ...currentIdleEntries(workspaceIdleCandidates(workspaceStateReader, workspaceJournal, project?.id))];
        if (normalized.as) consumerRuntime.set(normalized.as, { lastReadAt: Date.now() });
        return {
          ok: true,
          epoch: workspaceJournal.epoch,
          generation: workspaceJournal.generation,
          entries,
          timedOut: false,
          reset,
          session,
          nextCommand: workspaceNextCommand(normalized, workspaceJournal.generation, session),
        };
      }

      let cadence: WatchCadence | undefined;
      if (cadenceOptions) {
        cadence = runtime?.cadence?.options.key === cadenceOptions.key ? runtime.cadence : new WatchCadence(cadenceOptions);
        cursor = cadence.readCursor ?? cursor;
      }

      const deadlineAt = requestStartedAt + timeoutMs;
      const startCursor = cursor;
      let readAny = false;
      let waited: Awaited<ReturnType<WorkspaceJournal['waitAfter']>>;
      let entries: RunpaneWorkspaceEntry[];
      for (;;) {
        const idleCandidates = workspaceIdleCandidates(workspaceStateReader, workspaceJournal, project?.id);
        const initial = workspaceJournal.readAfter(cursor, readFilter, limit);
        let idleEntries = currentIdleEntries(idleCandidates);
        if (initial.entries.length > 0 || initial.dropped !== undefined || idleEntries.length > 0) {
          waited = { ...initial, timedOut: initial.entries.length === 0 };
        } else {
          const now = Date.now();
          const parkUntil = Math.min(
            deadlineAt,
            nextIdleDeadline(idleCandidates, idleSchedule, now) ?? Number.POSITIVE_INFINITY,
            cadence?.nextDeadline(now) ?? Number.POSITIVE_INFINITY,
          );
          waited = await workspaceJournal.waitAfter(
            cursor,
            readFilter,
            Math.max(0, parkUntil - now),
            limit,
            normalized.as ?? 'anonymous',
          );
          idleEntries = currentIdleEntries(workspaceIdleCandidates(workspaceStateReader, workspaceJournal, project?.id));
        }
        if (waited.dropped) {
          reset = { reason: 'cursor-truncated' };
        }
        entries = [...reset ? baselineEntries() : waited.entries, ...idleEntries];

        if (!cadence || reset) {
          if (normalized.as && (!waited.timedOut || waited.dropped !== undefined)) {
            workspaceCursorStore.advance(
              normalized.as,
              waited.generation,
              workspaceJournal.epoch,
              !normalized.ackNow,
            );
          }
          break;
        }

        // Drain the rest of the backlog before flushing so a BUSY on a later page
        // can still cancel a READY on an earlier one.
        const now = Date.now();
        if (waited.entries.length > 0) readAny = true;
        cadence.ingest(entries, now);
        idleWindowStart = now;
        cursor = Math.max(cursor, waited.generation);
        if (waited.entries.length > 0 && cursor < workspaceJournal.generation) {
          const rest = workspaceJournal.readAfter(cursor, readFilter, Number.MAX_SAFE_INTEGER);
          cadence.ingest(rest.entries, now);
          cursor = Math.max(cursor, rest.generation);
        }
        cadence.readCursor = cursor;
        entries = cadence.flush(now);
        // Held lines are delivered under the Session's membership at flush time: a Pane detached
        // while its READY settled drops out.
        if (filter.sessionId !== undefined) entries = entries.filter(workspaceJournal.matcher(filter));
        if (entries.length > 0 || now >= deadlineAt) break;
      }
      if (cadence && !reset && readAny) {
        // The durable cursor never passes an entry still pending or held in memory. The
        // instance resumes from its own read cursor, so nothing repeats while it lives. If
        // the instance is discarded (request shape change, eviction, reset, or a call without
        // cadence flags) the re-read from the durable cursor re-delivers the held entries under
        // the new filter, and later entries already delivered may repeat: that is the accepted
        // at-least-once contract.
        const lowestUnflushed = cadence.lowestUnflushedGen();
        const durableGen = Math.max(
          startCursor,
          Math.min(cursor, lowestUnflushed === undefined ? cursor : lowestUnflushed - 1),
        );
        workspaceCursorStore.advance(normalized.as ?? '', durableGen, workspaceJournal.epoch, !normalized.ackNow);
      }
      // A reset drops the cadence; the idle window still moves forward.
      if (normalized.as) consumerRuntime.set(normalized.as, { lastReadAt: Date.now(), cadence: reset ? undefined : cadence });

      const generation = cadence && !reset ? cursor : waited.generation;
      return {
        ok: true,
        epoch: workspaceJournal.epoch,
        generation,
        entries,
        timedOut: entries.length === 0 && (cadence !== undefined || waited.timedOut),
        dropped: waited.dropped,
        reset,
        session,
        nextCommand: workspaceNextCommand(normalized, generation, session),
      };
    }, result => ({ resultCount: result.entries.length, timedOut: result.timedOut }), result =>
      result.entries.length > 0 || result.reset !== undefined);
  });

  commandRegistry.register('runpane:agents:doctor', async (request: PaneCommandValue): Promise<RunpaneAgentDoctorResult> => {
    return withRunpaneAction(services, 'agents:doctor', {}, async () => {
      const normalized = parseAgentDoctorRequest(request);
      const repo = normalized.repo
        ? resolveRepoSelector(databaseService.getAllProjects(), normalized.repo)
        : resolveActiveProject(databaseService.getAllProjects());
      return runAgentDoctor(services, repo, normalized.agent);
    }, result => ({
      repoId: result.repo?.id,
      ok: result.ok,
      resultCount: result.checks.length,
      available: result.available,
      environment: result.environment,
    }));
  });
}

function runpaneDaemonChannels(): readonly string[] {
  return RUNPANE_CHANNELS;
}

function projectToRepoSummary(project: Project, sessionCount: number): RunpaneRepoSummary {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    active: Boolean(project.active),
    environment: new PathResolver(project).environment,
    sessionCount,
  };
}

function sessionToPaneSummary(session: Session, project: Project): RunpanePaneSummary {
  const panels = panelManager.getPanelsForSession(session.id);
  const agentStatus = resolveAggregatedAgentStatus(panels);

  return {
    id: session.id,
    paneId: session.id,
    name: session.name,
    status: resolvePaneLiveStatus(session, panels),
    agentStatus,
    agentState: resolvePaneAgentState(panels),
    worktreePath: session.worktreePath,
    repoId: project.id,
    repoName: project.name,
    panelCount: panels.length,
    pinned: Boolean(session.isFavorite),
    createdAt: toIsoString(session.createdAt),
    lastActivity: toIsoString(session.lastActivity),
    archived: session.archived || undefined,
    ownership: session.worktreeOwnership ?? 'pane',
  };
}

function resolveAggregatedAgentStatus(panels: readonly ToolPanel[]): RunpanePanelActivityStatus {
  for (const panel of panels) {
    const state = terminalPanelManager.getAgentStatus(panel.id);
    if (state === 'working' || state === 'blocked') {
      return 'active';
    }
  }
  return 'idle';
}

/**
 * A Pane with a live terminal is running, whatever lifecycle value was stored
 * when it was created or adopted. Errors and startup keep their stored status.
 */
function resolvePaneLiveStatus(session: Session, panels: readonly ToolPanel[]): string {
  if (session.status === 'error' || session.status === 'initializing') return session.status;
  const hasLiveTerminal = panels.some(panel => panel.type === 'terminal' && terminalPanelManager.isTerminalInitialized(panel.id));
  return hasLiveTerminal ? 'running' : session.status;
}

/** The most urgent state across a Pane's live agent panels: blocked, then working, then ready. */
function resolvePaneAgentState(panels: readonly ToolPanel[]): RunpanePaneAgentState {
  let agentState: RunpanePaneAgentState = 'none';
  for (const panel of panels) {
    if (panel.type !== 'terminal' || !terminalPanelManager.isTerminalInitialized(panel.id)) continue;
    if (!panelToSummary(panel).isCliPanel) continue;
    const state = terminalPanelManager.getAgentStatus(panel.id);
    if (state === 'blocked') return 'blocked';
    if (state === 'working') agentState = 'working';
    else if (state === 'idle' && agentState === 'none') agentState = 'ready';
  }
  return agentState;
}

function optionalAgentDetection(value: PaneCommandValue): RunpaneAgentDetection | undefined {
  try {
    return decodeBoundary(value, boundary.enumeration('declared', 'command', 'process', 'screen'));
  } catch {
    return undefined;
  }
}

function panelToSummary(panel: ToolPanel) {
  const customState = isRecord(panel.state.customState) ? panel.state.customState : {};
  const initialCommand = optionalString(customState.initialCommand);
  const commandAgentType = resolveAgentTypeFromCommand(initialCommand);
  const agentType = optionalAgentId(customState.agentType) ?? commandAgentType;
  const agentDetection = optionalAgentDetection(customState.agentDetection) ??
    (agentType ? (agentType === commandAgentType ? 'command' : 'declared') : undefined);
  const isCliPanel = optionalBoolean(customState.isCliPanel) ?? (agentType ? true : undefined);

  return {
    id: panel.id,
    panelId: panel.id,
    paneId: panel.sessionId,
    type: panel.type,
    title: panel.title,
    active: Boolean(panel.state.isActive),
    initialized: panel.type === 'terminal' ? terminalPanelManager.isTerminalInitialized(panel.id) : undefined,
    agentType,
    agentDetection,
    launchCommand: optionalString(customState.launchCommand) ?? initialCommand,
    isCliPanel,
    position: optionalNumber(panel.metadata.position),
    createdAt: toIsoString(panel.metadata.createdAt),
    lastActiveAt: toIsoString(panel.metadata.lastActiveAt),
    report: readPanelAgentReport(panel),
  };
}

/** Keep the report in the panel's custom state; the write merges, so other terminal state is untouched. */
async function storePanelAgentReport(panel: ToolPanel, report: TerminalAgentReport): Promise<void> {
  const current = panelManager.getPanel(panel.id) ?? panel;
  const state = current.state ?? { isActive: false };
  const customState = isRecord(state.customState) ? state.customState : {};
  await panelManager.updatePanel(panel.id, {
    state: { ...state, customState: { ...customState, agentReport: report } },
  });
}

/**
 * The agent's last reply from its transcript, bounded to `limit` characters (the tail is kept).
 * Without a transcript this reports `transcript-unavailable`; it never falls back to the screen.
 */
async function readPanelLastMessage(
  panel: ToolPanel,
  cwd: string | undefined,
  limit: number,
): Promise<RunpanePanelLastMessageResult> {
  const agentType = panelStateSummary(panel, terminalPanelManager.getTerminalSnapshot(panel.id)).agentType;
  const unavailable = (message: string): RunpanePanelLastMessageResult => ({
    ok: false,
    panelId: panel.id,
    paneId: panel.sessionId,
    reason: 'transcript-unavailable',
    message,
  });
  if (agentType !== 'claude' && agentType !== 'codex') {
    return unavailable(`Panel ${panel.id} is not a Claude or Codex panel, so Pane has no transcript to read. Use \`runpane panels screen --panel ${panel.id}\`.`);
  }
  const locator = panelTranscriptLocator(panel, cwd, agentType);
  let message: string | undefined;
  try {
    message = locator ? await agentTranscripts.lastAssistantMessage(locator) : undefined;
  } catch {
    message = undefined;
  }
  if (message === undefined) {
    return unavailable(`No ${agentType} transcript reply found for panel ${panel.id}. Use \`runpane panels screen --panel ${panel.id}\`.`);
  }
  const truncated = message.length > limit;
  const text = truncated
    ? `${LAST_MESSAGE_TRUNCATION_MARKER}${message.slice(message.length - Math.max(0, limit - LAST_MESSAGE_TRUNCATION_MARKER.length))}`
    : message;
  return { ok: true, panelId: panel.id, paneId: panel.sessionId, agentType, text, length: message.length, limit, truncated };
}

interface PaneCreateItemOptions {
  timeoutMs?: number;
  waitReady?: boolean;
  readyTimeoutMs?: number;
  activate?: boolean;
  associateSession?: string;
}

interface TerminalPanelCreateOptions {
  activate?: boolean;
  waitReady?: boolean;
  readyTimeoutMs?: number;
  /** false types the launch command at the shell prompt without running it (`panes adopt` without `--launch`). */
  launch?: boolean;
  /** Agent conversation to resume instead of starting a new one (`panes adopt --resume`). */
  agentSessionId?: string;
}

interface TerminalPanelCreateResult {
  panel: ToolPanel;
  readiness?: RunpanePaneReadiness;
  initialInput?: RunpaneInitialInputDeliveryResult;
  promptFile?: string;
  warnings?: RunpanePromptWarning[];
}

interface PreparedInitialInput {
  /** The tool with the prompt as it will be sent: newlines normalised, or the file pointer line. */
  tool: RunpaneResolvedTool;
  useArgumentDelivery: boolean;
  /** Prompt file the launch command reads with `"$(cat '<file>')"`. */
  initialInputFile?: string;
  /** Prompt file written for `--as-file-pointer`. */
  promptFile?: string;
  warnings?: RunpanePromptWarning[];
}

/**
 * Decide how a create prompt reaches the agent. A long or multi-line prompt
 * is never typed into the shell as an argument: on a POSIX shell the launch
 * reads it from a prompt file, elsewhere the agent's composer takes it as a
 * paste once the agent is ready. `--as-file-pointer` swaps the prompt for a
 * one-line pointer to its file.
 */
async function prepareInitialInput(
  session: Session,
  tool: RunpaneResolvedTool,
  wslContext: WSLContext | null,
  allowArgumentDelivery = true,
): Promise<PreparedInitialInput> {
  if (!tool.initialInput) {
    return { tool, useArgumentDelivery: false };
  }

  // Agent composers read CR as Enter; plain terminals keep their bytes.
  let text = tool.agent ? stripTrailingNewlines(normalizePromptNewlines(tool.initialInput)) : tool.initialInput;
  let promptFile: string | undefined;
  if (tool.initialInputAsFilePointer) {
    promptFile = await writePromptFile(session.id, text);
    text = filePointerPrompt(agentVisiblePath(promptFile, wslContext));
  }
  const prepared: RunpaneResolvedTool = { ...tool, initialInput: text };
  const warnings = tool.agent === 'claude' ? claudePromptWarnings(text) : undefined;

  const useArgumentDelivery = allowArgumentDelivery && shouldUseArgumentDelivery(prepared);
  if (!useArgumentDelivery || !isLongPrompt(text)) {
    return { tool: prepared, useArgumentDelivery, promptFile, warnings };
  }
  if (terminalPanelManager.launchShellReadsPromptFile(wslContext)) {
    const initialInputFile = await writePromptFile(session.id, text);
    if (promptFileShellWord(initialInputFile)) {
      return { tool: prepared, useArgumentDelivery: true, initialInputFile, promptFile, warnings };
    }
  }
  return { tool: prepared, useArgumentDelivery: false, promptFile, warnings };
}

/** A Pane-side file path as the agent's shell sees it (a WSL mount path for WSL repos). */
function agentVisiblePath(file: string, wslContext: WSLContext | null): string {
  return wslContext && process.platform === 'win32' ? windowsPathToWSLMount(file) : file;
}

function sessionWslContext(services: AppServices, sessionId: string): WSLContext | null {
  return services.sessionManager.getProjectContext(sessionId)?.commandRunner.wslContext ?? null;
}

async function createTerminalPanelForSession(
  services: AppServices,
  session: Session,
  requestedTool: RunpaneResolvedTool,
  options: TerminalPanelCreateOptions,
): Promise<TerminalPanelCreateResult> {
  const wslContext = sessionWslContext(services, session.id);
  const { tool, useArgumentDelivery, initialInputFile, promptFile, warnings } = await prepareInitialInput(
    session,
    requestedTool,
    wslContext,
    !options.agentSessionId,
  );
  const launch = options.launch !== false;
  const waitReady = launch && options.waitReady;
  const shouldCreateSubmitInitialInput = Boolean(
    waitReady &&
    tool.agent &&
    tool.initialInput &&
    !useArgumentDelivery,
  );
  const initialState: TerminalPanelState = {
    ...toolAgentIdentityState(tool),
    initialCommand: launch ? tool.command : undefined,
    initialInput: tool.initialInput,
    initialInputSubmitStrategy: tool.agent === 'codex' && !useArgumentDelivery
      ? 'codex-ctrl-enter'
      : 'enter',
  };
  if (options.agentSessionId) {
    initialState.agentSessionId = options.agentSessionId;
    initialState.hasClaudeSessionId = tool.agent === 'claude';
  }
  if (useArgumentDelivery) {
    initialState.initialInputMode = 'argument';
  }
  if (initialInputFile) {
    initialState.initialInputFile = initialInputFile;
  }
  if (shouldCreateSubmitInitialInput) {
    initialState.initialInputSentAt = new Date().toISOString();
  }

  const createRequest: CreatePanelRequest = {
    sessionId: session.id,
    type: 'terminal',
    title: tool.title,
    initialState,
  };
  if (options.activate === false) {
    createRequest.activate = false;
  }

  const panel = await panelManager.createPanel(createRequest);
  await terminalPanelManager.initializeTerminal(panel, session.worktreePath, wslContext);
  if (!launch) {
    await terminalPanelManager.stageInitialCommand(panel.id, tool.command);
  }

  const readiness = waitReady
    ? toPaneReadiness(await waitForPanel(panel, {
      panelId: panel.id,
      condition: 'ready',
      timeoutMs: options.readyTimeoutMs ?? DEFAULT_PANEL_WAIT_TIMEOUT_MS,
      intervalMs: DEFAULT_PANEL_WAIT_INTERVAL_MS,
    }))
    : undefined;

  const initialInput = readiness ? await submitCreateInitialInput(panel, tool, useArgumentDelivery, readiness, session.worktreePath) : undefined;

  return { panel, readiness, initialInput, promptFile, warnings };
}

async function submitCreateInitialInput(
  panel: ToolPanel,
  tool: RunpaneResolvedTool,
  useArgumentDelivery: boolean,
  readiness: RunpanePaneReadiness | undefined,
  cwd: string | undefined,
): Promise<RunpaneInitialInputDeliveryResult | undefined> {
  if (!tool.initialInput) {
    return undefined;
  }

  if (useArgumentDelivery) {
    const currentPanel = panelManager.getPanel(panel.id);
    const customState = currentPanel && isRecord(currentPanel.state.customState)
      ? currentPanel.state.customState
      : {};
    const sentAt = optionalString(customState.initialInputSentAt);
    const deliveryError = optionalString(customState.initialInputError);
    const delivered = Boolean(sentAt) && !deliveryError;
    const result: RunpaneInitialInputDeliveryResult = {
      delivered,
      submitted: delivered,
      inputBytes: Buffer.byteLength(tool.initialInput, 'utf8'),
      strategy: 'argument',
      sequenceName: 'argument',
      verifiedSubmitted: delivered,
      delivery: delivered
        ? await argumentDelivery(panel, tool, cwd, sentAt)
        : { state: 'unknown', evidence: 'argv' },
      sentAt,
      nextCommand: readiness?.nextCommand ?? panelWaitCommand(panel.id),
    };
    if (!delivered) {
      result.error = {
        message: deliveryError ?? 'Initial input was not attached to the agent launch command.',
      };
    }
    return result;
  }

  if (!tool.agent || !readiness) {
    return undefined;
  }

  if (!readiness.ok) {
    await clearInitialInputSentPremark(panel);
    terminalPanelManager.deliverPendingInitialInput(panel.id);
    return {
      delivered: false,
      submitted: false,
      inputBytes: Buffer.byteLength(tool.initialInput, 'utf8'),
      error: { message: 'The agent is not ready yet, so initial input is queued and sent once it is.' },
      nextCommand: readiness.nextCommand ?? panelWaitCommand(panel.id),
    };
  }

  if (tool.agent !== 'claude' && tool.agent !== 'codex') {
    terminalPanelManager.writeToTerminal(panel.id, tool.initialInput);
    await sleep(300);
    return submitCreateComposerInput(panel, tool, tool.initialInput);
  }
  const staged = await stageComposerText(panel, tool.agent, tool.initialInput);
  return submitCreateComposerInput(panel, tool, staged.evidenceText, composerDeliveryProbe(panel, cwd, tool.agent, tool.initialInput));
}

/**
 * A launch-argument prompt reached the agent with its launch (`argv`); the
 * transcript upgrades that to `transcript` evidence once the agent has
 * recorded the turn. One read, no waiting: create has already waited for ready.
 */
async function argumentDelivery(
  panel: ToolPanel,
  tool: RunpaneResolvedTool,
  cwd: string | undefined,
  sentAt: string | undefined,
): Promise<RunpaneDelivery> {
  const probe = composerDeliveryProbe(panel, cwd, tool.agent, tool.initialInput);
  const sentAtMs = sentAt ? Date.parse(sentAt) : Number.NaN;
  if (probe && !Number.isNaN(sentAtMs)) {
    const check = await checkTranscriptDelivery({ ...probe, sentAtMs });
    if (check.delivery) return check.delivery;
  }
  return { state: 'taken', evidence: 'argv' };
}

async function clearInitialInputSentPremark(panel: ToolPanel): Promise<void> {
  const currentPanel = panelManager.getPanel(panel.id) ?? panel;
  const state = currentPanel.state ?? {};
  const customState = isRecord(state.customState) ? state.customState : {};
  if (!Object.prototype.hasOwnProperty.call(customState, 'initialInputSentAt')) {
    return;
  }

  // Panel state writes merge into the stored row; an explicit undefined removes the key, a delete does not.
  const nextCustomState = { ...customState, initialInputSentAt: undefined };
  await panelManager.updatePanel(panel.id, {
    state: {
      ...state,
      customState: nextCustomState,
    },
  });
}

function shouldUseArgumentDelivery(tool: RunpaneResolvedTool): boolean {
  // A wrapper's own arguments are not the agent's prompt argument.
  return Boolean(
    tool.initialInput &&
    tool.launchMode !== 'wrapped' &&
    (tool.agent === 'claude' ||
      tool.agent === 'cursor' ||
      (tool.agent === 'codex' && !isSlashCommandInput(tool.initialInput))),
  );
}

/**
 * Submit create input already staged in the composer. `evidenceText` is what
 * the composer shows for it: the text, or the agent's paste marker. A retry
 * Enter goes only on stable staged-text evidence, and never once the
 * transcript or the agent's queue hint shows the prompt taken or queued.
 */
async function submitCreateComposerInput(
  panel: ToolPanel,
  tool: RunpaneResolvedTool,
  evidenceText: string,
  probeBase?: Omit<DeliveryProbe, 'sentAtMs'>,
): Promise<RunpaneInitialInputDeliveryResult> {
  const input = tool.initialInput ?? '';
  const submit = resolveComposerSubmit(tool.agent === 'codex' ? 'codex-ctrl-enter' : 'auto', tool.agent);
  const nextCommand = panelScreenCommand(panel.id);
  const probe = probeBase ? { ...probeBase, sentAtMs: Date.now() } : undefined;
  let lastVerdict: ReturnType<typeof assessComposerEvidence> = 'unknown';
  let attempts = 0;
  let transcriptLocated = false;
  const submitted = (delivery: RunpaneDelivery | undefined): RunpaneInitialInputDeliveryResult => ({
    delivered: true,
    submitted: true,
    inputBytes: Buffer.byteLength(input, 'utf8'),
    strategy: submit.strategy,
    sequenceName: submit.sequenceName,
    verifiedSubmitted: true,
    verification: 'observed' as const,
    delivery,
    staged: false,
    attempts,
    sentAt: new Date().toISOString(),
    nextCommand,
  });

  for (let attempt = 1; attempt <= MAX_CREATE_SUBMIT_ATTEMPTS; attempt += 1) {
    attempts = attempt;
    const beforeScreen = await buildPanelScreenResult(panel, DEFAULT_PANEL_SCREEN_LIMIT);
    const outputGenerationBeforeSubmit = terminalPanelManager.getOutputGeneration(panel.id);
    terminalPanelManager.writeToTerminal(panel.id, submit.input);
    const attemptStartedAt = Date.now();
    let retryConfirmed = false;

    while (Date.now() - attemptStartedAt <= DEFAULT_COMPOSER_VERIFY_TIMEOUT_MS) {
      await sleep(DEFAULT_COMPOSER_VERIFY_INTERVAL_MS);
      const afterScreen = await buildPanelScreenResult(panel, DEFAULT_PANEL_SCREEN_LIMIT);
      if (probe) {
        const check = await checkTranscriptDelivery(probe);
        transcriptLocated ||= check.located;
        if (check.delivery) return submitted(check.delivery);
        if (screenShowsQueuedMessage(afterScreen.text, probe.agentType, input)) {
          return submitted({ state: 'queued', evidence: 'screen' });
        }
      }
      lastVerdict = assessComposerEvidence({
        beforeText: beforeScreen.text,
        afterText: afterScreen.text,
        stagedText: evidenceText,
      });

      if (lastVerdict === 'cleared' && panelHasFreshOutputSince(panel.id, outputGenerationBeforeSubmit)) {
        return submitted(probe ? { state: 'taken', evidence: 'screen' } : undefined);
      }

      if (lastVerdict !== 'staged') {
        continue;
      }

      const afterScreenHasFreshOutput = panelHasFreshOutputSince(panel.id, outputGenerationBeforeSubmit);
      if (!afterScreenHasFreshOutput) {
        lastVerdict = 'unknown';
        continue;
      }

      await sleep(CREATE_SUBMIT_CONFIRMATION_DELAY_MS);
      const confirmationScreen = await buildPanelScreenResult(panel, DEFAULT_PANEL_SCREEN_LIMIT);
      const confirmationVerdict = assessComposerEvidence({
        beforeText: beforeScreen.text,
        afterText: confirmationScreen.text,
        stagedText: evidenceText,
      });
      const unchangedSinceFirstSample = assessComposerEvidence({
        beforeText: afterScreen.text,
        afterText: confirmationScreen.text,
        stagedText: evidenceText,
      }) === 'staged';
      const confirmationScreenHasFreshOutput = panelHasFreshOutputSince(panel.id, outputGenerationBeforeSubmit);
      lastVerdict = confirmationVerdict;

      if (confirmationVerdict === 'staged' && unchangedSinceFirstSample && confirmationScreenHasFreshOutput) {
        retryConfirmed = true;
        break;
      }
    }

    if (!retryConfirmed || attempt === MAX_CREATE_SUBMIT_ATTEMPTS) {
      break;
    }
  }

  // Nothing on screen settled it; the transcript gets the rest of the delivery window.
  if (probe && transcriptLocated && lastVerdict !== 'staged') {
    const late = await waitForTranscriptDelivery(probe, TRANSCRIPT_DELIVERY_TIMEOUT_MS - (Date.now() - probe.sentAtMs));
    if (late) return submitted(late);
  }

  return {
    delivered: true,
    submitted: false,
    inputBytes: Buffer.byteLength(input, 'utf8'),
    strategy: submit.strategy,
    sequenceName: submit.sequenceName,
    verifiedSubmitted: false,
    delivery: probe ? { state: lastVerdict === 'staged' ? 'in-composer' : 'unknown', evidence: 'screen' } : undefined,
    staged: lastVerdict === 'staged',
    attempts,
    sentAt: new Date().toISOString(),
    blocked: {
      kind: 'submission_unverified',
      message: `Pane could not verify composer submission after ${attempts} attempt${attempts === 1 ? '' : 's'}; no further submit was sent without stable staged-text evidence.`,
      suggestedCommand: nextCommand,
    },
    nextCommand,
  };
}

function panelHasFreshOutputSince(panelId: string, generation: number): boolean {
  return terminalPanelManager.getOutputGeneration(panelId) > generation;
}

function panelHasOutputWithin(panelId: string, windowMs: number): boolean {
  const lastOutputAt = terminalPanelManager.getLastOutputAt(panelId);
  return lastOutputAt !== undefined && Date.now() - Date.parse(lastOutputAt) < windowMs;
}

async function createPaneItem(
  services: AppServices,
  repo: Project,
  item: RunpanePaneCreateItem,
  index: number,
  options: PaneCreateItemOptions,
): Promise<RunpanePaneCreateResultItem> {
  const { sessionManager, taskQueue } = services;
  if (!taskQueue) {
    throw new Error('Task queue not initialized');
  }

  const tool = resolveToolSpec(item.tool, new PathResolver(repo).environment);

  let createdSessionId: string | undefined;
  let createdWorktreePath: string | undefined;

  try {
    // Checked again under the creation lock; this early check keeps a bad or
    // taken branch name from reaching the queue and its failure toast.
    await validateRequestedBranch(services, repo, item.branch);
    const sessionResult = await taskQueue.createSessionAndWait({
      prompt: item.sessionPrompt ?? '',
      worktreeTemplate: item.worktreeName ?? item.name,
      projectId: repo.id,
      baseBranch: item.baseBranch,
      branchName: item.branch,
      toolType: 'none',
      startPinned: item.pinned,
      activateOnCreate: options.activate !== false,
    }, {
      timeoutMs: options.timeoutMs,
      onSessionCreated: (sessionId) => { createdSessionId = sessionId; },
    });

    createdSessionId = sessionResult.sessionId;

    const session = sessionManager.getSession(sessionResult.sessionId);
    if (!session) {
      throw new Error(`Created session ${sessionResult.sessionId} was not found`);
    }
    createdWorktreePath = session.worktreePath;
    const association = await associateCreatedPane(services, options.associateSession, session.id);

    const { panel, readiness, initialInput, promptFile, warnings } = await createTerminalPanelForSession(services, session, tool, {
      activate: options.activate,
      waitReady: options.waitReady,
      readyTimeoutMs: options.readyTimeoutMs,
    });

    const itemOk = Boolean((!readiness || readiness.ok) && (!initialInput || initialInput.submitted));
    return {
      ok: itemOk,
      index,
      name: item.name,
      pinned: Boolean(session.isFavorite),
      sessionId: session.id,
      paneId: session.id,
      panelId: panel.id,
      worktreePath: session.worktreePath,
      nextCommand: initialInput?.nextCommand ?? readiness?.nextCommand ?? panelOutputCommand(panel.id),
      tool: describeTool(tool),
      active: Boolean(panel.state.isActive),
      focused: Boolean(panel.state.isActive),
      readiness,
      initialInput,
      association,
      promptFile,
      warnings,
    };
  } catch (error) {
    return createFailureItem(index, item, error, createdSessionId, createdWorktreePath);
  }
}

async function validateRequestedBranch(services: AppServices, repo: Project, branch: string | undefined): Promise<void> {
  if (branch === undefined) return;
  const context = services.sessionManager.getProjectContextByProjectId(repo.id);
  if (!context) throw new Error(`Project context is unavailable for ${repo.name}`);
  await assertNewBranchName(repo.path, branch, context.commandRunner);
}

function isPaneCreateItemSuccessful(item: RunpanePaneCreateResultItem): boolean {
  return item.ok && (!item.readiness || item.readiness.ok) && (!('initialInput' in item) || !item.initialInput || item.initialInput.submitted);
}

function resolvePaneCreateActivation(
  request: RunpanePaneCreateRequest,
  item: RunpanePaneCreateItem,
): boolean {
  if (request.focus === true) {
    return true;
  }
  if (request.noFocus === true || request.source === 'agent') {
    return false;
  }
  return !('agent' in item.tool);
}

function resolvePanelCreateActivation(
  request: RunpanePanelCreateRequest,
  tool: RunpaneResolvedTool,
): boolean {
  if (request.focus === true) {
    return true;
  }
  if (request.noFocus === true || request.source === 'agent') {
    return false;
  }
  return !tool.agent;
}

function toPaneReadiness(result: RunpanePanelWaitResult): RunpanePaneReadiness {
  return {
    ok: result.ok,
    condition: result.condition,
    matched: result.matched,
    timedOut: result.timedOut,
    elapsedMs: result.elapsedMs,
    state: result.state,
    blocked: result.blocked,
    nextCommand: result.nextCommand,
  };
}

async function mapSequentially<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  for (let index = 0; index < items.length; index++) {
    results[index] = await worker(items[index], index);
  }

  return results;
}

function resolveTerminalPanel(panelId: string): ToolPanel {
  const panel = resolvePanel(panelId);
  if (panel.type !== 'terminal') {
    throw new Error(`Panel ${panel.id} is a ${panel.type} panel, not a terminal panel`);
  }
  return panel;
}

async function buildPanelScreenResult(panel: ToolPanel, limit: number): Promise<RunpanePanelScreenResult> {
  await terminalPanelManager.waitForTerminalState(panel.id);
  const liveSnapshot = terminalPanelManager.getTerminalSnapshot(panel.id);
  const customState = getTerminalCustomState(panel);
  const state = panelStateSummary(panel, liveSnapshot, customState);
  const persisted = liveSnapshot ? null : panelDatabase.getPanelBuffers(panel.id);
  const { source, rawText } = selectPanelScreenText(liveSnapshot, customState, persisted);
  const bounded = boundSanitizedLines(rawText, limit);
  // A wrapper agent Pane has not confirmed yet is still read by its screen signature.
  const composerAgentType = state.agentType ?? detectAgentFromScreen(bounded.text);
  // The live viewport split into typed and ghost (placeholder, suggestion) cells.
  const composer = detectAgentComposer(bounded.text, composerAgentType, liveSnapshot
    ? {
      typedText: terminalPanelManager.getInputScreenText(panel.id),
      ghostText: terminalPanelManager.getGhostScreenText(panel.id),
    }
    : {});

  return {
    ok: true,
    panelId: panel.id,
    paneId: panel.sessionId,
    source,
    limit,
    returnedLineCount: bounded.returnedLineCount,
    hasMore: bounded.hasMore,
    text: bounded.text,
    state,
    composer,
    nextCommand: bounded.hasMore ? panelOutputCommand(panel.id) : panelWaitCommand(panel.id),
  };
}

interface PanelScreenText {
  source: RunpanePanelScreenSource;
  rawText: string;
}

function selectPanelScreenText(
  snapshot: TerminalPanelSnapshot | null,
  customState: TerminalPanelState,
  persisted: PanelBuffers | null,
): PanelScreenText {
  if (snapshot) {
    if (snapshot.screenText !== undefined) {
      return {
        source: snapshot.isAlternateScreen ? 'alternateScreen' : 'scrollback',
        rawText: snapshot.screenText,
      };
    }
    if (snapshot.isAlternateScreen && snapshot.alternateScreenBuffer) {
      return { source: 'alternateScreen', rawText: snapshot.alternateScreenBuffer };
    }
    if (snapshot.scrollbackBuffer) {
      return { source: 'scrollback', rawText: snapshot.scrollbackBuffer };
    }
    return { source: 'empty', rawText: '' };
  }

  const persistedAlternate = persisted?.alternate;
  if (customState.isAlternateScreen && persistedAlternate) {
    return { source: 'persistedOutput', rawText: persistedAlternate };
  }

  const persistedScrollback = persisted?.scrollback;
  if (persistedScrollback) {
    return { source: 'persistedOutput', rawText: persistedScrollback };
  }

  return { source: 'empty', rawText: '' };
}

function panelStateSummary(
  panel: ToolPanel,
  snapshot: TerminalPanelSnapshot | null,
  customState: TerminalPanelState = getTerminalCustomState(panel),
): RunpanePanelStateSummary {
  const customAgentType = optionalAgentId(customState.agentType);
  const hasLiveTerminal = Boolean(snapshot || terminalPanelManager.isTerminalInitialized(panel.id));

  return {
    initialized: hasLiveTerminal,
    isAlternateScreen: snapshot?.isAlternateScreen ?? customState.isAlternateScreen,
    activityStatus: snapshot?.activityStatus,
    isCliReady: snapshot?.isCliReady ?? (hasLiveTerminal ? customState.isCliReady : undefined),
    isCliPanel: snapshot?.isCliPanel ?? customState.isCliPanel,
    agentType: snapshot?.agentType ?? customAgentType,
    lastActivity: snapshot?.lastActivityTime ?? customState.lastActivityTime ?? toIsoString(panel.metadata.lastActiveAt),
  };
}

function getTerminalCustomState(panel: ToolPanel): TerminalPanelState {
  try {
    return decodeBoundary(panel.state.customState, boundary.object({
      isAlternateScreen: boundary.optional(boundary.boolean),
      agentType: boundary.optional(boundary.enumeration(...RUNPANE_CONTRACT.enums.agents)),
      isCliReady: boundary.optional(boundary.boolean),
      isCliPanel: boundary.optional(boundary.boolean),
      lastActivityTime: boundary.optional(boundary.string),
    }));
  } catch {
    return {};
  }
}

interface BoundedSanitizedLines {
  text: string;
  hasMore: boolean;
  returnedLineCount: number;
}

function boundSanitizedLines(rawText: string, limit: number): BoundedSanitizedLines {
  const stripped = sanitizeTerminalOutput(rawText);
  if (!stripped) {
    return { text: '', hasMore: false, returnedLineCount: 0 };
  }

  const allLines = stripped.split('\n');
  const hasMore = allLines.length > limit;
  const lines = hasMore ? allLines.slice(-limit) : allLines;
  return {
    text: lines.join('\n'),
    hasMore,
    returnedLineCount: lines.length,
  };
}

async function waitForPanel(panel: ToolPanel, request: RunpanePanelWaitRequest): Promise<RunpanePanelWaitResult> {
  const startedAt = Date.now();
  const timeoutMs = request.timeoutMs ?? DEFAULT_PANEL_WAIT_TIMEOUT_MS;
  const intervalMs = request.intervalMs ?? DEFAULT_PANEL_WAIT_INTERVAL_MS;
  let lastScreen = await buildPanelScreenResult(panel, DEFAULT_PANEL_SCREEN_LIMIT);
  let condition = request.condition ?? defaultWaitCondition(lastScreen.state);
  let requiresFirstEvaluation = true;

  while (requiresFirstEvaluation || Date.now() - startedAt <= timeoutMs) {
    requiresFirstEvaluation = false;
    lastScreen = await buildPanelScreenResult(panel, DEFAULT_PANEL_SCREEN_LIMIT);
    condition = request.condition ?? defaultWaitCondition(lastScreen.state);
    const blocked = detectPanelBlocker(lastScreen.text, lastScreen.state.agentType, panel.id);
    const matched = isWaitConditionMatched(condition, lastScreen, request.contains, blocked);

    if (matched) {
      return panelWaitResult(panel, condition, true, false, startedAt, lastScreen);
    }
    if (blocked && condition !== 'text') {
      return panelWaitResult(panel, condition, false, false, startedAt, lastScreen, blocked);
    }

    await sleep(Math.min(intervalMs, Math.max(timeoutMs - (Date.now() - startedAt), 0)));
  }

  return panelWaitResult(panel, condition, false, true, startedAt, lastScreen);
}

function defaultWaitCondition(state: RunpanePanelStateSummary): RunpanePanelWaitCondition {
  return state.isCliPanel ? 'ready' : 'idle';
}

function isWaitConditionMatched(
  condition: RunpanePanelWaitCondition,
  screen: RunpanePanelScreenResult,
  contains: string | undefined,
  blocked?: RunpanePanelBlockedState,
): boolean {
  switch (condition) {
    case 'initialized':
      return screen.state.initialized;
    case 'ready':
      if (blocked || !screen.state.initialized) return false;
      if (!screen.state.isCliPanel) return true;
      // Claude and Codex are ready once their composer is on screen, not at their first output.
      return screen.state.isCliReady === true
        && (screen.composer.isPresent || (screen.state.agentType !== 'claude' && screen.state.agentType !== 'codex'));
    case 'idle':
      return screen.state.initialized && screen.state.activityStatus === 'idle';
    case 'text':
      return Boolean(contains && screen.text.includes(contains));
  }
}

function panelWaitResult(
  panel: ToolPanel,
  condition: RunpanePanelWaitCondition,
  matched: boolean,
  timedOut: boolean,
  startedAt: number,
  screen: RunpanePanelScreenResult,
  blocked?: RunpanePanelBlockedState,
): RunpanePanelWaitResult {
  return {
    ok: matched && !timedOut && !blocked,
    panelId: panel.id,
    paneId: panel.sessionId,
    condition,
    matched,
    timedOut,
    elapsedMs: Date.now() - startedAt,
    state: screen.state,
    blocked,
    screen: {
      source: screen.source,
      text: screen.text,
      hasMore: screen.hasMore,
    },
    nextCommand: blocked?.suggestedCommand ?? (matched ? panelScreenCommand(panel.id) : panelWaitCommand(panel.id, condition)),
  };
}

function detectPanelBlocker(
  text: string,
  agentType: RunpaneAgentId | undefined,
  panelId: string,
): RunpanePanelBlockedState | undefined {
  if (!text) return undefined;

  if (
    (agentType === 'codex' || /codex/i.test(text)) &&
    /update available/i.test(text) &&
    (/skip/i.test(text) || /npm install -g @openai\/codex/i.test(text))
  ) {
    return {
      kind: 'codex-update',
      message: 'Codex is showing an update prompt instead of accepting the task prompt.',
      suggestedCommand: `runpane panels submit --panel ${panelId} --text "2" --yes --json`,
    };
  }

  // Scan the current screen as well as reading the published status, which lags it by up to one poll.
  const screenBlocked = detectAgentState(getManifestForAgent(agentType), { screen: text, oscTitle: '', oscProgress: '' })
    .state === 'blocked';
  if (/press enter to continue/i.test(text) || screenBlocked || terminalPanelManager.getAgentStatus(panelId) === 'blocked') {
    return {
      kind: 'agent-prompt',
      message: 'The terminal is waiting at an interactive prompt.',
      suggestedCommand: panelScreenCommand(panelId),
    };
  }

  return undefined;
}

function ensureSubmitEnter(input: string): string {
  if (input.endsWith('\r\n')) {
    return `${input.slice(0, -2)}\r`;
  }
  if (input.endsWith('\r')) {
    return input;
  }
  if (input.endsWith('\n')) {
    return `${input.slice(0, -1)}\r`;
  }
  return `${input}\r`;
}

interface ComposerSubmit {
  strategy: 'codex-ctrl-enter' | 'enter' | 'tab';
  sequenceName: RunpanePanelSubmitComposerResult['sequenceName'];
  input: string;
}

function resolveComposerSubmit(
  strategy: RunpanePanelSubmitComposerStrategy | undefined,
  agentType: RunpaneAgentId | undefined,
  activityStatus?: string,
): ComposerSubmit {
  if (strategy === 'tab' || ((!strategy || strategy === 'auto') && agentType === 'codex' && activityStatus === 'active')) {
    return { strategy: 'tab', sequenceName: 'tab', input: '\t' };
  }
  if (strategy === 'codex-ctrl-enter') {
    return {
      strategy: 'codex-ctrl-enter',
      sequenceName: 'codex-ctrl-enter-cr',
      input: '\x1b[13;5u\r',
    };
  }

  return {
    strategy: 'enter',
    sequenceName: 'enter-cr',
    input: '\r',
  };
}

/**
 * Press the composer's submit sequence and report where the prompt went.
 * `delivery` names the submitted text for the transcript check; without it,
 * any turn the agent takes after Enter counts (submit-composer does not know
 * what the composer holds).
 */
async function submitComposerForPanel(
  panel: ToolPanel,
  strategy: RunpanePanelSubmitComposerStrategy | undefined,
  delivery: { cwd: string | undefined; text?: string },
): Promise<RunpanePanelSubmitComposerResult> {
  const beforeScreen = await buildPanelScreenResult(panel, DEFAULT_PANEL_SCREEN_LIMIT);
  const agentType = screenAgentType(beforeScreen);
  let submit = resolveComposerSubmit(strategy, agentType, beforeScreen.state.activityStatus);
  const probeBase = composerDeliveryProbe(panel, delivery.cwd, agentType, delivery.text);
  const probe = probeBase ? { ...probeBase, sentAtMs: Date.now() } : undefined;
  const outputGenerationBeforeSubmit = terminalPanelManager.getOutputGeneration(panel.id);
  terminalPanelManager.writeToTerminal(panel.id, submit.input);
  let inputBytes = Buffer.byteLength(submit.input, 'utf8');
  let verification = await verifyComposerSubmitted(panel, beforeScreen, outputGenerationBeforeSubmit, probe);

  // The staged text still sitting in the composer proves the first submit was
  // not taken (an agent mid-paste or busy can drop it). Retry once using the
  // current activity state; a busy Codex must still queue with Tab.
  if ((strategy ?? 'auto') === 'auto' && verification.stagedTextVisible) {
    const outputGenerationBeforeRetry = terminalPanelManager.getOutputGeneration(panel.id);
    submit = resolveComposerSubmit('auto', agentType, verification.latestScreen.state.activityStatus);
    terminalPanelManager.writeToTerminal(panel.id, submit.input);
    inputBytes += Buffer.byteLength(submit.input, 'utf8');
    verification = await verifyComposerSubmitted(panel, verification.latestScreen, outputGenerationBeforeRetry, probe);
  }

  return {
    ok: verification.ok,
    panelId: panel.id,
    paneId: panel.sessionId,
    inputBytes,
    strategy: submit.strategy,
    sequenceName: submit.sequenceName,
    verifiedSubmitted: verification.verifiedSubmitted,
    verification: verification.verification,
    delivery: verification.delivery,
    sentAt: new Date().toISOString(),
    blocked: verification.blocked,
    nextCommand: verification.blocked?.suggestedCommand ?? panelWaitCommand(panel.id),
  };
}

async function waitForPanelScreen(
  panel: ToolPanel,
  isReady: (screen: RunpanePanelScreenResult) => boolean,
  timeoutMs = CLAUDE_INPUT_WAIT_TIMEOUT_MS,
): Promise<RunpanePanelScreenResult> {
  const startedAt = Date.now();
  let screen = await buildPanelScreenResult(panel, DEFAULT_PANEL_SCREEN_LIMIT);
  while (!isReady(screen) && Date.now() - startedAt < timeoutMs) {
    await sleep(DEFAULT_COMPOSER_VERIFY_INTERVAL_MS);
    screen = await buildPanelScreenResult(panel, DEFAULT_PANEL_SCREEN_LIMIT);
  }
  return screen;
}

interface StagedComposerText {
  inputBytes: number;
  /** What the composer shows for the staged text: the agent's paste marker, or the text. */
  evidenceText: string;
}

/**
 * Type text into a Claude or Codex composer and wait until it has landed, so
 * the caller's Enter goes as its own write. Long or multi-line text goes as
 * one bracketed paste (when the agent turned bracketed paste on): newlines
 * stay text, and Enter waits for the paste marker or the text, then for the
 * agent to stop drawing (bounded).
 */
async function stageComposerText(
  panel: ToolPanel,
  agentType: 'claude' | 'codex',
  text: string,
): Promise<StagedComposerText> {
  const pasted = isLongPrompt(text) && terminalPanelManager.isBracketedPasteEnabled(panel.id);
  const payload = pasted ? bracketedPaste(text) : text;
  // A short Codex stage waits a fixed delay and reads no output.
  const watchesEcho = agentType === 'claude' || pasted;
  const outputGenerationBeforeStage = watchesEcho ? terminalPanelManager.getOutputGeneration(panel.id) : 0;
  terminalPanelManager.writeToTerminal(panel.id, payload);
  const landed = (screen: RunpanePanelScreenResult) =>
    screen.composer.hasUndeliveredText && panelHasFreshOutputSince(panel.id, outputGenerationBeforeStage);

  let screen: RunpanePanelScreenResult | undefined;
  if (agentType === 'claude') {
    screen = await waitForPanelScreen(panel, landed);
  } else {
    await sleep(CODEX_SUBMIT_STAGE_DELAY_MS);
    if (pasted) screen = await waitForPanelScreen(panel, landed, CODEX_PASTE_ECHO_TIMEOUT_MS);
  }
  if (pasted) {
    await waitForPanelOutputQuiet(panel.id);
    screen = await buildPanelScreenResult(panel, DEFAULT_PANEL_SCREEN_LIMIT);
  }

  return {
    inputBytes: Buffer.byteLength(payload, 'utf8'),
    evidenceText: (pasted && screen ? composerEvidenceText(screen.text) : '') || text,
  };
}

/** Wait until the panel has drawn nothing for a short window, bounded. */
async function waitForPanelOutputQuiet(panelId: string): Promise<void> {
  const startedAt = Date.now();
  while (panelHasOutputWithin(panelId, PASTE_SETTLE_QUIET_MS) && Date.now() - startedAt < PASTE_SETTLE_MAX_MS) {
    await sleep(DEFAULT_COMPOSER_VERIFY_INTERVAL_MS);
  }
}

/**
 * What a composer submit is checked against: the agent's transcript (when
 * Pane can find it) and its queued-message hint on screen.
 */
interface DeliveryProbe {
  agentType: 'claude' | 'codex';
  locator?: TranscriptLocator;
  /** The submitted text; undefined when Pane could not read it, and any turn taken since `sentAtMs` counts. */
  text?: string;
  /** When Pane pressed Enter. */
  sentAtMs: number;
}

interface TranscriptCheck {
  delivery?: RunpaneDelivery;
  /** Whether the panel's transcript exists, so waiting on it can pay off. */
  located: boolean;
}

async function checkTranscriptDelivery(probe: DeliveryProbe): Promise<TranscriptCheck> {
  if (!probe.locator) return { located: false };
  try {
    const lookup = await agentTranscripts.findUserTurnSince(probe.locator, probe.sentAtMs, probe.text);
    return {
      delivery: lookup.state ? { state: lookup.state, evidence: 'transcript' } : undefined,
      located: lookup.file !== undefined,
    };
  } catch {
    return { located: false };
  }
}

/** Poll the transcript until it shows the turn taken or queued, or `timeoutMs` passes. */
async function waitForTranscriptDelivery(probe: DeliveryProbe, timeoutMs: number): Promise<RunpaneDelivery | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(TRANSCRIPT_POLL_INTERVAL_MS);
    const check = await checkTranscriptDelivery(probe);
    if (check.delivery) return check.delivery;
  }
  return undefined;
}

/** Where the panel's agent writes its transcript; undefined for other panels or a Pane with no worktree. */
function panelTranscriptLocator(
  panel: ToolPanel,
  cwd: string | undefined,
  agentType: RunpaneAgentId | undefined,
): TranscriptLocator | undefined {
  if (!cwd || (agentType !== 'claude' && agentType !== 'codex')) return undefined;
  const current = panelManager.getPanel(panel.id) ?? panel;
  const customState = isRecord(current.state?.customState) ? current.state.customState : {};
  const createdAt = Date.parse(panel.metadata?.createdAt ?? '');
  return {
    agent: agentType,
    cwd,
    sessionId: optionalString(customState.agentSessionId),
    notBeforeMs: Number.isNaN(createdAt) ? undefined : createdAt,
  };
}

/** A delivery probe for a Claude or Codex composer; other panels have none. */
function composerDeliveryProbe(
  panel: ToolPanel,
  cwd: string | undefined,
  agentType: RunpaneAgentId | undefined,
  text: string | undefined,
): Omit<DeliveryProbe, 'sentAtMs'> | undefined {
  if (agentType !== 'claude' && agentType !== 'codex') return undefined;
  return { agentType, locator: panelTranscriptLocator(panel, cwd, agentType), text };
}

/**
 * After Enter, learn where the prompt went. The transcript is read on every
 * poll and settles it (taken or queued); so does the agent's queued-message
 * hint on screen. Otherwise the screen decides: a steadily empty composer is
 * `taken`, text still in it is `in-composer`, and anything else waits on the
 * transcript for the rest of TRANSCRIPT_DELIVERY_TIMEOUT_MS before `unknown`.
 */
async function verifyComposerSubmitted(
  panel: ToolPanel,
  beforeScreen: RunpanePanelScreenResult,
  outputGenerationBeforeSubmit: number,
  probe?: DeliveryProbe,
): Promise<ComposerVerification> {
  const beforeHadComposerPrompt = beforeScreen.composer.hasUndeliveredText || looksLikePendingComposer(beforeScreen.text);
  if (!beforeHadComposerPrompt && !beforeScreen.text.trim() && !probe) {
    return { ok: true, verifiedSubmitted: false, latestScreen: beforeScreen, stagedTextVisible: false };
  }
  const agentType = screenAgentType(beforeScreen);
  const stagedText = composerEvidenceText(beforeScreen.text);
  let latestScreen = beforeScreen;
  let previousPollShowedEmptyComposer = false;
  let transcriptLocated = false;
  let clearedOnScreen = false;
  const startedAt = Date.now();
  const delivered = (delivery: RunpaneDelivery): ComposerVerification => ({
    ok: true,
    verifiedSubmitted: true,
    verification: 'observed',
    latestScreen,
    stagedTextVisible: false,
    delivery,
  });

  while (!clearedOnScreen && Date.now() - startedAt <= DEFAULT_COMPOSER_VERIFY_TIMEOUT_MS) {
    await sleep(DEFAULT_COMPOSER_VERIFY_INTERVAL_MS);
    latestScreen = await buildPanelScreenResult(panel, DEFAULT_PANEL_SCREEN_LIMIT);

    if (probe) {
      const check = await checkTranscriptDelivery(probe);
      transcriptLocated ||= check.located;
      if (check.delivery) return delivered(check.delivery);
      if (probe.text && screenShowsQueuedMessage(latestScreen.text, probe.agentType, probe.text)) {
        return delivered({ state: 'queued', evidence: 'screen' });
      }
    }

    // Claude always draws its composer box, and repaints (at startup, say)
    // briefly show neither the box nor the prompt; only a steady empty box
    // proves the prompt left it.
    if (agentType === 'claude') {
      const showsEmptyComposer = latestScreen.composer.isPresent && !latestScreen.composer.hasUndeliveredText;
      clearedOnScreen = beforeHadComposerPrompt && showsEmptyComposer && previousPollShowedEmptyComposer;
      previousPollShowedEmptyComposer = showsEmptyComposer;
      continue;
    }

    const verdict = assessComposerEvidence({
      beforeText: beforeScreen.text,
      afterText: latestScreen.text,
      stagedText,
    });
    clearedOnScreen = (verdict === 'cleared' && !latestScreen.composer.hasUndeliveredText && panelHasFreshOutputSince(panel.id, outputGenerationBeforeSubmit)) ||
      (beforeHadComposerPrompt && !latestScreen.composer.hasUndeliveredText && !looksLikePendingComposer(latestScreen.text));
  }

  if (clearedOnScreen) {
    // The composer emptied; the transcript, once written, says whether the agent took the turn or queued it.
    const confirmed = probe && transcriptLocated
      ? await waitForTranscriptDelivery(probe, TRANSCRIPT_CONFIRM_MS)
      : undefined;
    return delivered(confirmed ?? { state: 'taken', evidence: 'screen' });
  }

  // Claude can take longer to echo staged text than Pane waits, so a held
  // composer after Enter fails even when the earlier screen never showed it.
  const checksHeldComposer = beforeHadComposerPrompt || beforeScreen.state.agentType === 'claude';
  if (checksHeldComposer && (latestScreen.composer.hasUndeliveredText || looksLikePendingComposer(latestScreen.text))) {
    return {
      ok: false,
      verifiedSubmitted: false,
      verification: panelHasFreshOutputSince(panel.id, outputGenerationBeforeSubmit) ? 'unverifiable' : undefined,
      blocked: {
        kind: 'agent-prompt',
        message: 'Pane sent the composer submit sequence, but the prompt still appears to be sitting in the composer.',
        suggestedCommand: latestScreen.state.agentType === 'codex'
          ? `runpane panels input --panel ${panel.id} --keys ${latestScreen.state.activityStatus === 'active' ? 'tab' : 'enter'} --yes --json`
          : panelScreenCommand(panel.id),
      },
      latestScreen,
      stagedTextVisible: latestScreen.composer.hasUndeliveredText,
      delivery: probe ? { state: 'in-composer', evidence: 'screen' } : undefined,
    };
  }

  if (probe && transcriptLocated) {
    const late = await waitForTranscriptDelivery(probe, TRANSCRIPT_DELIVERY_TIMEOUT_MS - (Date.now() - startedAt));
    if (late) return delivered(late);
  }
  const unknown: RunpaneDelivery | undefined = probe ? { state: 'unknown', evidence: 'screen' } : undefined;
  if (panelHasFreshOutputSince(panel.id, outputGenerationBeforeSubmit)) {
    return { ok: true, verifiedSubmitted: false, verification: 'unverifiable', latestScreen, stagedTextVisible: false, delivery: unknown };
  }

  return { ok: true, verifiedSubmitted: false, latestScreen, stagedTextVisible: false, delivery: unknown };
}

interface ComposerVerification {
  ok: boolean;
  /** The agent took or queued the prompt. */
  verifiedSubmitted: boolean;
  verification?: 'observed' | 'unverifiable';
  blocked?: RunpanePanelBlockedState;
  latestScreen: RunpanePanelScreenResult;
  /** The composer still shows held text, so the submit was not taken. */
  stagedTextVisible: boolean;
  /** Present when the submit had a delivery probe (a Claude or Codex composer). */
  delivery?: RunpaneDelivery;
}

/** The panel's agent, or the agent its screen shows before Pane has confirmed it. */
function screenAgentType(screen: RunpanePanelScreenResult): RunpaneAgentId | undefined {
  return screen.state.agentType ?? detectAgentFromScreen(screen.text);
}

/**
 * A Claude or Codex panel with no composer on screen: typed text could land
 * anywhere, so submit reports it rather than writing blind. Claude's quiet
 * full-screen menus and Pane's own shell prompt (the agent has exited) keep
 * the plain write.
 */
function isComposerUnknown(
  panel: ToolPanel,
  screen: RunpanePanelScreenResult,
  agentType: RunpaneAgentId | undefined,
): boolean {
  if (agentType !== 'claude' && agentType !== 'codex') return false;
  if (screen.composer.isPresent) return false;
  if (agentType === 'claude' && screen.state.isAlternateScreen === true && !panelHasOutputWithin(panel.id, CLAUDE_UI_QUIET_MS)) {
    return false;
  }
  return terminalPanelManager.getForegroundProcess(panel.id)?.isShell !== true;
}

function composerEvidenceText(text: string): string {
  const lines = text.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index].trim().match(/^[>›❯▌]\s*(.+)$/u);
    if (match?.[1]) return match[1];
  }
  const pasted = text.match(/\[Pasted (?:Content|text)[^\]]*\]/iu);
  return pasted?.[0] ?? '';
}

// GUI-launched Electron PATHs typically miss ~/.local/bin, cursor-agent's install target.
const AGENT_FALLBACK_BIN_PATHS = {
  cursor: ['$HOME/.local/bin/cursor-agent'],
} satisfies Partial<Record<RunpaneAgentId, readonly string[]>>;

async function runAgentDoctor(
  services: AppServices,
  repo: Project,
  agent: RunpaneAgentId,
): Promise<RunpaneAgentDoctorResult> {
  const context = services.sessionManager.getProjectContextByProjectId(repo.id);
  const repoSummary = projectToRepoSummary(repo, services.sessionManager.getSessionsForProject(repo.id).length);
  const environment = new PathResolver(repo).environment;
  const command = AGENT_TEMPLATES[agent].command;
  const executable = agentCommandExecutable(command);
  const checks: RunpaneAgentDoctorResult['checks'] = [];
  const warnings: string[] = [];

  if (!isAgentSupportedOnPlatform(agent, environment)) {
    checks.push({
      name: 'platform',
      ok: false,
      message: `${AGENT_TEMPLATES[agent].title} is not supported on ${environment} repos.`,
    });
    return {
      ok: false,
      agent,
      command,
      repo: repoSummary,
      environment,
      available: false,
      checks,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  if (!context) {
    checks.push({
      name: 'repo-context',
      ok: false,
      message: `Could not create Pane execution context for repo ${repo.id}.`,
    });
    return {
      ok: false,
      agent,
      command,
      repo: repoSummary,
      environment,
      available: false,
      checks,
      warnings,
    };
  }

  const lookupCommand = environment === 'windows' ? `where ${executable}` : `command -v ${executable}`;
  let executablePath: string | undefined;
  let version: string | undefined;
  let versionCommand = `${executable} --version`;

  try {
    const result = await context.commandRunner.execAsync(lookupCommand, repo.path, {
      timeout: 5_000,
      silent: true,
    });
    executablePath = firstNonEmptyLine(result.stdout);
    checks.push({
      name: 'executable',
      ok: Boolean(executablePath),
      message: executablePath ? `Found ${executable} at ${executablePath}.` : `${executable} was not found on PATH.`,
    });
  } catch (error) {
    checks.push({
      name: 'executable',
      ok: false,
      message: commandErrorMessage(error, `${executable} was not found on PATH.`),
    });
  }

  if (!executablePath && environment !== 'windows') {
    const fallbackPaths = agent === 'cursor' ? AGENT_FALLBACK_BIN_PATHS.cursor : [];
    for (const fallback of fallbackPaths) {
      try {
        const result = await context.commandRunner.execAsync(`command -v "${fallback}"`, repo.path, {
          timeout: 5_000,
          silent: true,
        });
        const fallbackPath = firstNonEmptyLine(result.stdout);
        if (fallbackPath) {
          executablePath = fallbackPath;
          versionCommand = `"${fallback}" --version`;
          checks.push({
            name: 'executable-fallback',
            ok: true,
            message: `Found ${executable} at ${fallbackPath}.`,
          });
          warnings.push(`${executable} is installed at ${fallbackPath} but not on PATH; GUI-launched apps may not see it.`);
          break;
        }
      } catch {
        // Fallback probes are best-effort; the PATH check already reported the miss.
      }
    }
  }

  if (executablePath) {
    try {
      const result = await context.commandRunner.execAsync(versionCommand, repo.path, {
        timeout: 5_000,
        silent: true,
      });
      version = firstNonEmptyLine(result.stdout) || firstNonEmptyLine(result.stderr);
      checks.push({
        name: 'version',
        ok: Boolean(version),
        message: version ? version : `${executable} did not print a version.`,
      });
    } catch (error) {
      warnings.push(commandErrorMessage(error, `${executable} --version failed.`));
      checks.push({
        name: 'version',
        ok: false,
        message: `${executable} is on PATH, but --version failed.`,
      });
    }
  }

  if (environment === 'wsl' && !executablePath) {
    warnings.push(`Repo ${repo.name} is a WSL repo; install ${executable} inside the WSL distro Pane uses, not only on Windows.`);
  }

  const available = Boolean(executablePath);
  return {
    ok: available,
    agent,
    command,
    repo: repoSummary,
    environment,
    available,
    executablePath,
    version,
    checks,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

function outputToRecord(output: SessionOutput): RunpanePanelOutputRecord {
  return {
    type: output.type,
    data: output.data,
    timestamp: requireIsoString(output.timestamp, 'Panel output timestamp'),
  };
}

function outputToText(output: SessionOutput): string {
  try {
    return decodeBoundary(output.data, boundary.string);
  } catch {
    // Non-string output is serialized below.
  }

  try {
    return `${JSON.stringify(output.data)}\n`;
  } catch {
    return `${String(output.data)}\n`;
  }
}

async function panelScrollbackOutput(panel: ToolPanel, limit: number): Promise<{ text: string; hasMore: boolean; timestamp: string } | null> {
  const timestamp = toIsoString(panel.metadata.lastActiveAt) ?? new Date().toISOString();

  // Ask for one extra rendered line so hasMore reflects emulator truncation.
  let text = await terminalPanelManager.getCleanTerminalScrollback(panel.id, limit + 1);
  if (text === null) {
    const persistedScrollback = panelDatabase.getPanelBuffers(panel.id)?.scrollback;
    if (!persistedScrollback) return null;
    text = sanitizeTerminalOutput(persistedScrollback);
  }
  if (!text) return null;

  const allLines = text.split('\n');
  const hasMore = allLines.length > limit;
  return { text: allLines.slice(-limit).join('\n'), hasMore, timestamp };
}

function panelOutputCommand(panelId: string): string {
  return `runpane panels output --panel ${panelId} --limit ${DEFAULT_PANEL_OUTPUT_LIMIT} --json`;
}

function panelScreenCommand(panelId: string): string {
  return `runpane panels screen --panel ${panelId} --limit ${DEFAULT_PANEL_SCREEN_LIMIT} --json`;
}

function panelWaitCommand(panelId: string, condition: RunpanePanelWaitCondition = 'ready'): string {
  return `runpane panels wait --panel ${panelId} --for ${condition} --timeout-ms ${DEFAULT_PANEL_WAIT_TIMEOUT_MS} --json`;
}

function parsePaneListRequest(value: PaneCommandValue): RunpanePaneListRequest {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error('Pane list request must be an object');
  }
  if (value.repo === undefined || value.repo === null || value.repo === '') {
    return {};
  }

  return {
    repo: parseRepoSelector(value.repo),
  };
}

function createNamedLockService(services: AppServices): NamedLockService {
  return new NamedLockService(new NamedLockStore(path.join(getAppDirectory(), 'locks.json')), {
    isOwnerLive: owner => isLockOwnerLive(services, owner),
    log: (message, error) => console.warn(message, error),
  });
}

/** A Pane owner is live while its Pane exists unarchived and, when named, its panel still exists. */
export function isLockOwnerLive(services: Pick<AppServices, 'sessionManager'>, owner: RunpaneLockOwner): boolean {
  if (owner.kind !== 'pane' || !owner.paneId) return true;
  const pane = services.sessionManager.getSession(owner.paneId);
  if (!pane || pane.archived) return false;
  return !owner.panelId || panelManager.getPanel(owner.panelId)?.sessionId === owner.paneId;
}

/**
 * Resolve who is calling. A Pane caller (from PANE_SESSION_ID/PANE_PANEL_ID or
 * --pane/--panel) owns the lock and scopes it to its Session when it has one;
 * a caller outside Pane is an external owner named by its --note.
 */
async function resolveLockOwner(
  services: AppServices,
  input: RunpaneLockOwnerInput,
  allowAnonymous = false,
): Promise<{ owner: RunpaneLockOwner; sessionId?: string }> {
  const panel = input.panelId ? panelManager.getPanel(input.panelId) : undefined;
  if (input.panelId && !panel) throw new Error(`No Pane panel found with id ${input.panelId}. Run \`runpane panels list --pane <pane-id>\` to see panel ids.`);
  const paneId = input.paneId ?? panel?.sessionId;
  if (paneId) {
    const pane = services.sessionManager.getSession(paneId);
    if (!pane) throw new Error(`No Pane pane found with id ${paneId}. Run \`runpane panes list\` to see Pane ids.`);
    if (pane.archived) throw new Error(`Pane ${paneId} is archived and cannot hold locks.`);
    if (panel && panel.sessionId !== paneId) throw new Error(`Panel ${input.panelId} does not belong to Pane ${paneId}.`);
    const owner: RunpaneLockOwner = { kind: 'pane', paneId };
    if (input.panelId) owner.panelId = input.panelId;
    const sessionId = await services.orchestrationSessionManager?.sessionIdForPane(paneId, input.panelId);
    return { owner, sessionId };
  }
  const label = optionalLockText(input.label);
  if (label) return { owner: { kind: 'external', label } };
  if (allowAnonymous) return { owner: { kind: 'external', label: '' } };
  throw new Error('Outside a Pane terminal, pass --note <text> to say who holds the lock (or --pane/--panel to act for a Pane).');
}

function optionalLockText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function sessionLockFilter(session: { id: string; internalSessionId: string; associations: readonly { paneId: string }[] }) {
  return {
    sessionId: session.id,
    paneIds: [session.internalSessionId, ...session.associations.map(association => association.paneId)],
  };
}

function requireOrchestrationSessionManager(services: AppServices) {
  if (!services.orchestrationSessionManager) throw new Error('Sessions manager is not initialized');
  return services.orchestrationSessionManager;
}

function parseOrchestrationSessionSelector(value: PaneCommandValue): RunpaneSessionSelector {
  const selector = decodeBoundary(value, orchestrationSelectorSchema);
  if (!selector.sessionId && !selector.name) throw new Error('Named Session id or name is required');
  return selector;
}

function parseOrchestrationSessionCreateRequest(value: PaneCommandValue): OrchestrationSessionCreateInput {
  return decodeBoundary(value, orchestrationSessionCreateSchema);
}

interface OrchestrationSessionUpdateRequest {
  selector: RunpaneSessionSelector;
  input: OrchestrationSessionUpdateInput;
}

function parseOrchestrationSessionUpdateRequest(value: PaneCommandValue): OrchestrationSessionUpdateRequest {
  if (!isRecord(value)) throw new Error('Session update request must be an object');
  const selector = parseOrchestrationSessionSelector(value.selector);
  const input = decodeBoundary(value.input, orchestrationSessionUpdateSchema);
  return { selector, input };
}

interface OrchestrationSessionAgentRequest {
  selector: RunpaneSessionSelector;
  agent: PaneChatAgent;
}

function parseOrchestrationSessionAgentRequest(value: PaneCommandValue): OrchestrationSessionAgentRequest {
  if (!isRecord(value)) throw new Error('Session agent request must be an object');
  const selector = parseOrchestrationSessionSelector(value.selector);
  const agent = decodeBoundary(value.agent, boundary.enumeration('claude', 'codex', 'cursor'));
  return { selector, agent };
}

interface OrchestrationSessionAssociationRequest {
  selector: RunpaneSessionSelector;
  association: OrchestrationAssociationInput;
}

function parseOrchestrationSessionAssociationRequest(value: PaneCommandValue): OrchestrationSessionAssociationRequest {
  if (!isRecord(value)) throw new Error('Session association request must be an object');
  const selector = parseOrchestrationSessionSelector(value.selector);
  const association = decodeBoundary(value.association, boundary.object({
    paneId: boundary.nonEmptyString,
    panelIds: boundary.optional(boundary.array(boundary.nonEmptyString)),
  }));
  return { selector, association };
}

interface OrchestrationSessionDetachRequest {
  selector: RunpaneSessionSelector;
  paneId?: string;
}

function parseOrchestrationSessionDetachRequest(value: PaneCommandValue): OrchestrationSessionDetachRequest {
  if (!isRecord(value)) throw new Error('Session detach request must be an object');
  const selector = parseOrchestrationSessionSelector(value.selector);
  const paneId = value.paneId === undefined ? undefined : decodeBoundary(value.paneId, boundary.nonEmptyString);
  return { selector, paneId };
}

function parsePaneCostRequest(value: PaneCommandValue): RunpanePaneCostRequest {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new Error('Pane cost request must be an object');
  const paneId = optionalString(value.paneId)?.trim();
  if (value.paneId !== undefined && !paneId) {
    throw new Error('Pane cost paneId must be a non-empty string');
  }
  return {
    repo: value.repo === undefined || value.repo === null || value.repo === ''
      ? undefined
      : parseRepoSelector(value.repo),
    paneId,
  };
}

function emptyPaneCostSlice() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    messageCount: 0,
    estimatedCostUsd: 0,
    costIncomplete: false,
    cacheSavingsUsd: 0,
    uncachedCostUsd: 0,
    uncachedInputTokens: 0,
    cacheHitRate: 0,
    byModel: [],
  };
}

function parseSessionTimestampMs(value: string): number {
  const sqliteTimestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value);
  return Date.parse(sqliteTimestamp ? `${value.replace(' ', 'T')}Z` : value);
}

function isSessionArchived(value: boolean | number | null | undefined): boolean {
  return value === true || value === 1;
}

function parseWorkspaceWaitRequest(value: PaneCommandValue): RunpaneWorkspaceWaitRequest {
  if (!isRecord(value)) throw new Error('Workspace wait request must be an object');
  const consumer = optionalString(value.as)?.trim();
  if (consumer && !WORKSPACE_CONSUMER_PATTERN.test(consumer)) {
    throw new Error('Workspace wait as must contain 1-128 letters, numbers, dots, underscores, or hyphens');
  }
  const since = parseNonNegativeInteger(value.since, 'since');
  if (consumer && since !== undefined) throw new Error('Workspace wait request cannot include both as and since');
  const session = optionalString(value.session)?.trim() || undefined;
  const paneIds = parseStringArray(value.paneIds, 'paneIds');
  if (session && paneIds?.length) {
    throw new Error('Workspace wait request cannot include both session and paneIds; a Session scope already covers its Panes');
  }
  if (value.from !== undefined && value.from !== 'now' && value.from !== 'earliest') {
    throw new Error('Workspace wait from must be now or earliest');
  }

  return {
    since,
    as: consumer,
    from: value.from === 'earliest' ? 'earliest' : value.from === 'now' ? 'now' : undefined,
    timeoutMs: parseNonNegativeInteger(value.timeoutMs, 'timeoutMs'),
    limit: parsePositiveInteger(value.limit, 'limit'),
    kinds: parseWorkspaceKinds(value.kinds),
    paneIds,
    session,
    excludePaneIds: parseStringArray(value.excludePaneIds, 'excludePaneIds'),
    repo: value.repo === undefined || value.repo === null || value.repo === '' ? undefined : parseRepoSelector(value.repo),
    nameContains: optionalString(value.nameContains),
    agentsOnly: optionalBoolean(value.agentsOnly),
    ackNow: optionalBoolean(value.ackNow),
    includeHeldInput: optionalBoolean(value.includeHeldInput),
    includeHeldInputPresence: optionalBoolean(value.includeHeldInputPresence),
    idleAfterMs: parseNonNegativeInteger(value.idleAfterMs, 'idleAfterMs'),
    idleWindowStartMs: parseNonNegativeInteger(value.idleWindowStartMs, 'idleWindowStartMs'),
    settleMs: parseNonNegativeInteger(value.settleMs, 'settleMs'),
    blockedSettleMs: parseNonNegativeInteger(value.blockedSettleMs, 'blockedSettleMs'),
    minIntervalMs: parseNonNegativeInteger(value.minIntervalMs, 'minIntervalMs'),
    idleBackoff: optionalBoolean(value.idleBackoff),
  };
}

const workspaceEntryKindSchema = boundary.enumeration(
  'agent.ready',
  'agent.busy',
  'agent.blocked',
  'agent.unknown',
  'agent.idle',
  'pane.created',
  'pane.gone',
  'panel.exited',
  'pane.associated',
  'pane.detached',
  'pr.conflicted',
  'pr.checks',
  'pr.merged',
  'agent.report',
);

function parseWorkspaceKinds(value: PaneCommandValue): RunpaneWorkspaceEntryKind[] | undefined {
  if (value === undefined || value === null) return undefined;
  return decodeBoundary(value, boundary.array(workspaceEntryKindSchema));
}

function parseStringArray(value: PaneCommandValue, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    return decodeBoundary(value, boundary.array(boundary.string))
      .map(item => item.trim())
      .filter(Boolean);
  } catch {
    throw new Error(`Workspace wait ${field} must be an array of strings`);
  }
}

function parseNonNegativeInteger(value: PaneCommandValue, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const decoded = decodeBoundary(value, boundary.number);
  if (!Number.isInteger(decoded) || decoded < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return decoded;
}

function parsePaneCreateRequest(value: PaneCommandValue): RunpanePaneCreateRequest {
  if (!isRecord(value)) {
    throw new Error('Pane create request must be an object');
  }

  const repo = parseRepoSelector(value.repo);
  const panesValue = value.panes;
  if (!Array.isArray(panesValue) || panesValue.length === 0) {
    throw new Error('Pane create request must include at least one pane');
  }
  if (value.noFocus === true && value.focus === true) {
    throw new Error('Pane create request cannot include both noFocus and focus');
  }
  if (value.source !== undefined && value.source !== 'user' && value.source !== 'agent') {
    throw new Error('Pane create source must be user or agent');
  }

  const panes = panesValue.map(parsePaneCreateItem);
  const requestedBranches = panes.flatMap(pane => pane.branch === undefined ? [] : [pane.branch]);
  const duplicateBranch = requestedBranches.find((branch, index) => requestedBranches.indexOf(branch) !== index);
  if (duplicateBranch !== undefined) {
    throw new Error(`Pane create request names branch '${duplicateBranch}' more than once`);
  }

  return {
    repo,
    panes,
    dryRun: optionalBoolean(value.dryRun),
    timeoutMs: optionalNumber(value.timeoutMs),
    waitReady: optionalBoolean(value.waitReady),
    readyTimeoutMs: parsePositiveInteger(value.readyTimeoutMs, 'readyTimeoutMs'),
    concurrency: parsePositiveInteger(value.concurrency, 'concurrency'),
    noFocus: optionalBoolean(value.noFocus),
    focus: optionalBoolean(value.focus),
    source: value.source === 'user' || value.source === 'agent' ? value.source : undefined,
    associateSession: optionalString(value.associateSession)?.trim() || undefined,
  };
}

function parsePaneAdoptRequest(value: PaneCommandValue): RunpanePaneAdoptRequest {
  if (!isRecord(value)) throw new Error('Pane adopt request must be an object');
  if (!Array.isArray(value.panes) || value.panes.length === 0) {
    throw new Error('Pane adopt request must include at least one pane');
  }
  if (value.noFocus === true && value.focus === true) {
    throw new Error('Pane adopt request cannot include both noFocus and focus');
  }
  return {
    repo: parseRepoSelector(value.repo),
    panes: value.panes.map((entry, index) => {
      if (!isRecord(entry)) throw new Error(`Pane adopt item ${index} must be an object`);
      const worktreePath = optionalString(entry.path)?.trim();
      const name = optionalString(entry.name)?.trim();
      if (!worktreePath) throw new Error(`Pane adopt item ${index} must include path`);
      if (!name) throw new Error(`Pane adopt item ${index} must include name`);
      const tool = parseRunpaneToolSpec(entry.tool, `Pane adopt item ${index}`);
      const launch = optionalBoolean(entry.launch);
      if (tool.initialInput !== undefined && launch !== true) {
        throw new Error(`Pane adopt item ${index} has a prompt but no launch. Pass --launch (launch: true) so the agent starts and receives the prompt.`);
      }
      return {
        path: worktreePath,
        name,
        baseBranch: optionalString(entry.baseBranch),
        folder: optionalString(entry.folder),
        pinned: optionalBoolean(entry.pinned),
        tool,
        resume: optionalString(entry.resume),
        launch,
      };
    }),
    dryRun: optionalBoolean(value.dryRun),
    waitReady: optionalBoolean(value.waitReady),
    readyTimeoutMs: parsePositiveInteger(value.readyTimeoutMs, 'readyTimeoutMs'),
    noFocus: optionalBoolean(value.noFocus),
    focus: optionalBoolean(value.focus),
    source: value.source === 'user' || value.source === 'agent' ? value.source : undefined,
    associateSession: optionalString(value.associateSession)?.trim() || undefined,
  };
}

/**
 * Panes created from inside a Session orchestrator become that Session's
 * children in the same call, so agents cannot forget `sessions associate`.
 * A failed association is reported on the item and never undoes the Pane.
 */
async function associateCreatedPane(
  services: AppServices,
  sessionId: string | undefined,
  paneId: string,
): Promise<RunpanePaneAssociationOutcome | undefined> {
  if (!sessionId) return undefined;
  try {
    await requireOrchestrationSessionManager(services).associate({ sessionId }, { paneId });
    return { sessionId, ok: true };
  } catch (error) {
    return { sessionId, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function validateAdoptedWorktree(
  services: AppServices,
  repo: Project,
  requestedPath: string,
): Promise<{ storagePath: string; identityPath: string; pathResolver: PathResolver }> {
  const context = services.sessionManager.getProjectContextByProjectId(repo.id);
  if (!context) throw new Error(`Project context is unavailable for ${repo.name}`);
  let identityPath: string;
  try {
    identityPath = resolvePathIdentity(requestedPath, context.pathResolver);
  } catch {
    throw new Error(`Adopt path does not exist: ${requestedPath}`);
  }
  const worktrees = await services.worktreeManager.listWorktrees(repo.path, context.commandRunner);
  const registeredPaths = worktrees.flatMap(entry => {
    try {
      return [resolvePathIdentity(entry.path, context.pathResolver)];
    } catch {
      return [];
    }
  });
  if (!registeredPaths.some(registeredPath => pathsHaveSameIdentity(registeredPath, identityPath))) {
    throw new Error(`Adopt path is not a git worktree of the selected repository: ${requestedPath}`);
  }

  const storagePath = context.pathResolver.environment === 'wsl'
    ? parseWSLPath(identityPath)?.linuxPath ?? requestedPath
    : identityPath;
  const candidateCommon = await resolveGitCommonDirectory(storagePath, context.pathResolver, context.commandRunner);
  const repoCommon = await resolveGitCommonDirectory(repo.path, context.pathResolver, context.commandRunner);
  if (!pathsHaveSameIdentity(candidateCommon, repoCommon)) {
    throw new Error(`Adopt path belongs to a different git repository: ${requestedPath}`);
  }
  return { storagePath, identityPath, pathResolver: context.pathResolver };
}

async function resolveGitCommonDirectory(
  directory: string,
  pathResolver: PathResolver,
  commandRunner: CommandRunner,
): Promise<string> {
  const { stdout } = await commandRunner.execAsync('git rev-parse --git-common-dir', directory);
  const common = stdout.trim();
  const storedCommon = pathResolver.environment === 'wsl'
    ? common.startsWith('/') ? common : path.posix.resolve(directory, common)
    : path.resolve(directory, common);
  return resolvePathIdentity(storedCommon, pathResolver);
}

function resolvePathIdentity(storedPath: string, pathResolver: PathResolver): string {
  return fs.realpathSync.native(pathResolver.toFileSystem(storedPath));
}

function pathsHaveSameIdentity(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const normalized = path.normalize(value).replace(/[\\/]+$/u, '');
    return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
  };
  return normalize(left) === normalize(right);
}

function findSessionByWorktreeIdentity<T extends { worktree_path: string }>(
  sessions: readonly T[],
  identityPath: string,
  pathResolver: PathResolver,
): T | undefined {
  return sessions.find(session => {
    try {
      return pathsHaveSameIdentity(resolvePathIdentity(session.worktree_path, pathResolver), identityPath);
    } catch {
      return false;
    }
  });
}

function resolveOrCreateAdoptFolder(
  databaseService: AppServices['databaseService'],
  projectId: number,
  folderName: string,
): string {
  const existing = databaseService.getFoldersForProject(projectId)
    .find(folder => folder.name === folderName && !folder.parent_folder_id);
  return existing?.id ?? databaseService.createFolder(folderName, projectId).id;
}

function parsePanelListRequest(value: PaneCommandValue): RunpanePanelListRequest {
  if (!isRecord(value)) {
    throw new Error('Panel list request must be an object');
  }

  const paneId = optionalString(value.paneId)?.trim();
  if (!paneId) {
    throw new Error('Panel list request must include paneId');
  }

  return { paneId };
}

function parsePanelCreateRequest(value: PaneCommandValue): RunpanePanelCreateRequest {
  if (!isRecord(value)) {
    throw new Error('Panel create request must be an object');
  }

  const paneId = optionalString(value.paneId)?.trim();
  if (!paneId) {
    throw new Error('Panel create request must include paneId');
  }
  if (value.type !== undefined && value.type !== 'terminal') {
    throw new Error('Panel create request currently supports only type "terminal"');
  }
  if (value.source !== undefined && value.source !== 'user' && value.source !== 'agent') {
    throw new Error('Panel create source must be user or agent');
  }
  if (value.noFocus === true && value.focus === true) {
    throw new Error('Panel create request cannot include both noFocus and focus');
  }

  return {
    paneId,
    type: 'terminal',
    tool: parseRunpaneToolSpec(value.tool, 'Panel create request'),
    noFocus: optionalBoolean(value.noFocus),
    focus: optionalBoolean(value.focus),
    source: value.source === 'user' || value.source === 'agent' ? value.source : undefined,
    waitReady: optionalBoolean(value.waitReady),
    readyTimeoutMs: parsePositiveInteger(value.readyTimeoutMs, 'readyTimeoutMs'),
  };
}

function parsePanelOpenRequest(value: PaneCommandValue): RunpanePanelOpenRequest {
  if (!isRecord(value)) {
    throw new Error('Panel open request must be an object');
  }

  const paneId = optionalString(value.paneId)?.trim();
  if (!paneId) {
    throw new Error('Panel open request must include paneId');
  }
  const url = optionalString(value.url)?.trim();
  const filePath = optionalString(value.filePath)?.trim();
  if (Boolean(url) === Boolean(filePath)) {
    throw new Error('Panel open request must include exactly one of url or filePath');
  }
  if (value.placement !== undefined && value.placement !== 'split' && value.placement !== 'tab') {
    throw new Error('Panel open placement must be split or tab');
  }
  if (value.source !== undefined && value.source !== 'user' && value.source !== 'agent') {
    throw new Error('Panel open source must be user or agent');
  }
  if (value.noFocus === true && value.focus === true) {
    throw new Error('Panel open request cannot include both noFocus and focus');
  }

  return {
    paneId,
    url: url || undefined,
    filePath: filePath || undefined,
    title: optionalString(value.title)?.trim() || undefined,
    placement: value.placement === 'split' || value.placement === 'tab' ? value.placement : undefined,
    noFocus: optionalBoolean(value.noFocus),
    focus: optionalBoolean(value.focus),
    source: value.source === 'user' || value.source === 'agent' ? value.source : undefined,
  };
}

type PanelOpenTarget =
  | { type: 'browser'; title: string; filePath?: string; customState: BrowserPanelState & { currentUrl: string } }
  | { type: 'editor'; title: string; filePath: string; customState: EditorPanelState };

const PANEL_OPEN_URL_PROTOCOLS = new Set(['http:', 'https:', 'file:']);
const HTML_FILE_PATTERN = /\.html?$/iu;

async function resolvePanelOpenUrl(rawUrl: string, services: AppServices, pane: Session): Promise<PanelOpenTarget> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }
  if (!PANEL_OPEN_URL_PROTOCOLS.has(parsed.protocol)) {
    throw new Error(`Unsupported URL scheme ${parsed.protocol} (use http, https, or file)`);
  }
  if (parsed.protocol === 'file:' && process.platform === 'win32'
    && (services.sessionManager.getProjectContext(pane.id) || (pane.isHidden && isOrchestrationInternalSessionId(pane.id)))) {
    const { pathResolver, toFileSystem } = await browserFileContext(services, pane);
    if (pathResolver.environment === 'wsl') {
      const filePath = !parsed.hostname && !/^\/[a-z]:/i.test(parsed.pathname)
        ? fileURLToPath(parsed, { windows: false })
        : fileURLToPath(parsed);
      const normalized = pathToFileURL(toFileSystem(filePath));
      normalized.search = parsed.search;
      normalized.hash = parsed.hash;
      parsed = normalized;
    }
  }
  const title = parsed.protocol === 'file:'
    ? path.basename(decodeURIComponent(parsed.pathname)) || 'Browser'
    : parsed.host || 'Browser';
  return { type: 'browser', title, customState: { currentUrl: parsed.href } };
}

/**
 * Resolve a file inside the Pane's worktree. Session orchestrators run in a
 * hidden internal Pane whose worktree is the Session folder and which has no
 * project context, mirroring file.ts getFileContext.
 */
async function resolvePanelOpenFile(services: AppServices, pane: Session, rawPath: string): Promise<PanelOpenTarget> {
  const { pathResolver, toFileSystem } = await browserFileContext(services, pane);

  const basePath = toFileSystem(pane.worktreePath);
  const requested = path.isAbsolute(rawPath)
    ? path.relative(basePath, toFileSystem(rawPath))
    : rawPath;
  const relativePath = path.normalize(requested);
  if (!relativePath || relativePath === '.' || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`File path must be inside the Pane worktree: ${rawPath}`);
  }
  const fullPath = path.join(basePath, relativePath);
  if (!await pathResolver.isWithin(basePath, fullPath)) {
    throw new Error(`File path must be inside the Pane worktree: ${rawPath}`);
  }
  const stat = await fs.promises.stat(fullPath).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error(`File not found: ${rawPath}`);
  }

  const filePath = relativePath.split(path.sep).join('/');
  const title = path.basename(relativePath);
  if (HTML_FILE_PATTERN.test(relativePath)) {
    return { type: 'browser', title, filePath, customState: { currentUrl: pathToFileURL(fullPath).href } };
  }
  return { type: 'editor', title, filePath, customState: { filePath, isPreview: false, isDirty: false } };
}

function panelShowsOpenTarget(panel: ToolPanel, target: PanelOpenTarget): boolean {
  if (panel.type !== target.type) return false;
  if (target.type === 'browser') {
    // SAFETY: The browser panel type discriminator establishes BrowserPanelState.
    return (panel.state.customState as BrowserPanelState | undefined)?.currentUrl === target.customState.currentUrl;
  }
  // SAFETY: The editor panel type discriminator establishes EditorPanelState.
  const state = panel.state.customState as EditorPanelState | undefined;
  return state?.filePath === target.filePath && !state.diff;
}

function parsePanelOutputRequest(value: PaneCommandValue): RunpanePanelOutputRequest {
  if (!isRecord(value)) {
    throw new Error('Panel output request must be an object');
  }

  const panelId = optionalString(value.panelId)?.trim();
  if (!panelId) {
    throw new Error('Panel output request must include panelId');
  }

  return {
    panelId,
    limit: parsePositiveInteger(value.limit, 'limit'),
  };
}

function parsePanelInputRequest(value: PaneCommandValue): RunpanePanelInputRequest {
  if (!isRecord(value)) {
    throw new Error('Panel input request must be an object');
  }

  const panelId = optionalString(value.panelId)?.trim();
  if (!panelId) {
    throw new Error('Panel input request must include panelId');
  }
  const input = optionalString(value.input);
  if (input === undefined) {
    throw new Error('Panel input request must include input');
  }

  return {
    panelId,
    input,
    source: value.source === 'user' || value.source === 'agent' ? value.source : undefined,
  };
}

function parsePanelScreenRequest(value: PaneCommandValue): RunpanePanelScreenRequest {
  if (!isRecord(value)) {
    throw new Error('Panel screen request must be an object');
  }

  const panelId = optionalString(value.panelId)?.trim();
  if (!panelId) {
    throw new Error('Panel screen request must include panelId');
  }

  return {
    panelId,
    limit: parsePositiveInteger(value.limit, 'limit'),
  };
}

function parsePanelLastMessageRequest(value: PaneCommandValue): RunpanePanelLastMessageRequest {
  if (!isRecord(value)) {
    throw new Error('Panel last-message request must be an object');
  }
  const panelId = optionalString(value.panelId)?.trim();
  if (!panelId) {
    throw new Error('Panel last-message request must include panelId');
  }
  return { panelId, limit: parsePositiveInteger(value.limit, 'limit') };
}

const reportRequestSchema = boundary.object({
  paneId: boundary.optional(boundary.string),
  panelId: boundary.nonEmptyString,
  state: boundary.enumeration(...AGENT_REPORT_STATES),
  pr: boundary.optional(boundary.number),
  head: boundary.optional(boundary.string),
  summary: boundary.optional(boundary.string),
  summaryPath: boundary.optional(boundary.string),
  question: boundary.optional(boundary.string),
});

function parseReportRequest(value: PaneCommandValue): RunpaneReportRequest {
  if (!isRecord(value)) {
    throw new Error('Report request must be an object');
  }
  const decoded = decodeBoundary(value, reportRequestSchema);
  return { ...decoded, paneId: decoded.paneId?.trim() || undefined, panelId: decoded.panelId.trim() };
}

function parsePanelSubmitRequest(value: PaneCommandValue): RunpanePanelSubmitRequest {
  if (!isRecord(value)) {
    throw new Error('Panel submit request must be an object');
  }

  const panelId = optionalString(value.panelId)?.trim();
  if (!panelId) {
    throw new Error('Panel submit request must include panelId');
  }
  const input = optionalString(value.input);
  if (input === undefined) {
    throw new Error('Panel submit request must include input');
  }

  return {
    panelId,
    input,
    asFilePointer: optionalBoolean(value.asFilePointer),
    source: value.source === 'user' || value.source === 'agent' ? value.source : undefined,
  };
}

function parsePanelSubmitComposerRequest(value: PaneCommandValue): RunpanePanelSubmitComposerRequest {
  if (!isRecord(value)) {
    throw new Error('Panel submit-composer request must be an object');
  }

  const panelId = optionalString(value.panelId)?.trim();
  if (!panelId) {
    throw new Error('Panel submit-composer request must include panelId');
  }
  if (
    value.strategy !== undefined &&
    value.strategy !== 'auto' &&
    value.strategy !== 'codex-ctrl-enter' &&
    value.strategy !== 'tab' &&
    value.strategy !== 'enter'
  ) {
    throw new Error('Panel submit-composer strategy must be auto, codex-ctrl-enter, enter, or tab');
  }

  return {
    panelId,
    strategy: value.strategy === undefined
      ? undefined
      : decodeBoundary(value.strategy, boundary.enumeration('auto', 'codex-ctrl-enter', 'enter', 'tab')),
  };
}

function parsePanelWaitRequest(value: PaneCommandValue): RunpanePanelWaitRequest {
  if (!isRecord(value)) {
    throw new Error('Panel wait request must be an object');
  }

  const panelId = optionalString(value.panelId)?.trim();
  if (!panelId) {
    throw new Error('Panel wait request must include panelId');
  }

  const contains = optionalString(value.contains);
  const condition = parseWaitCondition(value.condition, contains);
  if (condition === 'text' && (!contains || contains.length === 0)) {
    throw new Error('Panel wait request with condition "text" must include contains');
  }

  return {
    panelId,
    condition,
    contains,
    timeoutMs: parsePositiveInteger(value.timeoutMs, 'timeoutMs'),
    intervalMs: parsePositiveInteger(value.intervalMs, 'intervalMs'),
  };
}

function parseAgentDoctorRequest(value: PaneCommandValue): RunpaneAgentDoctorRequest {
  if (!isRecord(value)) {
    throw new Error('Agent doctor request must be an object');
  }
  const agent = optionalAgentId(value.agent);
  if (!agent) {
    throw new Error(`Agent doctor request must include agent: ${[...AGENT_IDS].join(', ')}`);
  }

  return {
    agent,
    repo: value.repo === undefined || value.repo === null || value.repo === ''
      ? undefined
      : parseRepoSelector(value.repo),
  };
}

function parseWaitCondition(value: PaneCommandValue, contains?: string): RunpanePanelWaitCondition | undefined {
  if (value === undefined || value === null || value === '') {
    return contains ? 'text' : undefined;
  }
  if (value === 'initialized' || value === 'ready' || value === 'idle' || value === 'text') {
    return value;
  }
  throw new Error('Panel wait condition must be one of: initialized, ready, idle, text');
}

function parseRepoAddRequest(value: PaneCommandValue): Required<Pick<RunpaneRepoAddRequest, 'path' | 'name'>> & Pick<RunpaneRepoAddRequest, 'dryRun'> {
  if (!isRecord(value)) {
    throw new Error('Repo add request must be an object');
  }

  const requestedPath = optionalString(value.path)?.trim();
  if (!requestedPath) {
    throw new Error('Repo add request must include a path');
  }

  const repoPath = expandUserRepoPath(requestedPath);
  const providedName = optionalString(value.name)?.trim();
  const location = resolveProjectRegistration(repoPath);
  const defaultName = path.posix.basename(location.path.replace(/\\/g, '/')) || location.path;

  return {
    path: repoPath,
    name: providedName && providedName.length > 0 ? providedName : defaultName,
    dryRun: optionalBoolean(value.dryRun),
  };
}

function resolvePane(sessionManager: AppServices['sessionManager'], paneId: string): Session {
  const session = sessionManager.getSession(paneId);
  if (!session) {
    throw new Error(`No Pane pane found with id ${paneId}. Run \`runpane panes list\` to see Pane ids.`);
  }
  return session;
}

/** Why archive leaves this pane's worktree alone, or undefined when archive removes it. */
function archiveCleanupSkipReason(pane: Session): RunpanePaneArchiveSafetyCheckReason | undefined {
  if (pane.worktreeOwnership === 'external') return 'external-worktree';
  if (pane.isMainRepo) return 'main-repo';
  if (!pane.projectId) return 'missing-project-context';
  return undefined;
}

async function computeArchiveSafety(services: AppServices, pane: Session): Promise<RunpanePaneArchiveSafetyCheck> {
  const ctx = services.sessionManager.getProjectContext(pane.id);
  if (!ctx) {
    return { performed: false, reason: 'missing-project-context' };
  }

  try {
    // Deliberately bypass gitStatusManager's cache (up to CACHE_TTL_MS stale)
    // and read git plumbing directly — a safety gate must see the current
    // state, not a snapshot from moments-ago that predates a recent commit.
    const workingDirectory = await fastCheckWorkingDirectory(pane.worktreePath, ctx.commandRunner.wslContext);
    const hasUncommittedChanges = workingDirectory.hasModified || workingDirectory.hasStaged || workingDirectory.hasConflicts;
    const hasUntrackedFiles = workingDirectory.hasUntracked;

    const upstream = await services.worktreeManager.getUpstream(pane.worktreePath, ctx.commandRunner);
    let upstreamGone = false;
    if (upstream) {
      const remote = await resolveUpstreamRemote(pane.worktreePath, upstream, ctx.commandRunner);
      await ctx.commandRunner.execAsync(
        `git fetch --no-tags --prune ${escapeShellArg(remote)}`,
        pane.worktreePath,
        { timeout: 30000 },
      );
      // `--prune` deletes the tracking ref when the remote branch was deleted,
      // which GitHub does after merging a PR. Fall through to the no-upstream path.
      upstreamGone = !await refExists(pane.worktreePath, upstream, ctx.commandRunner);
      if (!upstreamGone) {
        const unpushedCommitDetails = await listCommitsAhead(
          pane.worktreePath,
          upstream,
          ctx.commandRunner.wslContext,
        );
        return {
          performed: true,
          hasUncommittedChanges,
          hasUntrackedFiles,
          hasUpstream: true,
          upstream,
          upstreamRefreshed: true,
          unpushedCommits: unpushedCommitDetails.length,
          unpushedCommitDetails,
        };
      }
    }

    // No upstream (never pushed, detached HEAD, or the remote branch is gone):
    // the branch's own commits ahead of its base/comparison branch are the
    // closest proxy for "unpushed work".
    const comparisonBranch = await services.worktreeManager.getSessionComparisonBranch(pane, ctx);
    const unpushedCommitDetails = await listCommitsAhead(
      pane.worktreePath,
      comparisonBranch,
      ctx.commandRunner.wslContext,
    );
    // A squash or rebase merge leaves those commits outside the base branch.
    // A merged PR whose head is exactly HEAD proves they reached the remote.
    const mergedViaPr = unpushedCommitDetails.length > 0
      ? await findMergedPullRequestForHead(pane.worktreePath, ctx.commandRunner)
      : undefined;
    return {
      performed: true,
      hasUncommittedChanges,
      hasUntrackedFiles,
      hasUpstream: Boolean(upstream),
      upstream: upstream ?? undefined,
      upstreamRefreshed: Boolean(upstream),
      upstreamGone: upstreamGone || undefined,
      unpushedCommits: mergedViaPr ? 0 : unpushedCommitDetails.length,
      unpushedCommitDetails: mergedViaPr ? [] : unpushedCommitDetails,
      mergedViaPr,
    };
  } catch {
    return { performed: false, reason: 'git-error' };
  }
}

async function refExists(worktreePath: string, ref: string, commandRunner: CommandRunner): Promise<boolean> {
  try {
    await commandRunner.execAsync(`git rev-parse --verify --quiet ${escapeShellArg(`${ref}^{commit}`)}`, worktreePath, { silent: true });
    return true;
  } catch {
    return false;
  }
}

const mergedPullRequestListSchema = boundary.array(boundary.object({
  number: boundary.number,
  headRefOid: boundary.string,
}));

/**
 * The merged pull request whose head commit is this worktree's HEAD, if any.
 * Missing, unauthenticated, or offline `gh` means no evidence, never an error.
 */
async function findMergedPullRequestForHead(
  worktreePath: string,
  commandRunner: CommandRunner,
): Promise<RunpanePaneArchiveMergedPr | undefined> {
  try {
    const [branchResult, headResult] = await Promise.all([
      commandRunner.execFile('git', ['branch', '--show-current'], worktreePath, { silent: true, timeout: 10_000 }),
      commandRunner.execFile('git', ['rev-parse', 'HEAD'], worktreePath, { silent: true, timeout: 10_000 }),
    ]);
    const branch = branchResult.stdout.trim();
    const head = headResult.stdout.trim();
    if (!branch || !head) return undefined;
    const { stdout } = await commandRunner.execFile(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'merged', '--json', 'number,headRefOid', '--limit', '20'],
      worktreePath,
      { silent: true, timeout: GH_PR_LOOKUP_TIMEOUT_MS },
    );
    const pullRequests = decodeBoundary(JSON.parse(stdout.trim() || '[]'), mergedPullRequestListSchema);
    const match = pullRequests.find(pullRequest => pullRequest.headRefOid === head);
    return match ? { number: match.number, headOid: match.headRefOid } : undefined;
  } catch {
    return undefined;
  }
}

/** Whether archiving removes the Pane's worktree: always a Pane-managed one, an adopted one only on request. */
function removesPaneWorktree(pane: Session, removeWorktree: boolean): boolean {
  return Boolean(pane.projectId)
    && !pane.isMainRepo
    && (pane.worktreeOwnership !== 'external' || removeWorktree);
}

/** `--remove-worktree` never deletes an adopted path that is the repository's main checkout or another repository. */
async function assertRemovableWorktree(services: AppServices, pane: Session, removeWorktree: boolean): Promise<void> {
  if (!removeWorktree || pane.worktreeOwnership !== 'external' || !removesPaneWorktree(pane, removeWorktree)) return;
  const repo = services.sessionManager.getProjectForSession(pane.id);
  const ctx = services.sessionManager.getProjectContext(pane.id);
  if (!repo || !ctx) return;
  const worktree = await classifyWorktree(pane.worktreePath, repo.path, ctx.commandRunner);
  if (worktree.kind === 'main') {
    throw new Error(`Pane ${pane.id} is the repository's main checkout (${pane.worktreePath}); --remove-worktree only removes linked worktrees.`);
  }
  if (worktree.kind === 'foreign') {
    throw new Error(`Pane ${pane.id} is a checkout of a different repository (${pane.worktreePath}); --remove-worktree will not delete it.`);
  }
}

/**
 * Archives the Pane through `sessions:delete`, exactly like the UI, and waits
 * for its worktree to be removed. A large worktree reports `completed` with
 * `trashDeletion: 'pending'`: git has forgotten it and its files are being
 * deleted from quarantine. Durable cleanup reserves its path until finished.
 */
async function archivePaneAndRemoveWorktree(
  services: AppServices,
  commandRegistry: PaneCommandRegistry,
  pane: Session,
  removesWorktree: boolean,
): Promise<WorktreeCleanupOutcome> {
  const cleanupWait = removesWorktree && services.archiveProgressManager
    ? waitForArchiveProgressCompletion(services.archiveProgressManager, pane.id, DEFAULT_ARCHIVE_CLEANUP_TIMEOUT_MS)
    : null;

  const deleteArgs: PaneCommandValue[] = removesWorktree && pane.worktreeOwnership === 'external'
    ? [pane.id, { removeExternalWorktree: true }]
    : [pane.id];
  const deleteResult = decodeBoundary(
    await commandRegistry.invoke('sessions:delete', deleteArgs),
    boundary.object({
      success: boundary.boolean,
      error: boundary.optional(boundary.string),
    }),
  );
  if (!deleteResult.success) {
    throw new Error(deleteResult.error ?? `Failed to archive pane ${pane.id}`);
  }

  if (!removesWorktree) return { worktreeCleanup: 'not-applicable' };
  if (cleanupWait) return cleanupWait;
  return { worktreeCleanup: await waitForWorktreeRemovalByPolling(pane.worktreePath, DEFAULT_ARCHIVE_CLEANUP_TIMEOUT_MS) };
}

interface WorktreeCleanupOutcome {
  worktreeCleanup: RunpaneWorktreeCleanupState;
  trashDeletion?: RunpaneWorktreeTrashDeletion;
}

/**
 * The archive still succeeded when removal is only slow: the Pane is archived
 * and removal keeps running in the background. Only `failed` is an error.
 */
function isArchiveCleanupOk(worktreeCleanup: RunpaneWorktreeCleanupState): boolean {
  return worktreeCleanup !== 'failed';
}

/**
 * `runpane panes archive --session <id|name> --merged`: archives every Pane
 * associated with the Session whose work is already safe on the remote (clean
 * and pushed, or merged via a PR whose head is HEAD). Everything else is
 * skipped with the same block code a single archive would report.
 */
async function archiveSessionPanes(
  services: AppServices,
  commandRegistry: PaneCommandRegistry,
  request: RunpanePaneArchiveBulkRequest,
): Promise<RunpanePaneArchiveBulkResult> {
  const record = await requireOrchestrationSessionManager(services).get({ sessionId: request.sessionId });
  const removeWorktree = Boolean(request.removeWorktree);
  const paneIds = [...new Set(record.associations.map(association => association.paneId))];
  const items: RunpanePaneArchiveBulkItem[] = [];

  for (const paneId of paneIds) {
    const pane = services.sessionManager.getSession(paneId);
    if (!pane) {
      items.push({ paneId, outcome: 'skipped', skipped: { code: 'missing-pane', message: 'Pane no longer exists.' } });
      continue;
    }
    const base = { paneId, name: pane.name, worktreePath: pane.worktreePath };
    if (pane.archived) {
      items.push({ ...base, outcome: 'skipped', skipped: { code: 'already-archived', message: 'Pane is already archived.' } });
      continue;
    }
    if (pane.isMainRepo || !pane.projectId) {
      items.push({ ...base, outcome: 'skipped', skipped: { code: 'main-repo', message: 'Pane runs in the repository checkout, not a worktree; archive it by --pane.' } });
      continue;
    }

    try {
      await assertRemovableWorktree(services, pane, removeWorktree);
      const removesWorktree = removesPaneWorktree(pane, removeWorktree);
      // Evaluate every Pane, including adopted ones that keep their worktree:
      // --merged selects by evidence, not by what archiving deletes.
      const safetyCheck = await computeArchiveSafety(services, pane);
      if (!removesWorktree) safetyCheck.worktreeWillRemain = true;
      const blockCode = classifyArchiveBlock(safetyCheck, true);
      if (blockCode) {
        items.push({
          ...base,
          outcome: 'skipped',
          skipped: { code: blockCode, message: describeArchiveBlock(blockCode, safetyCheck) },
          safetyCheck,
        });
        continue;
      }
      if (request.dryRun) {
        items.push({ ...base, outcome: 'would-archive', safetyCheck });
        continue;
      }
      const cleanup = await archivePaneAndRemoveWorktree(services, commandRegistry, pane, removesWorktree);
      const cleanupOk = isArchiveCleanupOk(cleanup.worktreeCleanup);
      items.push({
        ...base,
        outcome: cleanupOk ? 'archived' : 'failed',
        error: cleanupOk ? undefined : 'Pane was archived but its worktree could not be removed.',
        safetyCheck,
        ...cleanup,
      });
    } catch (error) {
      items.push({ ...base, outcome: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  }

  const failed = items.filter(item => item.outcome === 'failed').length;
  return {
    ok: failed === 0,
    sessionId: record.id,
    merged: true,
    dryRun: request.dryRun ? true : undefined,
    removeWorktree,
    archived: items.filter(item => item.outcome === 'archived' || item.outcome === 'would-archive').length,
    skipped: items.filter(item => item.outcome === 'skipped').length,
    failed,
    items,
  };
}

async function resolveUpstreamRemote(
  worktreePath: string,
  upstream: string,
  commandRunner: CommandRunner,
): Promise<string> {
  const { stdout } = await commandRunner.execAsync('git remote', worktreePath);
  const remote = stdout
    .split('\n')
    .map(value => value.trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)
    .find(value => upstream.startsWith(`${value}/`));
  if (!remote) {
    throw new Error(`Could not resolve remote for upstream ${upstream}`);
  }
  return remote;
}

function classifyArchiveBlock(check: RunpanePaneArchiveSafetyCheck, applicable: boolean): RunpanePaneArchiveBlockCode | undefined {
  if (!applicable) {
    return undefined;
  }
  if (!check.performed) {
    return 'status-unknown';
  }

  const dirty = Boolean(check.hasUncommittedChanges || check.hasUntrackedFiles);
  const unpushed = (check.unpushedCommits ?? 0) > 0;
  if (dirty && unpushed) return 'uncommitted-and-unpushed';
  if (dirty) return 'uncommitted-changes';
  if (unpushed) return 'unpushed-commits';
  return undefined;
}

function describeArchiveBlock(code: RunpanePaneArchiveBlockCode, check: RunpanePaneArchiveSafetyCheck): string {
  const unpushedCount = check.unpushedCommits ?? 0;
  const unpushedPhrase = unpushedCount === 1 ? '1 commit' : `${unpushedCount} commits`;
  switch (code) {
    case 'uncommitted-and-unpushed':
      return `Pane has uncommitted or untracked changes and ${unpushedPhrase} not pushed to any remote. Archiving would remove the worktree and discard this work. Rerun with --force to archive anyway.`;
    case 'uncommitted-changes':
      return 'Pane has uncommitted or untracked changes. Archiving would remove the worktree and discard this work. Rerun with --force to archive anyway.';
    case 'unpushed-commits':
      return `Pane has ${unpushedPhrase} not pushed to any remote. Archiving would remove the worktree and discard this work. Rerun with --force to archive anyway.`;
    case 'status-unknown':
    default:
      return 'Could not determine whether the pane has uncommitted or unpushed changes. Refusing to archive without --force.';
  }
}

function waitForArchiveProgressCompletion(
  archiveProgressManager: ArchiveProgressManager,
  paneId: string,
  timeoutMs: number,
): Promise<WorktreeCleanupOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: WorktreeCleanupOutcome) => {
      if (settled) return;
      settled = true;
      archiveProgressManager.off('archive-progress', onProgress);
      clearTimeout(timer);
      resolve(outcome);
    };

    const onProgress = (payload: { tasks: ArchiveProgressTask[] }) => {
      const task = payload.tasks.find(candidate => candidate.sessionId === paneId);
      if (task?.status === 'completed' || (task?.cleanupId && task.trashDeletion === 'pending' && task.status !== 'failed')) {
        finish({ worktreeCleanup: 'completed', trashDeletion: task.trashDeletion });
      } else if (task?.status === 'failed') {
        finish({ worktreeCleanup: 'failed' });
      }
    };

    archiveProgressManager.on('archive-progress', onProgress);
    // A slow archive script or git removal keeps running in the background
    // queue; the Pane is already archived, so this is `timeout` with ok:true.
    const timer = setTimeout(() => finish({ worktreeCleanup: 'timeout' }), timeoutMs);
  });
}

async function waitForWorktreeRemovalByPolling(
  worktreePath: string,
  timeoutMs: number,
  intervalMs = DEFAULT_ARCHIVE_CLEANUP_POLL_INTERVAL_MS,
): Promise<RunpaneWorktreeCleanupState> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!fs.existsSync(worktreePath)) {
      return 'completed';
    }
    await sleep(Math.min(intervalMs, Math.max(timeoutMs - (Date.now() - startedAt), 0)));
  }
  return fs.existsSync(worktreePath) ? 'timeout' : 'completed';
}

function parsePaneArchiveRequest(value: PaneCommandValue): RunpanePaneArchiveRequest {
  if (!isRecord(value)) {
    throw new Error('Pane archive request must be an object');
  }

  const paneId = optionalString(value.paneId)?.trim();
  if (!paneId) {
    throw new Error('Pane archive request must include a paneId');
  }
  if (value.source !== undefined && value.source !== 'user' && value.source !== 'agent') {
    throw new Error('Pane archive source must be user or agent');
  }

  return {
    paneId,
    force: optionalBoolean(value.force),
    source: value.source === 'user' || value.source === 'agent' ? value.source : undefined,
    dryRun: optionalBoolean(value.dryRun),
    removeWorktree: optionalBoolean(value.removeWorktree),
  };
}

function parsePaneArchiveBulkRequest(value: Record<string, PaneCommandValue>): RunpanePaneArchiveBulkRequest {
  const request = decodeBoundary(value, boundary.object({
    sessionId: boundary.nonEmptyString,
    merged: boundary.optional(boundary.boolean),
    paneId: boundary.optional(boundary.string),
    force: boundary.optional(boundary.boolean),
    source: boundary.optional(boundary.enumeration('user', 'agent')),
    dryRun: boundary.optional(boundary.boolean),
    removeWorktree: boundary.optional(boundary.boolean),
  }));
  if (request.paneId !== undefined) {
    throw new Error('Pane archive accepts either paneId or sessionId, not both');
  }
  if (request.merged !== true) {
    throw new Error('Archiving a Session\'s Panes requires merged: true (--merged)');
  }
  if (request.force) {
    throw new Error('Archiving a Session\'s Panes does not accept force; archive a Pane by paneId to discard its work');
  }
  return {
    sessionId: request.sessionId.trim(),
    merged: true,
    source: request.source,
    dryRun: request.dryRun,
    removeWorktree: request.removeWorktree,
  };
}

function parsePanePinRequest(value: PaneCommandValue): RunpanePanePinRequest {
  if (!isRecord(value)) {
    throw new Error('Pane pin request must be an object');
  }

  const paneId = optionalString(value.paneId)?.trim();
  if (!paneId) {
    throw new Error('Pane pin request must include a paneId');
  }
  const pinned = optionalBoolean(value.pinned);
  if (pinned === undefined) {
    throw new Error('Pane pin request must include pinned as a boolean');
  }

  return {
    paneId,
    pinned,
    dryRun: optionalBoolean(value.dryRun),
  };
}

function parsePaneRenameRequest(value: PaneCommandValue): RunpanePaneRenameRequest {
  if (!isRecord(value)) {
    throw new Error('Pane rename request must be an object');
  }

  const paneId = optionalString(value.paneId)?.trim();
  if (!paneId) {
    throw new Error('Pane rename request must include a paneId');
  }
  const name = optionalString(value.name)?.trim();
  if (!name) {
    throw new Error('Pane rename request must include a non-empty name');
  }

  return {
    paneId,
    name,
    dryRun: optionalBoolean(value.dryRun),
  };
}

function parsePaneFocusRequest(value: PaneCommandValue): RunpanePaneFocusRequest {
  if (!isRecord(value)) {
    throw new Error('Pane focus request must be an object');
  }

  const paneId = optionalString(value.paneId)?.trim();
  if (!paneId) {
    throw new Error('Pane focus request must include a paneId');
  }
  const panelId = optionalString(value.panelId)?.trim();
  if (value.source !== undefined && value.source !== 'user' && value.source !== 'agent') {
    throw new Error('Pane focus source must be user or agent');
  }

  return {
    paneId,
    panelId: panelId || undefined,
    source: value.source === 'user' || value.source === 'agent' ? value.source : undefined,
  };
}

function resolvePanel(panelId: string): ToolPanel {
  const panel = panelManager.getPanel(panelId);
  if (!panel) {
    throw new Error(`No Pane panel found with id ${panelId}. Run \`runpane panels list --pane <pane-id>\` to see panel ids.`);
  }
  return panel;
}

function parsePaneCreateItem(value: PaneCommandValue, index: number): RunpanePaneCreateItem {
  if (!isRecord(value)) {
    throw new Error(`Pane create item ${index} must be an object`);
  }

  const name = optionalString(value.name);
  if (!name || name.trim().length === 0) {
    throw new Error(`Pane create item ${index} must include a name`);
  }

  return {
    name,
    worktreeName: optionalString(value.worktreeName),
    branch: optionalString(value.branch),
    baseBranch: optionalString(value.baseBranch),
    sessionPrompt: optionalString(value.sessionPrompt),
    // CLI/daemon-created Panes pin by default so orchestrated work stays visible
    // in the sidebar; the Pane UI create dialog has its own startPinned preference.
    pinned: optionalBoolean(value.pinned) ?? true,
    tool: parseRunpaneToolSpec(value.tool, `Pane create item ${index}`),
  };
}

function parseRunpaneToolSpec(value: PaneCommandValue, label: string): RunpaneToolSpec {
  if (!isRecord(value)) {
    throw new Error(`${label} must include a tool object`);
  }

  const agent = optionalAgentId(value.agent);
  if (agent) {
    return {
      agent,
      title: optionalString(value.title),
      initialInput: optionalString(value.initialInput),
      initialInputAsFilePointer: optionalBoolean(value.initialInputAsFilePointer),
    };
  }

  const command = optionalString(value.command);
  if (command && command.trim().length > 0) {
    const agentType = optionalAgentId(value.agentType);
    if (value.agentType !== undefined && value.agentType !== null && !agentType) {
      throw new Error(`${label} tool agentType must be one of ${RUNPANE_CONTRACT.enums.agents.join(', ')}`);
    }
    return {
      command,
      agentType,
      title: optionalString(value.title),
      initialInput: optionalString(value.initialInput),
      initialInputAsFilePointer: optionalBoolean(value.initialInputAsFilePointer),
    };
  }

  throw new Error(`${label} tool must include agent or command`);
}

function parseRepoSelector(value: PaneCommandValue): RunpaneRepoSelector {
  const selectorText = optionalString(value);
  if (selectorText !== undefined) return selectorText;

  if (!isRecord(value)) {
    throw new Error('Pane create request must include a repo selector');
  }

  const id = optionalNumber(value.id);
  if (id !== undefined) return { id };
  const selectorPath = optionalString(value.path);
  if (selectorPath !== undefined) return { path: selectorPath };
  const name = optionalString(value.name);
  if (name !== undefined) return { name };
  if (value.active === true) {
    return { active: true };
  }

  throw new Error('Repo selector must include id, path, name, active, or a string selector');
}

function resolveRepoSelector(projects: Project[], selector: RunpaneRepoSelector): Project {
  const selectorText = optionalString(selector);
  if (selectorText !== undefined) {
    if (selectorText === 'active' || selectorText === 'default') {
      return resolveActiveProject(projects);
    }

    if (/^\d+$/.test(selectorText)) {
      const byId = projects.find(project => project.id === Number(selectorText));
      if (byId) {
        return byId;
      }
    }

    const byPath = resolveProjectByPath(projects, selectorText);
    if (byPath) {
      return byPath;
    }

    return resolveProjectByName(projects, selectorText);
  }

  const selectorObject = decodeBoundary(selector, boundary.object({
    id: boundary.optional(boundary.number),
    path: boundary.optional(boundary.string),
    name: boundary.optional(boundary.string),
    active: boundary.optional(boundary.literal(true)),
  }));

  if (selectorObject.id !== undefined) {
    const project = projects.find(candidate => candidate.id === selectorObject.id);
    if (!project) {
      throw new Error(`No Pane repo found with id ${selectorObject.id}. Run \`runpane repos list\` to see saved repos, or \`runpane repos add --path <absolute path> --yes\` to add one.`);
    }
    return project;
  }

  if (selectorObject.path !== undefined) {
    const project = resolveProjectByPath(projects, selectorObject.path);
    if (!project) {
      throw new Error(`No Pane repo found at path ${selectorObject.path}. Run \`runpane repos list\` to see saved repos, or \`runpane repos add --path <absolute path> --yes\` to add one.`);
    }
    return project;
  }

  if (selectorObject.name !== undefined) {
    return resolveProjectByName(projects, selectorObject.name);
  }

  return resolveActiveProject(projects);
}

function resolveActiveProject(projects: Project[]): Project {
  const active = projects.find(project => Boolean(project.active));
  if (!active) {
    throw new Error('No active Pane repo found');
  }
  return active;
}

function resolveProjectByPath(projects: Project[], selectorPath: string): Project | undefined {
  const key = projectRegistrationKey({ path: selectorPath });
  return projects.find(project => projectRegistrationKey(project) === key);
}

function resolveProjectByName(projects: Project[], selectorName: string): Project {
  const matches = projects.filter(project => project.name.toLowerCase() === selectorName.toLowerCase());
  if (matches.length === 0) {
    throw new Error(`No Pane repo found named "${selectorName}". Run \`runpane repos list\` to see saved repos, or \`runpane repos add --path <absolute path> --yes\` to add one.`);
  }
  if (matches.length > 1) {
    throw new Error(`Multiple Pane repos are named "${selectorName}". Use --repo-id or an exact path.`);
  }
  return matches[0];
}

function resolveToolSpec(tool: RunpaneToolSpec, environment?: ProjectEnvironment): RunpaneResolvedTool {
  if ('agent' in tool) {
    const template = AGENT_TEMPLATES[tool.agent];
    if (environment && !isAgentSupportedOnPlatform(tool.agent, environment)) {
      throw new Error(`${template.title} is not supported on ${environment} repos.`);
    }
    return {
      title: tool.title ?? template.title,
      command: template.command,
      agent: tool.agent,
      initialInput: tool.initialInput,
      initialInputAsFilePointer: tool.initialInputAsFilePointer,
    };
  }

  const declaredAgent = tool.agentType;
  if (!declaredAgent) {
    return {
      title: tool.title ?? 'Terminal',
      command: tool.command,
      initialInput: tool.initialInput,
      initialInputAsFilePointer: tool.initialInputAsFilePointer,
    };
  }

  // `--agent` with `--tool-command` names the agent the command runs. A
  // wrapper is launched as given; a plain agent command keeps its usual launch.
  return {
    title: tool.title ?? AGENT_TEMPLATES[declaredAgent].title,
    command: tool.command,
    agent: declaredAgent,
    launchMode: resolveAgentTypeFromCommand(tool.command) === declaredAgent ? undefined : 'wrapped',
    initialInput: tool.initialInput,
    initialInputAsFilePointer: tool.initialInputAsFilePointer,
  };
}

/** Panel custom state for a tool's agent identity and launch command. */
function toolAgentIdentityState(tool: RunpaneResolvedTool): TerminalPanelState {
  const state: TerminalPanelState = {
    agentType: tool.agent,
    launchCommand: tool.command,
    isCliPanel: Boolean(tool.agent),
  };
  if (tool.launchMode === 'wrapped') {
    state.launchMode = 'wrapped';
    state.agentDetection = 'declared';
  }
  return state;
}

type DescribedTool = Pick<RunpaneResolvedTool, 'title' | 'command' | 'agent'>;

function describeTool(tool: RunpaneResolvedTool): DescribedTool {
  return {
    title: tool.title,
    command: tool.command,
    agent: tool.agent,
  };
}

function createFailureItem(
  index: number,
  item: RunpanePaneCreateItem,
  cause: unknown,
  sessionId?: string,
  worktreePath?: string,
): RunpanePaneCreateFailureItem {
  return {
    ok: false,
    index,
    name: item.name,
    sessionId,
    paneId: sessionId,
    worktreePath,
    error: {
      message: cause instanceof Error ? cause.message : String(cause),
      code: 'ERR_RUNPANE_PANE_CREATE_FAILED',
    },
  };
}

function parsePositiveInteger(value: PaneCommandValue, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const numberValue = optionalNumber(value);
  if (numberValue === undefined || !Number.isInteger(numberValue) || numberValue <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return numberValue;
}

function toIsoString(value: Date | string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toISOString();
}

function requireIsoString(value: Date | string | undefined, label: string): string {
  const isoString = toIsoString(value);
  if (!isoString) {
    throw new Error(`${label} is invalid`);
  }
  return isoString;
}

interface RunpaneActionMetadata {
  repoId?: number;
  paneId?: string;
  panelId?: string;
  resultCount?: number;
  inputBytes?: number;
  limit?: number;
  ok?: boolean;
  condition?: string;
  timedOut?: boolean;
  available?: boolean;
  environment?: string;
}

async function withRunpaneAction<T extends { ok: boolean }>(
  services: AppServices,
  action: string,
  metadata: RunpaneActionMetadata,
  handler: () => Promise<T> | T,
  resultMetadata?: (result: T) => RunpaneActionMetadata,
  shouldTrackResult: (result: T) => boolean = () => true,
): Promise<T> {
  const startedAt = Date.now();
  const generation = MUTATING_RUNPANE_ACTIONS.has(action)
    ? services.workspaceJournal?.generation
    : undefined;
  try {
    const result = await handler();
    if (generation !== undefined && !('dryRun' in result && result.dryRun === true)) {
      Object.assign(result, { generation });
    }
    const commandOk = result.ok;
    const actionMetadata: RunpaneActionMetadata = {
      ...metadata,
      ok: commandOk,
    };
    if (resultMetadata) {
      Object.assign(actionMetadata, resultMetadata(result));
    }
    if (shouldTrackResult(result)) {
      trackRunpaneAction(services, action, 'success', Date.now() - startedAt, actionMetadata);
    }
    return result;
  } catch (error) {
    trackRunpaneAction(services, action, 'failure', Date.now() - startedAt, {
      ...metadata,
      ok: false,
    }, error);
    throw error;
  }
}

function createWorkspaceJournal(services: AppServices): WorkspaceJournal {
  const journal = new WorkspaceJournal({
    resolvePane: (paneId) => {
      const session = services.sessionManager.getSession(paneId);
      if (!session) return undefined;
      const project = services.sessionManager.getProjectForSession(paneId);
      return {
        paneId,
        paneName: session.name,
        repoId: project?.id,
        repoName: project?.name,
        worktreePath: session.worktreePath,
      };
    },
    resolvePanel: (panelId) => {
      const panel = panelManager.getPanel(panelId);
      if (!panel) return undefined;
      const snapshot = terminalPanelManager.getTerminalSnapshot(panelId);
      const customState = isRecord(panel.state.customState) ? panel.state.customState : {};
      return {
        panelId,
        paneId: panel.sessionId,
        panelTitle: panel.title,
        isCliPanel: snapshot?.isCliPanel ?? optionalBoolean(customState.isCliPanel) ?? false,
        agentType: snapshot?.agentType ?? optionalString(customState.agentType),
        lastActivityAt: snapshot?.lastActivityTime,
        screenText: snapshot?.screenText,
      };
    },
    resolveSessionMembership: sessionId => services.orchestrationSessionManager?.workspaceMembership(sessionId),
  });
  const sessions = services.sessionManager.getAllSessions();
  for (const session of sessions) {
    const project = services.sessionManager.getProjectForSession(session.id);
    journal.rememberPane({
      paneId: session.id,
      paneName: session.name,
      repoId: project?.id,
      repoName: project?.name,
      worktreePath: session.worktreePath,
    });
  }
  return journal;
}

function workspaceCadenceOptions(
  request: RunpaneWorkspaceWaitRequest,
  filter: WorkspaceJournalFilter,
  idleSchedule: WorkspaceIdleSchedule,
): WatchCadenceOptions | undefined {
  const settleMs = request.settleMs ?? 0;
  const blockedSettleMs = request.blockedSettleMs ?? 0;
  const minIntervalMs = request.minIntervalMs ?? 0;
  if (settleMs <= 0 && blockedSettleMs <= 0 && minIntervalMs <= 0) return undefined;
  const key = JSON.stringify({
    settleMs,
    blockedSettleMs,
    minIntervalMs,
    idleAfterMs: idleSchedule.idleAfterMs,
    idleBackoff: idleSchedule.backoff === true,
    filter: workspaceFilterKey(filter),
  });
  return { settleMs, blockedSettleMs, minIntervalMs, emitKinds: request.kinds, key };
}

function workspaceNextCommand(
  request: RunpaneWorkspaceWaitRequest,
  generation: number,
  session: { id: string } | undefined,
): string {
  const cursor = request.as ? `--as ${request.as}` : `--since ${generation}`;
  return `runpane watch ${cursor}${session ? ` --session ${session.id}` : ''}`;
}

function workspaceIdleCandidates(
  workspaceStateReader: WorkspaceStateReader,
  workspaceJournal: WorkspaceJournal,
  repoId?: number,
): WorkspaceIdleCandidate[] {
  return workspaceStateReader.listManagedCliPanels(repoId).flatMap((panel) => {
    if (panel.agentState !== 'idle' || !panel.agentType) return [];
    const snapshotTime = panel.lastActivityTime ? Date.parse(panel.lastActivityTime) : Number.NaN;
    const idleSinceMs = workspaceJournal.readySince(panel.panelId)
      ?? (Number.isFinite(snapshotTime) ? snapshotTime : undefined);
    if (idleSinceMs === undefined) return [];
    return [{ ...panel, agentType: panel.agentType, idleSinceMs }];
  });
}

function trackRunpaneAction(
  services: AppServices,
  action: string,
  status: 'success' | 'failure',
  durationMs: number,
  metadata: RunpaneActionMetadata,
  cause?: unknown,
): void {
  const analyticsManager = services.analyticsManager;
  const paneIdHash = metadata.paneId && analyticsManager?.hashSessionId(metadata.paneId);
  const panelIdHash = metadata.panelId && analyticsManager?.hashSessionId(metadata.panelId);
  const errorMessage = cause instanceof Error ? cause.message : cause ? String(cause) : undefined;
  const errorType = cause instanceof Error ? cause.name : cause ? 'Error' : undefined;

  analyticsManager?.track('runpane_local_control', {
    action,
    status,
    command_ok: metadata.ok,
    duration_ms: durationMs,
    repo_id: metadata.repoId,
    pane_id_hash: paneIdHash,
    panel_id_hash: panelIdHash,
    result_count: metadata.resultCount,
    input_bytes: metadata.inputBytes,
    limit: metadata.limit,
    condition: metadata.condition,
    timed_out: metadata.timedOut,
    available: metadata.available,
    environment: metadata.environment,
    error_type: errorType,
  });

  const logPayload = {
    action,
    status,
    commandOk: metadata.ok,
    durationMs,
    repoId: metadata.repoId,
    paneIdHash,
    panelIdHash,
    resultCount: metadata.resultCount,
    inputBytes: metadata.inputBytes,
    limit: metadata.limit,
    condition: metadata.condition,
    timedOut: metadata.timedOut,
    available: metadata.available,
    environment: metadata.environment,
    error: errorMessage,
  };

  if (status === 'success') {
    console.log('[Runpane] Local control action completed', logPayload);
  } else {
    console.warn('[Runpane] Local control action failed', logPayload);
  }
}

function agentCommandExecutable(command: string): string {
  const executable = command.trim().split(/\s+/)[0];
  if (!executable || !/^[A-Za-z0-9._-]+$/.test(executable)) {
    throw new Error(`Unsupported agent command executable: ${command}`);
  }
  return executable;
}

function firstNonEmptyLine(value: string | undefined): string | undefined {
  return value
    ?.split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.length > 0);
}

function commandErrorMessage(cause: unknown, fallback: string): string {
  try {
    const details = decodeBoundary(cause, boundary.object({
      stderr: boundary.optional(boundary.string),
      stdout: boundary.optional(boundary.string),
    }));
    const stderr = firstNonEmptyLine(details.stderr);
    const stdout = firstNonEmptyLine(details.stdout);
    if (stderr) return stderr;
    if (stdout) return stdout;
  } catch {
    // Fall through to the standard Error contract.
  }
  if (cause instanceof Error && cause.message) {
    return cause.message;
  }
  return fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function optionalString(value: PaneCommandValue): string | undefined {
  try {
    return decodeBoundary(value, boundary.string);
  } catch {
    return undefined;
  }
}

function isRecord(value: PaneCommandValue): value is Record<string, PaneCommandValue> {
  try {
    decodeBoundary(value, boundary.jsonObject);
    return true;
  } catch {
    return false;
  }
}

function optionalBoolean(value: PaneCommandValue): boolean | undefined {
  try {
    return decodeBoundary(value, boundary.boolean);
  } catch {
    return undefined;
  }
}

function optionalNumber(value: PaneCommandValue): number | undefined {
  try {
    return decodeBoundary(value, boundary.number);
  } catch {
    return undefined;
  }
}

function optionalAgentId(value: PaneCommandValue): RunpaneAgentId | undefined {
  try {
    return decodeBoundary(value, boundary.enumeration(...RUNPANE_CONTRACT.enums.agents));
  } catch {
    return undefined;
  }
}
