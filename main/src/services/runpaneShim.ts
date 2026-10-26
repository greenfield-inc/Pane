/**
 * Puts Pane's own `runpane` on PATH for every terminal Pane launches, so agents
 * never depend on a global `npm i -g runpane` (or a stale one).
 *
 * Unless a CLI-only update selected a separate managed package/runtime, startup
 * copies the bundled CLI into `<PANE_DIR>/bin/runpane.cjs` and
 * writes a `runpane` shim that runs it with this Electron binary as Node
 * (ELECTRON_RUN_AS_NODE=1). Terminal launches then prepend `<PANE_DIR>/bin` to
 * PATH and, for zsh, bash and fish, re-apply that after the user's startup
 * files run, so a profile that rebuilds PATH cannot hide the shim or put a
 * globally installed (possibly mismatched) runpane ahead of it.
 *
 * WSL terminals are left alone: a Windows Electron path cannot run inside the
 * distro, and env set on wsl.exe does not reach the Linux shell anyway.
 *
 * The installed app also appends `<PANE_DIR>/bin` to the end of the user's own
 * PATH (shell startup files, or the Windows user PATH), so `runpane` works in
 * terminals Pane did not open, such as when recovering from a failed update.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import path from 'path';
import type { PtyHostSpawnOpts } from '../ptyHost/types';
import { isPackagedOnDefaultDirectory } from '../utils/appDirectory';

/** Environment handed to a terminal spawn. */
type SpawnEnv = PtyHostSpawnOpts['env'];

export const PANE_MANAGED_SHIM_MARKER = 'pane-managed-runpane-shim v1';
const MANAGED_SHELL_MARKER = 'pane-managed-shell-wrapper v1';
// No cmd.exe metacharacters: the Windows shim echoes it unquoted.
const MISSING_RUNTIME_MESSAGE = 'runpane: Pane is missing and Node.js is not on PATH. Reinstall Pane from https://runpane.com, or install Node.js and run: npx --yes runpane@latest update';

export interface RunpaneShimState {
  binDir: string;
  /** Absolute path to the shim agents should call (exported as PANE_RUNPANE_BIN). */
  shimPath: string;
  /** Wrapper startup files that re-apply PATH after the user's own files. */
  zshDotDir: string;
  bashRcFile: string;
}

export interface InstallRunpaneShimOptions {
  appDirectory: string;
  /** The bundled CLI shipped with this build (may live inside app.asar). */
  bundledCliPath: string;
  execPath: string;
  platform?: NodeJS.Platform;
}

let currentState: RunpaneShimState | null = null;

/** Where `pnpm build:main` puts the bundled CLI, relative to this compiled module. */
function defaultBundledRunpaneCliPath(): string {
  // main/dist/main/src/services/runpaneShim.js -> main/dist/runpane/runpane.cjs
  return path.resolve(__dirname, '..', '..', '..', 'runpane', 'runpane.cjs');
}

/** POSIX single-quote a value for sh, bash, zsh and fish. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isSymlink(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Write only when content differs. Never follows symlinks, and never replaces
 * a file Pane did not write (no marker), so a user's own file survives.
 */
function writeManagedFile(filePath: string, content: string, marker: string | null, mode: number): boolean {
  if (isSymlink(filePath)) return false;
  if (fs.existsSync(filePath)) {
    const previous = fs.readFileSync(filePath, 'utf8');
    if (previous === content) {
      fs.chmodSync(filePath, mode);
      return true;
    }
    if (marker && !previous.includes(marker)) return false;
  }
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content, { mode });
  fs.renameSync(temp, filePath);
  fs.chmodSync(filePath, mode);
  return true;
}

function ensureDirectory(directory: string): void {
  if (isSymlink(directory)) throw new Error(`Refusing to use symbolic link directory: ${directory}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
}

function posixShim(appDirectory: string, execPath: string, cliPath: string): string {
  return [
    '#!/bin/sh',
    `# ${PANE_MANAGED_SHIM_MARKER}: Pane rewrites this file at startup; edits are lost.`,
    '# Runs the runpane CLI bundled with this Pane build using its Electron binary as Node,',
    '# or Node on PATH when that binary is gone (a failed update, a moved app).',
    `if [ -z "\${PANE_DIR:-}" ]; then PANE_DIR=${shellQuote(appDirectory)}; export PANE_DIR; fi`,
    `if [ -x ${shellQuote(execPath)} ]; then ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(execPath)} ${shellQuote(cliPath)} "$@"; fi`,
    `if command -v node >/dev/null 2>&1; then exec node ${shellQuote(cliPath)} "$@"; fi`,
    `echo ${shellQuote(MISSING_RUNTIME_MESSAGE)} >&2`,
    'exit 127',
    '',
  ].join('\n');
}

function windowsShim(appDirectory: string, execPath: string, cliPath: string): string {
  return [
    '@echo off',
    `rem ${PANE_MANAGED_SHIM_MARKER}: Pane rewrites this file at startup; edits are lost.`,
    'setlocal',
    `if not defined PANE_DIR set "PANE_DIR=${appDirectory}"`,
    `if not exist "${execPath}" goto node`,
    'set ELECTRON_RUN_AS_NODE=1',
    `"${execPath}" "${cliPath}" %*`,
    'exit /b %ERRORLEVEL%',
    ':node',
    'where node >nul 2>nul || goto missing',
    `node "${cliPath}" %*`,
    'exit /b %ERRORLEVEL%',
    ':missing',
    `echo ${MISSING_RUNTIME_MESSAGE} 1>&2`,
    'exit /b 1',
    '',
  ].join('\r\n');
}

/** zsh: move the bin dir to the front of $path (zsh keeps $path and $PATH in sync). */
function zshPathLines(binDir: string): string[] {
  const quoted = shellQuote(binDir);
  return [
    `_pane_runpane_path() { path=(${quoted} \${path:#${quoted}}); }`,
    '_pane_runpane_path',
    'typeset -ga precmd_functions 2>/dev/null || true',
    '# Keep the hook last so tools that edit PATH before each prompt (direnv, nvm) cannot bury the shim.',
    'precmd_functions=(${precmd_functions:#_pane_runpane_path} _pane_runpane_path) 2>/dev/null || true',
    'rehash 2>/dev/null || true',
  ];
}

/**
 * zsh reads startup files from $ZDOTDIR, so Pane points ZDOTDIR at these
 * wrappers. Each one sources the user's matching file from their real
 * ZDOTDIR (PANE_USER_ZDOTDIR, else $HOME), then points ZDOTDIR back here for
 * the next stage. The last stage restores the user's ZDOTDIR for the session.
 */
function zshWrapperFiles(binDir: string, wrapperDir: string) {
  const wrapper = shellQuote(wrapperDir);
  const stage = (file: string, extra: string[] = [], finish: string[] = []) => [
    `# ${MANAGED_SHELL_MARKER}: Pane rewrites this file at startup; edits are lost.`,
    '_pane_user_zdotdir="${PANE_USER_ZDOTDIR:-$HOME}"',
    ...extra,
    'export ZDOTDIR="$_pane_user_zdotdir"',
    `[[ -f "$_pane_user_zdotdir/${file}" ]] && source "$_pane_user_zdotdir/${file}"`,
    '# A user file may move ZDOTDIR; later stages read the user files from there.',
    '[[ "$ZDOTDIR" != "$_pane_user_zdotdir" ]] && export PANE_USER_ZDOTDIR="$ZDOTDIR"',
    ...finish,
    '',
  ].join('\n');
  // /etc/zshrc (macOS) derives HISTFILE from ZDOTDIR while it still points here.
  const historyFix = [
    `[[ "\${HISTFILE:-}" == ${shellQuote(path.join(wrapperDir, '.zsh_history'))} ]] && HISTFILE="$_pane_user_zdotdir/.zsh_history"`,
  ];
  return {
    '.zshenv': stage('.zshenv', [], [`export ZDOTDIR=${wrapper}`]),
    '.zprofile': stage('.zprofile', [], [`export ZDOTDIR=${wrapper}`]),
    '.zshrc': stage('.zshrc', historyFix, [
      ...zshPathLines(binDir),
      // An interactive non-login shell (Pane's default, -i) ends here.
      `if [[ -o login ]]; then export ZDOTDIR=${wrapper}; else export ZDOTDIR="\${PANE_USER_ZDOTDIR:-$HOME}"; fi`,
    ]),
    '.zlogin': stage('.zlogin', [], [
      ...zshPathLines(binDir),
      'export ZDOTDIR="${PANE_USER_ZDOTDIR:-$HOME}"',
    ]),
  };
}

/** bash --rcfile replaces ~/.bashrc for an interactive non-login shell. */
function bashRcFile(binDir: string): string {
  const quoted = shellQuote(binDir);
  return [
    `# ${MANAGED_SHELL_MARKER}: Pane rewrites this file at startup; edits are lost.`,
    '# Same files an interactive non-login bash reads, then keep runpane first on PATH.',
    '[ -f /etc/bash.bashrc ] && . /etc/bash.bashrc',
    '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"',
    '_pane_runpane_path() {',
    `  local dir=${quoted} rest=":$PATH:"`,
    '  rest="${rest//:$dir:/:}"; rest="${rest#:}"; rest="${rest%:}"',
    '  PATH="$dir${rest:+:$rest}"',
    '}',
    '_pane_runpane_path',
    'case ";${PROMPT_COMMAND:-};" in',
    '  *";_pane_runpane_path;"*) ;;',
    '  *) PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND;}_pane_runpane_path" ;;',
    'esac',
    'hash -r 2>/dev/null || true',
    '',
  ].join('\n');
}

/** fish --init-command runs after the user's config files. */
function fishInitCommand(binDir: string): string {
  const quoted = shellQuote(binDir);
  return [
    `function _pane_runpane_path --on-event fish_prompt; set -gx PATH ${quoted} (string match -v -- ${quoted} $PATH); end`,
    '_pane_runpane_path',
  ].join('; ');
}

/**
 * Install the shim and shell wrappers under `<appDirectory>`. Returns null
 * (and leaves terminals untouched) when the bundled CLI is missing or a
 * target is not ours to overwrite.
 */
export function installRunpaneShim(options: InstallRunpaneShimOptions): RunpaneShimState | null {
  const platform = options.platform ?? process.platform;
  let cli: string;
  try {
    // Plain reads work inside Electron's asar archive; the copy runs outside it.
    cli = fs.readFileSync(options.bundledCliPath, 'utf8');
  } catch {
    return null;
  }

  const binDir = path.join(options.appDirectory, 'bin');
  ensureDirectory(binDir);
  let cliPath = path.join(binDir, 'runpane.cjs');
  let execPath = options.execPath;
  const overrideFile = path.join(binDir, 'runpane-override.json');
  if (fs.existsSync(overrideFile)) {
    // CLI-only updates are an explicit installation choice. Older Pane startup
    // must neither overwrite that package nor switch its runtime back to Electron.
    if (isSymlink(overrideFile)) return null;
    const override = decodeBoundary(JSON.parse(fs.readFileSync(overrideFile, 'utf8')), boundary.object({
      version: boundary.nonEmptyString,
      entrypoint: boundary.nonEmptyString,
      runtime: boundary.nonEmptyString,
    }));
    const root = fs.realpathSync(path.join(binDir, 'cli'));
    for (const file of [override.entrypoint, override.runtime]) {
      const relative = path.relative(root, fs.realpathSync(file));
      if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.statSync(file).isFile()) return null;
    }
    cliPath = override.entrypoint;
    execPath = override.runtime;
  } else if (!writeManagedFile(cliPath, cli, null, 0o644)) return null;

  const shimPath = path.join(binDir, platform === 'win32' ? 'runpane.cmd' : 'runpane');
  // Git Bash on Windows also finds the extensionless POSIX shim.
  if (!writeManagedFile(path.join(binDir, 'runpane'), posixShim(options.appDirectory, execPath, cliPath), PANE_MANAGED_SHIM_MARKER, 0o755)) {
    return null;
  }
  if (platform === 'win32'
    && !writeManagedFile(shimPath, windowsShim(options.appDirectory, execPath, cliPath), PANE_MANAGED_SHIM_MARKER, 0o755)) {
    return null;
  }

  const zshDotDir = path.join(options.appDirectory, 'shell', 'zsh');
  const bashDir = path.join(options.appDirectory, 'shell', 'bash');
  ensureDirectory(zshDotDir);
  ensureDirectory(bashDir);
  for (const [name, content] of Object.entries(zshWrapperFiles(binDir, zshDotDir))) {
    writeManagedFile(path.join(zshDotDir, name), content, MANAGED_SHELL_MARKER, 0o644);
  }
  const bashRc = path.join(bashDir, 'rcfile');
  writeManagedFile(bashRc, bashRcFile(binDir), MANAGED_SHELL_MARKER, 0o644);

  currentState = { binDir, shimPath, zshDotDir, bashRcFile: bashRc };
  return currentState;
}

export function installRunpaneShimBestEffort(appDirectory: string): RunpaneShimState | null {
  try {
    const state = installRunpaneShim({ appDirectory, bundledCliPath: defaultBundledRunpaneCliPath(), execPath: process.execPath });
    if (!state) console.warn('[runpane] Bundled CLI unavailable; terminals will use runpane from PATH if installed');
    return state;
  } catch (error) {
    console.warn('[runpane] Failed to install the runpane shim:', error);
    return null;
  }
}

function prependPath(currentPath: string | undefined, dir: string, delimiter: string): string {
  const parts = (currentPath ?? '').split(delimiter).filter(part => part && part !== dir);
  return [dir, ...parts].join(delimiter);
}

export interface ShellLaunch {
  args: string[];
  env: SpawnEnv;
}

/**
 * Put Pane's runpane first on PATH for an interactive shell launch. zsh, bash
 * and fish also re-apply it after the user's startup files; other shells get
 * the PATH prepend only.
 */
export function withRunpaneOnPath(
  shell: { name: string; args: string[] },
  env: SpawnEnv,
  state: RunpaneShimState | null = currentState,
  platform: NodeJS.Platform = process.platform,
): ShellLaunch {
  if (!state) return { args: shell.args, env };
  const delimiter = platform === 'win32' ? ';' : ':';
  const nextEnv: SpawnEnv = {
    ...env,
    PATH: prependPath(env.PATH, state.binDir, delimiter),
    PANE_RUNPANE_BIN: state.shimPath,
  };
  if (platform === 'win32') return { args: shell.args, env: nextEnv };

  switch (shell.name) {
    case 'zsh': {
      // Keep the user's own ZDOTDIR (if any) as the source of their startup files.
      const userZdotdir = env.ZDOTDIR && env.ZDOTDIR !== state.zshDotDir ? env.ZDOTDIR : env.PANE_USER_ZDOTDIR;
      if (userZdotdir) nextEnv.PANE_USER_ZDOTDIR = userZdotdir;
      else delete nextEnv.PANE_USER_ZDOTDIR;
      nextEnv.ZDOTDIR = state.zshDotDir;
      return { args: shell.args, env: nextEnv };
    }
    case 'bash':
      // --rcfile only applies to interactive non-login shells, which is how Pane starts bash.
      if (shell.args.includes('-l') || shell.args.includes('--login')) return { args: shell.args, env: nextEnv };
      return { args: ['--rcfile', state.bashRcFile, ...shell.args], env: nextEnv };
    case 'fish':
      return { args: [...shell.args, '--init-command', fishInitCommand(state.binDir)], env: nextEnv };
    default:
      return { args: shell.args, env: nextEnv };
  }
}

/** Non-interactive commands (run scripts) only need the PATH prepend. */
export function withRunpaneBinOnPath(env: SpawnEnv, state: RunpaneShimState | null = currentState, platform: NodeJS.Platform = process.platform): SpawnEnv {
  if (!state) return env;
  return { ...env, PATH: prependPath(env.PATH, state.binDir, platform === 'win32' ? ';' : ':'), PANE_RUNPANE_BIN: state.shimPath };
}

/** Marks the PATH lines Pane appends to a user's shell startup file. */
const USER_PATH_MARKER = 'pane-runpane-path v1';
/** Records which targets already got the entry, so one the user removes stays removed. */
const USER_PATH_RECORD = 'user-path.json';
const WINDOWS_USER_PATH = 'HKCU\\Environment\\Path';

type UserPathResult = 'changed' | 'present' | 'refused';

export interface AddRunpaneToUserPathOptions {
  binDir: string;
  home?: string;
  /** The user's login shell; it decides which startup files get the PATH lines. */
  loginShell?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** A packaged build on the default data directory; dev and side-by-side builds never touch the user's profile. */
  installed?: boolean;
  windowsUserPath?: WindowsUserPathStore;
}

function shellStartupFiles(home: string, loginShell: string, platform: NodeJS.Platform): string[] {
  const shell = path.basename(loginShell);
  const bashProfile = path.join(home, '.bash_profile');
  const files = platform === 'darwin' && (shell === 'bash' || fs.existsSync(bashProfile)) ? [bashProfile] : [];
  // zsh reads .zshenv in every shell, login or not, on macOS and Linux alike.
  if (shell === 'zsh') files.unshift(path.join(home, '.zshenv'));
  if (shell === 'bash') files.unshift(path.join(home, '.bashrc'));
  if (shell === 'fish') files.unshift(path.join(home, '.config', 'fish', 'conf.d', 'pane.fish'));
  return files;
}

function shellPathBlock(file: string, binDir: string): string {
  const quoted = shellQuote(binDir);
  const body = file.endsWith('.fish')
    ? [`if not contains -- ${quoted} $PATH`, `    set -gx PATH $PATH ${quoted}`, 'end']
    : ['case ":$PATH:" in', `  *:${quoted}:*) ;;`, `  *) export PATH="\${PATH:+$PATH:}"${quoted} ;;`, 'esac'];
  return [
    `# ${USER_PATH_MARKER}: Pane added these lines so runpane works in every terminal.`,
    '# Delete them to undo; Pane does not add them again.',
    ...body,
    `# end ${USER_PATH_MARKER}`,
    '',
  ].join('\n');
}

/** Append the block once. A file that already names the directory, or a symbolic link, is left alone. */
function appendShellPathBlock(file: string, binDir: string, home: string): UserPathResult {
  if (isSymlink(file)) return 'refused';
  const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  // Shell startup files spell paths with '/'.
  const relative = path.relative(home, binDir).split(path.sep).join('/');
  if ([USER_PATH_MARKER, binDir, `$HOME/${relative}`, `\${HOME}/${relative}`, `~/${relative}`].some(text => previous.includes(text))) return 'present';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const separator = previous === '' ? '' : previous.endsWith('\n') ? '\n' : '\n\n';
  fs.appendFileSync(file, `${separator}${shellPathBlock(file, binDir)}`, { mode: 0o644 });
  return 'changed';
}

function powershell(script: string, env: NodeJS.ProcessEnv = {}): Promise<string> {
  const encoded = Buffer.from(`$ErrorActionPreference = 'Stop'\n${script}`, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { env: { ...process.env, ...env }, timeout: 30_000, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
  });
}

// Base64 keeps non-ASCII PATH entries intact whatever the console code page is.
const READ_WINDOWS_USER_PATH = [
  "$key = Get-Item -LiteralPath 'HKCU:\\Environment'",
  "$value = $key.GetValue('Path', $null, 'DoNotExpandEnvironmentNames')",
  "$kind = if ($null -eq $value) { 'None' } else { $key.GetValueKind('Path').ToString() }",
  '[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$kind`n$value")))',
].join('\n');

// Set-ItemProperty keeps the value's type, unlike [Environment]::SetEnvironmentVariable,
// which rewrites REG_EXPAND_SZ as REG_SZ. The broadcast lets Explorer hand new terminals the new PATH.
const WRITE_WINDOWS_USER_PATH = [
  "Set-ItemProperty -LiteralPath 'HKCU:\\Environment' -Name 'Path' -Value $env:PANE_USER_PATH -Type $env:PANE_USER_PATH_KIND",
  'try {',
  "  Add-Type -Namespace Pane -Name Environment -MemberDefinition '[DllImport(\"user32.dll\", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);'",
  '  $result = [UIntPtr]::Zero',
  "  [void][Pane.Environment]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)",
  '} catch {}',
].join('\n');

/** HKCU\Environment\Path and its registry type: String, ExpandString, or None when the value is missing. */
export interface WindowsUserPath {
  kind: string;
  value: string;
}

/** Reads and writes the Windows user PATH. */
interface WindowsUserPathStore {
  read(): Promise<WindowsUserPath>;
  write(next: WindowsUserPath): Promise<void>;
}

const registryUserPath: WindowsUserPathStore = {
  async read() {
    const decoded = Buffer.from((await powershell(READ_WINDOWS_USER_PATH)).trim(), 'base64').toString('utf8');
    const newline = decoded.indexOf('\n');
    return { kind: decoded.slice(0, newline), value: decoded.slice(newline + 1) };
  },
  async write(next) {
    await powershell(WRITE_WINDOWS_USER_PATH, { PANE_USER_PATH: next.value, PANE_USER_PATH_KIND: next.kind });
  },
};

/** Append to the user PATH once, keeping REG_EXPAND_SZ or REG_SZ as it was. */
async function appendWindowsUserPath(binDir: string, env: NodeJS.ProcessEnv, store: WindowsUserPathStore): Promise<UserPathResult> {
  const { kind, value } = await store.read();
  if (kind !== 'None' && kind !== 'String' && kind !== 'ExpandString') return 'refused';
  const normalize = (entry: string) => entry.replace(/%([^%]+)%/g, (match, name: string) => env[name] ?? match).replace(/[\\/]+$/, '').toLowerCase();
  if (value.split(';').some(entry => normalize(entry) === normalize(binDir))) return 'present';
  await store.write({
    kind: kind === 'String' ? 'String' : 'ExpandString',
    value: value === '' || value.endsWith(';') ? `${value}${binDir}` : `${value};${binDir}`,
  });
  return 'changed';
}

function readUserPathRecord(file: string): string[] {
  try {
    return decodeBoundary(JSON.parse(fs.readFileSync(file, 'utf8')), boundary.object({ done: boundary.array(boundary.string) })).done;
  } catch {
    return [];
  }
}

/**
 * Put `binDir` at the end of the user's own PATH so `runpane` works in
 * terminals Pane did not open. A runpane installed with npm keeps winning there.
 * Each target is changed at most once. Returns the targets it changed.
 */
export async function addRunpaneToUserPath(options: AddRunpaneToUserPathOptions): Promise<string[]> {
  const env = options.env ?? process.env;
  if (env.PANE_DISABLE_OS_INTEGRATION === '1' || !(options.installed ?? isPackagedOnDefaultDirectory())) return [];
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const recordFile = path.join(options.binDir, USER_PATH_RECORD);
  const done = readUserPathRecord(recordFile);
  const targets = platform === 'win32'
    ? [WINDOWS_USER_PATH]
    : shellStartupFiles(home, options.loginShell ?? os.userInfo().shell ?? env.SHELL ?? '', platform);
  const changed: string[] = [];
  for (const target of targets.filter(candidate => !done.includes(candidate))) {
    const result = target === WINDOWS_USER_PATH ? await appendWindowsUserPath(options.binDir, env, options.windowsUserPath ?? registryUserPath) : appendShellPathBlock(target, options.binDir, home);
    if (result === 'refused') continue;
    if (result === 'changed') changed.push(target);
    done.push(target);
    writeManagedFile(recordFile, `${JSON.stringify({ done }, null, 2)}\n`, null, 0o644);
  }
  return changed;
}

export async function addRunpaneToUserPathBestEffort(): Promise<void> {
  if (!currentState) return;
  try {
    const changed = await addRunpaneToUserPath({ binDir: currentState.binDir });
    if (changed.length > 0) console.log(`[runpane] Added ${currentState.binDir} to PATH in ${changed.join(', ')}`);
  } catch (error) {
    console.warn('[runpane] Failed to add runpane to the user PATH:', error);
  }
}
