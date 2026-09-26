import { runRemoteSetupCommand, type RemoteSetupCommandRunner } from './remoteSetupCommand';
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'child_process';
import { existsSync, readSync } from 'fs';
import os from 'os';
import path from 'path';

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface ResolvedCommand {
  command: string;
  displayCommand: string;
  env?: NodeJS.ProcessEnv;
}

export interface TailscaleSetupDependencies {
  spawnSync: typeof spawnSync;
}

const defaultTailscaleSetupDependencies: TailscaleSetupDependencies = { spawnSync };

interface InstallAttempt {
  attempted: boolean;
  command: string;
  stdout: string;
  stderr: string;
  reason?: string;
}

export function buildTailscaleServeCommand(command: ResolvedCommand | null, port: number): string {
  return `${command?.displayCommand ?? 'tailscale'} serve --bg --tls-terminated-tcp=443 ${port}`;
}

export function installTailscaleCommandOrThrow(
  dependencies: TailscaleSetupDependencies = defaultTailscaleSetupDependencies,
): ResolvedCommand {
  const installAttempt = installTailscaleForPlatform({ interactive: false }, dependencies);
  const resolvedCommand = resolveTailscaleCommand(dependencies);
  if (resolvedCommand) {
    return resolvedCommand;
  }

  throw new Error(buildTailscaleInstallError(installAttempt));
}

export function resolveTailscaleCommand(
  dependencies: TailscaleSetupDependencies = defaultTailscaleSetupDependencies,
): ResolvedCommand | null {
  return tailscaleCandidates().find(command => commandExistsWithArgs(command, ['version'], dependencies)) ?? null;
}

export async function resolveTailscaleCommandAsync(
  run: RemoteSetupCommandRunner = runRemoteSetupCommand,
): Promise<ResolvedCommand | null> {
  for (const command of tailscaleCandidates()) {
    if ((await run(command.command, ['version'], { env: command.env })).ok) return command;
  }
  return null;
}

export function ensureTailscaleInstalledInteractive(
  dependencies: TailscaleSetupDependencies = defaultTailscaleSetupDependencies,
): ResolvedCommand {
  const existingCommand = resolveTailscaleCommand(dependencies);
  if (existingCommand) {
    return existingCommand;
  }

  const installAttempt = installTailscaleForPlatform({ interactive: true }, dependencies);
  const resolvedCommand = resolveTailscaleCommand(dependencies);
  if (resolvedCommand) {
    return resolvedCommand;
  }

  throw new Error(buildTailscaleInstallError(installAttempt));
}

export function runTailscaleUpInteractive(
  command: ResolvedCommand,
  dependencies: TailscaleSetupDependencies = defaultTailscaleSetupDependencies,
): void {
  const isLinux = process.platform === 'linux';
  const executable = isLinux ? 'sudo' : command.command;
  const args = isLinux ? [command.command, 'up'] : ['up'];
  const result = dependencies.spawnSync(executable, args, {
    stdio: 'inherit',
    env: command.env ?? process.env,
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.signal) {
    throw new Error(`Tailscale authentication stopped with signal ${result.signal}`);
  }

  if (result.status !== null && result.status !== 0) {
    throw new Error(`Tailscale authentication exited with code ${result.status}`);
  }
}

export function runTailscaleServeInteractive(
  command: ResolvedCommand,
  port: number,
  dependencies: TailscaleSetupDependencies = defaultTailscaleSetupDependencies,
): CommandResult {
  const args = ['serve', '--bg', '--tls-terminated-tcp=443', String(port)];
  let serve = runCommand(command, args, {}, dependencies);
  if (serve.ok) {
    return serve;
  }

  let output = firstNonEmpty(serve.stderr, serve.stdout, 'unknown error');
  if (isTailscaleServeDisabled(output) && waitForTailscaleServeEnablement(output)) {
    serve = runCommand(command, args, {}, dependencies);
    if (serve.ok) {
      return serve;
    }
    output = firstNonEmpty(serve.stderr, serve.stdout, 'unknown error');
  }

  if (process.platform === 'linux' && isTailscaleServePermissionDenied(output)) {
    console.log('Pane remote setup: Tailscale Serve needs elevated permission; running sudo tailscale serve...');
    const sudoServe = runCommandInteractive('sudo', [command.command, ...args], { timeoutMs: 300000 }, dependencies);
    if (sudoServe.ok) {
      return sudoServe;
    }
    return {
      ok: false,
      stdout: sudoServe.stdout,
      stderr: firstNonEmpty(sudoServe.stderr, output),
    };
  }

  return serve;
}

export function runCommand(
  command: string | ResolvedCommand,
  args: string[],
  options: { timeoutMs?: number } = {},
  dependencies: TailscaleSetupDependencies = defaultTailscaleSetupDependencies,
): CommandResult {
  const resolved = command instanceof Object
    ? { command: command.command, env: command.env ?? process.env }
    : { command, env: process.env };
  const result = dependencies.spawnSync(resolved.command, args, {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 30000,
    env: resolved.env,
  } satisfies SpawnSyncOptionsWithStringEncoding);

  return {
    ok: !result.error && result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? result.error.message : ''),
  };
}

function runCommandInteractive(
  command: string | ResolvedCommand,
  args: string[],
  options: { timeoutMs?: number } = {},
  dependencies: TailscaleSetupDependencies = defaultTailscaleSetupDependencies,
): CommandResult {
  const resolved = command instanceof Object
    ? { command: command.command, env: command.env ?? process.env }
    : { command, env: process.env };
  const result = dependencies.spawnSync(resolved.command, args, {
    stdio: 'inherit',
    timeout: options.timeoutMs ?? 30000,
    env: resolved.env,
  });

  return {
    ok: !result.error && result.status === 0,
    stdout: '',
    stderr: result.error ? result.error.message : '',
  };
}

function runShellCommand(
  command: string,
  options: { timeoutMs?: number } = {},
  dependencies: TailscaleSetupDependencies = defaultTailscaleSetupDependencies,
): CommandResult {
  const result = dependencies.spawnSync(command, {
    encoding: 'utf8',
    shell: true,
    timeout: options.timeoutMs ?? 30000,
  });

  return {
    ok: !result.error && result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? result.error.message : ''),
  };
}

function runShellCommandInteractive(
  command: string,
  options: { timeoutMs?: number } = {},
  dependencies: TailscaleSetupDependencies = defaultTailscaleSetupDependencies,
): CommandResult {
  const result = dependencies.spawnSync(command, {
    shell: true,
    stdio: 'inherit',
    timeout: options.timeoutMs ?? 30000,
  });

  return {
    ok: !result.error && result.status === 0,
    stdout: '',
    stderr: result.error ? result.error.message : '',
  };
}

export function getTailscaleSetupInstructions(): string {
  switch (process.platform) {
    case 'darwin':
      return 'Pane installs Tailscale on macOS with "brew install --cask tailscale" when Homebrew is available. Open Tailscale, sign in, then run setup again.';
    case 'win32':
      return 'Pane installs Tailscale on Windows with "winget install --id Tailscale.Tailscale --exact". Open Tailscale, sign in, then run setup again.';
    case 'linux':
      if (isWsl()) {
        return 'Pane installs Tailscale inside WSL with the official install script when curl is available. Run "sudo tailscale up" in the distro, then run setup again.';
      }
      return 'Pane installs Tailscale on Linux with "curl -fsSL https://tailscale.com/install.sh | sh" when curl is available. Run "sudo tailscale up", then run setup again.';
    default:
      return 'Install Tailscale from https://tailscale.com/download, sign in, then run setup again.';
  }
}

export function getTailscaleServeSetupInstructions(port?: number): string {
  const target = port ? ` --tls-terminated-tcp=443 ${port}` : '';
  if (process.platform === 'linux') {
    return [
      'Tailscale is installed and authenticated, but Pane could not configure Tailscale Serve.',
      `If Serve is disabled, enable it from the Tailscale URL above and run setup again.`,
      `If Serve needs elevated permission, run "sudo tailscale serve --bg${target}".`,
      'To avoid sudo for future Serve changes, run "sudo tailscale set --operator=$USER" once.',
    ].join(' ');
  }

  return [
    'Tailscale is installed and authenticated, but Pane could not configure Tailscale Serve.',
    'If Serve is disabled, enable it from the Tailscale URL above and run setup again.',
  ].join(' ');
}

function tailscaleCandidates(): ResolvedCommand[] {
  const commands: ResolvedCommand[] = [{ command: 'tailscale', displayCommand: 'tailscale' }];
  if (process.platform === 'darwin') {
    for (const candidate of [
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      path.join(os.homedir(), 'Applications', 'Tailscale.app', 'Contents', 'MacOS', 'Tailscale'),
    ]) {
      if (existsSync(candidate)) commands.push({
        command: candidate,
        displayCommand: `TAILSCALE_BE_CLI=1 ${quoteForPosix(candidate)}`,
        env: { ...process.env, TAILSCALE_BE_CLI: '1' },
      });
    }
  }
  if (process.platform === 'win32') {
    for (const directory of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
      if (!directory) continue;
      const candidate = path.join(directory, 'Tailscale', 'tailscale.exe');
      if (existsSync(candidate)) commands.push({ command: candidate, displayCommand: quoteForWindows(candidate) });
    }
  }
  return commands;
}

function installTailscaleForPlatform(
  options: { interactive: boolean },
  dependencies: TailscaleSetupDependencies,
): InstallAttempt {
  if (process.platform === 'darwin') {
    return installTailscaleWithBrew(options, dependencies);
  }

  if (process.platform === 'win32') {
    return installTailscaleWithWinget(options, dependencies);
  }

  if (process.platform === 'linux') {
    return installTailscaleWithOfficialScript(options, dependencies);
  }

  return {
    attempted: false,
    command: '',
    stdout: '',
    stderr: '',
    reason: `Automatic Tailscale installation is not configured for ${process.platform}.`,
  };
}

function installTailscaleWithBrew(
  options: { interactive: boolean },
  dependencies: TailscaleSetupDependencies,
): InstallAttempt {
  const brewCommand = resolveBrewCommand(dependencies);
  const command = `${brewCommand?.displayCommand ?? 'brew'} install --cask tailscale`;
  if (!brewCommand) {
    return {
      attempted: false,
      command,
      stdout: '',
      stderr: '',
      reason: 'Homebrew was not found.',
    };
  }

  const install = options.interactive
    ? runCommandInteractive(brewCommand, ['install', '--cask', 'tailscale'], { timeoutMs: 300000 }, dependencies)
    : runCommand(brewCommand, ['install', '--cask', 'tailscale'], { timeoutMs: 300000 }, dependencies);
  if (install.ok) {
    runCommand('open', ['-a', 'Tailscale'], { timeoutMs: 30000 }, dependencies);
  }

  return {
    attempted: true,
    command,
    stdout: install.stdout,
    stderr: install.stderr,
  };
}

function resolveBrewCommand(dependencies: TailscaleSetupDependencies): ResolvedCommand | null {
  if (commandExists('brew', dependencies)) {
    return {
      command: 'brew',
      displayCommand: 'brew',
    };
  }

  for (const candidate of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) {
    if (!existsSync(candidate)) {
      continue;
    }

    const command = {
      command: candidate,
      displayCommand: quoteForPosix(candidate),
    };
    if (commandExistsWithArgs(command, ['--version'], dependencies)) {
      return command;
    }
  }

  return null;
}

function installTailscaleWithWinget(
  options: { interactive: boolean },
  dependencies: TailscaleSetupDependencies,
): InstallAttempt {
  const command = 'winget install --id Tailscale.Tailscale --exact --accept-package-agreements --accept-source-agreements';
  if (!commandExists('winget', dependencies)) {
    return {
      attempted: false,
      command,
      stdout: '',
      stderr: '',
      reason: 'winget was not found.',
    };
  }

  const args = [
    'install',
    '--id',
    'Tailscale.Tailscale',
    '--exact',
    '--accept-package-agreements',
    '--accept-source-agreements',
  ];
  const install = options.interactive
    ? runCommandInteractive('winget', args, { timeoutMs: 300000 }, dependencies)
    : runCommand('winget', args, { timeoutMs: 300000 }, dependencies);

  return {
    attempted: true,
    command,
    stdout: install.stdout,
    stderr: install.stderr,
  };
}

function installTailscaleWithOfficialScript(
  options: { interactive: boolean },
  dependencies: TailscaleSetupDependencies,
): InstallAttempt {
  const command = 'curl -fsSL https://tailscale.com/install.sh | sh';
  if (!commandExists('curl', dependencies)) {
    return {
      attempted: false,
      command,
      stdout: '',
      stderr: '',
      reason: 'curl was not found.',
    };
  }

  const install = options.interactive
    ? runShellCommandInteractive(command, { timeoutMs: 300000 }, dependencies)
    : runShellCommand(command, { timeoutMs: 300000 }, dependencies);
  return {
    attempted: true,
    command,
    stdout: install.stdout,
    stderr: install.stderr,
  };
}

function buildTailscaleInstallError(installAttempt: InstallAttempt): string {
  const lines = [
    'Tailscale is required for cross-device remote setup, but Pane could not find the tailscale CLI after attempting setup.',
  ];

  if (installAttempt.command) {
    lines.push(`Install command: ${installAttempt.command}`);
  }
  if (installAttempt.reason) {
    lines.push(`Reason: ${installAttempt.reason}`);
  }
  if (installAttempt.attempted) {
    lines.push(`Install stdout: ${firstNonEmpty(installAttempt.stdout, '(empty)')}`);
    lines.push(`Install stderr: ${firstNonEmpty(installAttempt.stderr, '(empty)')}`);
  }

  lines.push('');
  lines.push(getTailscaleSetupInstructions());
  return lines.join('\n');
}

function isTailscaleServeDisabled(output: string): boolean {
  return output.toLowerCase().includes('serve is not enabled on your tailnet');
}

function isTailscaleServePermissionDenied(output: string): boolean {
  const normalized = output.toLowerCase();
  return normalized.includes('serve config denied')
    || normalized.includes('access denied');
}

function waitForTailscaleServeEnablement(output: string): boolean {
  console.error(`Tailscale Serve setup needs one-time tailnet enablement:\n${output.trim()}`);
  if (!process.stdin.isTTY) {
    return false;
  }

  process.stdout.write('\nEnable Tailscale Serve in the opened page, then press Enter to continue...');
  const buffer = Buffer.alloc(1);
  while (true) {
    try {
      const bytesRead = readSync(0, buffer, 0, 1, null);
      if (bytesRead === 0 || buffer[0] === 10 || buffer[0] === 13) {
        process.stdout.write('\n');
        return true;
      }
    } catch {
      process.stdout.write('\n');
      return false;
    }
  }
}

function commandExists(command: string, dependencies: TailscaleSetupDependencies): boolean {
  return commandExistsWithArgs(command, ['--version'], dependencies);
}

function commandExistsWithArgs(
  command: string | ResolvedCommand,
  args: string[],
  dependencies: TailscaleSetupDependencies,
): boolean {
  const result = runCommand(command, args, {}, dependencies);
  return result.ok;
}

function isWsl(): boolean {
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

function firstNonEmpty(...values: string[]): string {
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return '';
}

function quoteForPosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quoteForWindows(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}
