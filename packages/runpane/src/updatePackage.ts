import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { boundary, decodeBoundary } from './boundaryDecoder';
import { RunpaneError } from './errors';
import { writeUpdateJson } from './updateOperation';

/** Resolve npm's JS entry point so a Windows .cmd never needs shell evaluation. */
export function findNpm(runtime: string): string {
  const candidates = [
    path.join(path.dirname(runtime), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(runtime), '../lib/node_modules/npm/bin/npm-cli.js'),
    ...(process.env.PATH ?? '').split(path.delimiter).flatMap(directory => [
      path.join(directory, 'npm'), path.join(directory, 'node_modules/npm/bin/npm-cli.js'),
    ]),
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const real = fs.realpathSync(candidate);
    if (real.endsWith(`${path.sep}npm-cli.js`)) return real;
  }
  throw new RunpaneError('ERR_UPDATE_PACKAGE_MANAGER', 'npm could not be located. Nothing was changed.', 'Install standalone Node with npm, then retry.');
}

export function runNpm(runtime: string, npm: string, args: string[], cwd?: string): string {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return execFileSync(runtime, [npm, ...args], { encoding: 'utf8', cwd, env, timeout: 180_000, maxBuffer: 10 * 1024 * 1024 });
}

/** Copy all helper modules before either the app or the active CLI is replaced. */
export function stageUpdateCode(entrypoint: string, directory: string): string {
  const original = fs.realpathSync(entrypoint);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (original.endsWith('.cjs')) {
    const target = path.join(directory, 'runpane.cjs');
    fs.copyFileSync(original, target, fs.constants.COPYFILE_EXCL);
    return target;
  }
  const root = path.resolve(path.dirname(original), '..');
  const metadata = decodeBoundary(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')), boundary.object({ name: boundary.string }));
  if (metadata.name !== 'runpane' || path.basename(original) !== 'cli.js') {
    throw new RunpaneError('ERR_UPDATE_HELPER', 'The invoked helper is not a supported runpane package. Nothing was changed.', 'Use the installed runpane CLI.');
  }
  fs.cpSync(path.join(root, 'dist'), path.join(directory, 'dist'), { recursive: true, dereference: true, errorOnExist: true, force: false });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(directory, 'package.json'));
  return path.join(directory, 'dist', 'cli.js');
}

export interface StagedCli { version: string; archive: string; packageRoot: string }
export function stageCliPackage(runtime: string, npm: string, requested: string, directory: string): StagedCli {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const result = decodeBoundary(JSON.parse(runNpm(runtime, npm, ['pack', `runpane@${requested.replace(/^v/, '')}`, '--ignore-scripts', '--json', '--pack-destination', directory], directory)), boundary.array(boundary.object({ filename: boundary.nonEmptyString, version: boundary.nonEmptyString, integrity: boundary.nonEmptyString })));
  if (result.length !== 1 || path.basename(result[0].filename) !== result[0].filename) throw new Error('npm returned an invalid package archive.');
  const archive = path.join(directory, result[0].filename);
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', timeout: 30_000 }).split(/\r?\n/).filter(Boolean);
  if (entries.some(entry => !entry.startsWith('package/') || entry.split('/').includes('..') || entry.includes('\\'))) throw new Error('The CLI archive contains unsafe paths.');
  execFileSync('tar', ['-xzf', archive, '-C', directory], { timeout: 30_000 });
  const packageRoot = path.join(directory, 'package');
  const metadata = decodeBoundary(JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')), boundary.object({ name: boundary.string, version: boundary.string }));
  if (metadata.name !== 'runpane' || metadata.version !== result[0].version) throw new Error('The staged CLI identity does not match npm metadata.');
  // RUNPANE_NO_HANDOFF: the version check asks this package, not a newer Pane-managed CLI.
  const actual = execFileSync(runtime, [path.join(packageRoot, 'dist', 'cli.js'), '--version'], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, RUNPANE_NO_HANDOFF: '1' } }).trim();
  if (!actual.includes(metadata.version)) throw new Error('The staged CLI failed its version check.');
  return { version: metadata.version, archive, packageRoot };
}

/** Commit a managed version pin and rewrite the current shim immediately. */
export function activateManagedCli(paneDir: string, version: string, entrypoint: string, runtime: string): void {
  const bin = path.join(paneDir, 'bin');
  const root = fs.realpathSync(path.join(bin, 'cli'));
  for (const file of [entrypoint, runtime]) {
    const relative = path.relative(root, fs.realpathSync(file));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Managed CLI files must be inside the owned CLI directory.');
  }
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const marker = 'pane-managed-runpane-shim v1';
  const files = [{ name: 'runpane', content: `#!/bin/sh\n# ${marker}\nif [ -z "\${PANE_DIR:-}" ]; then PANE_DIR=${quote(paneDir)}; export PANE_DIR; fi\nexec ${quote(runtime)} ${quote(entrypoint)} "$@"\n` }];
  if (process.platform === 'win32') files.push({ name: 'runpane.cmd', content: `@echo off\r\nrem ${marker}\r\nsetlocal\r\nif not defined PANE_DIR set "PANE_DIR=${paneDir}"\r\n"${runtime}" "${entrypoint}" %*\r\n` });
  for (const file of files) {
    const target = path.join(bin, file.name);
    if (fs.lstatSync(target).isSymbolicLink() || !fs.readFileSync(target, 'utf8').includes(marker)) throw new Error(`The CLI shim is not owned by Pane: ${target}`);
  }
  writeUpdateJson(path.join(bin, 'runpane-override.json'), { version, entrypoint, runtime });
  for (const file of files) {
    const target = path.join(bin, file.name);
    fs.writeFileSync(`${target}.update`, file.content, { mode: 0o755 });
    fs.renameSync(`${target}.update`, target);
  }
}
