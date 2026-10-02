import path from 'path';
import { escapeForBash } from '../utils/wslUtils';
import { sessionRuntimePath } from './sessionRuntime';
import type { OrchestrationSessionRecord } from '../../../shared/types/orchestrationSession';

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Run the bundled Windows CLI, which can open this instance's named pipe. */
export function sessionWSLBridge(appDirectory: string, record: OrchestrationSessionRecord, launcherPath: string, execPath = process.execPath): string {
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
    'pane_windows_path() {',
    String.raw`  case "$1" in -|[A-Za-z]:*|\\*) printf %s "$1" ;; *) wslpath -aw "$1" ;; esac`,
    '}',
    `panel_id=\${PANE_PANEL_ID:-${escapeForBash(record.panelIds[record.agent])}}`,
    "panel_id=${panel_id//\\'/\\'\\'}",
    `command=${escapeForBash(`${command}; $env:PANE_PANEL_ID = `)}`,
    'command+="\'$panel_id\'; \\$paneArgs = @("',
    'path_arg=false',
    'for arg in "$@"; do',
    '  if "$path_arg"; then arg=$(pane_windows_path "$arg"); fi',
    '  path_arg=false',
    '  key=${arg%%=*}',
    '  case "$key" in',
    '    --pane-dir|--pane-path|--download-dir|--file|--path|--input-file|--initial-input-file|--prompt-file|--body-file|--summary-file|--from-json)',
    '      if [[ "$arg" == *=* ]]; then arg="$key=$(pane_windows_path "${arg#*=}")"; else path_arg=true; fi ;;',
    '  esac',
    // PowerShell single-quoted strings escape an apostrophe by doubling it.
    "  arg=${arg//\\'/\\'\\'}",
    '  command+="\'$arg\',"',
    'done',
    `command+=${escapeForBash(`${quotePowerShell('--pane-dir')},${quotePowerShell(appDirectory)}); $env:PANE_WSL_RUNPANE_ARGS_FILE = $PSCommandPath + '.json'; [System.IO.File]::WriteAllText($env:PANE_WSL_RUNPANE_ARGS_FILE, (ConvertTo-Json -InputObject $paneArgs -Compress), [System.Text.UTF8Encoding]::new($false)); & ${quotePowerShell(execPath)} ${quotePowerShell(launcherPath)}; exit $LASTEXITCODE`)}`,
    // Keep payloads off the Windows command line and preserve stdin for the CLI.
    `script=$(mktemp ${escapeForBash(`${sessionRuntimePath(path.dirname(launcherPath), record)}/bridge-XXXXXX.ps1`)})`,
    'trap \'rm -f -- "$script" "$script.json"\' EXIT',
    String.raw`{ printf '\xff\xfe'; printf %s "$command" | iconv -f UTF-8 -t UTF-16LE; } > "$script"`,
    `${escapeForBash(powershell)} -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$(wslpath -aw "$script")"`,
    '',
  ].join('\n');
}

/** JSON avoids Windows PowerShell's lossy native argument quoting. */
export function sessionWSLLauncher(appDirectory: string): string {
  return [
    "const args = JSON.parse(require('node:fs').readFileSync(process.env.PANE_WSL_RUNPANE_ARGS_FILE, 'utf8'));",
    'delete process.env.PANE_WSL_RUNPANE_ARGS_FILE;',
    `const cli = require(${JSON.stringify(path.join(appDirectory, 'bin', 'runpane.cjs'))});`,
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
