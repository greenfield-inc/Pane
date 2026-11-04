import path from 'path';
import fs from 'fs';
import { glob, hasMagic } from 'glob';
import { CommandRunner } from '../utils/commandRunner';
import type { ProjectEnvironment } from '../utils/pathResolver';
import { escapeForBash, posixJoin } from '../utils/wslUtils';
import type { WorktreeFileSyncEntry } from '../../../shared/types/worktreeFileSync';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

export interface WorktreeFileSyncFailure {
  path: string;
  reason: string;
}

export interface WorktreeFileSyncResult {
  installCommand: string | null;
  failures: WorktreeFileSyncFailure[];
}

// Recursive node_modules copies on large repos can take far longer than the
// 60s default exec timeout; give copy commands a generous ceiling instead of
// killing them midway and leaving a partial node_modules behind.
const COPY_TIMEOUT_MS = 600_000;
const GENERATED_WORKSPACE_DIR_NAMES = new Set(['worktrees']);

/**
 * Joins path segments correctly for the target environment.
 * On WSL, Node's path.join uses backslashes (Windows host), but commands
 * execute inside the Linux distro and need forward slashes.
 */
function envJoin(environment: ProjectEnvironment, ...segments: string[]): string {
  if (environment !== 'windows') {
    return posixJoin(...segments);
  }
  return path.join(...segments);
}

/**
 * Computes the relative path between two paths correctly for the target environment.
 * On WSL, both paths are POSIX (from WSL find output), but Node's path.relative
 * uses win32 semantics (backslashes) since Electron runs on Windows — so we must
 * use path.posix.relative instead.
 */
function envRelative(environment: ProjectEnvironment, from: string, to: string): string {
  if (environment !== 'windows') {
    return path.posix.relative(from, to);
  }
  return path.relative(from, to);
}

function normalizeSyncPath(entryPath: string): string {
  let normalized = entryPath.trim().replace(/\\/g, '/');
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  if (normalized === '.') {
    return '';
  }

  if (
    normalized.startsWith('/')
    || path.win32.isAbsolute(normalized)
    || normalized.split('/').includes('..')
  ) {
    throw new Error('Worktree file sync paths must be repo-relative and cannot contain ".."');
  }

  return normalized;
}

function entryHasGlobPattern(entryPath: string): boolean {
  return hasMagic(entryPath);
}

function isGeneratedWorkspaceSegment(segment: string): boolean {
  return GENERATED_WORKSPACE_DIR_NAMES.has(segment);
}

function isExplicitGeneratedWorkspaceEntry(entryPath: string): boolean {
  const segments = entryPath.split('/').filter(Boolean);
  const lastSegment = segments[segments.length - 1];
  return lastSegment !== undefined && isGeneratedWorkspaceSegment(lastSegment);
}

function buildMatchPatterns(entryPath: string, recursive: boolean): string[] {
  if (!recursive || entryPath.includes('/')) {
    return [entryPath];
  }
  return [
    entryPath,
    `*/${entryPath}`,
    `*/*/${entryPath}`,
    `*/*/*/${entryPath}`,
    `*/*/*/*/${entryPath}`,
  ];
}

function shouldSkipMatch(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  if (
    normalized === '.git'
    || normalized.startsWith('.git/')
    || normalized.includes('/.git/')
    || segments.some(isGeneratedWorkspaceSegment)
  ) {
    return true;
  }

  if (normalized.endsWith('/node_modules')) {
    const beforeNodeModules = normalized.slice(0, -'/node_modules'.length);
    return beforeNodeModules.includes('/node_modules');
  }

  return false;
}

function escapeRegexChar(char: string): string {
  return '\\^$+?.()|{}[]'.includes(char) ? `\\${char}` : char;
}

function segmentPatternToRegExp(segmentPattern: string): RegExp {
  let source = '';
  for (let i = 0; i < segmentPattern.length; i++) {
    const char = segmentPattern[i];
    if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '[') {
      const endIndex = segmentPattern.indexOf(']', i + 1);
      if (endIndex > i + 1) {
        source += segmentPattern.slice(i, endIndex + 1);
        i = endIndex;
      } else {
        source += '\\[';
      }
    } else {
      source += escapeRegexChar(char);
    }
  }
  try {
    return new RegExp(`^${source}$`);
  } catch {
    return /^$/;
  }
}

function globSegmentsMatch(patternSegments: string[], pathSegments: string[]): boolean {
  if (patternSegments.length === 0) {
    return pathSegments.length === 0;
  }

  const [patternSegment, ...remainingPatternSegments] = patternSegments;
  if (patternSegment === '**') {
    for (let i = 0; i <= pathSegments.length; i++) {
      if (globSegmentsMatch(remainingPatternSegments, pathSegments.slice(i))) {
        return true;
      }
    }
    return false;
  }

  const [pathSegment, ...remainingPathSegments] = pathSegments;
  if (!pathSegment) {
    return false;
  }

  return segmentPatternToRegExp(patternSegment).test(pathSegment)
    && globSegmentsMatch(remainingPatternSegments, remainingPathSegments);
}

function globMatchesAny(patterns: string[], relativePath: string): boolean {
  const pathSegments = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  return patterns.some((pattern) => {
    const patternSegments = pattern.split('/').filter(Boolean);
    return globSegmentsMatch(patternSegments, pathSegments);
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns the platform-appropriate copy command string.
 *
 * Files (.env*, .aider.conf.yml, etc.) always use a regular copy — never hard
 * links. Hard links share inodes, so editing the copy would silently edit the
 * original file in the main repo.
 *
 * Directories use platform-appropriate copy:
 *   - Linux / WSL  → `cp -rp`  (recursive copy, preserves permissions)
 *   - macOS        → `cp -c -R` (APFS clones, near-instant, copy-on-write)
 *   - Windows      → `robocopy /E /MT` (multi-threaded recursive copy)
 */
function getFastCopyCommand(
  src: string,
  dest: string,
  environment: ProjectEnvironment,
  isFile: boolean,
): string {
  if (isFile) {
    // Regular copy for files — no hard links
    if (environment === 'windows') {
      return `copy "${src}" "${dest}"`;
    }
    return `cp "${src}" "${dest}"`;
  }

  // Directory copy — use regular recursive copy for reliability
  // Hard links (cp -al) cause issues: .asar files crash Electron's fs.watch,
  // and shared inodes mean writes in the worktree can mutate the main repo.
  switch (environment) {
    case 'macos':
      return `cp -c -R "${src}" "${dest}"`;  // APFS clones — fast, copy-on-write, no shared inodes
    case 'linux':
    case 'wsl':
      return `cp -rp "${src}" "${dest}"`;    // regular recursive copy, preserves permissions
    case 'windows':
      return `robocopy "${src}" "${dest}" /E /MT /NJH /NJS /NDL /NFL /NC /NS`;
  }
}

/**
 * Ensures the parent directory of `destPath` exists.
 * Must be called BEFORE every copy to prevent `cp -al` from copying INTO an
 * existing directory and causing double-nesting (e.g. dest/node_modules/node_modules).
 *
 * @param cwd - A known-existing directory to use as the working directory for
 *              the mkdir command. Never pass `parentDir` itself because it may
 *              not exist yet, which would cause an ENOENT on the chdir call.
 */
async function ensureParentDir(
  destPath: string,
  commandRunner: CommandRunner,
  cwd: string,
  environment: ProjectEnvironment,
): Promise<void> {
  const parentDir = environment === 'windows'
    ? path.dirname(destPath)
    : path.posix.dirname(destPath);

  if (environment === 'windows') {
    // Windows: use md to create directory, suppress "already exists" error
    await commandRunner.execAsync(`md "${parentDir}" 2>nul || echo.`, cwd);
  } else {
    await commandRunner.execAsync(`mkdir -p "${parentDir}"`, cwd);
  }
}

/**
 * Returns true if the path exists (file or directory).
 *
 * On native Windows, uses Node's `fs.promises.access` directly since the paths
 * are local and `test -e` is not available outside WSL.
 * On Unix/WSL, uses `test -e` via the command runner so WSL paths are handled
 * transparently.
 */
async function existsAt(
  filePath: string,
  commandRunner: CommandRunner,
  environment: ProjectEnvironment,
  cwd: string,
): Promise<boolean> {
  if (environment === 'windows') {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
  try {
    await commandRunner.execAsync(`test -e "${filePath}"`, cwd, { silent: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true if `filePath` is a regular file (not a directory).
 *
 * On native Windows, uses Node's `fs.promises.stat` directly since the paths
 * are local and `test -f` is not available outside WSL.
 * On Unix/WSL, uses `test -f` via the command runner.
 */
async function isFilePath(
  filePath: string,
  commandRunner: CommandRunner,
  environment: ProjectEnvironment,
  cwd: string,
): Promise<boolean> {
  if (environment === 'windows') {
    try {
      const stat = await fs.promises.stat(filePath);
      return stat.isFile();
    } catch {
      return false;
    }
  }
  try {
    await commandRunner.execAsync(`test -f "${filePath}"`, cwd, { silent: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds all items matching `pattern` recursively under `repoPath`.
 *
 * Supported patterns:
 *   - `node_modules`  → directories named "node_modules", skipping nested ones
 *   - `.env*`         → files matching the .env* glob, skipping node_modules subtrees
 *
 * Windows native uses `dir /s /b`; all other environments (linux/macos/wsl) use `find`.
 */
async function findRecursiveMatches(
  repoPath: string,
  pattern: string,
  recursive: boolean,
  commandRunner: CommandRunner,
  environment: ProjectEnvironment,
): Promise<string[]> {
  try {
    const matchPatterns = buildMatchPatterns(pattern, recursive);
    if (environment === 'windows') {
      return await findRecursiveMatchesWindows(repoPath, matchPatterns);
    }
    return await findRecursiveMatchesUnix(repoPath, matchPatterns, commandRunner);
  } catch (err) {
    console.error(`[WorktreeFileSync] findRecursiveMatches failed for pattern "${pattern}":`, err);
    return [];
  }
}

async function findRecursiveMatchesUnix(
  repoPath: string,
  patterns: string[],
  commandRunner: CommandRunner,
): Promise<string[]> {
  const script = [
    'repo=$1',
    'find "$repo" -maxdepth 5 \\( -path "$repo/.git" -o \\( -type d -name worktrees ! -path "$repo" \\) \\) -prune -o -print | while IFS= read -r abs; do',
    '  printf "%s\\n" "$abs"',
    'done',
  ].join('\n');
  const cmd = `sh -c ${escapeForBash(script)} sh ${escapeForBash(repoPath)}`;
  const { stdout } = await commandRunner.execAsync(cmd, repoPath);
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .filter((absolutePath) => {
      const relativePath = path.posix.relative(repoPath, absolutePath);
      return relativePath.length > 0
        && !relativePath.startsWith('..')
        && globMatchesAny(patterns, relativePath);
    });
}

async function findRecursiveMatchesWindows(
  repoPath: string,
  patterns: string[],
): Promise<string[]> {
  return glob(patterns, {
    cwd: repoPath,
    dot: true,
    nodir: false,
    absolute: true,
    follow: false,
    ignore: [
      '**/.git',
      '**/.git/**',
      '**/worktrees',
      '**/worktrees/**',
    ],
  });
}

/**
 * Executes a copy command, with special handling for robocopy exit codes on Windows.
 * Robocopy exit codes 0–7 all indicate success; 8+ indicate errors.
 */
async function execCopyCommand(
  cmd: string,
  cwd: string,
  commandRunner: CommandRunner,
  environment: ProjectEnvironment,
): Promise<void> {
  try {
    await commandRunner.execAsync(cmd, cwd, { timeout: COPY_TIMEOUT_MS });
  } catch (err: unknown) {
    if (environment === 'windows') {
      let code: number | undefined;
      try {
        code = decodeBoundary(err, boundary.object({ code: boundary.optional(boundary.number) })).code;
      } catch {
        code = undefined;
      }
      if (code !== undefined && code >= 0 && code <= 7) {
        // Robocopy: exit codes 0–7 are all success (0=no copy, 1=copied, 2-7=informational)
        return;
      }
    }
    throw err;
  }
}

/** Why a copy failed: a shell command's stderr when it wrote one, since its message starts with the whole command. */
function failureReason(err: Error): string {
  let stderr = '';
  try {
    stderr = decodeBoundary(err, boundary.object({ stderr: boundary.optional(boundary.string) })).stderr?.trim() ?? '';
  } catch {
    // Errors that did not come from a shell command have no stderr.
  }
  return stderr || err.message;
}

async function copyRootDirectoryExcludingGeneratedChildren(
  srcPath: string,
  destPath: string,
  commandRunner: CommandRunner,
  environment: ProjectEnvironment,
): Promise<void> {
  if (environment === 'windows') {
    await fs.promises.mkdir(destPath, { recursive: true });
    const children = await fs.promises.readdir(srcPath, { withFileTypes: true });
    for (const child of children) {
      if (isGeneratedWorkspaceSegment(child.name)) continue;
      await fs.promises.cp(
        path.join(srcPath, child.name),
        path.join(destPath, child.name),
        { recursive: true, force: false, errorOnExist: false, preserveTimestamps: true },
      );
    }
    return;
  }

  const copyCommand = environment === 'macos' ? 'cp -c -R' : 'cp -rp';
  const excludedCasePatterns = Array.from(GENERATED_WORKSPACE_DIR_NAMES).join('|');
  const escapedSrc = escapeForBash(srcPath);
  const escapedDest = escapeForBash(destPath);
  const command = [
    `mkdir -p ${escapedDest}`,
    `for item in ${escapedSrc}/* ${escapedSrc}/.[!.]* ${escapedSrc}/..?*; do`,
    '  [ -e "$item" ] || continue',
    '  base="$(basename "$item")"',
    `  case "$base" in ${excludedCasePatterns}) continue ;; esac`,
    `  ${copyCommand} "$item" ${escapedDest}/`,
    'done',
  ].join('\n');

  await commandRunner.execAsync(command, srcPath, { timeout: COPY_TIMEOUT_MS });
}

/**
 * Copies a single root-level entry from main repo into the worktree.
 * Only copies if the source exists AND the destination is missing.
 */
async function copyRootEntry(
  mainRepoPath: string,
  worktreePath: string,
  entry: WorktreeFileSyncEntry,
  commandRunner: CommandRunner,
  environment: ProjectEnvironment,
): Promise<void> {
  const entryPath = normalizeSyncPath(entry.path);
  if (entryPath.length === 0) return;

  const srcPath = envJoin(environment, mainRepoPath, entryPath);
  const destPath = envJoin(environment, worktreePath, entryPath);

  const srcExists = await existsAt(srcPath, commandRunner, environment, mainRepoPath);
  if (!srcExists) return;

  const destExists = await existsAt(destPath, commandRunner, environment, worktreePath);
  if (destExists) return;

  const isFile = await isFilePath(srcPath, commandRunner, environment, mainRepoPath);
  if (!isFile && !isExplicitGeneratedWorkspaceEntry(entryPath)) {
    await copyRootDirectoryExcludingGeneratedChildren(srcPath, destPath, commandRunner, environment);
    return;
  }

  await ensureParentDir(destPath, commandRunner, worktreePath, environment);
  const cmd = getFastCopyCommand(srcPath, destPath, environment, isFile);
  await execCopyCommand(cmd, mainRepoPath, commandRunner, environment);
}

/**
 * Finds all recursive matches of `entry.path` in the main repo and copies any
 * that are missing from the worktree. Returns the failures encountered so the
 * caller can surface them; individual failures never abort remaining matches.
 */
async function copyRecursiveMatches(
  mainRepoPath: string,
  worktreePath: string,
  entry: WorktreeFileSyncEntry,
  commandRunner: CommandRunner,
  environment: ProjectEnvironment,
): Promise<WorktreeFileSyncFailure[]> {
  const entryPath = normalizeSyncPath(entry.path);
  if (entryPath.length === 0) return [];

  const matches = await findRecursiveMatches(
    mainRepoPath,
    entryPath,
    entry.recursive,
    commandRunner,
    environment,
  );

  const failures: WorktreeFileSyncFailure[] = [];
  for (const matchPath of matches) {
    const relativePath = envRelative(environment, mainRepoPath, matchPath);
    if (shouldSkipMatch(relativePath)) continue;

    try {
      const destPath = envJoin(environment, worktreePath, relativePath);

      const destExists = await existsAt(destPath, commandRunner, environment, worktreePath);
      if (destExists) continue;

      await ensureParentDir(destPath, commandRunner, worktreePath, environment);
      const isFile = await isFilePath(matchPath, commandRunner, environment, mainRepoPath);
      const cmd = getFastCopyCommand(matchPath, destPath, environment, isFile);
      await execCopyCommand(cmd, mainRepoPath, commandRunner, environment);
    } catch (err) {
      console.error(`[WorktreeFileSync] Failed to copy match "${matchPath}":`, err);
      failures.push({ path: relativePath, reason: err instanceof Error ? failureReason(err) : String(err) });
      // Continue with remaining matches, best effort
    }
  }
  return failures;
}

/**
 * Checks root-level lock files in priority order and returns the corresponding
 * install command for the first match.
 *
 * Uses `existsAt` (which handles WSL and native Windows transparently) to
 * check each lock file.
 */
async function detectInstallCommand(
  mainRepoPath: string,
  commandRunner: CommandRunner,
  environment: ProjectEnvironment,
): Promise<string | null> {
  const lockFiles: Array<{ file: string; command: string }> = [
    { file: 'pnpm-lock.yaml', command: 'pnpm install' },
    { file: 'package-lock.json', command: 'npm install' },
    { file: 'yarn.lock', command: 'yarn install' },
    { file: 'bun.lockb', command: 'bun install' },
  ];

  for (const { file, command } of lockFiles) {
    const lockPath = envJoin(environment, mainRepoPath, file);
    const exists = await existsAt(lockPath, commandRunner, environment, mainRepoPath);
    if (exists) {
      return command;
    }
  }

  return null;
}

/**
 * Heavyweight entries (node_modules) can take tens of seconds to copy, so
 * they must never delay small/critical entries like .env files.
 */
function isHeavyweightEntry(entry: WorktreeFileSyncEntry): boolean {
  const name = entry.path.trim();
  return name === 'node_modules' || name.endsWith('/node_modules');
}

export const worktreeFileSyncService = {
  /**
   * Copies all enabled sync entries from `mainRepoPath` into `worktreePath`,
   * then detects the package manager and returns its install command.
   *
   * Small/critical entries (.env*, config dirs) are always copied before
   * heavyweight directories like node_modules, regardless of the order in the
   * persisted config, so credentials land quickly even on large repos.
   *
   * This method is best-effort: individual copy failures are caught, logged,
   * and reported in the returned `failures` array without aborting the rest
   * of the sync. The method itself never throws.
   */
  async syncWorktree(
    mainRepoPath: string,
    worktreePath: string,
    commandRunner: CommandRunner,
    environment: ProjectEnvironment,
    entries: WorktreeFileSyncEntry[],
  ): Promise<WorktreeFileSyncResult> {
    const failures: WorktreeFileSyncFailure[] = [];
    try {
      const enabledEntries = entries.filter((e) => e.enabled && e.path.trim().length > 0);
      const orderedEntries = [
        ...enabledEntries.filter((e) => !isHeavyweightEntry(e)),
        ...enabledEntries.filter(isHeavyweightEntry),
      ];

      for (const entry of orderedEntries) {
        try {
          const normalizedPath = normalizeSyncPath(entry.path);
          const hasGlobPattern = entryHasGlobPattern(normalizedPath);
          const isExplicitGeneratedWorkspacePath = !hasGlobPattern && isExplicitGeneratedWorkspaceEntry(normalizedPath);
          if ((entry.recursive || hasGlobPattern) && !isExplicitGeneratedWorkspacePath) {
            const matchFailures = await copyRecursiveMatches(
              mainRepoPath,
              worktreePath,
              entry,
              commandRunner,
              environment,
            );
            failures.push(...matchFailures);
          } else {
            await copyRootEntry(
              mainRepoPath,
              worktreePath,
              entry,
              commandRunner,
              environment,
            );
          }
        } catch (err) {
          console.error(`[WorktreeFileSync] Failed to sync entry "${entry.path}":`, err);
          failures.push({ path: entry.path, reason: err instanceof Error ? failureReason(err) : String(err) });
          // Continue with next entry, best effort
        }
      }

      const installCommand = await detectInstallCommand(mainRepoPath, commandRunner, environment);
      return { installCommand, failures };
    } catch (err) {
      console.error('[WorktreeFileSync] syncWorktree failed:', err);
      failures.push({ path: 'worktree files', reason: err instanceof Error ? failureReason(err) : String(err) });
      return { installCommand: null, failures };
    }
  },
};
