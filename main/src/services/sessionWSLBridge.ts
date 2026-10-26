import path from 'path';
import { escapeForBash, RUNPANE_PATH_FLAGS, RUNPANE_WSL_PATH_FUNCTIONS, WSLPATH } from '../utils/wslUtils';
import { sessionRuntimePath } from './sessionRuntime';
import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Run the bundled Windows CLI, which can open this instance's named pipe.
 * WSL Session terminals use this PowerShell bridge, pinned to their Session;
 * other WSL terminals use the interop branch of runpaneShim.ts's POSIX shim.
 */
export function sessionWSLBridge(appDirectory: string, record: OrchestrationSessionRecord, launcherPath: string, execPath = process.execPath): string {
  appDirectory = path.resolve(appDirectory);
  launcherPath = path.resolve(launcherPath);
  const powershell = sessionRuntimePath(path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), record);
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    'Set-Location $env:TEMP',
    "$env:ELECTRON_RUN_AS_NODE = '1'",
    `$env:PANE_DIR = ${quotePowerShell(appDirectory)}`,
    `$env:PANE_ORCHESTRATION_SESSION_ID = ${quotePowerShell(record.id)}`,
    `$env:PANE_SESSION_ID = ${quotePowerShell(record.internalSessionId)}`,
  ].join('; ');
  return [
    '#!/bin/bash',
    '# Pane-managed WSL Session bridge. Arguments cross as PowerShell literals.',
    'set -euo pipefail',
    ...RUNPANE_WSL_PATH_FUNCTIONS,
    `panel_id=\${PANE_PANEL_ID:-${escapeForBash(record.panelIds[record.agent])}}`,
    "panel_id=${panel_id//\\'/\\'\\'}",
    `command=${escapeForBash(`${command}; $env:PANE_PANEL_ID = `)}`,
    'command+="\'$panel_id\'; \\$paneArgs = @("',
    'path_arg=false',
    'repo_arg=false',
    'passthrough=false',
    `pane_dir_args=${escapeForBash(`${quotePowerShell('--pane-dir')},${quotePowerShell(appDirectory)},`)}`,
    'for arg in "$@"; do',
    // Keep the instance override last among CLI flags, never inside the command payload.
    '  if ! "$passthrough" && [[ "$arg" == -- ]]; then',
    '    command+="$pane_dir_args"',
    '    passthrough=true',
    '  fi',
    '  if ! "$passthrough"; then',
    '    if "$path_arg"; then arg=$(pane_windows_path "$arg"); fi',
    '    if "$repo_arg"; then arg=$(pane_repo_selector "$arg"); fi',
    '    path_arg=false',
    '    repo_arg=false',
    '    key=${arg%%=*}',
    '    case "$key" in',
    '      --repo)',
    '        if [[ "$arg" == *=* ]]; then arg="$key=$(pane_repo_selector "${arg#*=}")"; else repo_arg=true; fi ;;',
    `      ${RUNPANE_PATH_FLAGS.join('|')})`,
    '        if [[ "$arg" == *=* ]]; then arg="$key=$(pane_windows_path "${arg#*=}")"; else path_arg=true; fi ;;',
    '    esac',
    '  fi',
    // PowerShell single-quoted strings escape an apostrophe by doubling it.
    "  arg=${arg//\\'/\\'\\'}",
    '  command+="\'$arg\',"',
    'done',
    'if ! "$passthrough"; then command+="$pane_dir_args"; fi',
    'command=${command%,}',
    `command+=${escapeForBash(`); $env:PANE_WSL_RUNPANE_ARGS_FILE = $PSCommandPath + '.json'; [System.IO.File]::WriteAllText($env:PANE_WSL_RUNPANE_ARGS_FILE, (ConvertTo-Json -InputObject $paneArgs -Compress), [System.Text.UTF8Encoding]::new($false)); & ${quotePowerShell(execPath)} ${quotePowerShell(launcherPath)}; exit $LASTEXITCODE`)}`,
    // Keep payloads off the Windows command line and preserve stdin for the CLI.
    `script=$(mktemp ${escapeForBash(`${sessionRuntimePath(path.dirname(launcherPath), record)}/bridge-XXXXXX.ps1`)})`,
    'trap \'rm -f -- "$script" "$script.json"\' EXIT',
    String.raw`{ printf '\xff\xfe'; printf %s "$command" | iconv -f UTF-8 -t UTF-16LE; } > "$script"`,
    `${escapeForBash(powershell)} -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$(${WSLPATH} -aw "$script")"`,
    '',
  ].join('\n');
}

/** JSON avoids Windows PowerShell's lossy native argument quoting. */
export function sessionWSLLauncher(appDirectory: string): string {
  return [
    "const args = JSON.parse(require('node:fs').readFileSync(process.env.PANE_WSL_RUNPANE_ARGS_FILE, 'utf8'));",
    'delete process.env.PANE_WSL_RUNPANE_ARGS_FILE;',
    `const cli = require(${JSON.stringify(path.resolve(appDirectory, 'bin', 'runpane.cjs'))});`,
    'cli.main(args).then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });',
    '',
  ].join('\n');
}

export function sessionWSLRcFile(workspace: string, record: OrchestrationSessionRecord): string {
  const bin = sessionRuntimePath(path.join(workspace, '.pane-runtime'), record);
  return [
    '# Pane-managed Session shell startup.',
    '[ ! -f "$HOME/.bashrc" ] || . "$HOME/.bashrc"',
    `export PATH=${escapeForBash(bin)}:"$PATH"`,
    `export PANE_RUNPANE_BIN=${escapeForBash(`${bin}/runpane`)}`,
    '',
  ].join('\n');
}
