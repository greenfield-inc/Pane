import childProcess from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ArtifactFormat, InstallTarget, ParsedArgs } from './commands';
import type { DownloadedArtifact } from './download';
import { defaultInstallRoot, type PanePlatform } from './platform';

export interface InstalledPane {
  executablePath: string;
  installKind: 'existing' | 'installed' | 'launched-installer';
}

export function resolveExistingPanePath(panePath?: string): string | undefined {
  if (panePath) {
    return fs.existsSync(panePath) ? panePath : undefined;
  }

  const candidates = [
    process.platform === 'darwin' ? '/Applications/Pane.app/Contents/MacOS/Pane' : undefined,
    process.platform === 'darwin' ? path.join(os.homedir(), 'Applications', 'Pane.app', 'Contents', 'MacOS', 'Pane') : undefined,
    process.platform === 'linux' ? path.join(os.homedir(), '.local', 'bin', 'pane') : undefined,
    process.platform === 'linux' ? '/usr/bin/pane' : undefined,
    process.platform === 'linux' ? '/opt/Pane/pane' : undefined,
    process.platform === 'linux' ? '/opt/Pane/Pane' : undefined,
    process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Pane', 'Pane.exe') : undefined,
    process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Pane', 'Pane.exe') : undefined,
    process.platform === 'win32' && process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Pane', 'Pane.exe') : undefined
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => fs.existsSync(candidate));
}

export function shouldReuseExistingPane(parsed: Pick<ParsedArgs, 'command'>, target: InstallTarget): boolean {
  return parsed.command === 'install' && target === 'daemon';
}

export async function installPaneArtifact(
  artifact: DownloadedArtifact,
  options: {
    parsed: ParsedArgs;
    platform: PanePlatform;
    format: Exclude<ArtifactFormat, 'auto'>;
    target: InstallTarget;
  }
): Promise<InstalledPane> {
  const existing = resolveExistingPanePath(options.parsed.panePath);
  if (existing && shouldReuseExistingPane(options.parsed, options.target)) {
    return { executablePath: existing, installKind: 'existing' };
  }

  if (options.platform.os === 'darwin') {
    return installMac(artifact, options);
  }
  if (options.platform.os === 'linux') {
    return installLinux(artifact, options);
  }
  return installWindows(artifact, options);
}

export function spawnPane(executablePath: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = childProcess.spawn(executablePath, buildPaneDaemonArgs(args), {
      stdio: 'inherit',
      shell: false,
      env: buildPaneDaemonEnvironment()
    });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (error) => {
      console.error(`Failed to launch Pane: ${error.message}`);
      resolve(1);
    });
  });
}

export interface CapturedPaneResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function spawnPaneCaptured(executablePath: string, args: string[]): Promise<CapturedPaneResult> {
  return new Promise((resolve) => {
    const child = childProcess.spawn(executablePath, buildPaneDaemonArgs(args), {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env: buildPaneDaemonEnvironment()
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on('error', (error) => resolve({ code: 1, stdout, stderr: `${stderr}${error.message}` }));
  });
}

// Ozone resolves its platform before the app's main script runs, so headless
// selection must arrive as argv. ELECTRON_OZONE_PLATFORM_HINT (below) was
// removed in Electron 38 and is a no-op from 39 on; it is kept only so older
// Pane builds keep working.
export function buildPaneDaemonArgs(args: string[], platform = process.platform): string[] {
  if (platform !== 'linux') {
    return [...args];
  }

  return ['--ozone-platform=headless', '--disable-gpu', ...args];
}

export function buildPaneDaemonEnvironment(
  platform = process.platform,
  baseEnvironment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  if (platform !== 'linux') {
    return { ...baseEnvironment };
  }

  return {
    ...baseEnvironment,
    ELECTRON_OZONE_PLATFORM_HINT: 'headless'
  };
}

export function launchPaneClient(executablePath: string): void {
  const child = childProcess.spawn(executablePath, [], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
}

function installMac(
  artifact: DownloadedArtifact,
  { format, target }: { format: Exclude<ArtifactFormat, 'auto'>; target: InstallTarget }
): InstalledPane {
  if (format === 'dmg') {
    childProcess.spawnSync('open', [artifact.path], { stdio: 'inherit' });
    return { executablePath: '/Applications/Pane.app/Contents/MacOS/Pane', installKind: 'launched-installer' };
  }

  const appsRoot = path.join(os.homedir(), 'Applications');
  const appPath = path.join(appsRoot, 'Pane.app');
  fs.mkdirSync(appsRoot, { recursive: true });
  childProcess.execFileSync('ditto', ['-x', '-k', artifact.path, appsRoot], { stdio: 'inherit' });
  const executablePath = path.join(appPath, 'Contents', 'MacOS', 'Pane');

  if (!fs.existsSync(executablePath)) {
    throw new Error(`Pane executable was not found after extracting ${artifact.fileName}. Expected ${executablePath}`);
  }

  if (target === 'client') {
    childProcess.spawnSync('open', [appPath], { stdio: 'inherit' });
  }

  return { executablePath, installKind: 'installed' };
}

function installLinux(
  artifact: DownloadedArtifact,
  { format }: { format: Exclude<ArtifactFormat, 'auto'> }
): InstalledPane {
  if (format === 'deb') {
    const installer = commandExists('apt') ? 'apt' : 'dpkg';
    const args = installer === 'apt' ? ['install', '-y', artifact.path] : ['-i', artifact.path];
    ensureInstallerSucceeded(childProcess.spawnSync('sudo', [installer, ...args], { stdio: 'inherit' }));
    const executablePath = resolveExistingPanePath();
    if (!executablePath) {
      throw new Error('Pane installed from .deb, but the pane executable could not be found.');
    }
    return { executablePath, installKind: 'installed' };
  }

  const binRoot = defaultInstallRoot();
  const executablePath = path.join(binRoot, 'pane');
  fs.mkdirSync(binRoot, { recursive: true });
  fs.copyFileSync(artifact.path, executablePath);
  fs.chmodSync(executablePath, 0o755);
  return { executablePath, installKind: 'installed' };
}

function installWindows(
  artifact: DownloadedArtifact,
  { target }: { target: InstallTarget }
): InstalledPane {
  const args = target === 'daemon' ? ['/S'] : [];
  const result = childProcess.spawnSync(artifact.path, args, { stdio: 'inherit' });
  ensureInstallerSucceeded(result);

  const executablePath = resolveExistingPanePath();
  if (!executablePath) {
    throw new Error('Pane installer completed, but Pane.exe could not be found. Open the installer manually and rerun with --pane-path.');
  }
  return { executablePath, installKind: target === 'daemon' ? 'installed' : 'launched-installer' };
}

function ensureInstallerSucceeded(result: childProcess.SpawnSyncReturns<Buffer>): void {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const reason = result.signal ? `signal ${result.signal}` : `status ${result.status}`;
    throw new Error(`Pane installer exited with ${reason}.`);
  }
}

function commandExists(command: string): boolean {
  const check = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [command] : ['-v', command];
  const result = childProcess.spawnSync(check, args, { stdio: 'ignore', shell: process.platform !== 'win32' });
  return result.status === 0;
}
