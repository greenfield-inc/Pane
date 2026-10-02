import { stat } from 'fs/promises';
import path from 'path';
import { CommandRunner } from '../utils/commandRunner';
import { PathResolver, expandUserRepoPath } from '../utils/pathResolver';
import { parseWSLPath } from '../utils/wslUtils';

/** Canonical storage and execution context shared by UI and CLI registration. */
export function resolveProjectRegistration(repoPath: string) {
  const requestedPath = expandUserRepoPath(repoPath);
  const wsl = parseWSLPath(requestedPath);
  const location = {
    path: wsl ? path.posix.normalize(wsl.linuxPath) : requestedPath,
    wsl_enabled: Boolean(wsl),
    wsl_distribution: wsl?.distro ?? null,
  };
  return {
    ...location,
    commandRunner: new CommandRunner(location),
    pathResolver: new PathResolver(location),
  };
}

export function projectRegistrationKey(project: { path: string; wsl_enabled?: boolean; wsl_distribution?: string | null }): string {
  const location = project.wsl_enabled && project.wsl_distribution
    ? { ...project, path: path.posix.normalize(project.path) }
    : resolveProjectRegistration(project.path);
  return `${location.wsl_distribution?.toLowerCase() ?? ''}\0${location.path}`;
}

/** Validate without initializing or modifying an existing repository (including dry runs). */
export async function validateProjectRepository(registration: ReturnType<typeof resolveProjectRegistration>): Promise<void> {
  let directory;
  try {
    directory = await stat(registration.pathResolver.toFileSystem(registration.path));
  } catch {
    throw new Error(`Repo path does not exist: ${registration.path}`);
  }
  if (!directory.isDirectory()) throw new Error(`Repo path must be a directory: ${registration.path}`);
  try {
    const result = await registration.commandRunner.execFile('git', ['rev-parse', '--is-inside-work-tree'], registration.path, { silent: true });
    if (result.stdout.trim() !== 'true') throw new Error('Not inside a work tree');
  } catch {
    throw new Error(`Repo path must be an existing git repository: ${registration.path}`);
  }
}
