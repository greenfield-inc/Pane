import { clipboard, IpcMain, IpcMainInvokeEvent } from 'electron';
import { join } from 'path';
import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import { exec, execFile, execSync, spawn, type ExecSyncOptionsWithStringEncoding } from 'child_process';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import * as pty from '@lydell/node-pty';
import type { AppServices } from './types';
import { getAppDirectory } from '../utils/appDirectory';
import { CommandRunner } from '../utils/commandRunner';
import { getShellPath } from '../utils/shellPath';
import type { PaneCommandValue } from '../daemon/commandRegistry';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

/** Returns exec options that include the user's full shell PATH (Homebrew, nvm, etc.). */
function shellExecOpts<Options extends object>(extra: Options): Options & { env: NodeJS.ProcessEnv } {
  return { ...extra, env: { ...process.env, PATH: getShellPath() } };
}

const execAsync = promisify(exec);

/**
 * Runs a probe without blocking the main process: the renderer checks the
 * environment on launch, and gh may wait on the network.
 */
async function runProbe(command: string, timeout?: number): Promise<string> {
  return (await execAsync(command, shellExecOpts({ encoding: 'utf-8', timeout }))).stdout;
}

const PANE_REPO = 'greenfield-inc/Pane';
const PANE_REPO_URL = `https://github.com/${PANE_REPO}.git`;
const SUPPORT_GITHUB_USER = 'parsakhaz';
const GITHUB_HOST = 'github.com';
const GH_INSTALL_URL = 'https://cli.github.com/';
const REQUIRED_GITHUB_SCOPES = ['user'] as const;
const GH_LOGIN_COMMAND = `gh auth login -h ${GITHUB_HOST} -s ${REQUIRED_GITHUB_SCOPES.join(',')}`;
const GH_REFRESH_COMMAND = `gh auth refresh -h ${GITHUB_HOST} -s ${REQUIRED_GITHUB_SCOPES.join(',')}`;

interface EnvironmentInfo {
  gitInstalled: boolean;
  ghInstalled: boolean;
  ghAuthenticated: boolean;
  ghReady: boolean;
  ghScopes: string[];
  requiredGhScopes: string[];
  missingGhScopes: string[];
  ghAuthCommand?: string;
  ghInstallUrl: string;
}

interface GitHubAuthCommandResult {
  command: string;
  reason: 'login' | 'refresh' | 'install-gh' | 'ready';
}

interface GitHubAuthTerminalResult extends GitHubAuthCommandResult {
  copied: boolean;
  openedTerminal: boolean;
  platform: NodeJS.Platform;
}

interface GitHubAuthPtyStartResult extends GitHubAuthCommandResult {
  terminalId: string;
  cols: number;
  rows: number;
}

interface GitHubAuthPtySession {
  pty: pty.IPty;
  ownerWebContentsId: number;
}

const githubAuthPtySessions = new Map<string, GitHubAuthPtySession>();

async function detectEnvironment(): Promise<EnvironmentInfo> {
  const result: EnvironmentInfo = {
    gitInstalled: false,
    ghInstalled: false,
    ghAuthenticated: false,
    ghReady: false,
    ghScopes: [],
    requiredGhScopes: [...REQUIRED_GITHUB_SCOPES],
    missingGhScopes: [...REQUIRED_GITHUB_SCOPES],
    ghAuthCommand: GH_LOGIN_COMMAND,
    ghInstallUrl: GH_INSTALL_URL,
  };

  // Check git (use shell-aware PATH so packaged apps find Homebrew/nvm binaries)
  try {
    await runProbe('git --version');
    result.gitInstalled = true;
  } catch {
    return result;
  }

  // Check gh CLI
  try {
    await runProbe('gh --version');
    result.ghInstalled = true;
  } catch {
    result.ghAuthCommand = undefined;
    return result;
  }

  // Check gh authentication
  let authStatusOutput = '';
  try {
    authStatusOutput = await runProbe(`gh auth status -h ${GITHUB_HOST}`);
    result.ghAuthenticated = true;
  } catch {
    // gh installed but not authenticated
    result.ghAuthCommand = GH_LOGIN_COMMAND;
    return result;
  }

  result.ghScopes = await getGitHubCliScopes(authStatusOutput);
  result.missingGhScopes = getMissingGitHubScopes(result.ghScopes);
  result.ghReady = result.missingGhScopes.length === 0;
  result.ghAuthCommand = result.ghReady ? undefined : GH_REFRESH_COMMAND;

  return result;
}

async function getGitHubAuthCommand(): Promise<GitHubAuthCommandResult> {
  const env = await detectEnvironment();
  if (!env.ghInstalled) {
    return { command: '', reason: 'install-gh' };
  }

  if (!env.ghAuthenticated) {
    return { command: GH_LOGIN_COMMAND, reason: 'login' };
  }

  if (env.ghReady) {
    return { command: '', reason: 'ready' };
  }

  return { command: GH_REFRESH_COMMAND, reason: 'refresh' };
}

function getGitHubAuthSpawnArgs(reason: GitHubAuthCommandResult['reason']): string[] {
  const scopes = REQUIRED_GITHUB_SCOPES.join(',');
  if (reason === 'login') {
    return ['auth', 'login', '-h', GITHUB_HOST, '-s', scopes];
  }

  if (reason === 'refresh') {
    return ['auth', 'refresh', '-h', GITHUB_HOST, '-s', scopes];
  }

  return [];
}

function getMissingGitHubScopes(scopes: string[]): string[] {
  const granted = new Set(scopes.map(scope => scope.toLowerCase()));
  return REQUIRED_GITHUB_SCOPES.filter(scope => !granted.has(scope.toLowerCase()));
}

async function getGitHubCliScopes(authStatusOutput: string): Promise<string[]> {
  try {
    const apiOutput = await runProbe(`gh api -i /user --silent --hostname ${GITHUB_HOST}`, 15000);
    const scopes = parseScopesFromHeaders(apiOutput);
    if (scopes.length > 0) return scopes;
  } catch {
    // Fall back to auth status output below.
  }

  return parseScopesFromAuthStatus(authStatusOutput);
}

function parseScopesFromHeaders(output: string): string[] {
  const line = output
    .split(/\r?\n/)
    .find(headerLine => /^x-oauth-scopes:/i.test(headerLine));
  if (!line) return [];

  return parseScopeList(line.slice(line.indexOf(':') + 1));
}

function parseScopesFromAuthStatus(output: string): string[] {
  const line = output
    .split(/\r?\n/)
    .find(statusLine => /Token scopes:/i.test(statusLine));
  if (!line) return [];

  return parseScopeList(line.slice(line.indexOf(':') + 1));
}

function parseScopeList(value: string): string[] {
  return value
    .split(',')
    .map(scope => scope.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function execFileAsync(command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function spawnDetached(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PATH: getShellPath() },
    });

    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildUnixInteractiveCommand(command: string): string {
  return `${command}; status=$?; printf '\\nGitHub setup finished. You can return to Pane. Press Enter to close this terminal...'; read _; exit $status`;
}

function buildWindowsInteractiveCommand(command: string): string {
  return `${command} & echo. & echo GitHub setup finished. You can return to Pane. & pause`;
}

interface TerminalDimensions {
  cols: number;
  rows: number;
}

interface PtyEnvironment {
  [name: string]: string;
}

function normalizeTerminalDimensions(cols: PaneCommandValue, rows: PaneCommandValue): TerminalDimensions {
  const parseDimension = (value: PaneCommandValue, fallback: number): number => {
    try {
      const decoded = decodeBoundary(value, boundary.number);
      return Number.isFinite(decoded) ? Math.floor(decoded) : fallback;
    } catch {
      return fallback;
    }
  };
  const parsedCols = parseDimension(cols, 80);
  const parsedRows = parseDimension(rows, 18);

  return {
    cols: Math.min(Math.max(parsedCols, 20), 240),
    rows: Math.min(Math.max(parsedRows, 6), 80),
  };
}

function buildGitHubAuthPtyEnv(): PtyEnvironment {
  const env: PtyEnvironment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return {
    ...env,
    PATH: getShellPath(),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: process.env.LANG || 'en_US.UTF-8',
  };
}

function stopGitHubAuthPtySession(terminalId: string, ownerWebContentsId: number): boolean {
  const session = githubAuthPtySessions.get(terminalId);
  if (!session || session.ownerWebContentsId !== ownerWebContentsId) return false;

  githubAuthPtySessions.delete(terminalId);
  try {
    session.pty.kill();
  } catch {
    // Already exited.
  }
  return true;
}

async function openGitHubAuthTerminal(command: string): Promise<boolean> {
  if (!command) return false;

  if (process.platform === 'darwin') {
    const terminalCommand = buildUnixInteractiveCommand(command);
    await execFileAsync('osascript', [
      '-e',
      'tell application "Terminal" to activate',
      '-e',
      `tell application "Terminal" to do script "${escapeAppleScriptString(terminalCommand)}"`,
    ], { env: { ...process.env, PATH: getShellPath() } });
    return true;
  }

  if (process.platform === 'win32') {
    await spawnDetached('cmd.exe', [
      '/c',
      'start',
      'GitHub CLI Setup',
      'cmd.exe',
      '/k',
      buildWindowsInteractiveCommand(command),
    ]);
    return true;
  }

  const terminalCommand = buildUnixInteractiveCommand(command);
  const candidates: Array<{ command: string; args: string[] }> = [
    { command: 'x-terminal-emulator', args: ['-e', 'sh', '-lc', terminalCommand] },
    { command: 'gnome-terminal', args: ['--', 'sh', '-lc', terminalCommand] },
    { command: 'konsole', args: ['-e', 'sh', '-lc', terminalCommand] },
    { command: 'xfce4-terminal', args: ['-e', 'sh', '-lc', terminalCommand] },
    { command: 'xterm', args: ['-e', 'sh', '-lc', terminalCommand] },
  ];

  for (const candidate of candidates) {
    try {
      await spawnDetached(candidate.command, candidate.args);
      return true;
    } catch {
      // Try the next installed terminal.
    }
  }

  return false;
}

function starPaneRepo(): boolean {
  try {
    execSync(`gh api -X PUT /user/starred/${PANE_REPO}`, shellExecOpts({ stdio: 'ignore', timeout: 15000 }));
    return true;
  } catch {
    return false;
  }
}

function followSupportUser(): boolean {
  try {
    execSync(`gh api -X PUT /user/following/${SUPPORT_GITHUB_USER}`, shellExecOpts({ stdio: 'ignore', timeout: 15000 }));
    return true;
  } catch {
    return false;
  }
}

/** Checks that the path is a git repo related to Pane (canonical or a fork cloned via `gh repo clone`). */
function isPaneRepo(repoPath: string): boolean {
  if (!existsSync(join(repoPath, '.git'))) return false;
  try {
    execSync('git rev-parse --is-inside-work-tree', shellExecOpts({ cwd: repoPath, stdio: 'ignore' }));
    const execOpts = shellExecOpts({ cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] } satisfies ExecSyncOptionsWithStringEncoding);
    const canonicalPattern = /[/:](?:greenfield-inc|dcouple|dcouple-inc)\/pane(\.git)?$/i;
    // Fork pattern: any GitHub-hosted repo named exactly "Pane" (gh repo clone sets origin to user's fork)
    const forkPattern = /github\.com[/:][\w.-]+\/pane(\.git)?$/i;

    // Check origin — accept canonical or any GitHub fork named "Pane"
    const origin = execSync('git remote get-url origin', execOpts).trim();
    if (canonicalPattern.test(origin) || forkPattern.test(origin)) return true;

    // Also check upstream remote (gh sometimes sets this for forks)
    try {
      const upstream = execSync('git remote get-url upstream', execOpts).trim();
      if (canonicalPattern.test(upstream)) return true;
    } catch {
      // No upstream remote
    }

    return false;
  } catch {
    return false;
  }
}

export function registerOnboardingHandlers(ipcMain: IpcMain, services: AppServices): void {
  const { databaseService, sessionManager, analyticsManager } = services;

  // Detect git/gh environment
  ipcMain.handle('onboarding:detect-environment', async () => {
    try {
      const env = await detectEnvironment();
      return { success: true, data: env };
    } catch (error) {
      console.error('[Onboarding] Failed to detect environment:', error);
      return { success: false, error: 'Failed to detect environment' };
    }
  });

  ipcMain.handle('onboarding:get-github-auth-command', async () => {
    try {
      return { success: true, data: await getGitHubAuthCommand() };
    } catch (error) {
      console.error('[Onboarding] Failed to build GitHub auth command:', error);
      return { success: false, error: 'Failed to build GitHub auth command' };
    }
  });

  ipcMain.handle('onboarding:open-github-auth-terminal', async () => {
    try {
      const commandResult = await getGitHubAuthCommand();

      if (!commandResult.command) {
        const error = commandResult.reason === 'install-gh'
          ? 'GitHub CLI is not installed'
          : 'GitHub CLI is already configured';
        return { success: false, error, data: commandResult };
      }

      clipboard.writeText(commandResult.command);
      const openedTerminal = await openGitHubAuthTerminal(commandResult.command);
      const data: GitHubAuthTerminalResult = {
        ...commandResult,
        copied: true,
        openedTerminal,
        platform: process.platform,
      };

      return { success: true, data };
    } catch (error) {
      console.error('[Onboarding] Failed to open GitHub auth terminal:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to open GitHub auth terminal' };
    }
  });

  ipcMain.handle('onboarding:start-github-auth-pty', async (event: IpcMainInvokeEvent, cols?: number, rows?: number) => {
    try {
      const commandResult = await getGitHubAuthCommand();
      const args = getGitHubAuthSpawnArgs(commandResult.reason);

      if (!commandResult.command || args.length === 0) {
        const error = commandResult.reason === 'install-gh'
          ? 'GitHub CLI is not installed'
          : 'GitHub CLI is already configured';
        return { success: false, error, data: commandResult };
      }

      const dimensions = normalizeTerminalDimensions(cols, rows);
      const terminalId = randomUUID();
      const ownerWebContentsId = event.sender.id;
      const ptyProcess = pty.spawn('gh', args, {
        name: 'xterm-256color',
        cols: dimensions.cols,
        rows: dimensions.rows,
        cwd: process.env.HOME || process.cwd(),
        env: buildGitHubAuthPtyEnv(),
      });

      githubAuthPtySessions.set(terminalId, {
        pty: ptyProcess,
        ownerWebContentsId,
      });

      const cleanupOnDestroyed = () => {
        stopGitHubAuthPtySession(terminalId, ownerWebContentsId);
      };
      event.sender.once('destroyed', cleanupOnDestroyed);

      ptyProcess.onData((data: string) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('onboarding:github-auth-pty-output', { terminalId, data });
        }
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        githubAuthPtySessions.delete(terminalId);
        event.sender.removeListener('destroyed', cleanupOnDestroyed);
        if (!event.sender.isDestroyed()) {
          event.sender.send('onboarding:github-auth-pty-exit', {
            terminalId,
            exitCode,
            signal: signal ?? null,
          });
        }
      });

      const data: GitHubAuthPtyStartResult = {
        ...commandResult,
        terminalId,
        cols: dimensions.cols,
        rows: dimensions.rows,
      };

      return { success: true, data };
    } catch (error) {
      console.error('[Onboarding] Failed to start GitHub auth PTY:', error);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to start GitHub CLI setup terminal' };
    }
  });

  ipcMain.handle('onboarding:write-github-auth-pty', async (event: IpcMainInvokeEvent, terminalId: string, data: string) => {
    const session = githubAuthPtySessions.get(terminalId);
    if (!session || session.ownerWebContentsId !== event.sender.id) {
      return { success: false, error: 'GitHub CLI setup terminal is not running' };
    }

    session.pty.write(data);
    return { success: true };
  });

  ipcMain.handle('onboarding:resize-github-auth-pty', async (event: IpcMainInvokeEvent, terminalId: string, cols: number, rows: number) => {
    const session = githubAuthPtySessions.get(terminalId);
    if (!session || session.ownerWebContentsId !== event.sender.id) {
      return { success: false, error: 'GitHub CLI setup terminal is not running' };
    }

    const dimensions = normalizeTerminalDimensions(cols, rows);
    session.pty.resize(dimensions.cols, dimensions.rows);
    return { success: true };
  });

  ipcMain.handle('onboarding:kill-github-auth-pty', async (event: IpcMainInvokeEvent, terminalId: string) => {
    stopGitHubAuthPtySession(terminalId, event.sender.id);
    return { success: true };
  });

  // Fork+clone or clone the Pane repo, register as project
  ipcMain.handle('onboarding:setup-default-repo', async () => {
    try {
      const projectsDir = join(getAppDirectory(), 'projects');
      const clonePath = join(projectsDir, 'Pane');

      // Ensure projects directory exists
      await mkdir(projectsDir, { recursive: true });

      // Check if already cloned and valid
      const alreadyCloned = isPaneRepo(clonePath);

      if (!alreadyCloned) {
        // If directory exists but isn't a valid Pane repo, refuse to overwrite
        if (existsSync(clonePath)) {
          return {
            success: false,
            error: `The directory ${clonePath} already exists but does not appear to be a Pane repository. Please remove or rename it and try again.`,
          };
        }

        const env = await detectEnvironment();

        if (!env.gitInstalled) {
          return { success: false, error: 'Git is not installed' };
        }

        if (env.ghReady) {
          // Try fork + clone
          try {
            const commandRunner = new CommandRunner({ path: projectsDir, wsl_enabled: false, wsl_distribution: null });
            await commandRunner.execAsync(
              `gh repo fork ${PANE_REPO} --clone -- "${clonePath}"`,
              projectsDir,
              { timeout: 300000 }
            );
          } catch (forkError) {
            const errorMsg = forkError instanceof Error ? forkError.message : String(forkError);

            if (errorMsg.includes('already exists')) {
              // Fork exists on GitHub — find it and clone
              try {
                // Use --jq (long form) with double quotes for Windows cmd.exe compatibility
                const jqFilter = `.[] | select(.parent.nameWithOwner == \\"${PANE_REPO}\\") | .nameWithOwner`;
                const forkName = execSync(
                  `gh repo list --fork --limit 1000 --json nameWithOwner,parent --jq "${jqFilter}"`,
                  shellExecOpts({ encoding: 'utf-8', timeout: 30000 } satisfies ExecSyncOptionsWithStringEncoding)
                ).trim();

                if (forkName) {
                  const commandRunner = new CommandRunner({ path: projectsDir, wsl_enabled: false, wsl_distribution: null });
                  await commandRunner.execAsync(
                    `gh repo clone ${forkName} "${clonePath}"`,
                    projectsDir,
                    { timeout: 300000 }
                  );
                } else {
                  // Couldn't find fork, fall back to plain clone
                  const commandRunner = new CommandRunner({ path: projectsDir, wsl_enabled: false, wsl_distribution: null });
                  await commandRunner.execAsync(
                    `git clone ${PANE_REPO_URL} "${clonePath}"`,
                    projectsDir,
                    { timeout: 300000 }
                  );
                }
              } catch {
                // Last resort: plain clone
                const commandRunner = new CommandRunner({ path: projectsDir, wsl_enabled: false, wsl_distribution: null });
                await commandRunner.execAsync(
                  `git clone ${PANE_REPO_URL} "${clonePath}"`,
                  projectsDir,
                  { timeout: 300000 }
                );
              }
            } else {
              // Fork failed for another reason — fall back to plain clone
              const commandRunner = new CommandRunner({ path: projectsDir, wsl_enabled: false, wsl_distribution: null });
              await commandRunner.execAsync(
                `git clone ${PANE_REPO_URL} "${clonePath}"`,
                projectsDir,
                { timeout: 300000 }
              );
            }
          }
        } else {
          // git only — plain clone
          const commandRunner = new CommandRunner({ path: projectsDir, wsl_enabled: false, wsl_distribution: null });
          await commandRunner.execAsync(
            `git clone ${PANE_REPO_URL} "${clonePath}"`,
            projectsDir,
            { timeout: 300000 }
          );
        }
      }

      // Check if project already exists in database
      const existingProjects = databaseService.getAllProjects();
      const existingPaneProject = existingProjects.find(p => p.path === clonePath);

      if (existingPaneProject) {
        // Already registered — just activate it
        databaseService.setActiveProject(existingPaneProject.id);
        sessionManager.setActiveProject(existingPaneProject);
        return {
          success: true,
          data: {
            projectId: existingPaneProject.id,
            projectPath: clonePath,
            wasAlreadyRegistered: true,
          }
        };
      }

      // Create project in database
      const project = databaseService.createProject(
        'Pane',
        clonePath,
        undefined, // systemPrompt
        undefined, // runScript
        undefined, // buildScript
        undefined, // default_permission_mode
        undefined, // openIdeCommand
      );

      if (!project) {
        return { success: false, error: 'Failed to create project in database' };
      }

      // Set as active project
      databaseService.setActiveProject(project.id);
      sessionManager.setActiveProject(project);

      // Track onboarding
      if (analyticsManager) {
        analyticsManager.track('onboarding_completed', {
          was_already_cloned: alreadyCloned,
        });
      }

      return {
        success: true,
        data: {
          projectId: project.id,
          projectPath: clonePath,
          wasAlreadyRegistered: false,
        }
      };
    } catch (error) {
      console.error('[Onboarding] Failed to setup default repo:', error);
      const errorMsg = error instanceof Error ? error.message : 'Failed to setup default repository';

      // Provide user-friendly error for common cases
      if (errorMsg.includes('Could not resolve host') || errorMsg.includes('Connection timed out')) {
        return { success: false, error: 'Network error — please check your internet connection and try again.' };
      }

      return { success: false, error: errorMsg };
    }
  });

  // Support Pane via gh API: star the repo and follow the maintainer.
  ipcMain.handle('onboarding:support-project', async () => {
    const results = {
      starred: starPaneRepo(),
      followed: followSupportUser(),
    };

    if (results.starred || results.followed) {
      if (analyticsManager) {
        analyticsManager.track('onboarding_project_supported', results);
      }

      return { success: true, data: results };
    }

    return { success: false, error: 'gh_api_failed', data: results };
  });
}
