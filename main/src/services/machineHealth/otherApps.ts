import { execFile } from 'child_process';
import { promisify } from 'util';
import type { CleanupRun, CleanupSource, OtherApp } from '../../../../shared/types/machineHealth';
import { PaneError } from '../../../../shared/paneError';
import { cLocaleEnv } from '../../utils/processTree';
import { parseCpuTime } from './processAttribution';

const execFileAsync = promisify(execFile);

/** One process as the app list reads it. */
export interface AppProcessRow {
  pid: number;
  ppid: number;
  /** Start time exactly as stopProcessIdentities compares it. */
  started: string;
  rssKB: number;
  cpuSeconds: number;
  /** As the OS names it: on macOS and Linux argv[0] (a path or a bare name), on Windows the executable's path, else its name. */
  path: string;
  /** macOS only: the executable's real path when argv[0] is not one (read with lsof), or undefined when it could not be read. */
  exe?: string;
  /** Another user's process, a Windows service (session 0), or one whose path this user cannot read. */
  otherUser: boolean;
}

interface Identity {
  pid: number;
  started: string;
}

export interface OtherAppsDeps {
  platform: NodeJS.Platform;
  /** Pane's main process: it and everything under it are Pane's own. */
  selfPid: number;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  read: () => Promise<AppProcessRow[]>;
  /** Processes Resources already credits to a Pane (including ones that left their tab). */
  paneProcesses: () => ReadonlySet<number>;
  /** The icon of an app bundle or executable, as a PNG data URL. */
  iconOf?: (path: string) => Promise<string | undefined>;
  /** Asks each process to stop, then forces it, only while pid and start time still match; resolves with those still running. */
  stop: (identities: readonly Identity[]) => Promise<Identity[]>;
  record: (run: CleanupRun) => void;
}

interface AppIdentity {
  key: string;
  name: string;
  iconPath?: string;
  /** Grouped by executable name rather than an app bundle, so it can span other terminals. */
  byName: boolean;
  /** An iOS simulator runtime. */
  simulator?: boolean;
}

interface AppGroup extends AppIdentity {
  rows: AppProcessRow[];
}

/** CPU needs two reads; one older than this is too stale to compare with. */
const CPU_BASELINE_MAX_AGE_MS = 5 * 60_000;
const CPU_BASELINE_GAP_MS = 1000;
/** Icons for the biggest apps only, to keep the answer small for a linked machine. */
const ICON_LIMIT = 40;
/** Protected rows smaller than this are left out of the list: they are system daemons nobody can act on. */
const PROTECTED_MIN_MB = 1;
/** Executables under these hold macOS itself. Built-in apps in /System/Applications (Safari in its cryptex) are the person's to quit. */
const MAC_SYSTEM_PATH = /^\/(?:System|usr(?!\/local\/)|bin|sbin|Library\/Apple)\//u;
const MAC_USER_APP_PATH = /^\/System\/Applications\/|\/Cryptexes\/App\/System\/Applications\//u;
const WINDOWS_SYSTEM_PATH = /^[a-z]:\\windows\\/iu;
/**
 * The desktop session itself on Linux, as `comm` prints it (15 characters): display servers, session managers,
 * compositors and window managers, and the session's own services. Stopping one ends or breaks the person's session.
 */
const LINUX_SESSION = /^(?:systemd|init|Xorg|Xwayland|dbus-daemon|dbus-broker|sddm|gdm\d?|lightdm|ksmserver|kwin\w*|plasmashell|plasma_session|startplasma-\S*|kded\d?|xfce4-session|xfwm4|xfsettingsd|xfce4-panel|cinnamon\S*|mate-session|marco|muffin|mutter|gnome-shell\S*|gnome-session\S*|gnome-keyring-d|gsd-\S+|sway|swaybg|Hyprland|i3|i3bar|openbox|xdg-desktop-por|xdg-document-po|xdg-permission-|at-spi\S*|pipewire\S*|wireplumber|pulseaudio)$/u;

const systemText = (platform: NodeJS.Platform) =>
  `Part of ${platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'the system'}. Pane never stops system processes.`;

const baseName = (path: string) => path.split(/[\\/]/u).pop() ?? path;

/**
 * The apps running outside Pane, for the expanded "Other apps" row on Resources, and stopping one
 * when the person asks. Pane never stops one by itself.
 */
export class OtherApps {
  private baseline: { at: number; cpu: Map<string, number> } | null = null;
  private icons = new Map<string, Promise<string | undefined>>();
  private inFlight: Promise<Array<OtherApp & { iconPath?: string }>> | null = null;

  constructor(private readonly deps: OtherAppsDeps) {}

  /**
   * Every app outside Pane, biggest memory first. Icons come only for apps whose key is not in `knownIcons`,
   * so a screen that keeps them asks for each once. Concurrent callers share one read.
   */
  async list(knownIcons: readonly string[] = []): Promise<OtherApp[]> {
    this.inFlight ??= this.read().finally(() => { this.inFlight = null; });
    const known = new Set(knownIcons);
    const apps = await this.inFlight;
    return Promise.all(apps.map(async ({ iconPath, ...app }, index) => {
      if (!iconPath || index >= ICON_LIMIT || known.has(app.key)) return app;
      const icon = await this.icon(iconPath);
      return icon ? { ...app, icon } : app;
    }));
  }

  private async read(): Promise<Array<OtherApp & { iconPath?: string }>> {
    if (!this.baseline || this.deps.now() - this.baseline.at > CPU_BASELINE_MAX_AGE_MS) {
      this.baseline = { at: this.deps.now(), cpu: cpuTimes(await this.deps.read()) };
      await (this.deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(CPU_BASELINE_GAP_MS);
    }
    const rows = await this.deps.read();
    const now = this.deps.now();
    const seconds = Math.max(0.001, (now - this.baseline.at) / 1000);
    const previous = this.baseline.cpu;
    this.baseline = { at: now, cpu: cpuTimes(rows) };
    return this.groups(rows).flatMap(group => {
      const cpu = group.rows.reduce((sum, row) => {
        const before = previous.get(`${row.pid}:${row.started}`);
        return sum + (before === undefined ? 0 : Math.max(0, row.cpuSeconds - before));
      }, 0);
      const rssMB = Math.round(group.rows.reduce((sum, row) => sum + row.rssKB, 0) / 102.4) / 10;
      const protectedReason = this.protectedReason(group, rows);
      if (protectedReason && rssMB < PROTECTED_MIN_MB) return [];
      return [{
        key: group.key, name: group.name, iconPath: group.iconPath, rssMB, byName: group.byName,
        cpuPercent: Math.round((cpu / seconds) * 1000) / 10,
        processCount: group.rows.length,
        protectedReason,
      }];
    });
  }

  /** Stops every process of the app named `key` as it runs now; refuses a protected one. */
  async stop(key: string, source: CleanupSource): Promise<CleanupRun> {
    const rows = await this.deps.read();
    const group = this.groups(rows).find(item => item.key === key);
    if (!group) {
      throw new PaneError('ERR_MACHINE_APP_GONE', 'That app is no longer running. Nothing was stopped.', 'Refresh Resources to see what runs now.');
    }
    const reason = this.protectedReason(group, rows);
    if (reason) {
      throw new PaneError('ERR_MACHINE_APP_PROTECTED', `Pane does not stop ${group.name}: ${reason} Nothing was stopped.`, 'Quit it from the app itself if you need to.');
    }
    const running = await this.deps.stop(group.rows.map(row => ({ pid: row.pid, started: row.started })));
    const entry = { id: group.key, kind: 'app' as const, path: group.name, sizeBytes: group.rows.reduce((sum, row) => sum + row.rssKB * 1024, 0) };
    const run: CleanupRun = {
      at: this.deps.now(), source, freedBytes: 0,
      removed: running.length === 0 ? [entry] : [],
      skipped: running.length === 0 ? [] : [{ ...entry, reason: `${running.length} of its processes did not stop.` }],
    };
    this.deps.record(run);
    if (running.length > 0) {
      throw new PaneError('ERR_MACHINE_APP_STILL_RUNNING', `${group.name} did not stop: ${running.length} of its ${group.rows.length} processes are still running.`, 'Quit it from the app itself, or stop it with your system\'s task manager.');
    }
    return run;
  }

  /**
   * Apps outside Pane: Pane's own process tree and processes credited to a Pane are left out. Everything another
   * Pane instance started counts with that Pane, so its agents and dev servers never fall into a stoppable group.
   */
  private groups(rows: readonly AppProcessRow[]): AppGroup[] {
    const own = this.paneTree(rows);
    const byPid = new Map(rows.map(row => [row.pid, row]));
    const owners = new Map<number, AppIdentity>();
    const ownerOf = (row: AppProcessRow): AppIdentity => {
      const known = owners.get(row.pid);
      if (known) return known;
      const seen = new Set<number>();
      let owner = this.identify(row);
      for (let parent = byPid.get(row.ppid); parent && parent.pid > 1 && !seen.has(parent.pid); parent = byPid.get(parent.ppid)) {
        seen.add(parent.pid);
        const identity = this.identify(parent);
        if (isPane(identity)) owner = identity;
      }
      owners.set(row.pid, owner);
      return owner;
    };
    const groups = new Map<string, AppGroup>();
    for (const row of rows) {
      if (own.has(row.pid)) continue;
      const identity = ownerOf(row);
      const group = groups.get(identity.key);
      if (group) group.rows.push(row);
      else groups.set(identity.key, { ...identity, rows: [row] });
    }
    const memory = (group: AppGroup) => group.rows.reduce((sum, row) => sum + row.rssKB, 0);
    return [...groups.values()].sort((a, b) => memory(b) - memory(a) || a.name.localeCompare(b.name));
  }

  /**
   * macOS: the outermost .app bundle (or simulator runtime) of the real executable, so helpers count with their app;
   * otherwise the name the process runs under (argv[0]: `claude`, not its versioned binary). Elsewhere: the executable's name.
   */
  private identify(row: AppProcessRow): AppIdentity {
    if (this.deps.platform === 'darwin') {
      // A simulator runtime holds a whole iOS, with its own apps and daemons: one app per runtime.
      const bundle = /^(.*?\.(?:app|simruntime))(?:\/|$)/u.exec(row.exe ?? row.path)?.[1];
      if (bundle?.endsWith('.simruntime')) return { key: bundle, name: `${baseName(bundle).replace(/\.simruntime$/u, '')} Simulator`, byName: false, simulator: true };
      if (bundle) return { key: bundle, name: baseName(bundle).replace(/\.app$/u, ''), iconPath: bundle, byName: false };
      return { key: baseName(row.path), name: baseName(row.path), byName: true };
    }
    if (this.deps.platform === 'win32') {
      const name = baseName(row.path).replace(/\.exe$/iu, '');
      return { key: name.toLowerCase(), name, iconPath: /^[a-z]:\\/iu.test(row.path) ? row.path : undefined, byName: true };
    }
    return { key: baseName(row.path), name: baseName(row.path), byName: true };
  }

  private paneTree(rows: readonly AppProcessRow[]): Set<number> {
    const own = new Set([this.deps.selfPid, ...this.deps.paneProcesses()]);
    const children = new Map<number, number[]>();
    for (const row of rows) if (row.pid !== row.ppid) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);
    const queue = [this.deps.selfPid];
    for (let next = 0; next < queue.length; next++) {
      for (const child of children.get(queue[next]) ?? []) {
        if (!own.has(child)) queue.push(child);
        own.add(child);
      }
    }
    return own;
  }

  private protectedReason(group: AppGroup, rows: readonly AppProcessRow[]): string | null {
    if (isPane(group)) return 'This is Pane, with what it runs. Quit it from its own window.';
    // Its devices run helpers outside the runtime (launchd_sim's host, the render server), so a stop here would not end it.
    if (group.simulator) return 'Quit it from the Simulator app, or run `xcrun simctl shutdown all`. Some of its helpers run outside this list.';
    if (this.deps.platform === 'darwin' && group.rows.some(row => !row.exe && !row.path.startsWith('/') && !row.otherUser && row.pid > 1)) {
      return 'Pane can\'t tell which program this is, so it does not stop it.';
    }
    const parents = new Map(rows.map(row => [row.pid, row.ppid]));
    const ancestors = new Set<number>();
    for (let pid = parents.get(this.deps.selfPid); pid !== undefined && pid > 1 && !ancestors.has(pid); pid = parents.get(pid)) ancestors.add(pid);
    if (group.rows.some(row => ancestors.has(row.pid))) return 'Pane runs inside it, so stopping it would stop Pane.';
    if (group.rows.some(row => this.isSystem(row))) return systemText(this.deps.platform);
    return null;
  }

  private isSystem(row: AppProcessRow): boolean {
    if (row.otherUser || row.pid <= 1) return true;
    if (this.deps.platform === 'darwin') {
      const exe = row.exe ?? row.path;
      return MAC_SYSTEM_PATH.test(exe) && !MAC_USER_APP_PATH.test(exe);
    }
    if (this.deps.platform === 'win32') return WINDOWS_SYSTEM_PATH.test(row.path);
    return LINUX_SESSION.test(baseName(row.path));
  }

  private icon(path: string): Promise<string | undefined> {
    const iconOf = this.deps.iconOf;
    if (!iconOf) return Promise.resolve(undefined);
    let icon = this.icons.get(path);
    if (!icon) {
      icon = iconOf(path).catch(() => undefined);
      this.icons.set(path, icon);
    }
    return icon;
  }
}

const isPane = (identity: Pick<AppIdentity, 'name'>) => identity.name.toLowerCase() === 'pane';

function cpuTimes(rows: readonly AppProcessRow[]): Map<string, number> {
  return new Map(rows.map(row => [`${row.pid}:${row.started}`, row.cpuSeconds]));
}

const POSIX_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s*(.*)$/u;

/** Parse `ps -Ao pid=,ppid=,uid=,rss=,time=,lstart=,comm=`; `comm` goes last because it may hold spaces. */
export function parseAppProcessTable(stdout: string, uid: number): AppProcessRow[] {
  const rows: AppProcessRow[] = [];
  for (const line of stdout.split('\n')) {
    const match = POSIX_ROW.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]), ppid: Number(match[2]), otherUser: Number(match[3]) !== uid,
      rssKB: Number(match[4]), cpuSeconds: parseCpuTime(match[5]), started: match[6], path: match[7].trim() || 'unknown',
    });
  }
  return rows;
}

/** Every process on this machine with its owner and executable, in one call. */
export async function readAppProcesses(): Promise<AppProcessRow[]> {
  const options = { encoding: 'utf8' as const, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 };
  if (process.platform === 'win32') {
    // Session 0 holds services; a path this user cannot read belongs to another user or the system.
    const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      '$me = (Get-Process -Id $PID).SessionId; Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { [long]$t = $_.CreationDate.ToUniversalTime().Ticks; $b = ($t - ($t % [long]10)).ToString(); $o = if ($_.SessionId -ne $me -or -not $_.ExecutablePath) { 1 } else { 0 }; $p = if ($_.ExecutablePath) { $_.ExecutablePath } else { $_.Name }; "$($_.ProcessId)`t$($_.ParentProcessId)`t$b`t$($_.WorkingSetSize)`t$([long]$_.KernelModeTime + [long]$_.UserModeTime)`t$o`t$p" } }'], options);
    return stdout.split(/\r?\n/u).flatMap(line => {
      const parts = line.split('\t');
      if (parts.length < 7 || !/^\d+$/u.test(parts[2])) return [];
      return [{
        pid: Number(parts[0]), ppid: Number(parts[1]), started: parts[2], rssKB: Math.round(Number(parts[3]) / 1024),
        cpuSeconds: Number(parts[4]) / 1e7, otherUser: parts[5] === '1', path: parts.slice(6).join('\t') || 'unknown',
      }];
    });
  }
  const { stdout } = await execFileAsync('ps', ['-Ao', 'pid=,ppid=,uid=,rss=,time=,lstart=,comm='], { ...options, env: cLocaleEnv() });
  const rows = parseAppProcessTable(stdout, process.getuid?.() ?? -1);
  if (process.platform !== 'darwin') return rows;
  // macOS prints argv[0], which can be a bare name: read the real executable of those, in one call.
  const bare = rows.filter(row => !row.path.startsWith('/') && !row.otherUser);
  const exes = await readExecutables(bare.map(row => row.pid));
  for (const row of bare) row.exe = exes.get(row.pid);
  return rows;
}

/** macOS: each process's executable (its first `txt` file) from one lsof call; unreadable ones are left out. */
async function readExecutables(pids: readonly number[]): Promise<Map<number, string>> {
  const exes = new Map<number, string>();
  if (pids.length === 0) return exes;
  // lsof exits 1 when one of the pids has gone; what it printed for the rest still counts.
  const stdout = await new Promise<string>(resolve => {
    execFile('lsof', ['-a', '-d', 'txt', '-Fn', '-p', pids.join(',')], { encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024, env: cLocaleEnv() },
      (_error, out) => resolve(out ?? ''));
  });
  let pid = 0;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid && !exes.has(pid)) exes.set(pid, line.slice(1));
  }
  return exes;
}
