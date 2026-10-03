import { randomUUID } from 'crypto';
import { AGENT_LAUNCH_PRESETS, type AgentLaunchPreset } from '../../../shared/constants/agentLaunchPresets';
import type { PaneChatAgent } from '../../../shared/types/paneChat';
import type { DefaultAgentLaunchResult } from '../../../shared/types/workspaceEntry';
import type { AppConfig } from '../types/config';
import type { AppServices } from '../ipc/types';
import { panelManager } from './panelManager';
import { terminalPanelManager } from './terminalPanelManager';
import { escapeForBash } from '../utils/wslUtils';
import { ShellDetector } from '../utils/shellDetector';
import { runAgentDoctor } from './agents/agentDoctor';

const READINESS_TIMEOUT_MS = 30_000;
const READINESS_INTERVAL_MS = 500;
const LAUNCH_DEADLINE_MS = 45_000;
interface InFlightLaunch {
  controller: AbortController;
  promise: Promise<DefaultAgentLaunchResult>;
}

const inFlight = new Map<number, InFlightLaunch>();
const attempted = new Map<number, DefaultAgentLaunchResult>();

class AgentValidationError extends Error {
  override name = 'AgentValidationError';
}

class LaunchCancelledError extends Error {
  override name = 'LaunchCancelledError';

  constructor(agentTitle: string) {
    super(`Project was deleted before ${agentTitle} started.`);
  }
}

export function resolveConfiguredLaunchPreset(
  config: Pick<AppConfig, 'defaultOrchestratorAgent'> | undefined,
): AgentLaunchPreset | null {
  return AGENT_LAUNCH_PRESETS.find(preset => preset.id === config?.defaultOrchestratorAgent) ?? null;
}

async function waitForCliReady(
  panelId: string,
  deadlineSignal: AbortSignal,
  attemptSignal: AbortSignal,
  agentTitle: string,
): Promise<void> {
  const readinessStartedAt = Date.now();
  while (
    !deadlineSignal.aborted
    && !attemptSignal.aborted
    && Date.now() - readinessStartedAt <= READINESS_TIMEOUT_MS
  ) {
    const snapshot = terminalPanelManager.getTerminalSnapshot(panelId);
    if (!snapshot) throw new Error(`${agentTitle} exited before it was ready.`);
    if (snapshot.isCliReady && snapshot.initialCommandSent) return;
    await new Promise(resolve => setTimeout(resolve, READINESS_INTERVAL_MS));
  }
  if (!deadlineSignal.aborted && !attemptSignal.aborted) {
    throw new Error(`${agentTitle} did not become ready in time.`);
  }
}

function assertLaunchActive(
  services: AppServices,
  projectId: number,
  signal: AbortSignal,
  agentTitle: string,
): void {
  if (signal.aborted || !services.databaseService.getProject(projectId)) {
    throw new LaunchCancelledError(agentTitle);
  }
}

async function runCancellableStage<T>(
  services: AppServices,
  projectId: number,
  signal: AbortSignal,
  agentTitle: string,
  stage: () => Promise<T>,
): Promise<T> {
  assertLaunchActive(services, projectId, signal, agentTitle);
  let rejectCancellation: ((error: LaunchCancelledError) => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = () => rejectCancellation?.(new LaunchCancelledError(agentTitle));
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    const result = await Promise.race([stage(), cancellation]);
    assertLaunchActive(services, projectId, signal, agentTitle);
    return result;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

async function cleanupProvisionalPanel(
  services: AppServices,
  panelId: string | undefined,
  sessionId: string | undefined,
  initializationPromise: Promise<void> | undefined,
): Promise<string | undefined> {
  let stalePanelMessage: string | undefined;
  if (panelId) {
    const provisionalPanelId = panelId;
    if (initializationPromise) {
      void initializationPromise.then(async () => {
        try {
          if (terminalPanelManager.isTerminalInitialized(provisionalPanelId)) {
            await terminalPanelManager.destroyTerminal(provisionalPanelId);
          }
        } catch (cleanupError) {
          console.error('[WorkspaceEntry] Failed to destroy late provisional terminal:', cleanupError);
        }
      }, () => {});
    }
    try {
      if (terminalPanelManager.isTerminalInitialized(provisionalPanelId)) {
        await terminalPanelManager.destroyTerminal(provisionalPanelId);
      }
    } catch (cleanupError) {
      console.error('[WorkspaceEntry] Failed to destroy provisional terminal:', cleanupError);
    }

    const provisionalPanelExists = (): boolean => {
      try {
        return Boolean(panelManager.getPanel(provisionalPanelId));
      } catch (cleanupError) {
        console.error('[WorkspaceEntry] Failed to verify provisional panel cleanup:', cleanupError);
        return true;
      }
    };
    for (let deleteAttempt = 0; deleteAttempt < 2 && provisionalPanelExists(); deleteAttempt += 1) {
      try {
        await panelManager.deletePanel(provisionalPanelId);
      } catch (cleanupError) {
        console.error('[WorkspaceEntry] Failed to delete provisional panel:', cleanupError);
      }
    }
    if (provisionalPanelExists()) {
      try {
        services.databaseService.deletePanel(provisionalPanelId);
        panelManager.removePanelFromMemory(provisionalPanelId);
      } catch (cleanupError) {
        console.error('[WorkspaceEntry] Failed to force-delete provisional panel:', cleanupError);
      }
    }
    if (provisionalPanelExists()) {
      stalePanelMessage = `A stale panel remained after cleanup (${provisionalPanelId}).`;
    }
  }
  if (sessionId) {
    try {
      const explorer = panelManager.getPanelsForSession(sessionId).find(panel => panel.type === 'explorer');
      if (explorer) await panelManager.setActivePanel(sessionId, explorer.id);
    } catch (cleanupError) {
      console.error('[WorkspaceEntry] Failed to restore Explorer after launch failure:', cleanupError);
    }
  }
  return stalePanelMessage;
}

async function runAttempt(
  services: AppServices,
  projectId: number,
  signal: AbortSignal,
  options?: { disclosedAgent?: PaneChatAgent },
): Promise<DefaultAgentLaunchResult> {
  let preset: AgentLaunchPreset | null = null;
  let panelId: string | undefined;
  let sessionId: string | undefined;
  let initializationPromise: Promise<void> | undefined;
  try {
    const project = services.databaseService.getProject(projectId);
    if (!project) throw new Error(`Project with ID ${projectId} not found`);
    if (project.default_agent_launched_at) {
      return { status: 'skipped', reason: 'already-launched' };
    }

    preset = resolveConfiguredLaunchPreset(services.configManager.getConfig());
    if (!preset) {
      return { status: 'skipped', reason: 'no-default' };
    }
    const launchPreset = preset;
    if (!options?.disclosedAgent || options.disclosedAgent !== launchPreset.id) {
      return { status: 'skipped', reason: 'disclosure-mismatch' };
    }

    const session = await runCancellableStage(
      services,
      projectId,
      signal,
      launchPreset.title,
      () => services.sessionManager.getOrCreateMainRepoSessionAnnounced(projectId, {
        createDefaultTerminalOnCreate: false,
      }),
    );
    sessionId = session.id;

    const doctor = await runCancellableStage(
      services,
      projectId,
      signal,
      launchPreset.title,
      () => runAgentDoctor(services, project, launchPreset.id),
    );
    if (!doctor.available) {
      const failedCheck = doctor.checks.find(check => !check.ok);
      throw new AgentValidationError(failedCheck?.message ?? `${launchPreset.title} is unavailable.`);
    }

    const context = services.sessionManager.getProjectContext(session.id);
    const configuredExecutable = launchPreset.id === 'claude' ? services.configManager.getConfig().claudeExecutablePath?.trim() : undefined;
    let initialCommand = launchPreset.command;
    if (configuredExecutable) {
      const shell = context?.commandRunner.wslContext ? 'bash' : ShellDetector.getDefaultShell(services.configManager.getPreferredShell()).name;
      const flags = launchPreset.command.slice('claude'.length);
      if (shell === 'pwsh' || shell === 'powershell') initialCommand = "& '" + configuredExecutable.replaceAll("'", "''") + "'" + flags;
      else if (shell === 'cmd') {
        if (/[\"%\r\n]/.test(configuredExecutable)) throw new AgentValidationError('Configured Claude path cannot be represented by the selected cmd shell.');
        initialCommand = '"' + configuredExecutable + '"' + flags;
      } else initialCommand = escapeForBash(configuredExecutable) + flags;
    }

    panelId = randomUUID();
    const provisionalPanelId = panelId;
    const panel = await runCancellableStage(
      services,
      projectId,
      signal,
      launchPreset.title,
      () => panelManager.createPanel({
        id: provisionalPanelId,
        sessionId: session.id,
        type: 'terminal',
        title: launchPreset.title,
        initialState: {
          initialCommand,
          agentType: launchPreset.id,
          isCliPanel: true,
        },
      }),
    );
    const deadlineController = new AbortController();
    let launchDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const launchDeadline = new Promise<never>((_resolve, reject) => {
      launchDeadlineTimer = setTimeout(() => {
        deadlineController.abort();
        reject(new Error(`${launchPreset.title} did not start within ${LAUNCH_DEADLINE_MS / 1000} s.`));
      }, LAUNCH_DEADLINE_MS);
    });
    try {
      await runCancellableStage(
        services,
        projectId,
        signal,
        launchPreset.title,
        async () => {
          const currentInitialization = terminalPanelManager.initializeTerminal(
            panel,
            session.worktreePath,
            context?.commandRunner.wslContext ?? null,
          );
          initializationPromise = currentInitialization;
          await Promise.race([
            currentInitialization.then(() => waitForCliReady(
              panel.id,
              deadlineController.signal,
              signal,
              launchPreset.title,
            )),
            launchDeadline,
          ]);
        },
      );
    } finally {
      if (launchDeadlineTimer) clearTimeout(launchDeadlineTimer);
    }

    assertLaunchActive(services, projectId, signal, launchPreset.title);
    const updatedProject = services.databaseService.updateProject(projectId, {
      default_agent_launched_at: new Date().toISOString(),
    });
    if (!updatedProject) throw new Error(`Failed to persist the default agent launch receipt for project ${projectId}.`);
    return {
      status: 'launched',
      agentType: launchPreset.id,
      agentTitle: launchPreset.title,
      initialCommand: launchPreset.command,
      sessionId,
      panelId,
    };
  } catch (error) {
    const stalePanelMessage = await cleanupProvisionalPanel(
      services,
      panelId,
      sessionId,
      initializationPromise,
    );
    if (!preset) {
      try {
        preset = resolveConfiguredLaunchPreset(services.configManager.getConfig());
      } catch {
        preset = null;
      }
    }
    if (!preset) {
      return { status: 'skipped', reason: 'no-default' };
    }
    return {
      status: 'failed',
      agentType: preset.id,
      agentTitle: preset.title,
      initialCommand: preset.command,
      reason: error instanceof AgentValidationError ? 'validation-failed' : 'launch-error',
      message: [
        error instanceof Error ? error.message : `Failed to start ${preset.title}.`,
        stalePanelMessage,
      ].filter((message): message is string => Boolean(message)).join(' '),
    };
  }
}

function synthesizeAttemptFailure(
  services: AppServices,
  error: Error,
  disclosedAgent: PaneChatAgent | undefined,
): DefaultAgentLaunchResult {
  let preset = AGENT_LAUNCH_PRESETS.find(candidate => candidate.id === disclosedAgent) ?? null;
  try {
    preset = resolveConfiguredLaunchPreset(services.configManager.getConfig()) ?? preset;
  } catch {
    // The disclosed preset still provides safe, static failure metadata.
  }
  if (!preset) return { status: 'skipped', reason: 'no-default' };
  return {
    status: 'failed',
    agentType: preset.id,
    agentTitle: preset.title,
    initialCommand: preset.command,
    reason: 'launch-error',
    message: error.message,
  };
}

export function forgetProjectLaunchState(projectId: number): void {
  const pending = inFlight.get(projectId);
  pending?.controller.abort();
  inFlight.delete(projectId);
  attempted.delete(projectId);
}

export function launchDefaultAgentOnce(
  services: AppServices,
  projectId: number,
  options?: { disclosedAgent?: PaneChatAgent },
): Promise<DefaultAgentLaunchResult> {
  const prior = attempted.get(projectId);
  if (prior) return Promise.resolve(prior);
  const pending = inFlight.get(projectId);
  if (pending) return pending.promise;

  const controller = new AbortController();
  const attempt: Promise<DefaultAgentLaunchResult> = Promise.resolve()
    .then(() => runAttempt(services, projectId, controller.signal, options))
    .catch(error => synthesizeAttemptFailure(
      services,
      error instanceof Error ? error : new Error('Failed to start the default agent.'),
      options?.disclosedAgent,
    ))
    .then(result => {
      if (!controller.signal.aborted && inFlight.get(projectId)?.promise === attempt) {
        attempted.set(projectId, result);
      }
      return result;
    })
    .finally(() => {
      if (inFlight.get(projectId)?.promise === attempt) inFlight.delete(projectId);
    });
  inFlight.set(projectId, { controller, promise: attempt });
  return attempt;
}
