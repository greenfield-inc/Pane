import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { boundary, decodeBoundary } from './boundaryDecoder';
import { resolvePaneDirectory } from './daemonClient';
import { findNpm, runNpm } from './updatePackage';
import { findUpdateRuntime } from './updatePreflight';
import { getWrapperVersion } from './version';

/** Written by Pane into every `runpane` shim it owns (main/src/services/runpaneShim.ts). */
const MANAGED_SHIM_MARKER = 'pane-managed-runpane-shim v1';
/** Line main/build-runpane-cli.js puts at the top of the bundled CLI. */
const BUNDLE_VERSION_PATTERN = /^\/\/ runpane-version (\S+)$/m;
/** Set on a handed-off child, and by anyone who wants this exact CLI to run. */
const NO_HANDOFF_ENV = 'RUNPANE_NO_HANDOFF';

interface ManagedCli {
  version: string;
  binDir: string;
  /** The POSIX shim; Pane writes it on every platform. */
  shim: string;
  /** What the Windows shim runs, without going through cmd.exe. */
  runtime?: string;
  entrypoint: string;
}

interface RunpaneInstall {
  path: string;
  origin: 'pane' | 'npm' | 'other';
  version?: string;
  /** npm installs only: the prefix `npm i -g --prefix` takes. */
  npmPrefix?: string;
}

/**
 * The CLI Pane keeps current in a bin directory: a `runpane update` pin
 * (runpane-override.json) or the CLI bundled with the Pane build.
 */
function readManagedCli(binDir: string): ManagedCli | null {
  const shim = path.join(binDir, 'runpane');
  if (!isManagedShim(shim)) return null;
  try {
    const override = path.join(binDir, 'runpane-override.json');
    if (fs.existsSync(override)) {
      const pin = decodeBoundary(JSON.parse(fs.readFileSync(override, 'utf8')), boundary.object({
        version: boundary.nonEmptyString,
        entrypoint: boundary.nonEmptyString,
        runtime: boundary.nonEmptyString,
      }));
      return { version: pin.version, binDir, shim, runtime: pin.runtime, entrypoint: pin.entrypoint };
    }
    const entrypoint = path.join(binDir, 'runpane.cjs');
    const version = readHead(entrypoint).match(BUNDLE_VERSION_PATTERN)?.[1];
    return version ? { version, binDir, shim, entrypoint } : null;
  } catch {
    return null;
  }
}

/**
 * The Pane data directory's CLI. Without an explicit PANE_DIR, falls back to
 * the first Pane-managed one on PATH, which is how WSL reaches Windows Pane's.
 */
function findManagedCli(paneDir?: string): ManagedCli | null {
  const own = readManagedCli(path.join(resolvePaneDirectory(paneDir), 'bin'));
  if (own || paneDir || process.env.PANE_DIR || process.env.FOOZOL_DIR) return own;
  return pathDirectories().map(readManagedCli).find(cli => cli !== null) ?? null;
}

/**
 * When the Pane-managed CLI is newer than this one, run the whole invocation
 * there and return its exit code. Null means this CLI should run it.
 */
export function handOffToManagedCli(argv: string[]): number | null {
  if (process.env[NO_HANDOFF_ENV]) return null;
  const managed = findManagedCli();
  if (!managed || compareVersions(managed.version, getWrapperVersion()) <= 0) return null;
  const env = { ...process.env, [NO_HANDOFF_ENV]: '1' };
  const result = process.platform === 'win32'
    ? spawnSync(managed.runtime ?? process.execPath, [managed.entrypoint, ...argv], {
      stdio: 'inherit',
      env: { PANE_DIR: path.dirname(managed.binDir), ...env },
    })
    : spawnSync('/bin/sh', [managed.shim, ...argv], { stdio: 'inherit', env });
  if (result.error) return null;
  if (result.signal) process.kill(process.pid, result.signal);
  return result.status ?? 1;
}

/** Every `runpane` on PATH, in the order a shell resolves them. */
function listRunpaneInstalls(): RunpaneInstall[] {
  const names = process.platform === 'win32' ? ['runpane.cmd', 'runpane.exe', 'runpane'] : ['runpane'];
  const seen = new Set<string>();
  const installs: RunpaneInstall[] = [];
  for (const directory of pathDirectories()) {
    const file = names.map(name => path.join(directory, name)).find(isFile);
    if (!file) continue;
    const real = realpath(file);
    if (seen.has(real)) continue;
    seen.add(real);
    installs.push(describeInstall(file, real));
  }
  return installs;
}

interface CliInstallWarning {
  code: 'RUNPANE_STALE_INSTALL' | 'RUNPANE_STALE_UNMANAGED' | 'RUNPANE_MANAGED_BEHIND';
  path: string;
  message: string;
  /** The command that resolves it. `doctor --fix` runs it only for RUNPANE_STALE_INSTALL. */
  fix: string;
}

interface CliFixResult {
  command: string;
  ok: boolean;
  error?: string;
}

export interface CliInstallsCheck {
  /** The Pane-managed CLI's version; absent when Pane has none. */
  managedVersion?: string;
  installs: RunpaneInstall[];
  warnings: CliInstallWarning[];
  fixed?: CliFixResult[];
}

/** Compare every runpane on PATH with the Pane-managed CLI. */
export function checkCliInstalls(paneDir?: string): CliInstallsCheck {
  const installs = listRunpaneInstalls();
  const managed = findManagedCli(paneDir);
  if (!managed) return { installs, warnings: [] };
  const managedVersion = managed.version;
  const firstPane = installs.findIndex(install => install.origin === 'pane');
  const warnings: CliInstallWarning[] = [];
  installs.forEach((install, index) => {
    const order = index === 0 ? ', and it runs first on PATH' : '';
    const older = install.version !== undefined && compareVersions(install.version, managedVersion) < 0;
    if (install.origin === 'npm' && install.npmPrefix && older) {
      warnings.push({
        code: 'RUNPANE_STALE_INSTALL',
        path: install.path,
        message: `npm runpane ${install.version} at ${install.path} is older than Pane's CLI ${managedVersion}${order}.`,
        fix: `npm i -g --prefix ${quoteArgument(install.npmPrefix)} runpane@${managedVersion}`,
      });
    } else if (install.origin === 'npm' && install.version && compareVersions(install.version, managedVersion) > 0) {
      warnings.push({
        code: 'RUNPANE_MANAGED_BEHIND',
        path: install.path,
        message: `Pane's CLI ${managedVersion} is older than npm runpane ${install.version} at ${install.path}.`,
        fix: 'runpane update',
      });
    } else if (install.origin === 'other' && (older || install.version === undefined) && (firstPane === -1 || index < firstPane)) {
      warnings.push({
        code: 'RUNPANE_STALE_UNMANAGED',
        path: install.path,
        message: `runpane ${install.version ?? 'of unknown version'} at ${install.path} runs before Pane's CLI ${managedVersion}${order}. Neither npm nor Pane installed it, so doctor --fix leaves it alone.`,
        fix: process.platform === 'win32' ? `del ${quoteArgument(install.path)}` : `rm ${quoteArgument(install.path)}`,
      });
    }
  });
  return { managedVersion, installs, warnings };
}

/** Update each stale npm install to the managed version, then check again. Never removes a file. */
export function fixCliInstalls(check: CliInstallsCheck, paneDir?: string): CliInstallsCheck {
  const stale = check.warnings.filter(warning => warning.code === 'RUNPANE_STALE_INSTALL');
  if (stale.length === 0 || !check.managedVersion) return check;
  const fixed: CliFixResult[] = [];
  for (const warning of stale) {
    const prefix = check.installs.find(install => install.path === warning.path)?.npmPrefix;
    if (!prefix) continue;
    try {
      const runtime = findUpdateRuntime();
      runNpm(runtime, findNpm(runtime), ['install', '-g', '--prefix', prefix, `runpane@${check.managedVersion}`]);
      fixed.push({ command: warning.fix, ok: true });
    } catch (error) {
      fixed.push({ command: warning.fix, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ...checkCliInstalls(paneDir), fixed };
}

function quoteArgument(value: string): string {
  if (/^[\w@%+=:,./\\-]+$/.test(value)) return value;
  return process.platform === 'win32' ? `"${value}"` : `'${value.replace(/'/g, `'\\''`)}'`;
}

function describeInstall(file: string, real: string): RunpaneInstall {
  const directory = path.dirname(file);
  if (isManagedShim(path.join(directory, 'runpane'))) {
    return { path: file, origin: 'pane', version: readManagedCli(directory)?.version };
  }
  // npm links <prefix>/bin/runpane to the package on POSIX and writes a
  // runpane.cmd beside <prefix>/node_modules on Windows.
  const roots = [
    ...(real.endsWith(path.join('dist', 'cli.js')) ? [path.resolve(real, '..', '..')] : []),
    path.join(directory, 'node_modules', 'runpane'),
  ];
  for (const root of roots) {
    const version = readRunpanePackageVersion(root);
    if (!version) continue;
    const modules = path.dirname(root);
    const prefix = path.basename(modules) !== 'node_modules' ? undefined
      : path.basename(path.dirname(modules)) === 'lib' ? path.resolve(modules, '..', '..')
        : process.platform === 'win32' ? path.dirname(modules) : undefined;
    return prefix ? { path: file, origin: 'npm', version, npmPrefix: prefix } : { path: file, origin: 'other', version };
  }
  return { path: file, origin: 'other' };
}

/** Numeric `major.minor.patch` order; prerelease tags are ignored, and unparsable versions compare equal. */
function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  const [a, b] = [parse(left), parse(right)];
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function pathDirectories(): string[] {
  const value = process.env.PATH ?? process.env.Path ?? '';
  return [...new Set(value.split(path.delimiter).filter(entry => entry && path.isAbsolute(entry)))];
}

function readRunpanePackageVersion(root: string): string | undefined {
  try {
    const pkg = decodeBoundary(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')), boundary.object({
      name: boundary.string,
      version: boundary.string,
    }));
    return pkg.name === 'runpane' ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

function isManagedShim(file: string): boolean {
  try {
    return !fs.lstatSync(file).isSymbolicLink() && readHead(file).includes(MANAGED_SHIM_MARKER);
  } catch {
    return false;
  }
}

function readHead(file: string): string {
  const descriptor = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(512);
    return buffer.toString('utf8', 0, fs.readSync(descriptor, buffer, 0, buffer.length, 0));
  } finally {
    fs.closeSync(descriptor);
  }
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function realpath(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}
