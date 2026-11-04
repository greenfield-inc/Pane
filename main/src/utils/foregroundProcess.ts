import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const PS_TIMEOUT_MS = 2000;

/**
 * Executable path of the foreground process-group leader on the terminal
 * whose session leader is `shellPid`. POSIX only; undefined when unknown.
 * node-pty reports only the process name, which is not enough for binaries
 * named by version (Claude Code's native installer).
 */
export async function readForegroundExecutablePath(shellPid: number): Promise<string | undefined> {
  const foregroundPid = await readForegroundProcessGroup(shellPid);
  if (foregroundPid === undefined) return undefined;

  if (process.platform === 'linux') {
    return fs.readlink(`/proc/${foregroundPid}/exe`).catch(() => undefined);
  }
  const { stdout } = await execFileAsync('ps', ['-o', 'comm=', '-p', String(foregroundPid)], {
    encoding: 'utf8',
    timeout: PS_TIMEOUT_MS,
  });
  return stdout.trim() || undefined;
}

/**
 * The foreground process group of the terminal whose session leader is
 * `shellPid`: the shell's own pid while it sits at its prompt, a command's
 * group while one runs. POSIX only; undefined when unknown.
 */
export async function readForegroundProcessGroup(shellPid: number): Promise<number | undefined> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return undefined;
  const { stdout } = await execFileAsync('ps', ['-o', 'tpgid=', '-p', String(shellPid)], {
    encoding: 'utf8',
    timeout: PS_TIMEOUT_MS,
  });
  const group = Number.parseInt(stdout.trim(), 10);
  return Number.isInteger(group) && group > 0 ? group : undefined;
}
