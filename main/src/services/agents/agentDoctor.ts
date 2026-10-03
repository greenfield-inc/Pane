import { isAgentSupportedOnPlatform } from '../../../../shared/constants/agentLaunchPresets';
import { RUNPANE_CONTRACT } from '../../../../shared/types/generatedRunpaneContract';
import type {
  RunpaneAgentDoctorResult,
  RunpaneAgentId,
  RunpaneRepoSummary,
} from '../../../../shared/types/runpaneOrchestration';
import { boundary, decodeBoundary } from '../../../../shared/validation/boundaryDecoder';
import type { AppServices } from '../../ipc/types';
import type { Project } from '../../database/models';
import { PathResolver } from '../../utils/pathResolver';

const AGENT_TEMPLATES = RUNPANE_CONTRACT.agentTemplates;
const AGENT_FALLBACK_BIN_PATHS = {
  cursor: ['$HOME/.local/bin/cursor-agent'],
} satisfies Partial<Record<RunpaneAgentId, readonly string[]>>;

export function projectToRepoSummary(project: Project, sessionCount: number): RunpaneRepoSummary {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    active: Boolean(project.active),
    environment: new PathResolver(project).environment,
    sessionCount,
  };
}

export async function runAgentDoctor(
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
    return { ok: false, agent, command, repo: repoSummary, environment, available: false, checks, warnings };
  }

  const configuredExecutable = agent === 'claude' ? services.configManager.getConfig().claudeExecutablePath?.trim() : undefined;
  if (configuredExecutable) {
    try {
      const result = await context.commandRunner.execFile(configuredExecutable, ['--version'], repo.path, { timeout: 5_000, silent: true });
      const version = firstNonEmptyLine(result.stdout) || firstNonEmptyLine(result.stderr);
      checks.push({ name: 'configured-executable', ok: true, message: 'Configured Claude executable is available.' });
      return { ok: true, agent, command, repo: repoSummary, environment, available: true, executablePath: configuredExecutable, version, checks };
    } catch (error) {
      checks.push({ name: 'configured-executable', ok: false, message: commandErrorMessage(error, 'Configured Claude executable is unavailable.') });
      return { ok: false, agent, command, repo: repoSummary, environment, available: false, checks };
    }
  }

  const lookupCommand = environment === 'windows' ? `where ${executable}` : `command -v ${executable}`;
  let executablePath: string | undefined;
  let version: string | undefined;
  let versionCommand = `${executable} --version`;

  try {
    const result = await context.commandRunner.execAsync(lookupCommand, repo.path, { timeout: 5_000, silent: true });
    executablePath = firstNonEmptyLine(result.stdout);
    checks.push({
      name: 'executable',
      ok: Boolean(executablePath),
      message: executablePath ? `Found ${executable} at ${executablePath}.` : `${executable} was not found on PATH.`,
    });
  } catch (error) {
    checks.push({ name: 'executable', ok: false, message: commandErrorMessage(error, `${executable} was not found on PATH.`) });
  }

  if (!executablePath && environment !== 'windows') {
    const fallbackPaths = agent === 'cursor' ? AGENT_FALLBACK_BIN_PATHS.cursor : [];
    for (const fallback of fallbackPaths) {
      try {
        const result = await context.commandRunner.execAsync(`command -v "${fallback}"`, repo.path, { timeout: 5_000, silent: true });
        const fallbackPath = firstNonEmptyLine(result.stdout);
        if (fallbackPath) {
          executablePath = fallbackPath;
          versionCommand = `"${fallback}" --version`;
          checks.push({ name: 'executable-fallback', ok: true, message: `Found ${executable} at ${fallbackPath}.` });
          warnings.push(`${executable} is installed at ${fallbackPath} but not on PATH; GUI-launched apps may not see it.`);
          break;
        }
      } catch {
        // Best effort; the PATH check already reports the miss.
      }
    }
  }

  if (executablePath) {
    try {
      const result = await context.commandRunner.execAsync(versionCommand, repo.path, { timeout: 5_000, silent: true });
      version = firstNonEmptyLine(result.stdout) || firstNonEmptyLine(result.stderr);
      checks.push({ name: 'version', ok: Boolean(version), message: version || `${executable} did not print a version.` });
    } catch (error) {
      warnings.push(commandErrorMessage(error, `${executable} --version failed.`));
      checks.push({ name: 'version', ok: false, message: `${executable} is on PATH, but --version failed.` });
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

function agentCommandExecutable(command: string): string {
  const executable = command.trim().split(/\s+/)[0];
  if (!executable || !/^[A-Za-z0-9._-]+$/.test(executable)) {
    throw new Error(`Unsupported agent command executable: ${command}`);
  }
  return executable;
}

function firstNonEmptyLine(value: string | undefined): string | undefined {
  return value?.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0);
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
    // Fall through to Error.
  }
  if (cause instanceof Error && cause.message) return cause.message;
  return fallback;
}
