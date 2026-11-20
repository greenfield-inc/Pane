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

/** What `terminateProcessTrees` asks of the OS. Tests stand in for Windows through it. */
export interface ProcessTreeSystem {
  platform: NodeJS.Platform;
  isAlive(pid: number): boolean;
  /** Like `execFile`: a failure rejects with an Error carrying the `stdout` read so far. */
  run(file: string, args: readonly string[], options: { timeout: number; maxBuffer?: number; windowsHide: boolean }): Promise<{ stdout: string }>;
}

const nativeSystem: ProcessTreeSystem = {
  get platform() {
    return process.platform;
  },
  isAlive: pid => isProcessAlive(pid),
  run: (file, args, options) => execFileAsync(file, [...args], { ...options, encoding: 'utf8' }),
};

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
  isAlive: (pid: number) => boolean = isProcessAlive,
): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let alive = pids.filter(pid => isAlive(pid));
  while (alive.length > 0 && Date.now() < deadline) {
    await delay(Math.min(EXIT_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    alive = alive.filter(pid => isAlive(pid));
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
 * Roots that have all exited return at once, without reading the process
 * table. On Windows the rest costs one PowerShell process, which reads the
 * table, kills and waits: about a second idle, more under load.
 *
 * Used when a process outlives the polite shutdown its owner asked for. On
 * Windows that matters beyond leaking a process: a directory cannot be renamed
 * or removed while it is any live process's current working directory.
 */
export async function terminateProcessTrees(
  rootPids: readonly number[],
  options: { timeoutMs?: number; system?: ProcessTreeSystem } = {},
): Promise<number[]> {
  const system = options.system ?? nativeSystem;
  const roots = [...new Set(rootPids.filter(pid => Number.isInteger(pid) && pid > 0))];
  // A dead root leaves nothing to walk to: Windows only links a child to a
  // parent still in the table, and POSIX reparents orphans. Reading the table
  // would cost a process (PowerShell on Windows, seconds under load) to find
  // nothing.
  if (!roots.some(pid => system.isAlive(pid))) return [];
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TERMINATE_TIMEOUT_MS);
  if (system.platform === 'win32') return terminateWindowsTrees(roots, deadline, system);
  const tree = [...new Set([...roots, ...await listDescendantPids(roots)])];
  // Deepest first: killing a parent can orphan a child nothing can walk to.
  await killProcesses([...tree].reverse(), system);
  return waitForProcessesToExit(tree, Math.max(0, deadline - Date.now()), pid => system.isAlive(pid));
}

/**
 * Windows: one PowerShell process reads the table, walks the trees, kills them
 * and waits for them to exit. Each step used to start its own process, and
 * PowerShell's start-up costs more than any of them.
 *
 * Windows sets a killed process's exit code, which is all `isProcessAlive`
 * sees, before it closes that process's handles (its current directory among
 * them), and signals the process only once they are closed. The script waits
 * for that signal, so the directories the processes sat in can be moved once
 * this returns. A pid the script could not wait on is polled by exit code. When
 * PowerShell cannot run at all, the roots are killed by pid.
 */
async function terminateWindowsTrees(roots: readonly number[], deadline: number, system: ProcessTreeSystem): Promise<number[]> {
  let stdout: string;
  try {
    ({ stdout } = await system.run('powershell', ['-NoProfile', '-NonInteractive', '-Command', windowsTerminateScript(roots, deadline)], {
      // The script stops waiting at the deadline; this bounds start-up and the table read.
      timeout: Math.max(0, deadline - Date.now()) + SNAPSHOT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    }));
  } catch (error) {
    console.warn('[ProcessTree] terminate_failed:', error);
    // SAFETY: `run` rejects like execFile, with an Error that carries the output read so far.
    stdout = String((error as { stdout?: unknown }).stdout ?? '');
  }
  const report = parseWindowsTerminateReport(stdout);
  if (report.snapshotError) console.warn('[ProcessTree] snapshot_failed:', report.snapshotError);
  if (report.tree.length === 0) {
    // PowerShell reported nothing, not even the roots it always lists first.
    await killProcesses(roots, system);
    return waitForProcessesToExit(roots, Math.max(0, deadline - Date.now()), pid => system.isAlive(pid));
  }
  const unconfirmed = report.tree.filter(pid => !report.exited.has(pid) && !report.alive.has(pid));
  const polled = await waitForProcessesToExit(unconfirmed, Math.max(0, deadline - Date.now()), pid => system.isAlive(pid));
  return [...report.alive, ...polled];
}

interface WindowsTerminateReport {
  /** The roots and their verified descendants, roots first. */
  tree: number[];
  /** Signalled, or gone before the kill. */
  exited: Set<number>;
  /** Still not signalled at the deadline. */
  alive: Set<number>;
  snapshotError?: string;
}

function parseWindowsTerminateReport(stdout: string): WindowsTerminateReport {
  const report: WindowsTerminateReport = { tree: [], exited: new Set(), alive: new Set() };
  for (const line of stdout.split(/\r?\n/u)) {
    const snapshot = /^snapshot_failed (.*)$/u.exec(line.trim());
    if (snapshot) report.snapshotError = snapshot[1];
    const match = /^(tree|exited|alive) (\d+)$/u.exec(line.trim());
    if (!match) continue;
    const pid = Number.parseInt(match[2], 10);
    if (match[1] === 'tree') report.tree.push(pid);
    else report[match[1] === 'exited' ? 'exited' : 'alive'].add(pid);
  }
  return report;
}

/**
 * The PowerShell script behind `terminateWindowsTrees`. It prints `tree <pid>`
 * for each root and verified descendant, then `exited <pid>` or `alive <pid>`
 * for each process it held a handle to. Exported for tests.
 *
 * Windows never clears a dead parent's pid from its children, and reuses pids
 * quickly: a child counts only when it was born no earlier than the process
 * holding its parent pid now. Each kill goes through a handle opened first and
 * checked against the birth time the table read, so a pid that a new process
 * took since then is never killed; the wait uses the same handle. Constrained
 * Language Mode (AppLocker, WDAC) blocks those handles: there the script kills
 * by pid with `Stop-Process` and leaves the wait to the caller's exit-code
 * poll, as it did before this wait existed.
 */
export function windowsTerminateScript(roots: readonly number[], deadline: number): string {
  // .NET DateTime ticks count 100 ns from year 1; Date.now() counts ms from 1970.
  const deadlineTicks = BigInt(deadline) * 10_000n + 621_355_968_000_000_000n;
  return [
    `$deadline = [long]${deadlineTicks}`,
    `$roots = @(${roots.join(',')})`,
    '$born = @{}',
    '$children = @{}',
    '$table = @()',
    "try { $table = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate -ErrorAction Stop) } catch { 'snapshot_failed ' + ($_.Exception.Message -replace '\\s+', ' ') }",
    // CIM reports microseconds; the handle's start time below is truncated to match.
    'foreach ($row in $table) { if ($row.CreationDate) { [long]$ticks = $row.CreationDate.ToUniversalTime().Ticks; $born[[int]$row.ProcessId] = $ticks - ($ticks % [long]10) } }',
    'foreach ($row in $table) {',
    '  $id = [int]$row.ProcessId; $parent = [int]$row.ParentProcessId',
    '  if ($id -eq $parent -or -not $born.ContainsKey($id) -or -not $born.ContainsKey($parent) -or $born[$parent] -gt $born[$id]) { continue }',
    '  if ($children.ContainsKey($parent)) { $children[$parent] += $id } else { $children[$parent] = @($id) }',
    '}',
    '$tree = @($roots)',
    '$seen = @{}',
    'foreach ($id in $roots) { $seen[$id] = $true }',
    'for ($i = 0; $i -lt $tree.Count; $i++) {',
    '  if (-not $children.ContainsKey($tree[$i])) { continue }',
    '  foreach ($child in $children[$tree[$i]]) { if (-not $seen.ContainsKey($child)) { $seen[$child] = $true; $tree += $child } }',
    '}',
    'foreach ($id in $tree) { "tree $id" }',
    "$full = $ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage'",
    '$held = @()',
    '$heldIds = @()',
    // Deepest first: killing a parent can orphan a child nothing can walk to.
    'for ($i = $tree.Count - 1; $i -ge 0; $i--) {',
    '  $id = $tree[$i]',
    '  if (-not $full) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue; continue }',
    '  $p = $null',
    '  try { $p = [Diagnostics.Process]::GetProcessById($id) } catch { "exited $id"; continue }',
    // Reading Handle pins this process: Kill and WaitForExit use it, not a later lookup of the pid.
    '  try { $null = $p.Handle; [long]$ticks = $p.StartTime.ToUniversalTime().Ticks; $ticks = $ticks - ($ticks % [long]10) } catch { $p.Dispose(); continue }',
    // Another process holds the pid now: the one the table saw has exited.
    '  if ($born.ContainsKey($id) -and $born[$id] -ne $ticks) { $p.Dispose(); "exited $id"; continue }',
    '  try { $p.Kill() } catch { }',
    '  $held += $p',
    '  $heldIds += $id',
    '}',
    'for ($i = 0; $i -lt $held.Count; $i++) {',
    '  $left = ($deadline - [DateTime]::UtcNow.Ticks) / 10000',
    '  if ($left -lt 0) { $left = 0 }',
    '  if ($held[$i].WaitForExit([int]$left)) { "exited $($heldIds[$i])" } else { "alive $($heldIds[$i])" }',
    '  $held[$i].Dispose()',
    '}',
  ].join('\n');
}

/** Kills these processes as forcefully as the platform allows. Never throws. */
async function killProcesses(pids: readonly number[], system: ProcessTreeSystem): Promise<void> {
  if (system.platform === 'win32') {
    // Only when PowerShell cannot run. One taskkill for the lot: taskkill
    // reports a pid it cannot touch without abandoning the rest.
    // No `/T`: taskkill walks children by a parent pid that Windows never
    // clears, so it would also kill whatever outlived a dead process whose pid
    // one of these now holds.
    const args = ['/F', ...pids.flatMap(pid => ['/PID', String(pid)])];
    await system.run('taskkill', args, { timeout: SNAPSHOT_TIMEOUT_MS, windowsHide: true }).catch(() => undefined);
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
