import { access, mkdir, readdir, stat } from 'fs/promises';
import type { Dirent } from 'fs';
import os from 'os';
import path from 'path';
import {
  formatWindowsPathOnPosixHostError,
  isWindowsStylePath,
} from '../../../shared/types/hostPaths';
import type {
  BrowseDirectoriesRequest,
  BrowseDirectoriesResult,
  CreateDirectoryRequest,
  HostDirectoryEntry,
  HostPathErrorCode,
  ValidateProjectPathRequest,
  ValidateProjectPathResult,
} from '../../../shared/types/hostPaths';
import { expandUserRepoPath } from '../utils/pathResolver';
import { resolveProjectRegistration } from './projectRegistration';

/** A path problem the dialog can show inline; `message` never includes file contents. */
export class HostPathError extends Error {
  constructor(readonly code: HostPathErrorCode, message: string) {
    super(message);
    this.name = 'HostPathError';
  }
}

/** The host this daemon runs on. Tests override it; handlers use the real machine. */
interface HostPathContext {
  platform?: NodeJS.Platform;
  homeDir?: string;
  hostLabel?: string;
}

type ProjectRegistration = ReturnType<typeof resolveProjectRegistration>;
type GitRepoCheck = (registration: ProjectRegistration) => Promise<boolean>;

function hostPlatform(context: HostPathContext): NodeJS.Platform {
  return context.platform ?? process.platform;
}

function hostHome(context: HostPathContext): string {
  return context.homeDir ?? os.homedir();
}

/**
 * Reject a path typed or picked on a Windows desktop when the host is POSIX.
 * Linux would otherwise read `C:\repo` as a relative name under the daemon's
 * home and Pane would create an empty repository there.
 */
export function assertPathOnHost(input: string, context: HostPathContext = {}): void {
  const platform = hostPlatform(context);
  if (platform === 'win32' || !isWindowsStylePath(input)) return;
  const hostLabel = context.hostLabel?.trim() || os.hostname();
  throw new HostPathError('WINDOWS_PATH_ON_POSIX_HOST', formatWindowsPathOnPosixHostError(hostLabel, platform));
}

/** Resolve a user path on the host: empty and `~` mean home, relative paths are under home. */
function resolveHostPath(input: string | undefined, context: HostPathContext): string {
  const requested = input?.trim() ?? '';
  assertPathOnHost(requested, context);
  return expandUserRepoPath(requested || '~', { homeDir: hostHome(context) });
}

function toHostPathError(error: NodeJS.ErrnoException, target: string): HostPathError {
  const { code } = error;
  if (code === 'ENOENT') return new HostPathError('NOT_FOUND', `Folder does not exist: ${target}`);
  if (code === 'ENOTDIR') return new HostPathError('NOT_A_DIRECTORY', `Not a folder: ${target}`);
  if (code === 'EACCES' || code === 'EPERM') return new HostPathError('PERMISSION_DENIED', `Permission denied: ${target}`);
  if (code === 'EEXIST') return new HostPathError('ALREADY_EXISTS', `Folder already exists: ${target}`);
  return new HostPathError('NOT_FOUND', `Folder is not available: ${target}`);
}

async function assertDirectory(target: string): Promise<void> {
  const info = await stat(target).catch((error: NodeJS.ErrnoException) => {
    throw toHostPathError(error, target);
  });
  if (!info.isDirectory()) throw new HostPathError('NOT_A_DIRECTORY', `Not a folder: ${target}`);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function isDirectoryEntry(parent: string, entry: Dirent): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await stat(path.join(parent, entry.name))).isDirectory();
  } catch {
    return false;
  }
}

/** List the subfolders of a folder on this host, flagging git repos and dot folders. */
export async function browseHostDirectories(
  request: BrowseDirectoriesRequest,
  context: HostPathContext = {},
): Promise<BrowseDirectoriesResult> {
  const target = resolveHostPath(request.path, context);
  await assertDirectory(target);

  const dirents = await readdir(target, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    throw toHostPathError(error, target);
  });

  const showHidden = request.showHidden ?? true;
  const candidates = dirents.filter(entry => showHidden || !entry.name.startsWith('.'));
  const entries = (await Promise.all(candidates.map(async (entry): Promise<HostDirectoryEntry | null> => {
    if (!(await isDirectoryEntry(target, entry))) return null;
    const entryPath = path.join(target, entry.name);
    return {
      name: entry.name,
      path: entryPath,
      isGitRepo: await pathExists(path.join(entryPath, '.git')),
      isHidden: entry.name.startsWith('.'),
    };
  }))).filter(entry => entry !== null);
  entries.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));

  const parent = path.dirname(target);
  return {
    path: target,
    parent: parent === target ? null : parent,
    home: hostHome(context),
    platform: hostPlatform(context),
    entries,
  };
}

/** Create one new folder on this host, for New project and the clone destination. */
export async function createHostDirectory(
  request: CreateDirectoryRequest,
  context: HostPathContext = {},
): Promise<{ path: string }> {
  const name = request.name.trim();
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) {
    throw new HostPathError('INVALID_NAME', 'Folder names cannot be empty, "." or "..", or contain slashes.');
  }
  const parent = resolveHostPath(request.parent, context);
  await assertDirectory(parent);
  const target = path.join(parent, name);
  await mkdir(target).catch((error: NodeJS.ErrnoException) => {
    throw toHostPathError(error, target);
  });
  return { path: target };
}

const isGitWorkTree: GitRepoCheck = async registration => {
  try {
    const result = await registration.commandRunner.execFile(
      'git',
      ['rev-parse', '--is-inside-work-tree'],
      registration.path,
      { silent: true },
    );
    return result.stdout.trim() === 'true';
  } catch {
    return false;
  }
};

/**
 * Resolve a project path on this host and check it suits the action, without
 * changing anything. `open` needs an existing git repo; `new` needs a folder
 * that is missing or already a folder.
 */
export async function validateHostProjectPath(
  request: ValidateProjectPathRequest,
  context: HostPathContext = {},
  isGitRepo: GitRepoCheck = isGitWorkTree,
): Promise<ValidateProjectPathResult> {
  assertPathOnHost(request.path, context);
  const registration = resolveProjectRegistration(expandUserRepoPath(request.path, { homeDir: hostHome(context) }));
  const fileSystemPath = registration.pathResolver.toFileSystem(registration.path);

  if (request.mode === 'new' && !(await pathExists(fileSystemPath))) {
    return { path: registration.path, isGitRepo: false };
  }
  await assertDirectory(fileSystemPath);

  const repo = await isGitRepo(registration);
  if (request.mode === 'open' && !repo) {
    throw new HostPathError('NOT_A_GIT_REPO', `Not a git repository: ${registration.path}. Use New project to create one.`);
  }
  return { path: registration.path, isGitRepo: repo };
}

/** Resolve the clone destination on this host; it defaults to the home folder. */
export function resolveCloneDestination(destDir: string | undefined, context: HostPathContext = {}): string {
  return resolveHostPath(destDir, context);
}

/** Map a thrown path error to the IPC failure shape the dialogs render inline. */
export function hostPathFailure<ErrorValue>(error: ErrorValue): { success: false; error: string; code: HostPathErrorCode } | null {
  if (!(error instanceof HostPathError)) return null;
  return { success: false, error: error.message, code: error.code };
}
