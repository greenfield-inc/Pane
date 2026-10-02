import { accessSync, constants, readFileSync, readlinkSync, statSync } from 'fs';
import os from 'os';
import path from 'path';
import type { RemoteDaemonExecutableHealth } from '../../../shared/types/remoteDaemon';
import {
  extractLegacyRemoteDaemonExecutablePath,
  getRemoteDaemonExecutableCandidates,
  resolveRemoteDaemonExecutablePath,
  resolveRemoteDaemonExecutablePathAsync,
} from './remoteDaemonService';

const LAUNCHER_MARKER = 'pane-remote-daemon-launcher-v2';

export interface ExecutableHealthDependencies {
  platform?: NodeJS.Platform;
  homeDir?: string;
  executablePath?: string;
  procExecutablePath?: string;
  candidates?: string[];
  readLink?: (filePath: string) => string;
  resolveCommandPath?: (command: string) => string | null;
}

/** Resolve login-shell executable discovery asynchronously for the desktop host. */
export async function collectRemoteDaemonExecutableHealthAsync(paneDir: string): Promise<RemoteDaemonExecutableHealth> {
  const installed = await resolveRemoteDaemonExecutablePathAsync(process.platform, getRemoteDaemonExecutableCandidates());
  return collectRemoteDaemonExecutableHealth(paneDir, {
    candidates: installed ? [installed] : [],
    resolveCommandPath: () => null,
  });
}

export function collectRemoteDaemonExecutableHealth(
  paneDir: string,
  dependencies: ExecutableHealthDependencies = {},
): RemoteDaemonExecutableHealth {
  const platform = dependencies.platform ?? process.platform;
  const homeDir = dependencies.homeDir ?? os.homedir();
  const candidates = dependencies.candidates ?? getRemoteDaemonExecutableCandidates(platform, homeDir);
  const installedPath = resolveRemoteDaemonExecutablePath(
    platform,
    candidates,
    dependencies.resolveCommandPath,
  );
  const launcherPath = path.join(paneDir, 'remote-daemon', platform === 'win32' ? 'start.cmd' : 'start.sh');
  const checkedAt = new Date().toISOString();

  const processImage = collectProcessImage({
    platform,
    installedPath,
    executablePath: dependencies.executablePath ?? process.execPath,
    procExecutablePath: dependencies.procExecutablePath ?? '/proc/self/exe',
    readLink: dependencies.readLink ?? readlinkSync,
  });
  const restart = collectRestartHealth(launcherPath, installedPath);
  const recoveryCommand = `runpane daemon repair --pane-dir ${formatPaneDirForCommand(paneDir, homeDir)}`;

  if (processImage.status === 'deleted' && restart.status === 'broken') {
    return {
      processImage,
      restart,
      diagnosticCode: 'PANE_REMOTE_DAEMON_EXECUTABLE_DELETED',
      recoveryCommand,
      checkedAt,
    };
  }
  if (processImage.status === 'replaced' || processImage.status === 'deleted') {
    const health: RemoteDaemonExecutableHealth = {
      processImage,
      restart,
      diagnosticCode: 'PANE_REMOTE_DAEMON_UPDATE_PENDING',
      checkedAt,
    };
    if (restart.status === 'broken') health.recoveryCommand = recoveryCommand;
    return health;
  }
  if (restart.status === 'broken') {
    return {
      processImage,
      restart,
      diagnosticCode: 'PANE_REMOTE_DAEMON_LAUNCHER_STALE',
      recoveryCommand,
      checkedAt,
    };
  }
  return { processImage, restart, checkedAt };
}

function collectProcessImage(options: {
  platform: NodeJS.Platform;
  installedPath: string | null;
  executablePath: string;
  procExecutablePath: string;
  readLink: (filePath: string) => string;
}): RemoteDaemonExecutableHealth['processImage'] {
  if (options.platform !== 'linux') {
    return {
      status: 'unknown',
      runtimePath: options.executablePath,
      installedPath: options.installedPath,
      evidence: 'This platform does not expose Linux /proc executable identity.',
    };
  }
  try {
    const runtimePath = options.readLink(options.procExecutablePath);
    if (runtimePath.endsWith(' (deleted)')) {
      return {
        status: 'deleted',
        runtimePath: runtimePath.slice(0, -' (deleted)'.length),
        installedPath: options.installedPath,
        evidence: `${options.procExecutablePath} points to a deleted inode.`,
      };
    }
    if (!options.installedPath) {
      return {
        status: 'unknown',
        runtimePath,
        installedPath: null,
        evidence: 'No supported installed Pane executable could be found for comparison.',
      };
    }
    const runtimeStat = statSync(options.procExecutablePath);
    const installedStat = statSync(options.installedPath);
    const current = runtimeStat.dev === installedStat.dev && runtimeStat.ino === installedStat.ino;
    return {
      status: current ? 'current' : 'replaced',
      runtimePath,
      installedPath: options.installedPath,
      evidence: current
        ? 'The running process and installed Pane executable have the same device and inode.'
        : 'The installed Pane executable has a different device or inode from the running process.',
    };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    return {
      status: 'unknown',
      runtimePath: options.executablePath,
      installedPath: options.installedPath,
      evidence: `Executable identity could not be inspected: ${failure.message}`,
    };
  }
}

function collectRestartHealth(
  launcherPath: string,
  resolvedInstalledPath: string | null,
): RemoteDaemonExecutableHealth['restart'] {
  let contents: string;
  try {
    contents = readFileSync(launcherPath, 'utf8');
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    return {
      status: 'unknown',
      launcherPath,
      evidence: isNodeErrorWithCode(failure, 'ENOENT')
        ? 'No managed remote daemon launcher exists for this Pane directory.'
        : `The managed launcher could not be read: ${failure.message}`,
    };
  }

  if (contents.includes(`${LAUNCHER_MARKER} source`)) {
    return {
      status: 'unknown',
      launcherPath,
      evidence: 'The source-development launcher is not tied to an installed Pane executable.',
    };
  }
  if (contents.includes(LAUNCHER_MARKER)) {
    return resolvedInstalledPath
      ? { status: 'ready', launcherPath, resolvedPath: resolvedInstalledPath, evidence: `The runtime resolver can launch ${resolvedInstalledPath}.` }
      : { status: 'broken', launcherPath, evidence: 'The runtime resolver cannot find an installed Pane executable.' };
  }

  const savedPath = extractLegacyRemoteDaemonExecutablePath(contents);
  if (!savedPath) {
    return { status: 'unknown', launcherPath, evidence: 'The launcher format is not recognized.' };
  }
  return isExecutableFile(savedPath)
    ? { status: 'ready', launcherPath, resolvedPath: savedPath, evidence: `The legacy launcher target still exists at ${savedPath}.` }
    : { status: 'broken', launcherPath, evidence: `The legacy launcher target is missing: ${savedPath}.` };
}

function isExecutableFile(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function formatPaneDirForCommand(paneDir: string, homeDir: string): string {
  const relative = path.relative(homeDir, paneDir);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return `~/${relative}`;
  }
  return `'${paneDir.replace(/'/g, `'\\''`)}'`;
}

function isNodeErrorWithCode(error: Error, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
