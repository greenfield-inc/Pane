import type { ParsedArgs } from './commands';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boundary } from './boundaryDecoder';
import {
  getPaneDaemonEndpoint,
  invokeDaemon,
  resolvePaneDirectory,
  type PaneDaemonEndpoint
} from './daemonClient';
import { resolveExistingPanePath } from './installers';
import { detectPlatform, type PanePlatform } from './platform';
import { RUNPANE_CONTRACT } from './generated/contract';
import { resolveRelease } from './releases';
import { getPaneVersion, getWrapperVersion } from './version';
import type { BoundarySchema } from './boundaryDecoder';

const DOCTOR_DAEMON_TIMEOUT_MS = 5_000;
const DOCTOR_RELEASE_TIMEOUT_MS = 5_000;
const REMOTE_LAUNCHER_MARKER = 'pane-remote-daemon-launcher-v2';
const REMOTE_DAEMON_UNIT = 'pane-remote-daemon.service';
const PANE_REPO = 'greenfield-inc/Pane';
const LEGACY_PANE_REPOS = ['dcouple/Pane', 'Dcouple-Inc/Pane'] as const;
const ISSUE_URL_PATTERN = new RegExp(
  `^https://github\\.com/(?:${[PANE_REPO, ...LEGACY_PANE_REPOS].join('|')})/issues/\\d+$`,
  'i',
);

type ProcessImageStatus = 'current' | 'replaced' | 'deleted' | 'unknown';
type RestartStatus = 'ready' | 'broken' | 'unknown';

interface RemoteDaemonExecutableHealth {
  processImage: {
    status: ProcessImageStatus;
    runtimePath: string | null;
    installedPath: string | null;
    evidence: string;
  };
  restart: {
    status: RestartStatus;
    launcherPath?: string;
    resolvedPath?: string;
    evidence: string;
  };
  diagnosticCode?: 'PANE_REMOTE_DAEMON_EXECUTABLE_DELETED' | 'PANE_REMOTE_DAEMON_UPDATE_PENDING' | 'PANE_REMOTE_DAEMON_LAUNCHER_STALE';
  recoveryCommand?: string;
  checkedAt: string;
}

const executableHealthSchema: BoundarySchema<RemoteDaemonExecutableHealth> = boundary.object({
  processImage: boundary.object({
    status: boundary.enumeration('current', 'replaced', 'deleted', 'unknown'),
    runtimePath: boundary.nullable(boundary.string),
    installedPath: boundary.nullable(boundary.string),
    evidence: boundary.string,
  }),
  restart: boundary.object({
    status: boundary.enumeration('ready', 'broken', 'unknown'),
    launcherPath: boundary.optional(boundary.string),
    resolvedPath: boundary.optional(boundary.string),
    evidence: boundary.string,
  }),
  diagnosticCode: boundary.optional(boundary.enumeration(
    'PANE_REMOTE_DAEMON_EXECUTABLE_DELETED',
    'PANE_REMOTE_DAEMON_UPDATE_PENDING',
    'PANE_REMOTE_DAEMON_LAUNCHER_STALE',
  )),
  recoveryCommand: boundary.optional(boundary.string),
  checkedAt: boundary.string,
});

interface DaemonDoctorResult {
  ok: true;
  app: {
    version: string;
    isPackaged: boolean;
    platform: string;
    electronVersion?: string;
    nodeVersion?: string;
  };
  daemon: {
    channels: string[];
    executableHealth?: RemoteDaemonExecutableHealth;
  };
  repos: {
    count: number;
    active?: {
      id: number;
      name: string;
      path: string;
      active: boolean;
      environment?: string;
      sessionCount: number;
    };
  };
  terminal?: {
    graphicsProtocols: string[];
    sizeReports: boolean;
    imageLimits: {
      storageLimitMb: number;
      pixelLimit: number;
    };
  };
  agentContext: {
    recommendedFirstCommands: string[];
  };
}

const daemonDoctorResultSchema: BoundarySchema<DaemonDoctorResult> = boundary.object({
  ok: boundary.literal(true),
  app: boundary.object({
    version: boundary.string,
    isPackaged: boundary.boolean,
    platform: boundary.string,
    electronVersion: boundary.optional(boundary.string),
    nodeVersion: boundary.optional(boundary.string),
  }),
  daemon: boundary.object({
    channels: boundary.array(boundary.string),
    executableHealth: boundary.optional(executableHealthSchema),
  }),
  repos: boundary.object({
    count: boundary.number,
    active: boundary.optional(boundary.object({
      id: boundary.number,
      name: boundary.string,
      path: boundary.string,
      active: boundary.boolean,
      environment: boundary.optional(boundary.string),
      sessionCount: boundary.number,
    })),
  }),
  // Optional: a newer wrapper still has to read an older Pane's doctor reply.
  terminal: boundary.optional(boundary.object({
    graphicsProtocols: boundary.array(boundary.string),
    sizeReports: boundary.boolean,
    imageLimits: boundary.object({
      storageLimitMb: boundary.number,
      pixelLimit: boundary.number,
    }),
  })),
  agentContext: boundary.object({
    recommendedFirstCommands: boundary.array(boundary.string),
  }),
});

interface DoctorReleaseCheck {
  ok: boolean;
  tagName?: string;
  artifactName?: string;
  format?: string;
  preferredDownloadUrl?: string;
  fallbackDownloadUrl?: string;
  error?: string;
}

interface DoctorInstalledPaneCheck {
  found: boolean;
  path?: string;
  version?: string;
}

interface DoctorDaemonCheck {
  reachable: boolean;
  endpoint: PaneDaemonEndpoint;
  result?: DaemonDoctorResult;
  error?: string;
  nextCommand?: string;
}

interface DoctorReport {
  ok: boolean;
  source: 'npm' | 'pip';
  wrapper: {
    runtime: 'node';
    version: string;
    paneDir: string;
    endpoint: PaneDaemonEndpoint;
  };
  platform?: PanePlatform;
  release: DoctorReleaseCheck;
  installedPane: DoctorInstalledPaneCheck;
  daemon: DoctorDaemonCheck;
  remoteDaemonService: RemoteDaemonServiceDoctorCheck;
  remoteSetup: RemoteSetupDoctorCheck;
  watchDefaults: DoctorWatchDefaults;
  nextCommands: string[];
}

type DoctorWatchDefaults = Omit<
  typeof RUNPANE_CONTRACT.defaults.watch,
  'format' | 'agentsOnly' | 'includeHeldInputPresence'
> & { kinds: 'all' };

interface RemoteDaemonServiceDoctorCheck {
  paneDir: string;
  managed: boolean;
  reachable: boolean;
  endpoint: PaneDaemonEndpoint;
  executableHealth?: RemoteDaemonExecutableHealth;
}

interface RemoteSetupDiagnostic {
  code: string;
  severity: 'warning' | 'error';
  message: string;
  recoveryCommand?: string;
}

interface RemoteSetupDoctorCheck {
  ready: boolean;
  displayAvailable: boolean;
  headlessEnvironmentApplied: boolean;
  diagnostics: RemoteSetupDiagnostic[];
}

export interface PreparedDoctorReport {
  ok: boolean;
  title: string;
  path: string;
  sha256: string;
  redactionCount: number;
  proposedCommand: string;
  filed: boolean;
  issueUrl?: string;
  fallbackUrl?: string;
  error?: string;
}

interface RedactedDoctorReport {
  text: string;
  count: number;
}

export async function runDoctor(parsed: ParsedArgs, source: 'npm' | 'pip' = 'npm'): Promise<number> {
  const report = await buildDoctorReport(parsed, source);

  if (parsed.report) {
    const prepared = prepareDoctorFailureReport(parsed, report);
    if (parsed.yes) {
      fileDoctorFailureReport(prepared);
    }
    if (parsed.json) {
      console.log(JSON.stringify(prepared, null, 2));
    } else {
      console.log(`Report: ${prepared.path}`);
      console.log(`SHA-256: ${prepared.sha256}`);
      console.log(`Redactions: ${prepared.redactionCount}`);
      if (prepared.issueUrl) console.log(`Issue: ${prepared.issueUrl}`);
      else console.log(`Proposed: ${prepared.proposedCommand}`);
      if (prepared.error) console.error(`Report filing failed: ${prepared.error}`);
    }
    return prepared.ok ? 0 : 1;
  }

  if (parsed.json) {
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }

  renderDoctorText(report);
  return report.ok ? 0 : 1;
}

export function prepareDoctorFailureReport(parsed: ParsedArgs, doctor: DoctorReport): PreparedDoctorReport {
  if (!parsed.bodyFile) {
    throw new Error('runpane doctor --report requires --body-file <path|->.');
  }
  const requestedTitle = singleLine(parsed.title?.trim() || 'RunPane watcher failure');
  const redactedTitle = redactDoctorReport(requestedTitle);
  const title = singleLine(redactedTitle.text);
  const evidence = readReportEvidence(parsed.bodyFile);
  const diagnostics = {
    source: doctor.source,
    wrapper: {
      runtime: doctor.wrapper.runtime,
      version: doctor.wrapper.version,
      paneDir: doctor.wrapper.paneDir,
      endpoint: doctor.wrapper.endpoint,
    },
    platform: doctor.platform,
    release: doctor.release,
    installedPane: doctor.installedPane,
    daemon: {
      reachable: doctor.daemon.reachable,
      endpoint: doctor.daemon.endpoint,
      app: doctor.daemon.result?.app,
      error: doctor.daemon.error,
    },
    remoteSetup: doctor.remoteSetup,
  };
  const diagnosticsText = JSON.stringify(diagnostics, null, 2);
  const fence = markdownFence(requestedTitle, evidence, diagnosticsText);
  const raw = [
    '# RunPane watcher failure report',
    '',
    '## Report title',
    '',
    fence,
    requestedTitle,
    fence,
    '',
    '## Failure evidence',
    '',
    fence,
    evidence,
    fence,
    '',
    '## RunPane diagnostics',
    '',
    fence,
    diagnosticsText,
    fence,
    '',
  ].join('\n');
  const redacted = redactDoctorReport(raw);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runpane-report-'));
  const reportPath = path.join(directory, 'report.md');
  fs.writeFileSync(reportPath, redacted.text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.chmodSync(reportPath, 0o600);
  const sha256 = createHash('sha256').update(redacted.text).digest('hex');
  const proposedCommand = [
    `gh issue create --repo ${PANE_REPO}`,
    `--title ${shellQuote(title)}`,
    `--body-file ${shellQuote(reportPath)}`,
    '--label bug',
  ].join(' ');
  return {
    ok: true,
    title,
    path: reportPath,
    sha256,
    redactionCount: redacted.count,
    proposedCommand,
    filed: false,
  };
}

export function redactDoctorReport(value: string, home = os.homedir()): RedactedDoctorReport {
  let text = value;
  let count = 0;
  if (home) {
    text = text.replace(new RegExp(escapeRegExp(home), 'g'), () => {
      count += 1;
      return '~';
    });
  }
  text = text.replace(
    /\b(authorization|proxy-authorization|cookie|set-cookie)(\s*:\s*)[^\r\n]*/giu,
    (_match, key: string, separator: string) => {
      count += 1;
      return `${key}${separator}[REDACTED]`;
    },
  );
  text = text.replace(
    /(["']?)((?:[a-z][a-z0-9_-]*?)?(?:token|password|passwd|secret|api[_-]?key|access[_-]?key)|authorization|proxy-authorization|cookie|set-cookie)\1(\s*[=:]\s*)([^\r\n]*)/giu,
    (match, quote: string, key: string, separator: string, value: string) => {
      if (/^(["']?)\[REDACTED\]\1$/iu.test(value.trim())) return match;
      count += 1;
      const redactedValue = quote ? `${quote}[REDACTED]${quote}` : '[REDACTED]';
      return `${quote}${key}${quote}${separator}${redactedValue}`;
    },
  );
  text = text.replace(/([?&][^=\s&]+)=([^&#\s]*)/gu, (_match, prefix: string) => {
    count += 1;
    return `${prefix}=[REDACTED]`;
  });
  return { text, count };
}

function markdownFence(...values: string[]): string {
  let longest = 2;
  for (const value of values) {
    for (const match of value.matchAll(/`+/gu)) longest = Math.max(longest, match[0].length);
  }
  return '`'.repeat(longest + 1);
}

function readReportEvidence(bodyFile: string): string {
  const bytes = bodyFile === '-' ? fs.readFileSync(0) : fs.readFileSync(bodyFile);
  if (bytes.byteLength > 32 * 1024) {
    throw new Error('runpane doctor --report evidence exceeds the 32 KiB limit.');
  }
  return bytes.toString('utf8');
}

export function fileDoctorFailureReport(prepared: PreparedDoctorReport): void {
  const { title } = prepared;
  const fallbackUrl = `https://github.com/${PANE_REPO}/issues/new?title=${encodeURIComponent(title)}`;
  prepared.fallbackUrl = fallbackUrl;
  const auth = childProcess.spawnSync('gh', ['auth', 'status'], { encoding: 'utf8', timeout: 10_000 });
  if (auth.error || auth.status !== 0) {
    prepared.ok = false;
    prepared.error = auth.error?.message || auth.stderr?.trim() || 'gh auth status failed';
    return;
  }
  const baseArgs = ['issue', 'create', '--repo', PANE_REPO, '--title', title, '--body-file', prepared.path];
  let created = childProcess.spawnSync('gh', [...baseArgs, '--label', 'bug'], { encoding: 'utf8', timeout: 30_000 });
  if (created.status !== 0 && !created.error && /label|could not add/iu.test(created.stderr ?? '')) {
    created = childProcess.spawnSync('gh', baseArgs, { encoding: 'utf8', timeout: 30_000 });
  }
  const issueUrl = created.stdout?.trim().split(/\s+/u).find(value => ISSUE_URL_PATTERN.test(value));
  if (created.error || created.status !== 0 || !issueUrl) {
    prepared.ok = false;
    prepared.error = created.error?.message || created.stderr?.trim() || 'gh issue create did not return an issue URL';
    return;
  }
  prepared.filed = true;
  prepared.issueUrl = issueUrl;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function singleLine(value: string): string {
  return [...value]
    .map(character => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint >= 127 && codePoint <= 159 ? ' ' : character;
    })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 180) || 'RunPane watcher failure';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function buildDoctorReport(parsed: ParsedArgs, source: 'npm' | 'pip'): Promise<DoctorReport> {
  const paneDir = resolvePaneDirectory(parsed.paneDir);
  const endpoint = getPaneDaemonEndpoint(paneDir);
  const platform = collectPlatform();
  const releasePromise = platform.ok
    ? collectReleaseCheck(parsed, source, platform.platform)
    : Promise.resolve({ ok: false, error: platform.error });
  const installedPane = collectInstalledPane(parsed.panePath);
  const daemonPromise = collectDaemonHealth(parsed.paneDir, endpoint);
  const [release, daemon] = await Promise.all([releasePromise, daemonPromise]);
  const remoteDaemonService = await collectRemoteDaemonServiceCheck(parsed, paneDir, daemon);
  const remoteSetup = collectRemoteSetupCheck(
    platform.ok ? platform.platform : undefined,
    'format' in release ? release.format : undefined,
  );
  addRemoteDaemonHealthDiagnostic(remoteSetup, remoteDaemonService);

  return {
    ok: release.ok && daemon.reachable && remoteSetup.ready,
    source,
    wrapper: {
      runtime: 'node',
      version: getWrapperVersion(),
      paneDir,
      endpoint,
    },
    platform: platform.ok ? platform.platform : undefined,
    release,
    installedPane,
    daemon,
    remoteDaemonService,
    remoteSetup,
    watchDefaults: watchDefaults(),
    nextCommands: [
      'runpane agent-context --json',
      'runpane agent-context --command "<command>" --json',
      'runpane repos list --json',
    ],
  };
}

async function collectRemoteDaemonServiceCheck(
  parsed: ParsedArgs,
  desktopPaneDir: string,
  desktopDaemon: DoctorDaemonCheck,
): Promise<RemoteDaemonServiceDoctorCheck> {
  const defaultRemotePaneDir = path.join(os.homedir(), '.pane_remote');
  const requestedPaneDir = parsed.paneDir ? resolvePaneDirectory(parsed.paneDir) : undefined;
  const fallbackManaged = hasManagedRemoteLauncher(defaultRemotePaneDir);
  const paneDir = requestedPaneDir ?? (fallbackManaged ? defaultRemotePaneDir : desktopPaneDir);
  const endpoint = getPaneDaemonEndpoint(paneDir);
  const managed = hasManagedRemoteLauncher(paneDir);
  const daemon = paneDir === desktopPaneDir
    ? desktopDaemon
    : await collectDaemonHealth(paneDir, endpoint);
  const selfReportedHealth = daemon.result?.daemon.executableHealth;
  return {
    paneDir,
    managed,
    reachable: daemon.reachable,
    endpoint,
    ...(selfReportedHealth
      ? { executableHealth: selfReportedHealth }
      : managed ? { executableHealth: inspectLegacyRemoteDaemonHealth(paneDir, daemon.reachable) } : {}),
  };
}

function hasManagedRemoteLauncher(paneDir: string): boolean {
  return fs.existsSync(path.join(paneDir, 'remote-daemon', process.platform === 'win32' ? 'start.cmd' : 'start.sh'));
}

interface LegacyHealthOverrides {
  platform?: NodeJS.Platform;
  launcherPath?: string;
  installedCandidates?: string[];
  runtimePath?: string | null;
  checkedAt?: string;
}

export function inspectLegacyRemoteDaemonHealth(
  paneDir: string,
  reachable: boolean,
  overrides: LegacyHealthOverrides = {},
): RemoteDaemonExecutableHealth {
  const platform = overrides.platform ?? process.platform;
  const launcherPath = overrides.launcherPath
    ?? path.join(paneDir, 'remote-daemon', platform === 'win32' ? 'start.cmd' : 'start.sh');
  const candidates = overrides.installedCandidates ?? getRemoteExecutableCandidates(platform);
  const installedPath = candidates.find(isExecutableFile) ?? resolveRemoteExecutableFromPath(platform);
  const recoveryCommand = `runpane daemon repair --pane-dir ${formatPaneDir(paneDir)}`;
  const checkedAt = overrides.checkedAt ?? new Date().toISOString();
  let launcherContents: string;
  try {
    launcherContents = fs.readFileSync(launcherPath, 'utf8');
  } catch (error) {
    return unknownExecutableHealth(launcherPath, installedPath, checkedAt, `The managed launcher could not be read: ${errorMessage(error)}`);
  }

  const savedPath = extractLegacyExecutablePath(launcherContents);
  const sourceLauncher = launcherContents.includes(`${REMOTE_LAUNCHER_MARKER} source`);
  const resolvedPath = launcherContents.includes(REMOTE_LAUNCHER_MARKER) && !sourceLauncher
    ? installedPath
    : savedPath && isExecutableFile(savedPath) ? savedPath : null;
  const restart: RemoteDaemonExecutableHealth['restart'] = sourceLauncher
    ? { status: 'unknown', launcherPath, evidence: 'The source-development launcher is not tied to an installed Pane executable.' }
    : resolvedPath
    ? { status: 'ready', launcherPath, resolvedPath, evidence: `The managed launcher resolves ${resolvedPath}.` }
    : savedPath
      ? { status: 'broken', launcherPath, evidence: `The saved launcher target is missing: ${savedPath}.` }
      : launcherContents.includes(REMOTE_LAUNCHER_MARKER)
        ? { status: 'broken', launcherPath, evidence: 'The runtime resolver cannot find an installed Pane executable.' }
        : { status: 'unknown', launcherPath, evidence: 'The launcher format is not recognized.' };
  const runtimeLink = overrides.runtimePath === undefined
    ? findSystemdDaemonRuntimePath(platform)
    : overrides.runtimePath;
  const processImage = classifyLegacyProcessImage(runtimeLink, installedPath, reachable);

  if (reachable && processImage.status === 'deleted' && restart.status === 'broken') {
    return {
      processImage,
      restart,
      diagnosticCode: 'PANE_REMOTE_DAEMON_EXECUTABLE_DELETED',
      recoveryCommand,
      checkedAt,
    };
  }
  if (processImage.status === 'deleted' || processImage.status === 'replaced') {
    const health: RemoteDaemonExecutableHealth = {
      processImage,
      restart,
      diagnosticCode: 'PANE_REMOTE_DAEMON_UPDATE_PENDING',
      checkedAt,
    };
    if (restart.status === 'broken') health.recoveryCommand = recoveryCommand;
    return health;
  }
  if (restart.status === 'broken') {
    return {
      processImage,
      restart,
      diagnosticCode: 'PANE_REMOTE_DAEMON_LAUNCHER_STALE',
      recoveryCommand,
      checkedAt,
    };
  }
  return { processImage, restart, checkedAt };
}

function classifyLegacyProcessImage(
  runtimeLink: string | null,
  installedPath: string | null,
  reachable: boolean,
): RemoteDaemonExecutableHealth['processImage'] {
  if (!reachable || !runtimeLink) {
    return {
      status: 'unknown',
      runtimePath: runtimeLink,
      installedPath,
      evidence: reachable ? 'The service process executable could not be inspected.' : 'The managed daemon is not reachable.',
    };
  }
  if (runtimeLink.endsWith(' (deleted)')) {
    return {
      status: 'deleted',
      runtimePath: runtimeLink.slice(0, -' (deleted)'.length),
      installedPath,
      evidence: 'The running service executable points to a deleted inode in /proc.',
    };
  }
  const current = installedPath !== null && sameExecutable(runtimeLink, installedPath);
  return {
    status: installedPath ? current ? 'current' : 'replaced' : 'unknown',
    runtimePath: runtimeLink,
    installedPath,
    evidence: installedPath
      ? current ? 'The running and installed executables have the same device and inode.' : 'The installed executable differs from the running service process.'
      : 'No installed Pane executable was found for comparison.',
  };
}

function findSystemdDaemonRuntimePath(platform: NodeJS.Platform): string | null {
  if (platform !== 'linux' || !commandExists('systemctl')) return null;
  const group = childProcess.spawnSync(
    'systemctl',
    ['--user', 'show', REMOTE_DAEMON_UNIT, '--property=ControlGroup', '--value'],
    { encoding: 'utf8', timeout: 2_000 },
  ).stdout?.trim();
  if (!group) return null;
  let pids: string[];
  try {
    pids = fs.readFileSync(path.join('/sys/fs/cgroup', group, 'cgroup.procs'), 'utf8').trim().split(/\s+/).filter(Boolean);
  } catch {
    return null;
  }
  for (const pid of pids) {
    try {
      const commandLine = fs.readFileSync(path.join('/proc', pid, 'cmdline'));
      if (!commandLine.toString('utf8').includes('--daemon-headless')) continue;
      return fs.readlinkSync(path.join('/proc', pid, 'exe'));
    } catch {
      // Processes can leave the cgroup while doctor is walking it.
    }
  }
  return null;
}

function addRemoteDaemonHealthDiagnostic(
  setup: RemoteSetupDoctorCheck,
  service: RemoteDaemonServiceDoctorCheck,
): void {
  const diagnostic = createRemoteDaemonHealthDiagnostic(service);
  if (!diagnostic) return;
  setup.diagnostics.push(diagnostic);
  setup.ready = setup.diagnostics.every((item) => item.severity !== 'error');
}

export function createRemoteDaemonHealthDiagnostic(
  service: RemoteDaemonServiceDoctorCheck,
): RemoteSetupDiagnostic | undefined {
  const health = service.executableHealth;
  if (!health?.diagnosticCode) return undefined;
  const fatal = service.reachable
    && health.diagnosticCode === 'PANE_REMOTE_DAEMON_EXECUTABLE_DELETED'
    && health.processImage.status === 'deleted'
    && health.restart.status === 'broken';
  const runtimePath = health.processImage.runtimePath ?? 'the previous Pane executable';
  const installedPath = health.processImage.installedPath ?? 'the current Pane executable';
  const launcherFailure = /(?:saved|legacy) launcher target is missing:/.test(health.restart.evidence)
    ? `Pane is now installed at ${installedPath}, and the saved launcher still references the old path`
    : 'the runtime-resolving launcher cannot find an installed Pane executable';
  const message = fatal
    ? `Remote daemon is reachable but unsafe to restart. It is running ${runtimePath} from a deleted inode; ${launcherFailure}. The daemon will not return after reboot or service restart. Run ${health.recoveryCommand} before restarting, then rerun doctor.`
    : health.diagnosticCode === 'PANE_REMOTE_DAEMON_UPDATE_PENDING'
      ? 'The remote daemon is still running an older or deleted process image, but its launcher can resolve the installed Pane executable on restart.'
      : health.restart.evidence;
  const finding: RemoteSetupDiagnostic = {
    code: health.diagnosticCode,
    severity: fatal ? 'error' : 'warning',
    message,
  };
  if (health.recoveryCommand) finding.recoveryCommand = health.recoveryCommand;
  return finding;
}

function unknownExecutableHealth(
  launcherPath: string,
  installedPath: string | null,
  checkedAt: string,
  evidence: string,
): RemoteDaemonExecutableHealth {
  return {
    processImage: { status: 'unknown', runtimePath: null, installedPath, evidence },
    restart: { status: 'unknown', launcherPath, evidence },
    checkedAt,
  };
}

function getRemoteExecutableCandidates(platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') {
    return ['/Applications/Pane.app/Contents/MacOS/Pane', path.join(os.homedir(), 'Applications', 'Pane.app', 'Contents', 'MacOS', 'Pane')];
  }
  if (platform === 'win32') {
    return [
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Pane', 'Pane.exe') : '',
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Pane', 'Pane.exe') : '',
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Pane', 'Pane.exe') : '',
    ].filter(Boolean);
  }
  return [path.join(os.homedir(), '.local', 'bin', 'pane'), '/usr/bin/pane', '/opt/Pane/pane', '/opt/Pane/Pane'];
}

function resolveRemoteExecutableFromPath(platform: NodeJS.Platform): string | null {
  const commandNames = platform === 'win32' ? ['pane.exe', 'Pane.exe'] : ['pane', 'Pane'];
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const directory of pathEntries) {
    for (const command of commandNames) {
      const candidate = path.join(directory, command);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function extractLegacyExecutablePath(contents: string): string | null {
  const quotedMatch = contents.match(/(["'])([^"'\r\n]*[\\/](?:Pane\.exe|Pane|pane))\1/);
  if (quotedMatch) return quotedMatch[2];
  return contents.match(/(\/opt\/Pane\/(?:Pane|pane)|[^\s'"]+[\\/](?:Pane\.exe|Pane|pane))/)?.[1] ?? null;
}

function isExecutableFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function sameExecutable(left: string, right: string): boolean {
  try {
    const leftStat = fs.statSync(left);
    const rightStat = fs.statSync(right);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
}

function formatPaneDir(paneDir: string): string {
  const relative = path.relative(os.homedir(), paneDir);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? `~/${relative}`
    : `'${paneDir.replace(/'/g, `'\\''`)}'`;
}

interface RemoteSetupProbes {
  displayAvailable: boolean;
  hasFuseRuntime: boolean;
  isRoot: boolean;
  unprivilegedUserNamespaceDisabled: boolean;
  hasSystemctl: boolean;
}

export function collectRemoteSetupCheck(
  platform: PanePlatform | undefined,
  releaseFormat: string | undefined,
  probeOverrides: Partial<RemoteSetupProbes> = {}
): RemoteSetupDoctorCheck {
  if (platform?.os !== 'linux') {
    return {
      ready: true,
      displayAvailable: true,
      headlessEnvironmentApplied: false,
      diagnostics: [],
    };
  }

  const probes: RemoteSetupProbes = {
    displayAvailable: Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
    hasFuseRuntime: hasLinuxFuseRuntime(),
    isRoot: process.getuid?.() === 0,
    unprivilegedUserNamespaceDisabled: isUnprivilegedUserNamespaceDisabled(),
    hasSystemctl: commandExists('systemctl'),
    ...probeOverrides,
  };
  const diagnostics: RemoteSetupDiagnostic[] = [];
  if (releaseFormat === 'appimage' && !probes.hasFuseRuntime) {
    diagnostics.push({
      code: 'PANE_APPIMAGE_FUSE_MISSING',
      severity: 'error',
      message: 'The selected AppImage may not start because Pane could not find /dev/fuse and a FUSE mount helper.',
      recoveryCommand: 'Install FUSE for this Linux distribution, or rerun with --format deb on a Debian-based host.',
    });
  }

  if (probes.isRoot) {
    diagnostics.push({
      code: 'PANE_ELECTRON_SANDBOX_ROOT',
      severity: 'error',
      message: 'The Pane Electron runtime should not be launched as root with its sandbox enabled.',
      recoveryCommand: 'Run runpane install daemon as a non-root user.',
    });
  } else if (probes.unprivilegedUserNamespaceDisabled) {
    diagnostics.push({
      code: 'PANE_ELECTRON_SANDBOX_UNAVAILABLE',
      severity: 'error',
      message: 'Unprivileged user namespaces are disabled, so the Electron sandbox may not start.',
      recoveryCommand: 'Enable unprivileged user namespaces for this host, or explicitly use --no-sandbox only if you accept the security tradeoff.',
    });
  }

  if (!probes.hasSystemctl) {
    diagnostics.push({
      code: 'PANE_USER_SERVICE_UNAVAILABLE',
      severity: 'warning',
      message: 'systemctl is unavailable; setup will print a manual daemon command instead of installing a user service.',
    });
  }

  return {
    ready: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
    displayAvailable: probes.displayAvailable,
    headlessEnvironmentApplied: true,
    diagnostics,
  };
}

function hasLinuxFuseRuntime(): boolean {
  return fs.existsSync('/dev/fuse') && (commandExists('fusermount') || commandExists('fusermount3'));
}

function isUnprivilegedUserNamespaceDisabled(): boolean {
  try {
    return fs.readFileSync('/proc/sys/kernel/unprivileged_userns_clone', 'utf8').trim() === '0';
  } catch {
    return false;
  }
}

function commandExists(command: string): boolean {
  const result = childProcess.spawnSync('sh', ['-lc', `command -v ${command}`], {
    stdio: 'ignore',
    timeout: 2_000,
  });
  return result.status === 0;
}

function collectPlatform(): { ok: true; platform: PanePlatform } | { ok: false; error: string } {
  try {
    return { ok: true, platform: detectPlatform() };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function collectReleaseCheck(
  parsed: ParsedArgs,
  source: 'npm' | 'pip',
  platform: PanePlatform
): Promise<DoctorReleaseCheck> {
  try {
    const release = await resolveRelease({
      version: parsed.paneVersion,
      channel: parsed.channel,
      source,
      platform,
      format: parsed.format,
      target: 'client',
      fetchTimeoutMs: DOCTOR_RELEASE_TIMEOUT_MS,
    });
    return {
      ok: true,
      tagName: release.release.tag_name,
      artifactName: release.artifact.name,
      format: release.format,
      preferredDownloadUrl: release.preferredDownloadUrl,
      fallbackDownloadUrl: release.fallbackDownloadUrl,
    };
  } catch (error) {
    return {
      ok: false,
      error: errorMessage(error),
    };
  }
}

function collectInstalledPane(panePath?: string): DoctorInstalledPaneCheck {
  const installedPath = resolveExistingPanePath(panePath);
  if (!installedPath) {
    return { found: false };
  }

  return {
    found: true,
    path: installedPath,
    version: getPaneVersion(installedPath),
  };
}

async function collectDaemonHealth(paneDir: string | undefined, endpoint: PaneDaemonEndpoint): Promise<DoctorDaemonCheck> {
  try {
    return {
      reachable: true,
      endpoint,
      result: await invokeDaemon('runpane:doctor', [], daemonDoctorResultSchema, {
        paneDir,
        timeoutMs: DOCTOR_DAEMON_TIMEOUT_MS,
      }),
    };
  } catch (error) {
    const message = errorMessage(error);
    return {
      reachable: false,
      endpoint,
      error: message,
      nextCommand: resolveDaemonRecoveryCommand(endpoint, message),
    };
  }
}

function resolveDaemonRecoveryCommand(endpoint: PaneDaemonEndpoint, message: string): string {
  if (
    endpoint.transport === 'unix'
    && (message.includes('ECONNREFUSED') || fs.existsSync(endpoint.path))
  ) {
    return 'Quit Pane completely, reopen Pane, then rerun runpane doctor --json';
  }

  return 'Open Pane, then rerun runpane doctor --json';
}

export function watchDefaults(): DoctorWatchDefaults {
  const { heartbeatSeconds, idleAfterMs, settleMs, blockedSettleMs, minIntervalMs, idleBackoff } = RUNPANE_CONTRACT.defaults.watch;
  return { heartbeatSeconds, idleAfterMs, settleMs, blockedSettleMs, minIntervalMs, idleBackoff, kinds: 'all' };
}

export function formatWatchDefaults(defaults: DoctorWatchDefaults): string {
  return `Watch defaults (--follow): heartbeat ${defaults.heartbeatSeconds}s, idle-after ${defaults.idleAfterMs}ms, `
    + `settle ${defaults.settleMs}ms, blocked-settle ${defaults.blockedSettleMs}ms, min-interval ${defaults.minIntervalMs}ms, `
    + `idle-backoff ${defaults.idleBackoff ? 'on' : 'off'}, kinds ${defaults.kinds}`;
}

function renderDoctorText(report: DoctorReport): void {
  if (report.platform) {
    console.log(`Platform: ${report.platform.os}/${report.platform.arch}`);
  }

  if (report.release.ok) {
    console.log(`Latest release: ${report.release.tagName}`);
    console.log(`Selected artifact: ${report.release.artifactName}`);
    console.log(`Website URL: ${report.release.preferredDownloadUrl}`);
    console.log(`GitHub fallback: ${report.release.fallbackDownloadUrl}`);
  } else {
    console.error(`Release check: failed - ${report.release.error ?? 'unknown error'}`);
  }

  if (report.installedPane.found) {
    console.log(`Installed Pane: ${report.installedPane.path}`);
    console.log(`Installed version: ${report.installedPane.version ?? 'unknown'}`);
  } else {
    console.log('Installed Pane: not found');
  }

  console.log(`Pane directory: ${report.wrapper.paneDir}`);
  console.log(`Daemon endpoint: ${report.daemon.endpoint.transport} ${report.daemon.endpoint.path}`);
  if (report.daemon.reachable) {
    console.log(`Pane daemon: reachable (${report.daemon.result?.repos.count ?? 0} repos)`);
    const terminal = report.daemon.result?.terminal;
    if (terminal) {
      console.log(`Terminal images: ${terminal.graphicsProtocols.join(', ')}`);
    }
  } else {
    console.log(`Pane daemon: unreachable - ${report.daemon.error ?? 'unknown error'}`);
  }

  console.log(`Remote setup preflight: ${report.remoteSetup.ready ? 'ready' : 'action required'}`);
  if (report.platform?.os === 'linux') {
    console.log(`  Display available: ${report.remoteSetup.displayAvailable ? 'yes' : 'no (headless mode will be applied)'}`);
  }
  for (const diagnostic of report.remoteSetup.diagnostics) {
    console.log(`  ${diagnostic.code}: ${diagnostic.message}`);
    if (diagnostic.recoveryCommand) {
      console.log(`  Recovery: ${diagnostic.recoveryCommand}`);
    }
  }

  console.log(formatWatchDefaults(report.watchDefaults));
  console.log('Agent discovery: run "runpane doctor --json" before Pane actions, then "runpane agent-context --json" for full CLI context.');
  console.log('Remote setup: run "runpane setup" for guided setup, or "runpane install daemon --label <name>" for scripting.');
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
