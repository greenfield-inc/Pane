# R3.5: drives the test build (session-proof.mjs) to create a FRESH Pane in a repo on the saved cloud host,
# and proves from that Pane's terminal and from this machine: the repo manifest's secrets are there (names
# only), `runpane port open` of a tiny server gives a Ports chip whose URL answers 200 here
# (Invoke-WebRequest), and the GitHub broker opens a TEST issue and a DRAFT PR from cloud/<host>/<branch>,
# refuses a push to master, and closes both again. Then it zips the evidence and checks that no saved host
# token or pairing code is in it.
#
# Uses the host run-proof.ps1 already saved (no pairing step). The pairing code is never read here.
#
#   powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\PaneCloudTest\kit\run-session-proof.ps1"
param(
  [string]$Root = (Join-Path $env:USERPROFILE 'PaneCloudTest'),
  [string]$PaneDir = (Join-Path $env:USERPROFILE '.pane_cloudtest'),
  [string]$OutDir = '',
  [string]$HostLabel = '',
  [string]$Repo = 'montlakev2',
  [int]$Port = 0,
  [switch]$NoGitHub,
  [switch]$KeepPane,
  [switch]$OpenInBrowser,
  [switch]$CloseRunning
)
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath($Root)
if (-not $OutDir) { $OutDir = Join-Path $Root ("evidence\r35-" + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
$PaneDir = [IO.Path]::GetFullPath($PaneDir)
if ($PaneDir.TrimEnd('\').Equals([IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.pane')), 'OrdinalIgnoreCase')) {
  throw 'Refusing: -PaneDir is the installed Pane data dir'
}
$exe = Join-Path $Root 'app\Pane.exe'
$kit = Join-Path $Root 'kit'
$config = Join-Path $PaneDir 'config.json'
foreach ($path in @($exe, (Join-Path $kit 'session-proof.mjs'), (Join-Path $kit 'session-checks.sh'), (Join-Path $kit 'node_modules\playwright-core'))) {
  if (-not (Test-Path $path)) { throw "Missing $path; run sobeck-install.ps1 first" }
}
if (-not (Test-Path $config)) { throw "No saved host in $config; run run-proof.ps1 once first (it saves the host from pairing.txt)" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# As run-proof.ps1: a running test build holds the single-instance lock, and someone may be working in it.
$running = @(Get-Process -Name Pane -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith("$Root\", 'OrdinalIgnoreCase') })
if ($running.Count -gt 0) {
  if (-not $CloseRunning) { throw "The test build is running ($($running.Count) processes from $Root\app). Close its window, or re-run with -CloseRunning to close it." }
  Write-Host "Closing the running test build ($($running.Count) processes)"
  $running | Stop-Process -Force
  Start-Sleep -Seconds 2
}

$stdout = Join-Path $OutDir 'session-proof.out.txt'
$stderr = Join-Path $OutDir 'session-proof.err.txt'
$names = @{
  PANE_EXE = $exe; PANE_DIR = $PaneDir; OUT = $OutDir; HOST_LABEL = $HostLabel; REPO = $Repo
  PORT = $(if ($Port -gt 0) { "$Port" } else { '' })
  GITHUB = $(if ($NoGitHub) { '0' } else { '1' })
  KEEP_PANE = $(if ($KeepPane) { '1' } else { '0' })
  OPEN_IN_BROWSER = $(if ($OpenInBrowser) { '1' } else { '0' })
  ELECTRON_RUN_AS_NODE = '1'
}
foreach ($name in $names.Keys) { Set-Item "Env:\$name" $names[$name] }
try {
  $process = Start-Process -FilePath $exe -ArgumentList "`"$(Join-Path $kit 'session-proof.mjs')`"" -WorkingDirectory $kit -Wait -NoNewWindow -PassThru `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $code = $process.ExitCode
} finally {
  foreach ($name in $names.Keys) { Remove-Item "Env:\$name" -ErrorAction SilentlyContinue }
}
Get-Content $stdout, $stderr -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }

# No saved host token and no pairing code in anything the proof wrote.
$tokens = @((Get-Content -Raw $config | ConvertFrom-Json).remoteDaemon.client.profiles | ForEach-Object { $_.token } | Where-Object { $_ })
$leaks = @(Get-ChildItem -Recurse -File $OutDir | Where-Object {
    $text = [IO.File]::ReadAllText($_.FullName)
    $text.Contains('pane-remote://') -or @($tokens | Where-Object { $text.Contains($_) }).Count -gt 0 })
if ($leaks.Count -gt 0) {
  Write-Host "FAIL no-secrets-in-evidence: found in $(($leaks | ForEach-Object Name) -join ', '); not zipped"
  exit 1
}
Write-Host "PASS no-secrets-in-evidence ($($tokens.Count) saved host token(s) and pairing codes searched in $(@(Get-ChildItem -Recurse -File $OutDir).Count) files)"
$zip = "$OutDir.zip"
Compress-Archive -Path "$OutDir\*" -DestinationPath $zip -Force
Write-Host "Evidence: $OutDir"
Write-Host "Zip: $zip"
exit $code
