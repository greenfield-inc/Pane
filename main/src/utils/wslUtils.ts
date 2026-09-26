import { execSync as nodeExecSync, execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Cache WSL user's $HOME per distro (one-time detection per distro).
const wslHomeCache = new Map<string, string>();

interface WSLCommand {
  file: string;
  args: string[];
}

interface WSLShellSpawn {
  path: string;
  name: string;
  args: string[];
}

/**
 * Get the WSL user's $HOME directory for a given distro, cached after first call.
 * Used to save files to the WSL-native filesystem (e.g. pasted images) so that
 * CLI tools running inside WSL can read them at a normal Linux path instead of
 * a /mnt/c/... DrvFs path, which some tools (Claude Code CLI) can't attach.
 */
export async function getWSLHome(distro: string): Promise<string | null> {
  const cached = wslHomeCache.get(distro);
  if (cached) return cached;
  try {
    const { stdout } = await execFileAsync(
      'wsl.exe',
      ['-d', distro, '--', 'bash', '-c', 'echo "$HOME"'],
      { timeout: 5000, encoding: 'utf8' }
    );
    const home = stdout.trim();
    if (home && home.startsWith('/')) {
      wslHomeCache.set(distro, home);
      return home;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Escape a value for bash single quotes — always uses Unix-style escaping.
 *
 * This is intentionally NOT using escapeShellArg() from shellEscape.ts because
 * that function is platform-aware (uses double quotes on win32). When building
 * commands for WSL, the target shell is always Linux bash regardless of the host
 * OS, so we must always use single-quote escaping to prevent $VAR / backtick
 * expansion. Safe on Windows because the escaped string goes inside a bash -c
 * argument passed to wsl.exe — it never touches cmd.exe or PowerShell.
 */
export function escapeForBash(value: string): string {
  if (!value) return "''";
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export interface WSLPathInfo {
  distro: string;
  linuxPath: string;
}

export interface WSLContext {
  enabled: boolean;
  distribution: string;
  linuxPath: string;
}

/**
 * Parse a Windows UNC path to extract WSL distro and Linux path.
 * Handles \\wsl.localhost\Distro\... and \\wsl$\Distro\...
 */
export function parseWSLPath(windowsPath: string): WSLPathInfo | null {
  const normalized = windowsPath.replace(/\\/g, '/');
  const match = normalized.match(/^\/\/(wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/i);
  if (!match) return null;
  return {
    distro: match[2],
    linuxPath: match[3] || '/',
  };
}

export function isWSLUNCPath(pathStr: string): boolean {
  return parseWSLPath(pathStr) !== null;
}

/**
 * Convert a Linux path back to a Windows UNC path for fs module access.
 * Example: linuxToUNCPath('/home/user/project', 'Ubuntu')
 *   → '\\\\wsl.localhost\\Ubuntu\\home\\user\\project'
 */
export function linuxToUNCPath(linuxPath: string, distro: string): string {
  // Use wsl.localhost for modern Windows
  const windowsPath = linuxPath.replace(/\//g, '\\');
  return `\\\\wsl.localhost\\${distro}${windowsPath}`;
}

/**
 * Convert a Windows drive path to its default WSL mount path.
 * Example: 'C:\\Users\\me\\file.png' → '/mnt/c/Users/me/file.png'
 */
export function windowsPathToWSLMount(windowsPath: string): string {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(windowsPath);
  if (!match) return windowsPath;
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, '/')}`;
}

/**
 * Join path segments with forward slashes (for Linux paths on Windows).
 * NEVER use Node's path.join() for WSL Linux paths.
 */
export function posixJoin(...segments: string[]): string {
  return segments
    .join('/')
    .replace(/\/+/g, '/')  // collapse multiple slashes
    .replace(/\/$/, '');    // remove trailing slash
}

/**
 * Escape a string for use inside a bash -c "..." double-quoted context.
 * Only escapes bash special characters (\, ", `, $).
 */
export function escapeForBashDoubleQuote(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');
}

/**
 * Build args array for invoking wsl.exe directly via execFileSync/execFile.
 * Bypasses cmd.exe entirely, avoiding all cmd.exe escaping issues (%, ^, &, etc.).
 * If cwd provided, cd to it first inside the bash -c command.
 */
export function getWSLExecArgs(command: string, distro: string, cwd?: string, extraEnv?: Record<string, string>): WSLCommand {
  let bashCommand = command;
  if (cwd) {
    bashCommand = `cd ${escapeForBash(cwd)} && ${command}`;
  }
  if (extraEnv && Object.keys(extraEnv).length > 0) {
    const exports = Object.entries(extraEnv)
      .map(([key, value]) => `export ${key}=${escapeForBash(value)}`)
      .join('; ');
    bashCommand = `${exports}; ${bashCommand}`;
  }
  return {
    file: 'wsl.exe',
    args: ['-d', distro, '--', 'bash', '-c', bashCommand],
  };
}

/**
 * Build a WSLENV value that tells WSL to propagate the given Windows env var
 * names into the Linux environment of child shells.
 *
 * Background: env vars passed to `pty.spawn('wsl.exe', ..., {env})` are set on
 * the wsl.exe Windows process — they do NOT automatically cross the WSL boundary
 * into the bash process that wsl.exe launches. Microsoft's documented mechanism
 * for crossing that boundary is WSLENV: a colon-delimited list of variable names
 * (plus optional flags) that WSL copies from the Windows env into the Linux env
 * at shell startup. See: https://learn.microsoft.com/en-us/windows/wsl/filesystems#wslenv
 *
 * We append to any pre-existing WSLENV on the user's Windows environment so we
 * don't clobber their own tooling.
 */
export function buildWSLENV(varNames: readonly string[]): string {
  const ours = varNames.join(':');
  const existing = process.env.WSLENV;
  return existing ? `${existing}:${ours}` : ours;
}

/**
 * Get shell spawn info for opening an interactive WSL terminal.
 * Returns shape compatible with ShellDetector's ShellInfo.
 */
export function getWSLShellSpawn(distro: string, cwd?: string): WSLShellSpawn {
  // Use bash -c "cd ... && exec bash" instead of --cd flag.
  // The --cd flag is broken on many WSL versions (e.g., 2.5.9.0) for Linux paths.
  const args = ['-d', distro, '--'];
  if (cwd) {
    const escapedCwd = escapeForBashDoubleQuote(cwd);
    args.push('bash', '-c', `cd '${escapedCwd}' && exec bash --login`);
  } else {
    args.push('bash', '--login');
  }
  return { path: 'wsl.exe', name: 'wsl', args };
}

/**
 * Build WSL context from a project record.
 * Returns null if project is not WSL-enabled.
 */
export function getWSLContextFromProject(project: {
  wsl_enabled?: boolean;
  wsl_distribution?: string | null;
  path: string;
}): WSLContext | null {
  if (!project.wsl_enabled || !project.wsl_distribution) return null;
  return {
    enabled: true,
    distribution: project.wsl_distribution,
    linuxPath: project.path,
  };
}

/**
 * Bump inotify limits inside WSL so file watchers (Claude Code, VS Code, etc.) don't exhaust them.
 * WSL2 doesn't persist sysctl changes across reboots, so this runs on every app launch.
 * Uses -u root to avoid sudo password prompts. Async and fire-and-forget — failures are silently ignored.
 */
export async function bumpWSLInotifyLimits(distros: string[]): Promise<void> {
  if (process.platform !== 'win32' || distros.length === 0) return;

  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);

  const unique = [...new Set(distros)];
  await Promise.allSettled(
    unique.map(distro =>
      execFileAsync('wsl.exe', [
        '-d', distro, '-u', 'root', '--',
        'sysctl', '-w',
        'fs.inotify.max_user_watches=2147483647',
        'fs.inotify.max_user_instances=8192',
      ], { timeout: 10000 })
    )
  );
}

/**
 * Validate that WSL is available and the specified distro is installed.
 * Returns error message if invalid, null if OK.
 */
export function validateWSLAvailable(distro: string): string | null {
  try {
    nodeExecSync('wsl.exe --version', { encoding: 'utf-8', timeout: 5000 });
  } catch {
    return 'WSL is not installed or not available on this system.';
  }

  try {
    const output = nodeExecSync('wsl.exe -l -q', { encoding: 'utf-8', timeout: 5000 });
    // wsl -l -q outputs distro names, one per line (may have UTF-16 BOM/null chars)
    const distros = output
      .replaceAll('\0', '') // strip null chars from UTF-16
      .split('\n')
      .map(d => d.trim())
      .filter(Boolean);
    const found = distros.some(d => d.toLowerCase() === distro.toLowerCase());
    if (!found) {
      return `WSL distribution '${distro}' is not installed. Available: ${distros.join(', ')}`;
    }
  } catch {
    return 'Failed to list WSL distributions.';
  }

  return null; // All good
}
