# Measures how the test build feels on a cloud host (measure-latency.mjs): keystroke echo, wheel scrolling in a
# fullscreen TUI (latency-tui.py, started with python3 on the host), terminal tab and Pane switches. Writes
# latency.json + steps.log to -OutDir. Only numbers are recorded (no terminal text, no tokens, no screenshots).
# It uses the host already saved in the test build (no pairing file is read).
#
#   powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\PaneCloudTest\kit\measure-latency.ps1" -HostLabel Scratch
param(
  [string]$Root = (Join-Path $env:USERPROFILE 'PaneCloudTest'),
  [string]$PaneDir = (Join-Path $env:USERPROFILE '.pane_cloudtest'),
  [string]$OutDir = '',
  [string]$HostLabel = '',
  [string]$Repo = 'Hello-World',
  [string]$PaneName = 'sobeck-check',
  [string]$Skip = '',
  [switch]$ClaudeProbe,
  [switch]$CloseRunning
)
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath($Root)
if (-not $OutDir) { $OutDir = Join-Path $Root ("latency\" + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
$PaneDir = [IO.Path]::GetFullPath($PaneDir)
if ($PaneDir.TrimEnd('\').Equals([IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.pane')), 'OrdinalIgnoreCase')) {
  throw 'Refusing: -PaneDir is the installed Pane data dir'
}
$exe = Join-Path $Root 'app\Pane.exe'
$kit = Join-Path $Root 'kit'
foreach ($path in @($exe, (Join-Path $kit 'measure-latency.mjs'), (Join-Path $kit 'latency-tui.py'), (Join-Path $kit 'node_modules\playwright-core'))) {
  if (-not (Test-Path $path)) { throw "Missing $path; run install.ps1 first (or copy measure-latency.mjs and latency-tui.py into $kit)" }
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# The measurement starts its own copy of the test build; a running one would hold the single-instance lock.
$running = @(Get-Process -Name Pane -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith("$Root\", 'OrdinalIgnoreCase') })
if ($running.Count -gt 0) {
  if (-not $CloseRunning) { throw "The test build is running ($($running.Count) processes from $Root\app). Close its window, or re-run with -CloseRunning to close it." }
  Write-Host "Closing the running test build ($($running.Count) processes)"
  $running | Stop-Process -Force
  Start-Sleep -Seconds 2
}

$names = 'PANE_EXE', 'PANE_DIR', 'OUT', 'HOST_LABEL', 'REPO', 'PANE_NAME', 'SKIP', 'CLAUDE_PROBE', 'ELECTRON_RUN_AS_NODE'
$env:PANE_EXE = $exe
$env:PANE_DIR = $PaneDir
$env:OUT = $OutDir
$env:HOST_LABEL = $HostLabel
$env:REPO = $Repo
$env:PANE_NAME = $PaneName
$env:SKIP = $Skip
$env:CLAUDE_PROBE = $(if ($ClaudeProbe) { '1' } else { '0' })
$env:ELECTRON_RUN_AS_NODE = '1'
$stdout = Join-Path $OutDir 'measure.out.txt'
$stderr = Join-Path $OutDir 'measure.err.txt'
try {
  $process = Start-Process -FilePath $exe -ArgumentList ('"' + (Join-Path $kit 'measure-latency.mjs') + '"') -WorkingDirectory $kit `
    -Wait -NoNewWindow -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
} finally {
  foreach ($name in $names) { Remove-Item "Env:\$name" -ErrorAction SilentlyContinue }
}
Get-Content $stdout, $stderr -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
Write-Host "Results: $(Join-Path $OutDir 'latency.json')"
exit $process.ExitCode
