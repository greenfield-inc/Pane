# Saves the cloud host from a pairing file into the test build's data dir, then drives the test build
# (proof.mjs) through the host switcher, a terminal on the cloud host, the Session's Ports row (the
# -PortName chip carries -PortUrl and opens it), the Claude "morning" Session and the repo list. The
# pairing code is only ever read from -PairingFile by seed-profile.cjs: it is never
# printed, logged, put on a command line or shown in the app. Screenshots are of the app window only.
#
#   powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\PaneCloudTest\kit\run-proof.ps1"
param(
  [string]$Root = (Join-Path $env:USERPROFILE 'PaneCloudTest'),
  [string]$PairingFile = '',
  [string]$PaneDir = (Join-Path $env:USERPROFILE '.pane_cloudtest'),
  [string]$OutDir = '',
  [string]$HostLabel = '',
  [string]$Repo = 'Hello-World',
  [string]$HostnamePrefix = 'box-node-',
  [string]$Session = 'morning',
  [string]$OptionalRepo = 'montlakev2',
  [string]$PortName = 'taste',
  [string]$PortUrl = '',
  [switch]$OpenInBrowser,
  [switch]$NoClaudeReply,
  [switch]$SkipSeed,
  [switch]$CloseRunning
)
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath($Root)
if (-not $PairingFile) { $PairingFile = Join-Path $Root 'pairing.txt' }
if (-not $OutDir) { $OutDir = Join-Path $Root ("evidence\" + (Get-Date -Format 'yyyyMMdd-HHmmss')) }
$PaneDir = [IO.Path]::GetFullPath($PaneDir)
if ($PaneDir.TrimEnd('\').Equals([IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.pane')), 'OrdinalIgnoreCase')) {
  throw 'Refusing: -PaneDir is the installed Pane data dir'
}
$exe = Join-Path $Root 'app\Pane.exe'
$kit = Join-Path $Root 'kit'
foreach ($path in @($exe, (Join-Path $kit 'proof.mjs'), (Join-Path $kit 'node_modules\playwright-core'))) {
  if (-not (Test-Path $path)) { throw "Missing $path; run install.ps1 first" }
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# The proof starts its own copy of the test build, and a running one would hold the single-instance lock.
# Someone may be working in it, so it is closed only when asked. Only processes started from this
# folder: the installed Pane is never touched.
$running = @(Get-Process -Name Pane -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith("$Root\", 'OrdinalIgnoreCase') })
if ($running.Count -gt 0) {
  if (-not $CloseRunning) { throw "The test build is running ($($running.Count) processes from $Root\app). Close its window, or re-run with -CloseRunning to close it." }
  Write-Host "Closing the running test build ($($running.Count) processes)"
  $running | Stop-Process -Force
  Start-Sleep -Seconds 2
}

# Runs the test build's Pane.exe as Node. It is a GUI program, so PowerShell only waits for it and sees
# its output through Start-Process with redirection.
function RunAsNode([string]$name, [string[]]$arguments) {
  $stdout = Join-Path $OutDir "$name.out.txt"
  $stderr = Join-Path $OutDir "$name.err.txt"
  $quoted = ($arguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
  $env:ELECTRON_RUN_AS_NODE = '1'
  try {
    $process = Start-Process -FilePath $exe -ArgumentList $quoted -WorkingDirectory $kit -Wait -NoNewWindow -PassThru `
      -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  } finally {
    Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  }
  Get-Content $stdout, $stderr -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
  return $process.ExitCode
}

if (-not $SkipSeed) {
  if (-not (Test-Path $PairingFile)) { throw "No pairing file at $PairingFile" }
  $others = @((Get-Acl $PairingFile).Access | Where-Object {
      $_.IdentityReference.Value -notmatch '\\' + [regex]::Escape($env:USERNAME) + '$' -and
      $_.IdentityReference.Value -notmatch '^(NT AUTHORITY\\SYSTEM|BUILTIN\\Administrators)$' })
  if ($others.Count -gt 0) {
    Write-Warning "The pairing file is readable by: $(($others | ForEach-Object { $_.IdentityReference.Value }) -join ', ')"
  }
  $code = RunAsNode 'seed' @((Join-Path $kit 'seed-profile.cjs'), $PairingFile, $PaneDir)
  if ($code -ne 0) { throw "seed-profile failed ($code)" }
}

$env:PANE_EXE = $exe
$env:PANE_DIR = $PaneDir
$env:OUT = $OutDir
$env:HOST_LABEL = $HostLabel
$env:REPO = $Repo
$env:HOSTNAME_PREFIX = $HostnamePrefix
$env:SESSION = $Session
$env:OPTIONAL_REPO = $OptionalRepo
$env:CLAUDE_REPLY = $(if ($NoClaudeReply) { '0' } else { '1' })
$env:PORT_NAME = $PortName
$env:PORT_URL = $PortUrl
$env:OPEN_IN_BROWSER = $(if ($OpenInBrowser) { '1' } else { '0' })
try {
  $code = RunAsNode 'proof' @((Join-Path $kit 'proof.mjs'))
} finally {
  foreach ($name in 'PANE_EXE', 'PANE_DIR', 'OUT', 'HOST_LABEL', 'REPO', 'HOSTNAME_PREFIX', 'SESSION', 'OPTIONAL_REPO', 'CLAUDE_REPLY', 'PORT_NAME', 'PORT_URL', 'OPEN_IN_BROWSER') {
    Remove-Item "Env:\$name" -ErrorAction SilentlyContinue
  }
}
Write-Host "Evidence: $OutDir"
Get-ChildItem $OutDir -Filter *.png | ForEach-Object { Write-Host "  $($_.Name)" }
exit $code
