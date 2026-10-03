/**
 * Folder browsing and typed-path checks that run on the active host's daemon.
 *
 * When Pane is connected to a remote host, repo actions (open, create, clone)
 * run there, so every path the user picks or types has to be a path on that
 * host. These shapes are shared by the daemon handlers and the renderer.
 */

export type HostPathErrorCode =
  | 'NOT_FOUND'
  | 'NOT_A_DIRECTORY'
  | 'PERMISSION_DENIED'
  | 'ALREADY_EXISTS'
  | 'INVALID_NAME'
  | 'NOT_A_GIT_REPO'
  | 'WINDOWS_PATH_ON_POSIX_HOST';

/** `open` registers an existing git repo as is; `new` creates the folder (and repo) first. */
export type ProjectPathMode = 'open' | 'new';

interface HostLabelledRequest {
  /** Display name of the active host, used only in user-facing messages. */
  hostLabel?: string;
}

export interface BrowseDirectoriesRequest extends HostLabelledRequest {
  /** Folder to list. Omitted, empty or `~` lists the host's home folder. */
  path?: string;
  /** Include dot folders (flagged with `isHidden`). Defaults to true. */
  showHidden?: boolean;
}

export interface HostDirectoryEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
  isHidden: boolean;
}

export interface BrowseDirectoriesResult {
  path: string;
  /** Null at the filesystem root. */
  parent: string | null;
  home: string;
  /** The host's `process.platform`. */
  platform: string;
  entries: HostDirectoryEntry[];
}

export interface CreateDirectoryRequest extends HostLabelledRequest {
  parent: string;
  name: string;
}

export interface ValidateProjectPathRequest extends HostLabelledRequest {
  path: string;
  mode: ProjectPathMode;
}

export interface ValidateProjectPathResult {
  path: string;
  isGitRepo: boolean;
}

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:(?:[\\/]|$)/;

/** A drive-letter path (`C:\x`, `C:/x`) or any path with a backslash. */
export function isWindowsStylePath(input: string): boolean {
  const trimmed = input.trim();
  return WINDOWS_DRIVE_PATH.test(trimmed) || trimmed.includes('\\');
}

function describePlatform(platform: string): string {
  if (platform === 'darwin') return 'a macOS host';
  return 'a Linux host';
}

export function formatWindowsPathOnPosixHostError(hostLabel: string, platform = 'linux'): string {
  return `That's a path on this computer; ${hostLabel} is ${describePlatform(platform)}. Pick a folder on ${hostLabel}.`;
}
