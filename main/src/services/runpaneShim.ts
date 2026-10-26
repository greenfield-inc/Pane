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
 * WSL terminals run the same POSIX shim from the distro: it starts the Windows
 * Electron binary through WSL interop, so the CLI is a Windows process that can
 * open the daemon's named pipe (Linux processes cannot). WSLENV carries
 * ELECTRON_RUN_AS_NODE and PANE_DIR across. A WSL rcfile re-applies PATH after
 * the user's login files, using `wslpath` for the Linux side of each path.
 */
import fs from 'fs';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import path from 'path';
import type { PtyHostSpawnOpts } from '../ptyHost/types';
import { RUNPANE_PATH_FLAGS, RUNPANE_WSL_PATH_FUNCTIONS, WSLPATH } from '../utils/wslUtils';

/** Environment handed to a terminal spawn. */
type SpawnEnv = PtyHostSpawnOpts['env'];

export const PANE_MANAGED_SHIM_MARKER = 'pane-managed-runpane-shim v1';
const MANAGED_SHELL_MARKER = 'pane-managed-shell-wrapper v1';

export interface RunpaneShimState {
  binDir: string;
  /** Absolute path to the shim agents should call (exported as PANE_RUNPANE_BIN). */
  shimPath: string;
  /** Wrapper startup files that re-apply PATH after the user's own files. */
  zshDotDir: string;
  bashRcFile: string;
  /** Windows only: the rcfile WSL terminals start bash with. */
  wslBashRcFile?: string;
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

/**
 * Inside WSL, the Windows binary runs through interop. Its Windows paths stay
 * as they are; the executable becomes a Linux path, and a Linux PANE_DIR and
 * path-valued flags become Windows paths. WSL Session terminals use
 * sessionWSLBridge.ts instead, a PowerShell bridge pinned to their Session.
 */
function wslShimLines(execPath: string, cliPath: string): string[] {
  return [
    'if [ -n "${WSL_DISTRO_NAME:-}" ]; then',
    "  if ! grep -qs '^enabled' /proc/sys/fs/binfmt_misc/WSLInterop /proc/sys/fs/binfmt_misc/WSLInterop-late; then",
    '    echo "runpane: WSL interop is off in $WSL_DISTRO_NAME, so it cannot start Pane\'s Windows CLI. Nothing was run. Set enabled=true under [interop] in /etc/wsl.conf, then run wsl.exe --shutdown from Windows." >&2',
    '    exit 126',
    '  fi',
    ...RUNPANE_WSL_PATH_FUNCTIONS.map(line => `  ${line}`),
    '  case "$PANE_DIR" in /*) PANE_DIR=$(pane_windows_path "$PANE_DIR") ;; esac',
    '  # Rebuild "$@" with path values converted; everything after -- passes through.',
    '  pane_count=$# pane_next= pane_rest=',
    '  while [ "$pane_count" -gt 0 ]; do',
    '    pane_arg=$1; shift; pane_count=$((pane_count - 1))',
    '    case "$pane_next" in',
    '      path) pane_arg=$(pane_windows_path "$pane_arg") ;;',
    '      repo) pane_arg=$(pane_repo_selector "$pane_arg") ;;',
    '    esac',
    '    pane_next=',
    '    if [ -z "$pane_rest" ]; then',
    '      case "$pane_arg" in',
    '        --) pane_rest=1 ;;',
    '        --repo=*) pane_arg="--repo=$(pane_repo_selector "${pane_arg#*=}")" ;;',
    '        --repo) pane_next=repo ;;',
    `        ${RUNPANE_PATH_FLAGS.map(flag => `${flag}=*`).join('|')}) pane_arg="\${pane_arg%%=*}=$(pane_windows_path "\${pane_arg#*=}")" ;;`,
    `        ${RUNPANE_PATH_FLAGS.join('|')}) pane_next=path ;;`,
    '      esac',
    '    fi',
    '    set -- "$@" "$pane_arg"',
    '  done',
    '  WSLENV="${WSLENV:+$WSLENV:}ELECTRON_RUN_AS_NODE:PANE_DIR"; export WSLENV',
    `  ELECTRON_RUN_AS_NODE=1 exec "$(${WSLPATH} -u ${shellQuote(execPath)})" ${shellQuote(cliPath)} "$@"`,
    'fi',
  ];
}

function posixShim(appDirectory: string, execPath: string, cliPath: string, platform: NodeJS.Platform): string {
  return [
    '#!/bin/sh',
    `# ${PANE_MANAGED_SHIM_MARKER}: Pane rewrites this file at startup; edits are lost.`,
    '# Runs the runpane CLI bundled with this Pane build using its Electron binary as Node.',
    `if [ -z "\${PANE_DIR:-}" ]; then PANE_DIR=${shellQuote(appDirectory)}; export PANE_DIR; fi`,
    ...(platform === 'win32' ? wslShimLines(execPath, cliPath) : []),
    `ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(execPath)} ${shellQuote(cliPath)} "$@"`,
    '',
  ].join('\n');
}

function windowsShim(appDirectory: string, execPath: string, cliPath: string): string {
  return [
    '@echo off',
    `rem ${PANE_MANAGED_SHIM_MARKER}: Pane rewrites this file at startup; edits are lost.`,
    'setlocal',
    `if not defined PANE_DIR set "PANE_DIR=${appDirectory}"`,
    'set ELECTRON_RUN_AS_NODE=1',
    `"${execPath}" "${cliPath}" %*`,
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

/** Move `dir` (a shell expression) to the front of PATH now and before each prompt. */
function bashPathLines(dir: string): string[] {
  return [
    '_pane_runpane_path() {',
    `  local dir=${dir} rest=":$PATH:"`,
    '  rest="${rest//:$dir:/:}"; rest="${rest#:}"; rest="${rest%:}"',
    '  PATH="$dir${rest:+:$rest}"',
    '}',
    '_pane_runpane_path',
    'case ";${PROMPT_COMMAND:-};" in',
    '  *";_pane_runpane_path;"*) ;;',
    '  *) PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND;}_pane_runpane_path" ;;',
    'esac',
    'hash -r 2>/dev/null || true',
  ];
}

/** bash --rcfile replaces ~/.bashrc for an interactive non-login shell. */
function bashRcFile(binDir: string): string {
  return [
    `# ${MANAGED_SHELL_MARKER}: Pane rewrites this file at startup; edits are lost.`,
    '# Same files an interactive non-login bash reads, then keep runpane first on PATH.',
    '[ -f /etc/bash.bashrc ] && . /etc/bash.bashrc',
    '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"',
    ...bashPathLines(shellQuote(binDir)),
    '',
  ].join('\n');
}

/**
 * WSL terminals start a login bash. This rcfile reads the same files a login
 * bash reads, then puts the Windows bin directory, as a Linux path, first.
 */
function wslBashRcFile(binDir: string): string {
  return [
    `# ${MANAGED_SHELL_MARKER}: Pane rewrites this file at startup; edits are lost.`,
    '# Same files a login bash reads, then keep runpane first on PATH.',
    '[ -f /etc/profile ] && . /etc/profile',
    'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"',
    'elif [ -f "$HOME/.bash_login" ]; then . "$HOME/.bash_login"',
    'elif [ -f "$HOME/.profile" ]; then . "$HOME/.profile"; fi',
    `_pane_runpane_dir=$(${WSLPATH} -u ${shellQuote(binDir)} 2>/dev/null)`,
    '# An empty dir would put the current folder on PATH.',
    'if [ -n "$_pane_runpane_dir" ]; then',
    'export PANE_RUNPANE_BIN="$_pane_runpane_dir/runpane"',
    ...bashPathLines('"$_pane_runpane_dir"'),
    'fi',
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
  if (!writeManagedFile(path.join(binDir, 'runpane'), posixShim(options.appDirectory, execPath, cliPath, platform), PANE_MANAGED_SHIM_MARKER, 0o755)) {
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
  if (platform === 'win32') {
    const wslRc = path.join(bashDir, 'wsl-rcfile');
    if (writeManagedFile(wslRc, wslBashRcFile(binDir), MANAGED_SHELL_MARKER, 0o644)) currentState.wslBashRcFile = wslRc;
  }
  return currentState;
}

/** The installed shim, or null when this Pane has none. */
export function getRunpaneShimState(): RunpaneShimState | null {
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
