import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { linuxToUNCPath, parseWSLPath, posixJoin } from './wslUtils';

export type ProjectEnvironment = 'wsl' | 'windows' | 'linux' | 'macos';

interface ExpandUserRepoPathOptions {
  homeDir?: string;
}

/**
 * Expand `~` / `~/…` to the user home directory, then make the path absolute.
 *
 * Relative paths resolve against home rather than Electron's cwd (often `/` or
 * the app directory). WSL UNC paths are returned unchanged so parseWSLPath
 * still works. Existing paths retain the spelling supplied by the user, which
 * keeps stored project-path identity stable on platforms with aliases.
 */
export function expandUserRepoPath(input: string, options: ExpandUserRepoPathOptions = {}): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (parseWSLPath(trimmed)) {
    return trimmed;
  }

  const homeDir = options.homeDir ?? os.homedir();
  let expanded = trimmed;
  if (trimmed === '~') {
    expanded = homeDir;
  } else if (trimmed.startsWith('~') && (trimmed[1] === '/' || trimmed[1] === '\\')) {
    const rest = trimmed.slice(2).split(/[\\/]+/).filter(Boolean);
    expanded = rest.length > 0 ? path.join(homeDir, ...rest) : homeDir;
  }

  const resolved = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(homeDir, expanded);

  return resolved;
}

export class PathResolver {
  readonly environment: ProjectEnvironment;
  private readonly distribution?: string;

  constructor(project: { path: string; wsl_enabled?: boolean; wsl_distribution?: string | null }) {
    if (project.wsl_enabled && project.wsl_distribution) {
      this.environment = 'wsl';
      this.distribution = project.wsl_distribution;
    } else if (process.platform === 'win32') {
      this.environment = 'windows';
    } else if (process.platform === 'darwin') {
      this.environment = 'macos';
    } else {
      this.environment = 'linux';
    }
  }

  /** Convert a stored path (Linux for WSL) to one Node's fs module can use. Idempotent — already-converted UNC paths are returned unchanged. */
  toFileSystem(storedPath: string): string {
    if (this.environment === 'wsl' && this.distribution) {
      // Skip conversion if already a UNC path (prevents double-prefixing)
      if (storedPath.startsWith('\\\\')) {
        return storedPath;
      }
      return linuxToUNCPath(storedPath, this.distribution);
    }
    return storedPath;
  }

  /** Join path segments using the correct separator for this environment */
  join(...segments: string[]): string {
    if (this.environment === 'wsl') {
      return posixJoin(...segments);
    }
    return path.join(...segments);
  }

  /** Compute relative path. Both arguments must be filesystem-format paths (UNC for WSL, native for other platforms). */
  relative(from: string, to: string): string {
    const rel = path.relative(from, to);
    if (this.environment === 'wsl') {
      return rel.replace(/\\/g, '/');
    }
    return rel;
  }

  /** Check if targetPath is within basePath — resolves symlinks. Both must be filesystem-format paths (UNC for WSL, native for other platforms). */
  async isWithin(basePath: string, targetPath: string): Promise<boolean> {
    // Resolve symlinks to prevent escape via symlinked paths
    const resolvedBase = await fs.realpath(basePath).catch(() => basePath);
    // For existing paths, resolve fully. For non-existent paths (new files),
    // resolve the parent directory to catch symlink traversal, then re-append the filename.
    let resolvedTarget: string;
    try {
      resolvedTarget = await fs.realpath(targetPath);
    } catch {
      const parentDir = path.dirname(targetPath);
      const fileName = path.basename(targetPath);
      const resolvedParent = await fs.realpath(parentDir).catch(() => parentDir);
      resolvedTarget = path.join(resolvedParent, fileName);
    }
    const rel = path.relative(resolvedBase, resolvedTarget);
    // rel === '' means paths are equal (base is within itself) — that's valid
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }
}
