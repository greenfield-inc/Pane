import { assertUpdateCapacity } from './updateCapacity';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { boundary, decodeBoundary } from './boundaryDecoder';
import { invokeDaemon, resolvePaneDirectory } from './daemonClient';
import { RunpaneError } from './errors';
import { getWrapperVersion } from './version';
import { identifyPythonCli } from './updatePython';
import { findNpm, runNpm } from './updatePackage';
import { checkUpdateSupervisor } from './updateSupervisor';
import { assertSupportedNodeRuntime } from './nodeRuntime';
import type { ParsedArgs } from './commands';

export const updateHostSchema = boundary.object({
  protocol: boundary.literal(1),
  machine: boundary.nonEmptyString,
  bootId: boundary.nonEmptyString,
  pid: boundary.number,
  executable: boundary.nonEmptyString,
  version: boundary.nonEmptyString,
  paneDir: boundary.nonEmptyString,
  userData: boundary.nonEmptyString,
  packaged: boundary.boolean,
  remoteEnabled: boundary.boolean,
  remoteHealthy: boundary.boolean,
  endpointFingerprint: boundary.nonEmptyString,
  active: boundary.number,
  idle: boundary.number,
  blocked: boundary.number,
});
export type UpdateHost = ReturnType<typeof updateHostSchema.decode>;

interface UpdateCliInstallation {
  owner: 'managed' | 'npm' | 'pip';
  pipUser?: boolean;
  entrypoint: string;
  version: string;
  prefix: string;
  packageManager?: string;
}

export interface UpdatePreflight {
  machine: string;
  paneDir: string;
  scope: 'both' | 'pane' | 'cli';
  requestedVersion: string;
  host: UpdateHost | null;
  cli: UpdateCliInstallation | null;
  runtimeSource: string;
  npmSource?: string;
  lockDirectory: string;
  additionalLockDirectories: string[];
  limitations: string[];
  disableOsIntegration?: boolean;
}

function fail(message: string, next: string): never {
  throw new RunpaneError('ERR_UPDATE_PREFLIGHT', `${message} Nothing was changed.`, next);
}

/** Exercise directory ACLs too: fs.access(W_OK) does not check Windows ACLs. */
export function assertUpdateDirectoryWritable(directory: string): void {
  let probe: string | undefined;
  try {
    probe = fs.mkdtempSync(path.join(directory, '.pane-update-preflight-'));
    const file = path.join(probe, 'write');
    fs.writeFileSync(file, 'update preflight', { flag: 'wx', mode: 0o600 });
    fs.renameSync(file, path.join(probe, 'renamed'));
    fs.rmSync(probe, { recursive: true });
    probe = undefined;
  } catch {
    fail(`The update target is not writable with the current account: ${directory}.`, 'Use the installation’s owning account or package manager; Pane has not been stopped.');
  } finally {
    if (probe) fs.rmSync(probe, { recursive: true, force: true });
  }
}

/** Resolve the invoked CLI, not another runpane earlier/later on PATH. */
function identifyUpdateCli(paneDir: string, entrypoint = process.argv[1]): UpdateCliInstallation {
  const real = fs.realpathSync(entrypoint);
  const managed = fs.existsSync(path.join(paneDir, 'bin')) ? fs.realpathSync(path.join(paneDir, 'bin')) : path.join(paneDir, 'bin');
  if (real === path.join(managed, 'runpane.cjs') || real.startsWith(`${path.join(managed, 'cli')}${path.sep}`)) {
    const shim = path.join(managed, process.platform === 'win32' ? 'runpane.cmd' : 'runpane');
    if (!fs.readFileSync(shim, 'utf8').includes('pane-managed-runpane-shim v1')) fail('The active CLI is not a Pane-owned shim.', 'Use its owning package manager.');
    fs.accessSync(managed, fs.constants.W_OK);
    return { owner: 'managed', entrypoint: real, version: getWrapperVersion(), prefix: managed };
  }
  const root = path.resolve(path.dirname(real), '..');
  const pkg = decodeBoundary(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')), boundary.object({ name: boundary.string, version: boundary.string }));
  if (pkg.name !== 'runpane') fail('The active CLI package is not runpane.', 'Use the supported runpane installation.');
  const npmRoot = findNpm(process.execPath);
  const prefix = runNpm(process.execPath, npmRoot, ['prefix', '--global']).trim();
  const expected = path.join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules', 'runpane');
  if (!fs.existsSync(expected) || fs.realpathSync(expected) !== root) fail('The invoked CLI is a local, cached, or unsupported package installation.', 'Update that installation with its owning package manager, or invoke the supported global/Pane-managed CLI.');
  fs.accessSync(root, fs.constants.W_OK);
  fs.accessSync(path.dirname(root), fs.constants.W_OK);
  return { owner: 'npm', entrypoint: real, version: pkg.version, prefix, packageManager: npmRoot };
}

function findUpdateRuntime(): string {
  if (!process.versions.electron) return process.execPath;
  const candidates = (process.env.PATH ?? '').split(path.delimiter).map(directory => path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node'));
  const node = candidates.find(file => fs.existsSync(file) && fs.realpathSync(file) !== fs.realpathSync(process.execPath));
  if (!node) fail('No independent Node runtime is available; the managed CLI is running inside Electron.', 'Install standalone patched Node 22.23.4+ (22.x), 24.22.1+ (24.x), or 26.12.1+ (26.x), then retry.');
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  assertSupportedNodeRuntime(execFileSync(node, ['-p', 'process.versions.node'], { encoding: 'utf8', env: environment, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim());
  return node;
}

/** Refuse options the independent update cannot honor; these are the caller's to fix, so no fallback applies. */
export function assertUpdateOptions(parsed: ParsedArgs): void {
  if (parsed.channel !== 'stable' || parsed.target !== 'client' || parsed.downloadDir || (parsed.format !== 'auto' && parsed.format !== (process.platform === 'darwin' ? 'zip' : process.platform === 'win32' ? 'exe' : 'appimage'))) fail('These installer options are not supported by independent updates.', 'Use the stable client release with automatic format and operation-owned staging, or use runpane install for other installer options.');
  if (!/^(?:latest|v?\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)$/.test(parsed.paneVersion)) fail('The requested version is invalid.', 'Use --version latest or a released version such as 2.4.182.');
}

/** Callers run assertUpdateOptions first: option errors never fall back to the in-app updater. */
export async function preflightUpdate(parsed: ParsedArgs, scope: UpdatePreflight['scope']): Promise<UpdatePreflight> {
  const runtimeSource = findUpdateRuntime();
  const paneDir = path.resolve(resolvePaneDirectory(parsed.paneDir));
  const cli = scope === 'pane' ? null : process.env.PANE_UPDATE_PYTHON && process.env.PANE_UPDATE_PYTHON_ENTRYPOINT
    ? identifyPythonCli(process.env.PANE_UPDATE_PYTHON, process.env.PANE_UPDATE_PYTHON_ENTRYPOINT) : identifyUpdateCli(paneDir);
  let host: UpdateHost | null = null;
  if (scope !== 'cli') {
    host = await invokeDaemon('runpane:update:host', [], updateHostSchema, { paneDir, timeoutMs: 10_000 });
    if (path.resolve(host.paneDir) !== paneDir || host.machine !== os.hostname()) fail('The daemon identity does not match this command’s local target.', 'Run update on the owning machine with its explicit --pane-dir.');
    if (!host.packaged) fail('This Pane is a development build, not a supported installed application.', 'Use the packaged installation, or the isolated update test harness.');
    if (parsed.panePath && fs.realpathSync(parsed.panePath) !== fs.realpathSync(host.executable)) fail('--pane-path does not identify the running Pane.', 'Use the executable shown by this host’s update preflight.');
    fs.accessSync(host.executable, fs.constants.W_OK);
  }
  if (process.platform === 'linux' && host && !host.executable.toLowerCase().endsWith('.appimage')) fail('This Linux installation is not an owned AppImage.', 'Update the system package using its owning package manager.');
  checkUpdateSupervisor();
  const install = host ? (process.platform === 'darwin' ? path.resolve(host.executable, '../../..') : process.platform === 'linux' ? host.executable : path.dirname(host.executable)) : cli!.prefix;
  fs.accessSync(host ? path.dirname(install) : install, fs.constants.W_OK);
  fs.mkdirSync(path.join(paneDir, 'updates'), { recursive: true, mode: 0o700 });
  const writableDirectories = new Set([
    paneDir,
    ...(host ? [path.dirname(install), ...(process.platform === 'win32' ? [install] : [])] : []),
    ...(cli ? [cli.prefix, path.dirname(cli.entrypoint)] : []),
  ]);
  for (const directory of writableDirectories) assertUpdateDirectoryWritable(directory);
  assertUpdateCapacity(paneDir, host, install, cli?.prefix);
  return {
    machine: os.hostname(), paneDir, scope, requestedVersion: parsed.paneVersion, host, cli,
    runtimeSource, npmSource: cli && cli.owner !== 'pip' ? findNpm(runtimeSource) : undefined, lockDirectory: path.join(paneDir, 'updates', '.operation-lock'),
    additionalLockDirectories: [...(host ? [path.join(path.dirname(install), `.${path.basename(install)}.update-lock`)] : []), ...(cli ? [path.join(cli.prefix, '.runpane-update-lock')] : [])],
    disableOsIntegration: process.env.PANE_DISABLE_OS_INTEGRATION === '1',
    limitations: ['Requires the current interactive login. Logout/reboot recovery must be inspected through the durable operation status.', 'Agent turns with uncertain delivery are never replayed.'],
  };
}
