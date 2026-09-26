import { runRemoteSetupCommand, type RemoteSetupCommandRunner } from './remote-setup-command';
import { spawnSync } from 'child_process';
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type {
  RemoteDaemonServiceInspection,
  RemoteDaemonServiceRepairResult,
  RemoteHostSetupServiceResult,
} from '../../../shared/types/remoteDaemon';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';

const SERVICE_NAME = 'com.dcouple.pane.remote-daemon';
const SYSTEMD_UNIT_NAME = 'pane-remote-daemon.service';
const WINDOWS_TASK_NAME = 'PaneRemoteDaemon';
const LAUNCHER_MARKER = 'pane-remote-daemon-launcher-v2';

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface RemoteDaemonServiceDependencies {
  platform?: NodeJS.Platform;
  homeDir?: string;
  executablePath?: string;
  sourceRoot?: string | null;
  executableCandidates?: string[];
  asyncCommandRunner?: RemoteSetupCommandRunner;
  commandExists?: (command: string) => boolean;
  runCommand?: (command: string, args: string[]) => CommandResult;
}

export async function assertRemoteDaemonServiceCanBeInstalled(
  dependencies: RemoteDaemonServiceDependencies = {},
): Promise<void> {
  await assertPackagedExecutableDiscoverable(createContext(dependencies));
}

interface ServiceContext {
  platform: NodeJS.Platform;
  homeDir: string;
  executablePath: string;
  sourceRoot: string | null;
  executableCandidates: string[];
  commandExists: (command: string) => boolean | Promise<boolean>;
  runCommand: (command: string, args: string[]) => CommandResult | Promise<CommandResult>;
}

export async function installRemoteDaemonService(
  paneDir: string,
  dependencies: RemoteDaemonServiceDependencies = {},
): Promise<RemoteHostSetupServiceResult> {
  const context = createContext(dependencies);
  await assertPackagedExecutableDiscoverable(context);
  return installForContext(path.resolve(paneDir), context, false);
}

export function buildManualRemoteDaemonCommand(
  paneDir: string,
  dependencies: RemoteDaemonServiceDependencies = {},
): string {
  const resolvedPaneDir = path.resolve(paneDir);
  const context = createContext(dependencies);
  if (context.sourceRoot) {
    return buildSourceCommand(context.sourceRoot, resolvedPaneDir, context.platform);
  }
  if (context.platform === 'win32') {
    return `${quoteForWindows(context.executablePath)} --daemon-headless --pane-dir ${quoteForWindows(resolvedPaneDir)}`;
  }
  const flags = context.platform === 'linux' ? ' --ozone-platform=headless --disable-gpu' : '';
  const environment = context.platform === 'linux' ? 'ELECTRON_OZONE_PLATFORM_HINT=headless ' : '';
  return `${environment}PANE_DIR=${quoteForPosix(resolvedPaneDir)} ${quoteForPosix(context.executablePath)}${flags} --daemon-headless --pane-dir ${quoteForPosix(resolvedPaneDir)}`;
}

export async function repairRemoteDaemonService(
  paneDir: string,
  dependencies: RemoteDaemonServiceDependencies = {},
): Promise<RemoteDaemonServiceRepairResult> {
  const resolvedPaneDir = path.resolve(paneDir);
  const context = createContext(dependencies);
  await assertPackagedExecutableDiscoverable(context);
  const before = await inspectRemoteDaemonService(resolvedPaneDir, dependencies);
  const service = await installForContext(resolvedPaneDir, context, true);
  const after = await inspectRemoteDaemonService(resolvedPaneDir, dependencies);
  return {
    ok: service.installed && service.started && after.launcherCurrent,
    changed: !before.launcherCurrent || before.launcherContents !== after.launcherContents,
    paneDir: resolvedPaneDir,
    strategy: service.strategy,
    launcherPath: after.launcherPath,
    before: omitLauncherContents(before),
    after: omitLauncherContents(after),
    message: service.message,
  };
}

async function inspectRemoteDaemonService(
  paneDir: string,
  dependencies: RemoteDaemonServiceDependencies = {},
): Promise<RemoteDaemonServiceInspection & { launcherContents?: string }> {
  const context = createContext(dependencies);
  const launcherPath = getLauncherPath(path.resolve(paneDir), context.platform);
  let launcherContents: string | undefined;
  try {
    launcherContents = await fs.readFile(launcherPath, 'utf8');
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    if (!isNodeErrorWithCode(failure, 'ENOENT')) {
      throw error;
    }
  }

  const resolvedPath = await resolveRemoteDaemonExecutablePathAsync(
    context.platform,
    context.executableCandidates,
    (command) => resolveCommandPath(command, context),
  );
  const savedExecutablePath = launcherContents ? extractLegacyRemoteDaemonExecutablePath(launcherContents) : null;
  const savedExecutableExists = savedExecutablePath ? isExecutableFile(savedExecutablePath) : null;
  const launcherCurrent = launcherContents?.includes(LAUNCHER_MARKER) === true;
  const inspection: RemoteDaemonServiceInspection & { launcherContents?: string } = {
    launcherPath,
    launcherExists: launcherContents !== undefined,
    launcherCurrent,
    savedExecutablePath,
    savedExecutableExists,
    resolvedExecutablePath: resolvedPath,
    restartStatus: launcherCurrent
      ? resolvedPath ? 'ready' : 'broken'
      : savedExecutableExists === true ? 'ready' : launcherContents ? 'broken' : 'unknown',
  };
  if (launcherContents !== undefined) inspection.launcherContents = launcherContents;
  return inspection;
}

export function getRemoteDaemonExecutableCandidates(
  platform: NodeJS.Platform = process.platform,
  homeDir = os.homedir(),
): string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/Pane.app/Contents/MacOS/Pane',
      path.join(homeDir, 'Applications', 'Pane.app', 'Contents', 'MacOS', 'Pane'),
    ];
  }
  if (platform === 'win32') {
    return [
      ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Programs', 'Pane', 'Pane.exe')] : []),
      ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'Pane', 'Pane.exe')] : []),
      ...(process.env.ProgramFiles ? [path.join(process.env.ProgramFiles, 'Pane', 'Pane.exe')] : []),
    ];
  }
  return [
    path.join(homeDir, '.local', 'bin', 'pane'),
    '/usr/bin/pane',
    '/opt/Pane/pane',
    '/opt/Pane/Pane',
  ];
}

export function renderPosixRemoteDaemonLauncher(options: {
  paneDir: string;
  platform: 'linux' | 'darwin';
  executableCandidates: string[];
  sourceCommand?: string;
}): string {
  if (options.sourceCommand) {
    return [
      '#!/usr/bin/env sh',
      `# ${LAUNCHER_MARKER} source`,
      'set -eu',
      `export PANE_DIR=${quoteForPosix(options.paneDir)}`,
      `exec /bin/sh -lc ${quoteForPosix(options.sourceCommand)}`,
      '',
    ].join('\n');
  }

  const candidateAssignments = options.executableCandidates.map((candidate) => quoteForPosix(candidate)).join(' ');
  const linuxFlags = options.platform === 'linux' ? ' --ozone-platform=headless --disable-gpu' : '';
  const environment = options.platform === 'linux'
    ? ['export ELECTRON_OZONE_PLATFORM_HINT=headless']
    : [];
  const command = [
    'pane_executable=',
    `for candidate in ${candidateAssignments}; do`,
    '  if [ -x "$candidate" ]; then pane_executable=$candidate; break; fi',
    'done',
    'if [ -z "$pane_executable" ]; then',
    '  for name in pane Pane; do',
    '    candidate=$(command -v "$name" 2>/dev/null || true)',
    '    if [ -n "$candidate" ] && [ -x "$candidate" ]; then pane_executable=$candidate; break; fi',
    '  done',
    'fi',
    '[ -n "$pane_executable" ] || { echo "Pane remote daemon: no installed Pane executable could be resolved" >&2; exit 127; }',
    `exec "$pane_executable"${linuxFlags} --daemon-headless --pane-dir "$PANE_DIR"`,
  ].join('\n');
  return [
    '#!/usr/bin/env sh',
    `# ${LAUNCHER_MARKER}`,
    'set -eu',
    `export PANE_DIR=${quoteForPosix(options.paneDir)}`,
    ...environment,
    `exec /bin/sh -lc ${quoteForPosix(command)}`,
    '',
  ].join('\n');
}

export function renderWindowsRemoteDaemonLauncher(options: {
  paneDir: string;
  executableCandidates: string[];
  sourceCommand?: string;
}): string {
  if (options.sourceCommand) {
    return [
      '@echo off',
      `rem ${LAUNCHER_MARKER} source`,
      `set "PANE_DIR=${escapeForCmdEnvironment(options.paneDir)}"`,
      options.sourceCommand,
      '',
    ].join('\r\n');
  }
  const lines = [
    '@echo off',
    `rem ${LAUNCHER_MARKER}`,
    'setlocal',
    `set "PANE_DIR=${escapeForCmdEnvironment(options.paneDir)}"`,
    'set "PANE_EXECUTABLE="',
  ];
  for (const candidate of options.executableCandidates) {
    lines.push(`if not defined PANE_EXECUTABLE if exist ${quoteForWindows(candidate)} set "PANE_EXECUTABLE=${escapeForCmdEnvironment(candidate)}"`);
  }
  lines.push(
    'if not defined PANE_EXECUTABLE for %%I in (pane.exe Pane.exe) do if not defined PANE_EXECUTABLE for /f "delims=" %%P in (\'where %%I 2^>nul\') do set "PANE_EXECUTABLE=%%P"',
    'if defined PANE_EXECUTABLE goto pane_executable_found',
    'echo Pane remote daemon: no installed Pane executable could be resolved 1>&2',
    'exit /b 127',
    ':pane_executable_found',
    '"%PANE_EXECUTABLE%" --daemon-headless --pane-dir "%PANE_DIR%"',
    'exit /b %ERRORLEVEL%',
    '',
  );
  return lines.join('\r\n');
}

function createContext(dependencies: RemoteDaemonServiceDependencies): ServiceContext {
  const asyncRun = dependencies.asyncCommandRunner;
  const platform = dependencies.platform ?? process.platform;
  const homeDir = dependencies.homeDir ?? os.homedir();
  return {
    platform,
    homeDir,
    executablePath: dependencies.executablePath ?? process.execPath,
    sourceRoot: dependencies.sourceRoot === undefined ? findPaneSourceRoot(process.cwd()) : dependencies.sourceRoot,
    executableCandidates: dependencies.executableCandidates ?? getRemoteDaemonExecutableCandidates(platform, homeDir),
    commandExists: dependencies.commandExists ?? (asyncRun
      ? async (command) => (await asyncRun(
        platform === 'win32' ? 'where' : 'sh',
        platform === 'win32' ? [command] : ['-lc', `command -v ${quoteForPosix(command)}`],
        { timeoutMs: 5000 },
      )).ok
      : commandExists),
    runCommand: asyncRun
      ? (command, args) => asyncRun(command, args, { timeoutMs: 5000 })
      : dependencies.runCommand ?? runCommand,
  };
}

async function assertPackagedExecutableDiscoverable(context: ServiceContext): Promise<void> {
  if (context.sourceRoot) {
    return;
  }
  const current = safeRealpath(context.executablePath);
  const discoverable = context.executableCandidates.some((candidate) => safeRealpath(candidate) === current)
    || (await resolveCommandPath(context.platform === 'win32' ? 'pane.exe' : 'pane', context)) === current
    || (await resolveCommandPath(context.platform === 'win32' ? 'Pane.exe' : 'Pane', context)) === current;
  if (!discoverable) {
    throw new Error(
      `Pane remote daemon setup cannot persist the current executable safely: ${context.executablePath}. `
      + 'Install or symlink Pane at a supported stable location (for Linux, ~/.local/bin/pane or /opt/Pane/pane), then rerun setup.',
    );
  }
}

async function installForContext(
  paneDir: string,
  context: ServiceContext,
  restart: boolean,
): Promise<RemoteHostSetupServiceResult> {
  if (context.platform === 'linux' && await context.commandExists('systemctl')) {
    return installSystemdUserService(paneDir, context, restart);
  }
  if (context.platform === 'darwin' && await context.commandExists('launchctl')) {
    return installLaunchAgent(paneDir, context);
  }
  if (context.platform === 'win32' && await context.commandExists('schtasks')) {
    return installWindowsScheduledTask(paneDir, context);
  }
  return {
    strategy: 'manual',
    installed: false,
    started: false,
    message: 'No supported user-level service manager detected; use the manual daemon command.',
  };
}

async function installSystemdUserService(
  paneDir: string,
  context: ServiceContext,
  restart: boolean,
): Promise<RemoteHostSetupServiceResult> {
  const launcherPath = await writeLauncher(paneDir, context);
  const serviceDir = path.join(context.homeDir, '.config', 'systemd', 'user');
  const servicePath = path.join(serviceDir, SYSTEMD_UNIT_NAME);
  const serviceFile = [
    '[Unit]',
    'Description=Pane Remote Daemon',
    'After=default.target',
    '',
    '[Service]',
    'Type=simple',
    `Environment=${quoteForSystemd(`PANE_DIR=${paneDir}`)}`,
    `ExecStart=${quoteForSystemd(launcherPath)}`,
    'Restart=on-failure',
    'RestartSec=3',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
  await writeFileAtomically(servicePath, serviceFile, 0o644);
  const reload = await context.runCommand('systemctl', ['--user', 'daemon-reload']);
  const enable = reload.ok
    ? await context.runCommand('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME])
    : reload;
  const restartResult = enable.ok && restart
    ? await context.runCommand('systemctl', ['--user', 'restart', SYSTEMD_UNIT_NAME])
    : enable;
  const started = enable.ok && restartResult.ok;
  return {
    strategy: 'systemd-user',
    installed: enable.ok,
    started,
    message: started
      ? `${restart ? 'Repaired and restarted the user systemd service.' : 'Installed and started a user systemd service.'}${await enableLinger(context)}`
      : `Wrote ${servicePath}, but systemctl failed: ${firstNonEmpty(restartResult.stderr, restartResult.stdout, 'unknown error')}`,
  };
}

// A user service stops with the user's last login session unless lingering is on,
// which on a cloud VM means as soon as the SSH connection closes. Polkit usually
// denies this to SSH users, so fall back to sudo -n, which cloud images allow
// without a password and which fails fast instead of prompting everywhere else.
async function enableLinger(context: ServiceContext): Promise<string> {
  const args = ['enable-linger', '--no-ask-password', os.userInfo().username];
  const enabled = await context.commandExists('loginctl') && (
    (await context.runCommand('loginctl', args)).ok
    || (await context.commandExists('sudo') && (await context.runCommand('sudo', ['-n', 'loginctl', ...args])).ok)
  );
  return enabled ? '' : ' It will stop when you log out until you run: sudo loginctl enable-linger "$USER"';
}

async function installLaunchAgent(paneDir: string, context: ServiceContext): Promise<RemoteHostSetupServiceResult> {
  const launcherPath = await writeLauncher(paneDir, context);
  const agentDir = path.join(context.homeDir, 'Library', 'LaunchAgents');
  const plistPath = path.join(agentDir, `${SERVICE_NAME}.plist`);
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${SERVICE_NAME}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${escapeXml(launcherPath)}</string>`,
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PANE_DIR</key>',
    `    <string>${escapeXml(paneDir)}</string>`,
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
  await writeFileAtomically(plistPath, plist, 0o644);
  await context.runCommand('launchctl', ['unload', '-w', plistPath]);
  const load = await context.runCommand('launchctl', ['load', '-w', plistPath]);
  return {
    strategy: 'launch-agent',
    installed: load.ok,
    started: load.ok,
    message: load.ok ? 'Installed and started a LaunchAgent.' : `Wrote ${plistPath}, but launchctl failed: ${firstNonEmpty(load.stderr, load.stdout, 'unknown error')}`,
  };
}

async function installWindowsScheduledTask(paneDir: string, context: ServiceContext): Promise<RemoteHostSetupServiceResult> {
  const launcherPath = await writeLauncher(paneDir, context);
  const create = await context.runCommand('schtasks', [
    '/Create', '/TN', WINDOWS_TASK_NAME, '/TR', `cmd.exe /d /c ${quoteForWindows(launcherPath)}`, '/SC', 'ONLOGON', '/F',
  ]);
  const run = create.ok ? await context.runCommand('schtasks', ['/Run', '/TN', WINDOWS_TASK_NAME]) : create;
  return {
    strategy: 'scheduled-task',
    installed: create.ok,
    started: run.ok,
    message: create.ok && run.ok ? 'Installed and started a per-user Scheduled Task.' : `Scheduled Task setup failed: ${firstNonEmpty(run.stderr, run.stdout, 'unknown error')}`,
  };
}

async function writeLauncher(paneDir: string, context: ServiceContext): Promise<string> {
  const launcherPath = getLauncherPath(paneDir, context.platform);
  const sourceCommand = context.sourceRoot ? buildSourceCommand(context.sourceRoot, paneDir, context.platform) : undefined;
  const contents = context.platform === 'win32'
    ? renderWindowsRemoteDaemonLauncher({ paneDir, executableCandidates: context.executableCandidates, sourceCommand })
    : renderPosixRemoteDaemonLauncher({
        paneDir,
        platform: context.platform === 'darwin' ? 'darwin' : 'linux',
        executableCandidates: context.executableCandidates,
        sourceCommand,
      });
  await writeFileAtomically(launcherPath, contents, context.platform === 'win32' ? 0o644 : 0o755);
  return launcherPath;
}

function buildSourceCommand(sourceRoot: string, paneDir: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return `cd /d ${quoteForWindows(sourceRoot)} && set "PANE_DIR=${escapeForCmdEnvironment(paneDir)}" && pnpm daemon:headless -- --pane-dir ${quoteForWindows(paneDir)}`;
  }
  const flags = platform === 'linux' ? ' --ozone-platform=headless --disable-gpu' : '';
  return `cd ${quoteForPosix(sourceRoot)} && PANE_DIR=${quoteForPosix(paneDir)} pnpm daemon:headless --${flags} --pane-dir ${quoteForPosix(paneDir)}`;
}

function getLauncherPath(paneDir: string, platform: NodeJS.Platform): string {
  return path.join(paneDir, 'remote-daemon', platform === 'win32' ? 'start.cmd' : 'start.sh');
}

async function writeFileAtomically(filePath: string, contents: string, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, contents, { encoding: 'utf8', mode });
    await fs.chmod(temporaryPath, mode);
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function resolveFirstExecutable(candidates: string[]): string | null {
  return candidates.find(isExecutableFile) ?? null;
}

export function resolveRemoteDaemonExecutablePath(
  platform: NodeJS.Platform,
  candidates: string[],
  commandResolver?: (command: string) => string | null,
): string | null {
  const fixedCandidate = resolveFirstExecutable(candidates);
  if (fixedCandidate) return fixedCandidate;

  const resolveCommand = commandResolver ?? ((command: string) => {
    const result = platform === 'win32'
      ? runCommand('where', [command])
      : runCommand('sh', ['-lc', `command -v ${quoteForPosix(command)}`]);
    const firstLine = result.ok ? result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) : undefined;
    return firstLine ? safeRealpath(firstLine) : null;
  });
  const commandNames = platform === 'win32' ? ['pane.exe', 'Pane.exe'] : ['pane', 'Pane'];
  return commandNames
    .map(resolveCommand)
    .filter((candidate): candidate is string => candidate !== null)
    .find(isExecutableFile)
    ?? null;
}

export async function resolveRemoteDaemonExecutablePathAsync(
  platform: NodeJS.Platform,
  candidates: string[],
  resolveCommand?: (command: string) => string | null | Promise<string | null>,
): Promise<string | null> {
  const fixed = resolveFirstExecutable(candidates);
  if (fixed) return fixed;
  for (const command of platform === 'win32' ? ['pane.exe', 'Pane.exe'] : ['pane', 'Pane']) {
    let candidate: string | null;
    if (resolveCommand) candidate = await resolveCommand(command);
    else {
      const result = await runRemoteSetupCommand(
        platform === 'win32' ? 'where' : 'sh',
        platform === 'win32' ? [command] : ['-lc', `command -v ${quoteForPosix(command)}`],
        { timeoutMs: 5000 },
      );
      const line = result.ok ? result.stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean) : null;
      candidate = line ? safeRealpath(line) : null;
    }
    if (candidate && isExecutableFile(candidate)) return candidate;
  }
  return null;
}

async function resolveCommandPath(command: string, context: ServiceContext): Promise<string | null> {
  const result = context.platform === 'win32'
    ? await context.runCommand('where', [command])
    : await context.runCommand('sh', ['-lc', `command -v ${quoteForPosix(command)}`]);
  const firstLine = result.ok ? result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) : undefined;
  return firstLine ? safeRealpath(firstLine) : null;
}

function safeRealpath(filePath: string): string | null {
  try {
    return realpathSync(filePath);
  } catch {
    return null;
  }
}

function isExecutableFile(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function extractLegacyRemoteDaemonExecutablePath(contents: string): string | null {
  const quotedMatch = contents.match(/(["'])([^"'\r\n]*[\\/](?:Pane\.exe|Pane|pane))\1/);
  if (quotedMatch) return quotedMatch[2];
  return contents.match(/(\/opt\/Pane\/(?:Pane|pane)|[^\s'"]+[\\/](?:Pane\.exe|Pane|pane))/)?.[1] ?? null;
}

function omitLauncherContents(
  inspection: RemoteDaemonServiceInspection & { launcherContents?: string },
): RemoteDaemonServiceInspection {
  const result = { ...inspection };
  delete result.launcherContents;
  return result;
}

export function findPaneSourceRoot(startDir: string): string | null {
  let current = path.resolve(startDir);
  while (true) {
    const packagePath = path.join(current, 'package.json');
    if (existsSync(packagePath)) {
      try {
        const parsed = decodeBoundary(
          JSON.parse(readFileSync(packagePath, 'utf8')),
          boundary.object({ name: boundary.optional(boundary.json) }),
        );
        if (parsed.name === 'Pane') {
          return current;
        }
      } catch {
        return null;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function runCommand(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe', timeout: 5_000 });
  return {
    ok: result.status === 0,
    stdout: commandOutputToString(result.stdout),
    stderr: commandOutputToString(result.stderr) || result.error?.message || '',
  };
}

function commandExists(command: string): boolean {
  return process.platform === 'win32'
    ? runCommand('where', [command]).ok
    : runCommand('sh', ['-lc', `command -v ${quoteForPosix(command)}`]).ok;
}

function commandOutputToString(value: string | Buffer | null): string {
  return Buffer.isBuffer(value) ? value.toString('utf8') : value ?? '';
}

function firstNonEmpty(...values: string[]): string {
  return values.find((value) => value.trim().length > 0)?.trim() ?? '';
}

function isNodeErrorWithCode(error: Error, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function quoteForPosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quoteForWindows(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function quoteForSystemd(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function escapeForCmdEnvironment(value: string): string {
  return value.replace(/%/g, '%%').replace(/"/g, '""');
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
