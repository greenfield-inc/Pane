import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Reading the whole process table is one call; give it room without hanging teardown. */
const SNAPSHOT_TIMEOUT_MS = 5_000;
/** A killed process leaves the table within a few milliseconds, so poll finely. */
const EXIT_POLL_INTERVAL_MS = 25;
const DEFAULT_TERMINATE_TIMEOUT_MS = 5_000;

/**
 * Whether a process with this pid is still running.
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. `EPERM` means the process exists but is owned by someone else,
 * which still counts as alive.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // SAFETY: process.kill only ever rejects with an errno error, and the two
    // it can raise here are ESRCH (no such process) and EPERM (someone else's).
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Resolves once none of `pids` is running, or when `timeoutMs` elapses.
 * Returns the pids still alive, so callers can escalate.
 */
export async function waitForProcessesToExit(
  pids: readonly number[],
  timeoutMs: number,
): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let alive = pids.filter(isProcessAlive);
  while (alive.length > 0 && Date.now() < deadline) {
    await delay(Math.min(EXIT_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    alive = alive.filter(isProcessAlive);
  }
  return alive;
}

/**
 * Every process descended from `rootPids`, excluding the roots themselves.
 *
 * Read this *before* the roots are killed: a dead parent's children keep its
 * pid as their parent, so nothing can walk to them afterwards. Best effort —
 * an unreadable process table yields an empty list rather than an error.
 */
export async function listDescendantPids(rootPids: readonly number[]): Promise<number[]> {
  const roots = rootPids.filter(pid => Number.isInteger(pid) && pid > 0);
  if (roots.length === 0) return [];
  const children = await readProcessChildren();
  const descendants: number[] = [];
  const seen = new Set<number>(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    // SAFETY: the loop condition guarantees an element.
    const parent = queue.shift()!;
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      descendants.push(child);
      queue.push(child);
    }
  }
  return descendants;
}

/**
 * Forcefully terminates `pids` and everything descended from them, then waits
 * for them to leave the process table. Returns the pids still running when
 * `timeoutMs` ran out — empty when the whole tree is gone.
 *
 * Used when a process outlives the polite shutdown its owner asked for. On
 * Windows that matters beyond leaking a process: a directory cannot be renamed
 * or removed while it is any live process's current working directory.
 */
export async function terminateProcessTrees(
  rootPids: readonly number[],
  options: { timeoutMs?: number } = {},
): Promise<number[]> {
  const roots = rootPids.filter(pid => Number.isInteger(pid) && pid > 0);
  if (roots.length === 0) return [];
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TERMINATE_TIMEOUT_MS);
  const tree = [...new Set([...roots, ...await listDescendantPids(roots)])];
  // Deepest first: killing a parent can orphan a child nothing can walk to.
  await killProcesses([...tree].reverse());
  return waitForProcessesToExit(tree, Math.max(0, deadline - Date.now()));
}

/** Kills these processes as forcefully as the platform allows. Never throws. */
async function killProcesses(pids: readonly number[]): Promise<void> {
  if (process.platform === 'win32') {
    // One taskkill for the lot — a process per pid would cost more than the
    // kill itself. `/T` also takes down children spawned since the snapshot,
    // and taskkill reports a pid it cannot touch without abandoning the rest.
    const args = ['/F', '/T', ...pids.flatMap(pid => ['/PID', String(pid)])];
    await execFileAsync('taskkill', args, { timeout: SNAPSHOT_TIMEOUT_MS }).catch(() => undefined);
    return;
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone, or not ours to kill.
    }
  }
}

/**
 * Parent pid → its child pids, for every process on the machine.
 *
 * One snapshot rather than a query per pid: on Windows each query starts a
 * PowerShell process, which costs far more than the walk it serves.
 */
async function readProcessChildren(): Promise<Map<number, number[]>> {
  const children = new Map<number, number[]>();
  let stdout: string;
  try {
    stdout = process.platform === 'win32'
      ? (await execFileAsync('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
      ], { encoding: 'utf8', timeout: SNAPSHOT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 })).stdout
      : (await execFileAsync('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8', timeout: SNAPSHOT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 })).stdout;
  } catch (error) {
    console.warn('[ProcessTree] snapshot_failed:', error);
    return children;
  }
  for (const line of stdout.split('\n')) {
    const [pid, parent] = line.trim().split(/\s+/u).map(value => Number.parseInt(value, 10));
    if (!Number.isInteger(pid) || !Number.isInteger(parent) || pid === parent) continue;
    const siblings = children.get(parent);
    if (siblings) siblings.push(pid);
    else children.set(parent, [pid]);
  }
  return children;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
