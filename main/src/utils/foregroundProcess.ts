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
  if (process.platform !== 'darwin' && process.platform !== 'linux') return undefined;
  const { stdout: groupOutput } = await execFileAsync('ps', ['-o', 'tpgid=', '-p', String(shellPid)], {
    encoding: 'utf8',
    timeout: PS_TIMEOUT_MS,
  });
  const foregroundPid = Number.parseInt(groupOutput.trim(), 10);
  if (!Number.isInteger(foregroundPid) || foregroundPid <= 0) return undefined;

  if (process.platform === 'linux') {
    return fs.readlink(`/proc/${foregroundPid}/exe`).catch(() => undefined);
  }
  const { stdout } = await execFileAsync('ps', ['-o', 'comm=', '-p', String(foregroundPid)], {
    encoding: 'utf8',
    timeout: PS_TIMEOUT_MS,
  });
  return stdout.trim() || undefined;
}
