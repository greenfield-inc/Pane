import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Environment for `ps`: the C locale keeps dates and names in one parseable form, and the start text stops compare stable. */
export const cLocaleEnv = (): NodeJS.ProcessEnv => ({ ...process.env, LC_ALL: 'C' });

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
 *
 * Windows never clears a dead parent's pid from its children, and reuses pids
 * quickly: a process that inherits a dead parent's pid is not that parent. A
 * child counts only when it was born no earlier than the process holding its
 * parent pid now.
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

/** `ps` prints `??` (macOS) or `?` (Linux) for a process with no controlling terminal. */
function controllingTerminal(tty: string): string | undefined {
  return /^[?-]+$/u.test(tty) ? undefined : tty;
}

/**
 * Each process's controlling terminal (`ttys004`, `pts/3`), for the processes
 * that have one. Empty on Windows, which has no such thing. Naming terminals
 * costs `ps` about 200 ms on macOS, so read this only when a PTY shell is
 * involved. A failed read throws: callers decide what an unknown means.
 */
export async function readControllingTerminals(): Promise<Map<number, string>> {
  const terminals = new Map<number, string>();
  if (process.platform === 'win32') return terminals;
  const { stdout } = await execFileAsync('ps', ['-Ao', 'pid=,tty='], { encoding: 'utf8', timeout: SNAPSHOT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s*$/u.exec(line);
    const tty = match && controllingTerminal(match[2]);
    if (match && tty) terminals.set(Number(match[1]), tty);
  }
  return terminals;
}

/**
 * Forcefully terminates `pids` and everything descended from them, then waits
 * for them to leave the process table and, on Windows, to close their handles.
 * Returns the pids not confirmed exited when `timeoutMs` ran out — empty when
 * the whole tree is gone.
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
  const killedAt = Date.now();
  // Deepest first: killing a parent can orphan a child nothing can walk to.
  await killProcesses([...tree].reverse());
  const alive = await waitForProcessesToExit(tree, Math.max(0, deadline - Date.now()));
  // A survivor already decides the answer, and with no time left there is nothing to wait on.
  const left = deadline - Date.now();
  if (process.platform !== 'win32' || alive.length > 0 || left <= 0) return alive;
  return waitForWindowsExit(tree, killedAt, left);
}

/**
 * Windows sets a killed process's exit code, which is all `isProcessAlive`
 * sees, before it closes that process's handles (its current directory among
 * them), and signals the process only once they are closed. Waits for that
 * signal, so the directories the processes sat in can be moved once this
 * returns. Returns the pids not signalled in time. A pid whose process is
 * gone, or that a process born after `killedAt` now holds, has exited. When the
 * wait cannot run (PowerShell's Constrained Language Mode, which AppLocker and
 * WDAC enforce, blocks `Add-Type`), returns none: the exit-code poll's answer
 * stands, as it did before this wait existed.
 */
async function waitForWindowsExit(pids: readonly number[], killedAt: number, timeoutMs: number): Promise<number[]> {
  if (pids.length === 0) return [];
  // FILETIME counts 100 ns ticks from 1601; Date.now() counts ms from 1970.
  const killedAtFiletime = BigInt(killedAt) * 10_000n + 116_444_736_000_000_000n;
  const script = [
    `$deadline = [DateTime]::UtcNow.AddMilliseconds(${timeoutMs})`,
    "Add-Type -Namespace Pane -Name ProcessExit -MemberDefinition '"
      + '[DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);'
      + '[DllImport("kernel32.dll")] public static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);'
      + '[DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr handle, uint ms);'
      + '[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);'
      + "'",
    `foreach ($id in @(${pids.join(',')})) {`,
    // SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION. No handle means the process is gone.
    '  $handle = [Pane.ProcessExit]::OpenProcess(0x00101000, $false, $id)',
    '  if ($handle -eq [IntPtr]::Zero) { continue }',
    '  $created = 0; $exited = 0; $kernel = 0; $user = 0',
    '  [void][Pane.ProcessExit]::GetProcessTimes($handle, [ref]$created, [ref]$exited, [ref]$kernel, [ref]$user)',
    `  if ($created -le ${killedAtFiletime}) {`,
    '    $left = [Math]::Max(0, [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds)',
    // WAIT_OBJECT_0 (0) means signalled.
    '    if ([Pane.ProcessExit]::WaitForSingleObject($handle, [uint32]$left) -ne 0) { $id }',
    '  }',
    '  [void][Pane.ProcessExit]::CloseHandle($handle)',
    '}',
  ].join('\n');
  try {
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: timeoutMs + SNAPSHOT_TIMEOUT_MS });
    return stdout.split(/\r?\n/u).filter(line => /^\d+$/u.test(line.trim())).map(line => Number.parseInt(line, 10));
  } catch (error) {
    console.warn('[ProcessTree] exit_wait_failed:', error);
    return [];
  }
}

/** Kills these processes as forcefully as the platform allows. Never throws. */
async function killProcesses(pids: readonly number[]): Promise<void> {
  if (process.platform === 'win32') {
    // One taskkill for the lot — a process per pid would cost more than the
    // kill itself. taskkill reports a pid it cannot touch without abandoning
    // the rest.
    // No `/T`: taskkill walks children by a parent pid that Windows never
    // clears, so it would also kill whatever outlived a dead process whose pid
    // one of these now holds. The list already holds the verified descendants.
    const args = ['/F', ...pids.flatMap(pid => ['/PID', String(pid)])];
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

export interface ProcessTableRow {
  pid: number;
  parentPid: number;
  /** Owner's numeric user id. Unknown on Windows, where reading it costs a call per process. */
  uid: number | null;
  /** Full executable path where the platform reports one, else the process name. Empty when hidden. */
  executable: string;
  /** Windows: creation time in 100 ns ticks, to tell a parent from a later process with its pid. Unknown elsewhere. */
  born?: bigint;
}

/**
 * Every process on the machine, in one snapshot rather than a query per pid:
 * on Windows each query starts a PowerShell process, which costs far more than
 * the read it serves. Best effort: an unreadable table yields an empty list.
 */
export async function readProcessTable(): Promise<ProcessTableRow[]> {
  let stdout: string;
  try {
    stdout = process.platform === 'win32'
      ? (await execFileAsync('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().Ticks })`t$(if ($_.ExecutablePath) { $_.ExecutablePath } else { $_.Name })" }',
      ], { encoding: 'utf8', timeout: SNAPSHOT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 })).stdout
      // `comm` goes last: on macOS it is the full executable path, which may contain spaces.
      : (await execFileAsync('ps', ['-Ao', 'pid=,ppid=,uid=,comm='], { encoding: 'utf8', timeout: SNAPSHOT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 })).stdout;
  } catch (error) {
    console.warn('[ProcessTree] snapshot_failed:', error);
    return [];
  }
  const rows: ProcessTableRow[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (process.platform === 'win32') {
      const match = /^(\d+)\t(\d+)\t(\d*)\t(.*)$/u.exec(line);
      if (!match) continue;
      const [, pid, parentPid, born, executable] = match;
      const row: ProcessTableRow = { pid: Number.parseInt(pid, 10), parentPid: Number.parseInt(parentPid, 10), uid: null, executable: executable.trim() };
      if (born) row.born = BigInt(born);
      rows.push(row);
      continue;
    }
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s?(.*)$/u.exec(line);
    if (!match) continue;
    const [, pid, parentPid, uid, executable] = match;
    rows.push({
      pid: Number.parseInt(pid, 10),
      parentPid: Number.parseInt(parentPid, 10),
      uid: Number.parseInt(uid, 10),
      executable: executable.trim(),
    });
  }
  return rows;
}

/** Parent pid → its child pids, for every process on the machine. */
async function readProcessChildren(): Promise<Map<number, number[]>> {
  const children = new Map<number, number[]>();
  const table = await readProcessTable();
  const born = new Map(table.map(row => [row.pid, row.born]));
  for (const { pid, parentPid } of table) {
    if (pid === parentPid) continue;
    if (process.platform === 'win32') {
      const parentBorn = born.get(parentPid);
      const childBorn = born.get(pid);
      if (parentBorn === undefined || childBorn === undefined || parentBorn > childBorn) continue;
    }
    const siblings = children.get(parentPid);
    if (siblings) siblings.push(pid);
    else children.set(parentPid, [pid]);
  }
  return children;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
