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

/** The terminal's foreground process group: its id, and each member's executable (a path on macOS, a name on Linux). */
export interface ForegroundGroup {
  pgid: number;
  members: string[];
}

/**
 * Every process in the foreground process group of the terminal whose session
 * leader is `shellPid`. A wrapper (`node telemetry.mjs`) and the agent it
 * started share one group; an interactive shell puts each job in a group of
 * its own. POSIX only; undefined when unknown.
 */
export async function readForegroundGroupMembers(shellPid: number): Promise<ForegroundGroup | undefined> {
  const pgid = await readForegroundProcessGroup(shellPid);
  if (pgid === undefined) return undefined;
  const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pgid=,comm='], { encoding: 'utf8', timeout: PS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  const members: string[] = [];
  for (const line of stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/u);
    if (match && Number(match[1]) === pgid) members.push(match[2]);
  }
  return { pgid, members };
}
