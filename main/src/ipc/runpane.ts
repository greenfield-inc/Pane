import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { IpcMain } from 'electron';
import type { AppServices } from './types';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import { PathResolver, ProjectEnvironment } from '../utils/pathResolver';
import { sanitizeTerminalOutput } from '../utils/terminalOutputSanitizer';
import { escapeShellArg } from '../utils/shellEscape';
import { getGitAttributionEnv } from '../utils/attribution';
import { panelManager } from '../services/panelManager';
import { terminalPanelManager, type TerminalPanelSnapshot } from '../services/terminalPanelManager';
import { databaseService as panelDatabase } from '../services/database';
import type { PanelBuffers } from '../database/panelBuffers';
import { ensureProjectAgentContext } from '../services/agentContextManager';
import { fastCheckWorkingDirectory, listCommitsAhead } from '../services/gitPlumbingCommands';
import { assessComposerEvidence, isSlashCommandInput } from './runpaneComposerEvidence';
import {
  DEFAULT_HANDOFF_REPORT_LINES,
  HANDOFF_NOTE_FILENAME,
  parseHandoffTarget,
  receiveCommandFor,
  renderHandoffNote,
  type HandoffTarget,
} from './runpaneHandoff';
import { projectWorkspaceEntry } from '../services/workspaceJournal';
import type { ArchiveProgressManager, SerializedArchiveTask } from '../services/archiveProgressManager';
import type { CommandRunner } from '../utils/commandRunner';
import type { Project } from '../database/models';
import type { AppConfig } from '../types/config';
import type { Session, SessionOutput } from '../types/session';
import type { CreatePanelRequest, TerminalPanelState, ToolPanel } from '../../../shared/types/panels';
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
  RunpanePaneArchiveRequest,
  RunpanePaneArchiveResult,
  RunpanePaneArchiveSafetyCheck,
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
  RunpanePaneCreateFailureItem,
  RunpanePaneCreateItem,
  RunpanePaneCreateRequest,
  RunpanePaneCreateResult,
  RunpanePaneCreateResultItem,
  RunpanePaneHandoffBlockReason,
  RunpanePaneHandoffMode,
  RunpanePaneHandoffRequest,
  RunpanePaneHandoffResult,
  RunpanePaneReadiness,
  RunpanePaneSummary,
  RunpanePanelActivityStatus,
  RunpanePanelBlockedState,
  RunpanePanelCreateRequest,
  RunpanePanelCreateResult,
  RunpanePanelInputRequest,
  RunpanePanelInputResult,
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
  RunpaneResolvedTool,
  RunpaneToolSpec,
  RunpaneWorktreeCleanupState,
  RunpaneWorkspaceEntry,
  RunpaneWorkspaceEntryKind,
  RunpaneWorkspaceStateResult,
  RunpaneWorkspaceWaitRequest,
  RunpaneWorkspaceWaitResult,
} from '../../../shared/types/runpaneOrchestration';
import { getAppDirectory } from '../utils/appDirectory';
import { collectRemoteDaemonExecutableHealth } from '../daemon/remoteDaemonExecutableHealth';
import { WorkspaceJournal, type WorkspaceJournalFilter } from '../services/workspaceJournal';
import { WorkspaceStateReader } from '../services/workspaceStateReader';
import { WorkspaceCursorStore } from '../services/workspaceCursorStore';
import { usageManager } from '../services/usage/usageManager';
import { parseWSLPath } from '../utils/wslUtils';
import {
  dueIdleEntries,
  nextIdleDeadline,
  type WorkspaceIdleCandidate,
} from '../services/workspaceIdleTracker';

const RUNPANE_CHANNELS = [
  'runpane:doctor',
  'runpane:repos:list',
  'runpane:repos:add',
  'runpane:panes:list',
  'runpane:panes:cost',
  'runpane:panes:create',
  'runpane:panes:adopt',
  'runpane:panes:pin',
  'runpane:panes:rename',
  'runpane:panes:archive',
  'runpane:panes:handoff',
  'runpane:panels:create',
  'runpane:panels:list',
  'runpane:panels:output',
  'runpane:panels:input',
  'runpane:panels:screen',
  'runpane:panels:submit',
  'runpane:panels:submit-composer',
  'runpane:panels:wait',
  'runpane:workspace:state',
  'runpane:workspace:wait',
  'runpane:agents:doctor',
] as const;

const AGENT_TEMPLATES = RUNPANE_CONTRACT.agentTemplates;
const AGENT_IDS = new Set<string>(RUNPANE_CONTRACT.enums.agents);
const DEFAULT_PANEL_OUTPUT_LIMIT = 200;
const DEFAULT_PANEL_SCREEN_LIMIT = 80;
const DEFAULT_PANEL_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_PANEL_WAIT_INTERVAL_MS = 500;
const DEFAULT_COMPOSER_VERIFY_TIMEOUT_MS = 3_000;
const DEFAULT_COMPOSER_VERIFY_INTERVAL_MS = 100;
const CODEX_SUBMIT_STAGE_DELAY_MS = 500;
const MAX_CREATE_SUBMIT_ATTEMPTS = 3;
const CREATE_SUBMIT_CONFIRMATION_DELAY_MS = 400;
const DEFAULT_ARCHIVE_CLEANUP_TIMEOUT_MS = 30_000;
const DEFAULT_ARCHIVE_CLEANUP_POLL_INTERVAL_MS = 200;
const DEFAULT_WORKSPACE_WAIT_TIMEOUT_MS = 60_000;
const MAX_WORKSPACE_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_WORKSPACE_WAIT_LIMIT = 256;
const WORKSPACE_CONSUMER_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;
const MUTATING_RUNPANE_ACTIONS = new Set([
  'panes:create',
  'panes:adopt',
  'panes:archive',
  'panes:handoff',
  'panes:pin',
  'panes:rename',
  'panels:create',
  'panels:input',
  'panels:submit',
  'panels:submit-composer',
]);

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
  const lastReadAtByConsumer = new Map<string, number>();
  services.workspaceJournal = workspaceJournal;
  services.workspaceStateReader = workspaceStateReader;
  services.workspaceCursorStore = workspaceCursorStore;

  commandRegistry.register('runpane:doctor', async (): Promise<RunpaneDoctorResult> => {
    return withRunpaneAction(services, 'doctor', {}, () => {
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
          executableHealth: collectRemoteDaemonExecutableHealth(getAppDirectory()),
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

      validateRepositoryPath(normalized.path);

      const preview = {
        name: normalized.name,
        path: normalized.path,
        alreadyExists: false,
        wouldCreate: true,
        environment: new PathResolver({ path: normalized.path }).environment,
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
        normalized.path,
        undefined,
        undefined,
        undefined,
        'ignore',
      );

      try {
        await ensureProjectAgentContext(project, configManager.getConfig());
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
          if (!session) throw new Error(`No Pane pane found with id ${normalized.paneId}`);
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

      const updatedSession = databaseService.setSessionFavorite(normalized.paneId, normalized.pinned);
      if (!updatedSession) {
        throw new Error(`Failed to update pinned state for Pane ${normalized.paneId}`);
      }

      pane.isFavorite = Boolean(updatedSession.is_favorite);
      pane.favoritePinnedAt = updatedSession.favorite_pinned_at ?? undefined;
      sessionManager.emit('session-updated', pane);

      return {
        ok: true,
        paneId: normalized.paneId,
        pinned: Boolean(updatedSession.is_favorite),
        favoritePinnedAt: updatedSession.favorite_pinned_at ?? undefined,
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

      const updatedSession = databaseService.updateSession(pane.id, { name: normalized.name });
      if (!updatedSession) {
        throw new Error(`Failed to rename Pane ${pane.id}`);
      }

      pane.name = normalized.name;
      sessionManager.emit('session-updated', pane);

      return {
        ok: true,
        pane: sessionToPaneSummary(pane, project),
      };
    }, result => ({ paneId: result.pane.paneId }));
  });

  commandRegistry.register('runpane:panes:create', async (request: PaneCommandValue): Promise<RunpanePaneCreateResult> => {
    return withRunpaneAction(services, 'panes:create', {}, async () => {
      const normalized = parsePaneCreateRequest(request);
      const repo = resolveRepoSelector(databaseService.getAllProjects(), normalized.repo);
      const repoSummary = projectToRepoSummary(repo, sessionManager.getSessionsForProject(repo.id).length);

      if (normalized.dryRun) {
        return {
          ok: true,
          repo: repoSummary,
          items: normalized.panes.map((pane, index) => ({
            ok: true,
            index,
            name: pane.name,
            pinned: Boolean(pane.pinned),
            tool: describeTool(resolveToolSpec(pane.tool, new PathResolver(repo).environment)),
          })),
        };
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
          const existing = findSessionByWorktreeIdentity(
            databaseService.getAllSessionsIncludingArchived({ includeHidden: true }),
            validatedPath.identityPath,
            validatedPath.pathResolver,
          );
          if (existing) {
            throw new Error(`Worktree path is already registered by pane "${existing.name}" (${existing.id})`);
          }
          const tool = resolveToolSpec(item.tool, new PathResolver(repo).environment);
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
          await Promise.all([
            panelManager.ensureExplorerPanel(session.id),
            panelManager.ensureDiffPanel(session.id),
          ]);

          const resumeCommand = item.resume && tool.agent
            ? buildAdoptResumeCommand(tool.agent, item.resume)
            : tool.command;
          const initialState: TerminalPanelState = {
            initialCommand: item.launch ? resumeCommand : undefined,
            agentType: tool.agent,
            agentSessionId: item.resume,
            hasClaudeSessionId: tool.agent === 'claude' && Boolean(item.resume),
            isCliPanel: Boolean(tool.agent),
          };
          const panel = await panelManager.createPanel({
            sessionId: session.id,
            type: 'terminal',
            title: tool.title,
            initialState,
            activate: normalized.focus === true,
          });
          const context = sessionManager.getProjectContext(session.id);
          await terminalPanelManager.initializeTerminal(panel, storedWorktreePath, context?.commandRunner.wslContext ?? null);
          if (!item.launch) {
            terminalPanelManager.writeToTerminal(panel.id, resumeCommand);
          }
          sessionManager.emitSessionCreated(stoppedSession, {
            activateOnCreate: normalized.focus === true,
            createDefaultTerminalOnCreate: false,
          });
          items.push({
            ok: true,
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
            nextCommand: panelOutputCommand(panel.id),
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

  commandRegistry.register('runpane:panes:archive', async (request: PaneCommandValue): Promise<RunpanePaneArchiveResult> => {
    return withRunpaneAction(
      services,
      'panes:archive',
      {},
      () => archivePane(services, commandRegistry, parsePaneArchiveRequest(request)),
      result => ({ paneId: result.paneId, ok: result.ok }),
    );
  });

  commandRegistry.register('runpane:panes:handoff', async (request: PaneCommandValue): Promise<RunpanePaneHandoffResult> => {
    return withRunpaneAction(
      services,
      'panes:handoff',
      {},
      () => handoffPane(services, commandRegistry, parsePaneHandoffRequest(request)),
      result => ({ paneId: result.paneId, ok: result.ok }),
    );
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
      const { panel, readiness, initialInput } = await createTerminalPanelForSession(services, pane, tool, {
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
        nextCommand: initialInput?.nextCommand ?? readiness?.nextCommand ?? panelOutputCommand(panel.id),
      };
    }, result => ({
      paneId: result.paneId,
      panelId: result.panelId,
      ok: result.ok,
      resultCount: 1,
    }));
  });

  commandRegistry.register('runpane:panels:output', async (request: PaneCommandValue): Promise<RunpanePanelOutputResult> => {
    return withRunpaneAction(services, 'panels:output', {}, () => {
      const normalized = parsePanelOutputRequest(request);
      const panel = resolvePanel(normalized.panelId);
      const limit = normalized.limit ?? DEFAULT_PANEL_OUTPUT_LIMIT;
      const scrollbackResult = panel.type === 'terminal' ? panelScrollbackOutput(panel, limit) : null;

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

      const beforeScreen = await buildPanelScreenResult(panel, DEFAULT_PANEL_SCREEN_LIMIT);
      const stagedInput = stripSubmitEnter(normalized.input);
      if (
        stagedInput.length > 0 &&
        beforeScreen.state.agentType === 'codex' &&
        beforeScreen.state.activityStatus === 'idle' &&
        beforeScreen.state.isCliReady === true &&
        beforeScreen.composer.isPresent
      ) {
        terminalPanelManager.writeToTerminal(panel.id, stagedInput);
        await sleep(CODEX_SUBMIT_STAGE_DELAY_MS);
        const submission = await submitComposerForPanel(panel, 'auto');
        return {
          ok: submission.ok,
          panelId: panel.id,
          paneId: panel.sessionId,
          inputBytes: Buffer.byteLength(stagedInput, 'utf8') + submission.inputBytes,
          enter: 'cr',
          sequenceName: submission.sequenceName,
          verifiedSubmitted: submission.verifiedSubmitted,
          verification: submission.verification,
          sentAt: submission.sentAt,
          blocked: submission.blocked,
          nextCommand: submission.nextCommand,
        };
      }

      const input = ensureSubmitEnter(normalized.input);
      terminalPanelManager.writeToTerminal(panel.id, input);

      return {
        ok: true,
        panelId: panel.id,
        paneId: panel.sessionId,
        inputBytes: Buffer.byteLength(input, 'utf8'),
        enter: 'cr',
        sequenceName: 'enter-cr',
        verifiedSubmitted: false,
        sentAt: new Date().toISOString(),
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

      return submitComposerForPanel(panel, normalized.strategy);
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
      const filter: WorkspaceJournalFilter = {
        kinds: normalized.kinds,
        paneIds: normalized.paneIds,
        excludePaneIds: normalized.excludePaneIds,
        repoId: project?.id,
        nameContains: normalized.nameContains,
        agentsOnly: normalized.agentsOnly,
        includeHeldInput: normalized.includeHeldInput,
        includeHeldInputPresence: normalized.includeHeldInputPresence,
      };
      const timeoutMs = Math.min(normalized.timeoutMs ?? DEFAULT_WORKSPACE_WAIT_TIMEOUT_MS, MAX_WORKSPACE_WAIT_TIMEOUT_MS);
      const limit = normalized.limit ?? DEFAULT_WORKSPACE_WAIT_LIMIT;
      const idleAfterMs = normalized.idleAfterMs ?? 0;
      const requestStartedAt = Date.now();
      const idleWindowStart = normalized.idleWindowStartMs ?? (normalized.as
        ? lastReadAtByConsumer.get(normalized.as) ?? 0
        : normalized.since !== undefined ? 0 : requestStartedAt);
      let cursor = normalized.since ?? workspaceJournal.generation;
      let reset: RunpaneWorkspaceWaitResult['reset'];
      const currentIdleEntries = (): RunpaneWorkspaceEntry[] => dueIdleEntries(
        workspaceIdleCandidates(workspaceStateReader, workspaceJournal, project?.id),
        idleAfterMs,
        idleWindowStart,
        Date.now(),
        workspaceJournal.generation,
      )
        .filter(entry => workspaceEntryMatches(entry, filter))
        .map(entry => projectWorkspaceEntry(entry, filter));

      if (normalized.as) {
        const evicted = workspaceCursorStore.evictStale();
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
        const baseline = silentBaseline ? [] : workspaceStateReader.read(project?.id).entries
          .filter(entry => workspaceEntryMatches(entry, filter))
          .map(entry => projectWorkspaceEntry(entry, filter))
          .map(entry => reset?.reason === 'epoch-changed' ? { ...entry, changedWhileAway: true as const } : entry);
        const entries = [...baseline, ...currentIdleEntries()];
        if (normalized.as) lastReadAtByConsumer.set(normalized.as, Date.now());
        return {
          ok: true,
          epoch: workspaceJournal.epoch,
          generation: workspaceJournal.generation,
          entries,
          timedOut: false,
          reset,
          nextCommand: workspaceNextCommand(normalized, workspaceJournal.generation),
        };
      }

      const initial = workspaceJournal.readAfter(cursor, filter, limit);
      const initialIdle = currentIdleEntries();
      let waited: Awaited<ReturnType<WorkspaceJournal['waitAfter']>>;
      if (initial.entries.length > 0 || initial.dropped !== undefined || initialIdle.length > 0) {
        waited = { ...initial, timedOut: initial.entries.length === 0 };
      } else {
        const deadline = nextIdleDeadline(
          workspaceIdleCandidates(workspaceStateReader, workspaceJournal, project?.id),
          idleAfterMs,
          Date.now(),
        );
        const parkMs = deadline === undefined
          ? timeoutMs
          : Math.max(0, Math.min(timeoutMs, deadline - Date.now()));
        waited = await workspaceJournal.waitAfter(
          cursor,
          filter,
          parkMs,
          limit,
          normalized.as ?? 'anonymous',
        );
      }
      if (waited.dropped) {
        reset = { reason: 'cursor-truncated' };
      }
      let entries = waited.entries;
      if (reset) {
        entries = workspaceStateReader.read(project?.id).entries
          .filter(entry => workspaceEntryMatches(entry, filter))
          .map(entry => projectWorkspaceEntry(entry, filter));
      }
      entries = [...entries, ...currentIdleEntries()];

      if (normalized.as && (!waited.timedOut || waited.dropped !== undefined)) {
        workspaceCursorStore.advance(
          normalized.as,
          waited.generation,
          workspaceJournal.epoch,
          !normalized.ackNow,
        );
      }
      if (normalized.as) lastReadAtByConsumer.set(normalized.as, Date.now());

      return {
        ok: true,
        epoch: workspaceJournal.epoch,
        generation: waited.generation,
        entries,
        timedOut: entries.length === 0 && waited.timedOut,
        dropped: waited.dropped,
        reset,
        nextCommand: workspaceNextCommand(normalized, waited.generation),
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
    status: session.status,
    agentStatus,
    worktreePath: session.worktreePath,
    repoId: project.id,
    repoName: project.name,
    panelCount: panels.length,
    pinned: Boolean(session.isFavorite),
    createdAt: toIsoString(session.createdAt),
    lastActivity: toIsoString(session.lastActivity),
    archived: session.archived || undefined,
    ownership: session.worktreeOwnership ?? 'pane',
    handedOffAt: session.handedOffAt,
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

function panelToSummary(panel: ToolPanel) {
  const customState = isRecord(panel.state.customState) ? panel.state.customState : {};
  const agentType = optionalAgentId(customState.agentType);
  const isCliPanel = optionalBoolean(customState.isCliPanel);

  return {
    id: panel.id,
    panelId: panel.id,
    paneId: panel.sessionId,
    type: panel.type,
    title: panel.title,
    active: Boolean(panel.state.isActive),
    initialized: panel.type === 'terminal' ? terminalPanelManager.isTerminalInitialized(panel.id) : undefined,
    agentType,
    isCliPanel,
    position: optionalNumber(panel.metadata.position),
    createdAt: toIsoString(panel.metadata.createdAt),
    lastActiveAt: toIsoString(panel.metadata.lastActiveAt),
  };
}

interface PaneCreateItemOptions {
  timeoutMs?: number;
  waitReady?: boolean;
  readyTimeoutMs?: number;
  activate?: boolean;
}

interface TerminalPanelCreateOptions {
  activate?: boolean;
  waitReady?: boolean;
  readyTimeoutMs?: number;
}

interface TerminalPanelCreateResult {
  panel: ToolPanel;
  readiness?: RunpanePaneReadiness;
  initialInput?: RunpaneInitialInputDeliveryResult;
}

async function createTerminalPanelForSession(
  services: AppServices,
  session: Session,
  tool: RunpaneResolvedTool,
  options: TerminalPanelCreateOptions,
): Promise<TerminalPanelCreateResult> {
  const useArgumentDelivery = shouldUseArgumentDelivery(tool);
  const shouldCreateSubmitInitialInput = Boolean(
    options.waitReady &&
    tool.agent &&
    tool.initialInput &&
    !useArgumentDelivery,
  );
  const initialState: TerminalPanelState = {
    initialCommand: tool.command,
    initialInput: tool.initialInput,
    initialInputSubmitStrategy: tool.agent === 'codex' && !useArgumentDelivery
      ? 'codex-ctrl-enter'
      : 'enter',
    agentType: tool.agent,
    isCliPanel: Boolean(tool.agent),
  };
  if (useArgumentDelivery) {
    initialState.initialInputMode = 'argument';
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
  const context = services.sessionManager.getProjectContext(session.id);
  await terminalPanelManager.initializeTerminal(
    panel,
    session.worktreePath,
    context?.commandRunner.wslContext ?? null,
  );

  const readiness = options.waitReady
    ? toPaneReadiness(await waitForPanel(panel, {
      panelId: panel.id,
      condition: 'ready',
      timeoutMs: options.readyTimeoutMs ?? DEFAULT_PANEL_WAIT_TIMEOUT_MS,
      intervalMs: DEFAULT_PANEL_WAIT_INTERVAL_MS,
    }))
    : undefined;

  const initialInput = readiness ? await submitCreateInitialInput(panel, tool, readiness) : undefined;

  return { panel, readiness, initialInput };
}

async function submitCreateInitialInput(
  panel: ToolPanel,
  tool: RunpaneResolvedTool,
  readiness?: RunpanePaneReadiness,
): Promise<RunpaneInitialInputDeliveryResult | undefined> {
  if (!tool.initialInput) {
    return undefined;
  }

  if (shouldUseArgumentDelivery(tool)) {
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
      error: { message: 'Initial input was not sent because the terminal panel did not become ready.' },
      nextCommand: readiness.nextCommand ?? panelWaitCommand(panel.id),
    };
  }

  terminalPanelManager.writeToTerminal(panel.id, tool.initialInput);
  await sleep(300);
  return submitCreateComposerInput(panel, tool);
}

async function clearInitialInputSentPremark(panel: ToolPanel): Promise<void> {
  const currentPanel = panelManager.getPanel(panel.id) ?? panel;
  const state = currentPanel.state ?? {};
  const customState = isRecord(state.customState) ? state.customState : {};
  if (!Object.prototype.hasOwnProperty.call(customState, 'initialInputSentAt')) {
    return;
  }

  const nextCustomState = { ...customState };
  delete nextCustomState.initialInputSentAt;
  await panelManager.updatePanel(panel.id, {
    state: {
      ...state,
      customState: nextCustomState,
    },
  });
}

function shouldUseArgumentDelivery(tool: RunpaneResolvedTool): boolean {
  return Boolean(
    tool.initialInput &&
    (tool.agent === 'claude' ||
      tool.agent === 'cursor' ||
      (tool.agent === 'codex' && !isSlashCommandInput(tool.initialInput))),
  );
}

async function submitCreateComposerInput(
  panel: ToolPanel,
  tool: RunpaneResolvedTool,
): Promise<RunpaneInitialInputDeliveryResult> {
  const input = tool.initialInput ?? '';
  const submit = resolveComposerSubmit('auto', tool.agent);
  const nextCommand = panelScreenCommand(panel.id);
  let lastVerdict: ReturnType<typeof assessComposerEvidence> = 'unknown';
  let attempts = 0;

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
      lastVerdict = assessComposerEvidence({
        beforeText: beforeScreen.text,
        afterText: afterScreen.text,
        stagedText: input,
      });

      if (lastVerdict === 'cleared' && panelHasFreshOutputSince(panel.id, outputGenerationBeforeSubmit)) {
        return {
          delivered: true,
          submitted: true,
          inputBytes: Buffer.byteLength(input, 'utf8'),
          strategy: submit.strategy,
          sequenceName: submit.sequenceName,
          verifiedSubmitted: true,
          verification: 'observed' as const,
          staged: false,
          attempts,
          sentAt: new Date().toISOString(),
          nextCommand,
        };
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
        stagedText: input,
      });
      const unchangedSinceFirstSample = assessComposerEvidence({
        beforeText: afterScreen.text,
        afterText: confirmationScreen.text,
        stagedText: input,
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

  return {
    delivered: true,
    submitted: false,
    inputBytes: Buffer.byteLength(input, 'utf8'),
    strategy: submit.strategy,
    sequenceName: submit.sequenceName,
    verifiedSubmitted: false,
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
    const sessionResult = await taskQueue.createSessionAndWait({
      prompt: item.sessionPrompt ?? '',
      worktreeTemplate: item.worktreeName ?? item.name,
      projectId: repo.id,
      baseBranch: item.baseBranch,
      toolType: 'none',
      startPinned: item.pinned,
      activateOnCreate: options.activate !== false,
    }, { timeoutMs: options.timeoutMs });

    createdSessionId = sessionResult.sessionId;

    const session = sessionManager.getSession(sessionResult.sessionId);
    if (!session) {
      throw new Error(`Created session ${sessionResult.sessionId} was not found`);
    }
    createdWorktreePath = session.worktreePath;

    const { panel, readiness, initialInput } = await createTerminalPanelForSession(services, session, tool, {
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
    };
  } catch (error) {
    return createFailureItem(index, item, error, createdSessionId, createdWorktreePath);
  }
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
  const composer = detectPanelComposer(bounded.text, state.agentType);

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

function detectPanelComposer(
  text: string,
  agentType: RunpaneAgentId | undefined,
): RunpanePanelScreenResult['composer'] {
  if (agentType !== 'codex') {
    return { isPresent: false, hasUndeliveredText: false };
  }

  const lines = text.split(/\r?\n/u).map(line => line.trim());
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index].match(/^[›❯]\s*(.*)$/u);
    if (!match) continue;

    const content = match[1].trim();
    const isPlaceholder = /^ask codex to do anything[.!]?$/iu.test(content);
    return {
      isPresent: true,
      hasUndeliveredText: content.length > 0 && !isPlaceholder,
    };
  }

  const hasPastedContent = /\[Pasted Content[^\]]*\]/iu.test(text);
  return {
    isPresent: hasPastedContent,
    hasUndeliveredText: hasPastedContent,
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
      if (blocked) return false;
      return screen.state.initialized && (screen.state.isCliPanel ? screen.state.isCliReady === true : true);
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

  if (/press enter to continue/i.test(text)) {
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

function stripSubmitEnter(input: string): string {
  if (input.endsWith('\r\n')) return input.slice(0, -2);
  if (input.endsWith('\r') || input.endsWith('\n')) return input.slice(0, -1);
  return input;
}

interface ComposerSubmit {
  strategy: 'codex-ctrl-enter' | 'enter';
  sequenceName: RunpanePanelSubmitComposerResult['sequenceName'];
  input: string;
}

function resolveComposerSubmit(
  strategy: RunpanePanelSubmitComposerStrategy | undefined,
  agentType: RunpaneAgentId | undefined,
): ComposerSubmit {
  if (strategy === 'codex-ctrl-enter' || ((!strategy || strategy === 'auto') && agentType === 'codex')) {
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

async function submitComposerForPanel(
  panel: ToolPanel,
  strategy: RunpanePanelSubmitComposerStrategy | undefined,
): Promise<RunpanePanelSubmitComposerResult> {
  const beforeScreen = await buildPanelScreenResult(panel, DEFAULT_PANEL_SCREEN_LIMIT);
  const state = beforeScreen.state;
  const submit = resolveComposerSubmit(strategy, state.agentType);
  const outputGenerationBeforeSubmit = terminalPanelManager.getOutputGeneration(panel.id);
  terminalPanelManager.writeToTerminal(panel.id, submit.input);
  const verification = await verifyComposerSubmitted(panel, beforeScreen, outputGenerationBeforeSubmit);

  return {
    ok: verification.ok,
    panelId: panel.id,
    paneId: panel.sessionId,
    inputBytes: Buffer.byteLength(submit.input, 'utf8'),
    strategy: submit.strategy,
    sequenceName: submit.sequenceName,
    verifiedSubmitted: verification.verifiedSubmitted,
    verification: verification.verification,
    sentAt: new Date().toISOString(),
    blocked: verification.blocked,
    nextCommand: verification.blocked?.suggestedCommand ?? panelWaitCommand(panel.id),
  };
}

async function verifyComposerSubmitted(
  panel: ToolPanel,
  beforeScreen: RunpanePanelScreenResult,
  outputGenerationBeforeSubmit: number,
): Promise<{
  ok: boolean;
  verifiedSubmitted: boolean;
  verification?: 'observed' | 'unverifiable';
  blocked?: RunpanePanelBlockedState;
}> {
  const beforeHadComposerPrompt = beforeScreen.composer.hasUndeliveredText || looksLikePendingComposer(beforeScreen.text);
  if (!beforeHadComposerPrompt && !beforeScreen.text.trim()) {
    return { ok: true, verifiedSubmitted: false };
  }
  const stagedText = composerEvidenceText(beforeScreen.text);
  let latestScreen = beforeScreen;
  const startedAt = Date.now();

  while (Date.now() - startedAt <= DEFAULT_COMPOSER_VERIFY_TIMEOUT_MS) {
    await sleep(DEFAULT_COMPOSER_VERIFY_INTERVAL_MS);
    latestScreen = await buildPanelScreenResult(panel, DEFAULT_PANEL_SCREEN_LIMIT);

    const verdict = assessComposerEvidence({
      beforeText: beforeScreen.text,
      afterText: latestScreen.text,
      stagedText,
    });
    const hasFreshOutput = panelHasFreshOutputSince(panel.id, outputGenerationBeforeSubmit);

    if (verdict === 'cleared' && hasFreshOutput) {
      return { ok: true, verifiedSubmitted: true, verification: 'observed' };
    }

    if (beforeHadComposerPrompt && !latestScreen.composer.hasUndeliveredText && !looksLikePendingComposer(latestScreen.text)) {
      return { ok: true, verifiedSubmitted: true, verification: 'observed' };
    }

  }

  if (beforeHadComposerPrompt && (latestScreen.composer.hasUndeliveredText || looksLikePendingComposer(latestScreen.text))) {
    return {
      ok: false,
      verifiedSubmitted: false,
      verification: panelHasFreshOutputSince(panel.id, outputGenerationBeforeSubmit) ? 'unverifiable' : undefined,
      blocked: {
        kind: 'agent-prompt',
        message: 'Pane sent the composer submit sequence, but the prompt still appears to be sitting in the composer.',
        suggestedCommand: panelScreenCommand(panel.id),
      },
    };
  }

  if (panelHasFreshOutputSince(panel.id, outputGenerationBeforeSubmit)) {
    return { ok: true, verifiedSubmitted: false, verification: 'unverifiable' };
  }

  return { ok: true, verifiedSubmitted: false };
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

function looksLikePendingComposer(text: string): boolean {
  return /\[Pasted (?:Content|text)[^\]]*\]/i.test(text) ||
    /(?:press\s+)?(?:ctrl|control)\+enter\s+to\s+submit/i.test(text);
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

function panelScrollbackOutput(panel: ToolPanel, limit: number): { text: string; hasMore: boolean; timestamp: string } | null {
  const rawScrollback = getPanelScrollback(panel);
  if (!rawScrollback) {
    return null;
  }

  const stripped = sanitizeTerminalOutput(rawScrollback);
  if (!stripped) {
    return null;
  }

  const allLines = stripped.split('\n');
  const hasMore = allLines.length > limit;
  const text = allLines.slice(-limit).join('\n');
  const timestamp = toIsoString(panel.metadata.lastActiveAt) ?? new Date().toISOString();

  return { text, hasMore, timestamp };
}

function getPanelScrollback(panel: ToolPanel): string | null {
  const liveScrollback = terminalPanelManager.getTerminalScrollback(panel.id);
  if (liveScrollback !== null) {
    return liveScrollback;
  }

  const persisted = panelDatabase.getPanelBuffers(panel.id)?.scrollback;
  if (persisted) return persisted;

  return null;
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
    throw new Error('Workspace wait as must contain 1-64 letters, numbers, dots, underscores, or hyphens');
  }
  const since = parseNonNegativeInteger(value.since, 'since');
  if (consumer && since !== undefined) throw new Error('Workspace wait request cannot include both as and since');
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
    paneIds: parseStringArray(value.paneIds, 'paneIds'),
    excludePaneIds: parseStringArray(value.excludePaneIds, 'excludePaneIds'),
    repo: value.repo === undefined || value.repo === null || value.repo === '' ? undefined : parseRepoSelector(value.repo),
    nameContains: optionalString(value.nameContains),
    agentsOnly: optionalBoolean(value.agentsOnly),
    ackNow: optionalBoolean(value.ackNow),
    includeHeldInput: optionalBoolean(value.includeHeldInput),
    includeHeldInputPresence: optionalBoolean(value.includeHeldInputPresence),
    idleAfterMs: parseNonNegativeInteger(value.idleAfterMs, 'idleAfterMs'),
    idleWindowStartMs: parseNonNegativeInteger(value.idleWindowStartMs, 'idleWindowStartMs'),
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

  return {
    repo,
    panes: panesValue.map(parsePaneCreateItem),
    dryRun: optionalBoolean(value.dryRun),
    timeoutMs: optionalNumber(value.timeoutMs),
    waitReady: optionalBoolean(value.waitReady),
    readyTimeoutMs: parsePositiveInteger(value.readyTimeoutMs, 'readyTimeoutMs'),
    concurrency: parsePositiveInteger(value.concurrency, 'concurrency'),
    noFocus: optionalBoolean(value.noFocus),
    focus: optionalBoolean(value.focus),
    source: value.source === 'user' || value.source === 'agent' ? value.source : undefined,
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
      return {
        path: worktreePath,
        name,
        baseBranch: optionalString(entry.baseBranch),
        folder: optionalString(entry.folder),
        pinned: optionalBoolean(entry.pinned),
        tool: parseRunpaneToolSpec(entry.tool, `Pane adopt item ${index}`),
        resume: optionalString(entry.resume),
        launch: optionalBoolean(entry.launch),
      };
    }),
    dryRun: optionalBoolean(value.dryRun),
    noFocus: optionalBoolean(value.noFocus),
    focus: optionalBoolean(value.focus),
    source: value.source === 'user' || value.source === 'agent' ? value.source : undefined,
  };
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

function buildAdoptResumeCommand(agent: RunpaneAgentId, sessionId: string): string {
  const id = escapeShellArg(sessionId);
  if (agent === 'claude') return `claude --resume ${id} --dangerously-skip-permissions`;
  if (agent === 'codex') return `codex resume --yolo ${id}`;
  return `cursor-agent --force --trust --resume ${id}`;
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
    value.strategy !== 'enter'
  ) {
    throw new Error('Panel submit-composer strategy must be auto, codex-ctrl-enter, or enter');
  }

  return {
    panelId,
    strategy: value.strategy === undefined
      ? undefined
      : decodeBoundary(value.strategy, boundary.enumeration('auto', 'codex-ctrl-enter', 'enter')),
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

  const repoPath = path.resolve(requestedPath);
  const providedName = optionalString(value.name)?.trim();
  const defaultName = path.basename(repoPath) || repoPath;

  return {
    path: repoPath,
    name: providedName && providedName.length > 0 ? providedName : defaultName,
    dryRun: optionalBoolean(value.dryRun),
  };
}

function resolvePane(sessionManager: AppServices['sessionManager'], paneId: string): Session {
  const session = sessionManager.getSession(paneId);
  if (!session) {
    throw new Error(`No Pane pane found with id ${paneId}`);
  }
  return session;
}

/**
 * Body of `runpane:panes:archive`, shared with `panes handoff --archive` so the
 * archive safety check and worktree cleanup wait run exactly once, unchanged.
 */
async function archivePane(
  services: AppServices,
  commandRegistry: PaneCommandRegistry,
  normalized: RunpanePaneArchiveRequest,
): Promise<RunpanePaneArchiveResult> {
  const { sessionManager } = services;
  const pane = resolvePane(sessionManager, normalized.paneId);

  if (pane.archived) {
    throw new Error(`Pane ${normalized.paneId} is already archived`);
  }

  const worktreeCleanupApplicable = Boolean(pane.projectId)
    && !pane.isMainRepo
    && pane.worktreeOwnership !== 'external';
  const safetyCheck = worktreeCleanupApplicable
    ? await computeArchiveSafety(services, pane)
    : { performed: false };

  const blockCode = classifyArchiveBlock(safetyCheck, worktreeCleanupApplicable);
  if (normalized.dryRun) {
    return {
      ok: true,
      paneId: normalized.paneId,
      dryRun: true,
      wouldArchive: Boolean(normalized.force) || !blockCode,
      forced: Boolean(normalized.force),
      safetyCheck: toPublicSafetyCheck(safetyCheck),
      blocked: blockCode
        ? {
            code: blockCode,
            message: describeArchiveBlock(blockCode, safetyCheck),
            safetyCheck: toPublicSafetyCheck(safetyCheck),
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
          safetyCheck: toPublicSafetyCheck(safetyCheck),
        },
        nextCommand: `runpane panes archive --pane ${normalized.paneId} --force --yes --json`,
      };
      return blocked;
    }
  }

  const cleanupWait = worktreeCleanupApplicable && services.archiveProgressManager
    ? waitForArchiveProgressCompletion(services.archiveProgressManager, normalized.paneId, DEFAULT_ARCHIVE_CLEANUP_TIMEOUT_MS)
    : null;

  const deleteResult = decodeBoundary(
    await commandRegistry.invoke('sessions:delete', [normalized.paneId]),
    boundary.object({
      success: boundary.boolean,
      error: boundary.optional(boundary.string),
    }),
  );
  if (!deleteResult.success) {
    throw new Error(deleteResult.error ?? `Failed to archive pane ${normalized.paneId}`);
  }

  let worktreeCleanup: RunpaneWorktreeCleanupState;
  if (!worktreeCleanupApplicable) {
    worktreeCleanup = 'not-applicable';
  } else if (cleanupWait) {
    worktreeCleanup = await cleanupWait;
  } else {
    worktreeCleanup = await waitForWorktreeRemovalByPolling(pane.worktreePath, DEFAULT_ARCHIVE_CLEANUP_TIMEOUT_MS);
  }

  const success: RunpanePaneArchiveSuccessResult = {
    ok: worktreeCleanup === 'completed' || worktreeCleanup === 'not-applicable',
    paneId: normalized.paneId,
    archived: true,
    forced: Boolean(normalized.force),
    worktreeCleanup,
    worktreePath: pane.worktreePath,
    safetyCheck: toPublicSafetyCheck(safetyCheck),
  };
  return success;
}

async function handoffPane(
  services: AppServices,
  commandRegistry: PaneCommandRegistry,
  normalized: RunpanePaneHandoffRequest,
): Promise<RunpanePaneHandoffResult> {
  const { sessionManager, databaseService, configManager } = services;
  const pane = resolvePane(sessionManager, normalized.paneId);
  if (pane.archived) {
    throw new Error(`Pane ${normalized.paneId} is already archived`);
  }
  const target = parseHandoffTarget(normalized.to);
  const to = normalized.to.trim();
  const mode: RunpanePaneHandoffMode = normalized.mode ?? 'park';
  const ctx = sessionManager.getProjectContext(pane.id);
  if (!ctx) {
    throw new Error(`Project context is unavailable for pane ${pane.id}`);
  }
  const project = sessionManager.getProjectForSession(pane.id);
  if (!project) {
    throw new Error(`No Pane repo found for pane ${pane.id}`);
  }
  const runner = ctx.commandRunner;
  const cwd = pane.worktreePath;
  const warnings = handoffTargetWarnings(configManager.getConfig(), target);

  // Steps 1-3 are read-only so a dry run can report exactly what a real run would refuse.
  let blocked: RunpanePaneHandoffBlockReason | undefined;
  if (pane.handedOffAt && !normalized.force) {
    blocked = {
      code: 'already-handed-off',
      message: `Pane ${pane.id} was already handed off at ${pane.handedOffAt}; rerun with --force to hand it off again`,
    };
  }
  const files = blocked
    ? []
    : parsePorcelainFiles((await runner.execAsync('git status --porcelain=v1', cwd, { silent: true })).stdout);
  if (!blocked && files.length > 0 && !normalized.includeDirty) {
    blocked = {
      code: 'uncommitted-changes',
      message: `Worktree has ${files.length} uncommitted change(s); rerun with --include-dirty to commit them as "handoff: work in progress"`,
      files,
    };
  }
  const upstream = await services.worktreeManager.getUpstream(cwd, runner);
  if (!blocked && upstream) {
    blocked = await checkFastForward(cwd, upstream, runner);
  }

  if (normalized.dryRun) {
    return {
      ok: true,
      paneId: pane.id,
      dryRun: true,
      wouldHandoff: !blocked,
      mode,
      files,
      upstream: upstream ?? undefined,
      blocked,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }
  if (blocked) {
    return { ok: false, paneId: pane.id, blocked, nextCommand: handoffNextCommand(normalized, blocked) };
  }

  // Step 4: commit the work if asked, then push it before anything else changes.
  if (files.length > 0) {
    try {
      await services.worktreeManager.gitStageAllAndCommit(cwd, 'handoff: work in progress', runner);
    } catch (error) {
      return {
        ok: false,
        paneId: pane.id,
        blocked: { code: 'commit-failed', message: `Could not commit the working tree: ${errorMessage(error)}`, gitOutput: gitErrorOutput(error) },
      };
    }
  }
  const workPush = await pushClassified(services, cwd, runner);
  if (!workPush.ok) {
    return { ok: false, paneId: pane.id, blocked: workPush.blocked, nextCommand: handoffRetryCommand(normalized) };
  }

  const branch = (await runner.execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd, { silent: true })).stdout.trim();
  const head = (await runner.execFile('git', ['rev-parse', 'HEAD'], cwd, { silent: true })).stdout.trim();

  // Step 5: write, commit, and push the note. The report is captured before any panel is touched.
  const reportPanel = latestCliPanel(panelManager.getPanelsForSession(pane.id));
  const limit = normalized.limit ?? DEFAULT_HANDOFF_REPORT_LINES;
  const report = reportPanel ? collectAgentReport(services, reportPanel, limit) : '';
  const agent: RunpaneAgentId | 'unknown' = reportPanel ? (getTerminalCustomState(reportPanel).agentType ?? 'unknown') : 'unknown';
  const pr = await services.gitStatusManager.fetchPrForSession(branch, project.path, runner);
  const handedOffAt = new Date().toISOString();
  const noteText = renderHandoffNote({
    pane: pane.name,
    branch,
    head,
    agent,
    target: to,
    pr: pr.prState === 'OPEN' ? pr.prUrl : undefined,
    handedOffAt,
    report,
  });
  const handoffPath = ctx.pathResolver.join(cwd, HANDOFF_NOTE_FILENAME);
  try {
    await fs.promises.writeFile(ctx.pathResolver.toFileSystem(handoffPath), noteText, 'utf8');
    await runner.execFile('git', ['add', '--', HANDOFF_NOTE_FILENAME], cwd, { silent: true });
    const staged = await runner.execFile('git', ['diff', '--cached', '--quiet', '--', HANDOFF_NOTE_FILENAME], cwd, { okExitCodes: [1], silent: true });
    if (staged.exitCode === 1) {
      await runner.execFile(
        'git',
        ['commit', '-m', `handoff: ${pane.name} to ${to}`, '--', HANDOFF_NOTE_FILENAME],
        cwd,
        { env: getGitAttributionEnv(configManager.getConfig()), silent: true },
      );
    }
  } catch (error) {
    return {
      ok: false,
      paneId: pane.id,
      blocked: { code: 'commit-failed', message: `Could not commit ${HANDOFF_NOTE_FILENAME}: ${errorMessage(error)}`, gitOutput: gitErrorOutput(error) },
    };
  }
  const notePush = await pushClassified(services, cwd, runner);
  if (!notePush.ok) {
    return { ok: false, paneId: pane.id, blocked: notePush.blocked, nextCommand: handoffRetryCommand(normalized) };
  }

  const receiveCommand = receiveCommandFor({ repoName: project.name, branch, agent });
  const common = {
    paneId: pane.id,
    branch,
    headSha: head,
    handoffPath,
    target: to,
    agent,
    pushed: { upstream: notePush.upstream },
    receiveCommand,
    warnings: warnings.length > 0 ? warnings : undefined,
  };

  // Step 6: park (default) or archive. The note is already on the branch upstream.
  if (mode === 'archive') {
    const archive = await archivePane(services, commandRegistry, { paneId: pane.id, source: normalized.source });
    return { ok: archive.ok, ...common, mode: 'archived', archive };
  }
  for (const panel of panelManager.getPanelsForSession(pane.id)) {
    if (panel.type !== 'terminal' || !getTerminalCustomState(panel).isCliPanel) continue;
    // Killing the PTY alone is not enough: re-viewing the panel re-runs its launch command.
    terminalPanelManager.destroyTerminal(panel.id);
    await panelManager.deletePanel(panel.id);
  }
  databaseService.updateSession(pane.id, { handed_off_at: handedOffAt });
  sessionManager.updateSession(pane.id, { status: 'stopped' });
  return { ok: true, ...common, mode: 'parked' };
}

function parsePaneHandoffRequest(value: PaneCommandValue): RunpanePaneHandoffRequest {
  if (!isRecord(value)) {
    throw new Error('Pane handoff request must be an object');
  }
  const paneId = optionalString(value.paneId)?.trim();
  if (!paneId) {
    throw new Error('Pane handoff request must include a paneId');
  }
  const to = optionalString(value.to)?.trim();
  if (!to) {
    throw new Error('Pane handoff request must include "to" (local or remote:<profile label>)');
  }
  parseHandoffTarget(to);
  if (value.mode !== undefined && value.mode !== 'park' && value.mode !== 'archive') {
    throw new Error('Pane handoff mode must be park or archive');
  }
  if (value.source !== undefined && value.source !== 'user' && value.source !== 'agent') {
    throw new Error('Pane handoff source must be user or agent');
  }
  const limit = optionalNumber(value.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error('Pane handoff limit must be a positive integer');
  }
  return {
    paneId,
    to,
    mode: value.mode === 'archive' ? 'archive' : value.mode === 'park' ? 'park' : undefined,
    includeDirty: optionalBoolean(value.includeDirty),
    force: optionalBoolean(value.force),
    limit,
    dryRun: optionalBoolean(value.dryRun),
    source: value.source === 'user' || value.source === 'agent' ? value.source : undefined,
  };
}

function handoffTargetWarnings(config: AppConfig | null | undefined, target: HandoffTarget): string[] {
  if (target.kind !== 'remote') return [];
  const profiles = config?.remoteDaemon?.client?.profiles ?? [];
  if (profiles.length === 0) return [];
  if (profiles.some(profile => profile.label === target.label)) return [];
  return [`No saved Remote Pane profile on this runtime is labeled "${target.label}"; the label is recorded as given.`];
}

function handoffBaseCommand(request: RunpanePaneHandoffRequest): string[] {
  const parts = ['runpane panes handoff', `--pane ${request.paneId}`, `--to ${request.to}`];
  if ((request.mode ?? 'park') === 'archive') parts.push('--archive');
  if (request.includeDirty) parts.push('--include-dirty');
  if (request.force) parts.push('--force');
  if (request.limit !== undefined) parts.push(`--limit ${request.limit}`);
  return parts;
}

function handoffNextCommand(request: RunpanePaneHandoffRequest, blocked: RunpanePaneHandoffBlockReason): string | undefined {
  const parts = handoffBaseCommand(request);
  if (blocked.code === 'uncommitted-changes') {
    if (!request.includeDirty) parts.push('--include-dirty');
  } else if (blocked.code === 'already-handed-off') {
    if (!request.force) parts.push('--force');
  } else {
    return undefined;
  }
  return [...parts, '--yes', '--json'].join(' ');
}

function handoffRetryCommand(request: RunpanePaneHandoffRequest): string {
  return [...handoffBaseCommand(request), '--yes', '--json'].join(' ');
}

function parsePorcelainFiles(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter(line => line.length > 3)
    .map(line => line.slice(3).trim())
    .filter(Boolean);
}

async function checkFastForward(
  cwd: string,
  upstream: string,
  runner: CommandRunner,
): Promise<RunpanePaneHandoffBlockReason | undefined> {
  const remote = await resolveUpstreamRemote(cwd, upstream, runner);
  await runner.execAsync(`git fetch --no-tags --prune ${escapeShellArg(remote)}`, cwd, { timeout: 30000 });
  const remoteHead = (await runner.execFile('git', ['rev-parse', upstream], cwd, { silent: true })).stdout.trim();
  const ancestor = await runner.execFile('git', ['merge-base', '--is-ancestor', upstream, 'HEAD'], cwd, { okExitCodes: [1], silent: true });
  if (ancestor.exitCode === 1) {
    return {
      code: 'non-fast-forward',
      message: `Upstream ${upstream} is at ${remoteHead}, which is not an ancestor of HEAD; pull or rebase before handing off`,
      upstream,
      remoteHead,
    };
  }
  return undefined;
}

type PushOutcome =
  | { ok: true; upstream: string }
  | { ok: false; blocked: RunpanePaneHandoffBlockReason };

async function pushClassified(services: AppServices, cwd: string, runner: CommandRunner): Promise<PushOutcome> {
  try {
    await services.worktreeManager.gitPush(cwd, runner);
    const upstream = await services.worktreeManager.getUpstream(cwd, runner);
    return { ok: true, upstream: upstream ?? 'origin' };
  } catch (error) {
    const gitOutput = gitErrorOutput(error);
    const upstream = await services.worktreeManager.getUpstream(cwd, runner);
    if (upstream) {
      try {
        const nonFastForward = await checkFastForward(cwd, upstream, runner);
        if (nonFastForward) return { ok: false, blocked: { ...nonFastForward, gitOutput } };
      } catch {
        // Fall through to the generic push failure below.
      }
    }
    return {
      ok: false,
      blocked: {
        code: 'push-failed',
        message: `git push failed: ${errorMessage(error)}`,
        upstream: upstream ?? undefined,
        gitOutput,
      },
    };
  }
}

function latestCliPanel(panels: readonly ToolPanel[]): ToolPanel | undefined {
  const candidates = panels.filter(panel => panel.type === 'terminal' && getTerminalCustomState(panel).isCliPanel);
  const activeAt = (panel: ToolPanel): number => {
    const parsed = Date.parse(toIsoString(panel.metadata.lastActiveAt) ?? '');
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return candidates.sort((left, right) => activeAt(right) - activeAt(left))[0];
}

function collectAgentReport(services: AppServices, panel: ToolPanel, limit: number): string {
  const scrollback = panelScrollbackOutput(panel, limit);
  if (scrollback?.text) return scrollback.text;
  const outputs = services.sessionManager.getPanelOutputs(panel.id, limit);
  return boundSanitizedLines(outputs.map(outputToText).join(''), limit).text;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function gitErrorOutput(cause: unknown): string | undefined {
  try {
    return decodeBoundary(cause, boundary.object({ gitOutput: boundary.optional(boundary.string) })).gitOutput;
  } catch {
    return undefined;
  }
}

interface ArchiveSafetyCheck extends RunpanePaneArchiveSafetyCheck {
  reasonUnavailable?: 'missing-project-context' | 'git-status-error';
}

async function computeArchiveSafety(services: AppServices, pane: Session): Promise<ArchiveSafetyCheck> {
  const ctx = services.sessionManager.getProjectContext(pane.id);
  if (!ctx) {
    return { performed: false, reasonUnavailable: 'missing-project-context' };
  }

  try {
    // Deliberately bypass gitStatusManager's cache (up to CACHE_TTL_MS stale)
    // and read git plumbing directly — a safety gate must see the current
    // state, not a snapshot from moments-ago that predates a recent commit.
    const workingDirectory = await fastCheckWorkingDirectory(pane.worktreePath, ctx.commandRunner.wslContext);
    const hasUncommittedChanges = workingDirectory.hasModified || workingDirectory.hasStaged || workingDirectory.hasConflicts;
    const hasUntrackedFiles = workingDirectory.hasUntracked;

    const upstream = await services.worktreeManager.getUpstream(pane.worktreePath, ctx.commandRunner);
    if (upstream) {
      const remote = await resolveUpstreamRemote(pane.worktreePath, upstream, ctx.commandRunner);
      await ctx.commandRunner.execAsync(
        `git fetch --no-tags --prune ${escapeShellArg(remote)}`,
        pane.worktreePath,
        { timeout: 30000 },
      );
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

    // No upstream at all (never pushed, or detached HEAD): the branch's own
    // commits ahead of its base/comparison branch are the closest proxy for
    // "unpushed work".
    const comparisonBranch = await services.worktreeManager.getSessionComparisonBranch(pane, ctx);
    const unpushedCommitDetails = await listCommitsAhead(
      pane.worktreePath,
      comparisonBranch,
      ctx.commandRunner.wslContext,
    );
    return {
      performed: true,
      hasUncommittedChanges,
      hasUntrackedFiles,
      hasUpstream: false,
      upstreamRefreshed: false,
      unpushedCommits: unpushedCommitDetails.length,
      unpushedCommitDetails,
    };
  } catch {
    return { performed: false, reasonUnavailable: 'git-status-error' };
  }
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

function classifyArchiveBlock(check: ArchiveSafetyCheck, applicable: boolean): RunpanePaneArchiveBlockCode | undefined {
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

function describeArchiveBlock(code: RunpanePaneArchiveBlockCode, check: ArchiveSafetyCheck): string {
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

function toPublicSafetyCheck(check: ArchiveSafetyCheck): RunpanePaneArchiveSafetyCheck {
  return {
    performed: check.performed,
    hasUncommittedChanges: check.hasUncommittedChanges,
    hasUntrackedFiles: check.hasUntrackedFiles,
    hasUpstream: check.hasUpstream,
    upstream: check.upstream,
    upstreamRefreshed: check.upstreamRefreshed,
    unpushedCommits: check.unpushedCommits,
    unpushedCommitDetails: check.unpushedCommitDetails,
  };
}

function waitForArchiveProgressCompletion(
  archiveProgressManager: ArchiveProgressManager,
  paneId: string,
  timeoutMs: number,
): Promise<RunpaneWorktreeCleanupState> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (state: RunpaneWorktreeCleanupState) => {
      if (settled) return;
      settled = true;
      archiveProgressManager.off('archive-progress', onProgress);
      clearTimeout(timer);
      resolve(state);
    };

    const onProgress = (payload: { tasks: SerializedArchiveTask[] }) => {
      const task = payload.tasks.find(candidate => candidate.sessionId === paneId);
      if (task?.status === 'completed') {
        finish('completed');
      } else if (task?.status === 'failed') {
        finish('failed');
      }
    };

    archiveProgressManager.on('archive-progress', onProgress);
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
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

function resolvePanel(panelId: string): ToolPanel {
  const panel = panelManager.getPanel(panelId);
  if (!panel) {
    throw new Error(`No Pane panel found with id ${panelId}`);
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
    baseBranch: optionalString(value.baseBranch),
    sessionPrompt: optionalString(value.sessionPrompt),
    // CLI/daemon-created Panes pin by default so orchestrated work stays visible
    // in the sidebar; the Pane UI create dialog has its own startPinned preference.
    pinned: optionalBoolean(value.pinned) ?? true,
    tool: parseRunpaneToolSpec(value.tool, `Pane create item ${index}`),
  };
}

function validateRepositoryPath(repoPath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(repoPath);
  } catch {
    throw new Error(`Repo path does not exist: ${repoPath}`);
  }

  if (!stat.isDirectory()) {
    throw new Error(`Repo path must be a directory: ${repoPath}`);
  }

  try {
    const output = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    if (output !== 'true') {
      throw new Error('not inside work tree');
    }
  } catch {
    throw new Error(`Repo path must be an existing git repository: ${repoPath}`);
  }
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
    };
  }

  const command = optionalString(value.command);
  if (command && command.trim().length > 0) {
    return {
      command,
      title: optionalString(value.title),
      initialInput: optionalString(value.initialInput),
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
      throw new Error(`No Pane repo found with id ${selectorObject.id}`);
    }
    return project;
  }

  if (selectorObject.path !== undefined) {
    const project = resolveProjectByPath(projects, selectorObject.path);
    if (!project) {
      throw new Error(`No Pane repo found at path ${selectorObject.path}`);
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
  const normalized = path.resolve(selectorPath);
  return projects.find(project => project.path === selectorPath || path.resolve(project.path) === normalized);
}

function resolveProjectByName(projects: Project[], selectorName: string): Project {
  const matches = projects.filter(project => project.name.toLowerCase() === selectorName.toLowerCase());
  if (matches.length === 0) {
    throw new Error(`No Pane repo found named "${selectorName}"`);
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
    };
  }

  return {
    title: tool.title ?? 'Terminal',
    command: tool.command,
    initialInput: tool.initialInput,
  };
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
        heldInput: snapshot?.screenText ? composerEvidenceText(snapshot.screenText) : undefined,
      };
    },
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

function workspaceEntryMatches(
  entry: RunpaneWorkspaceEntry,
  filter: WorkspaceJournalFilter,
): boolean {
  if (filter.kinds && !filter.kinds.includes(entry.kind)) return false;
  if (filter.paneIds && !filter.paneIds.includes(entry.paneId)) return false;
  if (filter.excludePaneIds && filter.excludePaneIds.includes(entry.paneId)) return false;
  if (filter.repoId !== undefined && entry.repoId !== filter.repoId) return false;
  if (filter.nameContains && !entry.paneName.toLocaleLowerCase().includes(filter.nameContains.toLocaleLowerCase())) return false;
  if (filter.agentsOnly && !entry.agentType && entry.kind !== 'pane.created' && entry.kind !== 'pane.gone') return false;
  return true;
}

function workspaceNextCommand(request: RunpaneWorkspaceWaitRequest, generation: number): string {
  const cursor = request.as ? `--as ${request.as}` : `--since ${generation}`;
  return `runpane watch ${cursor}`;
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
