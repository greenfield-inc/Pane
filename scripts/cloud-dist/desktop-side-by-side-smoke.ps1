# Side-by-side smoke for a Windows desktop test build (rc-desktop.yml).
#
# Installs the released upstream Pane per user (%LOCALAPPDATA%\Programs\Pane, the
# layout on Red's machine), starts it, then starts the test build from its unpacked
# folder with no environment or flags, the way a person double-clicks it. PASS means:
#   - the test build keeps running beside the installed Pane (it did not hand its
#     launch to the installed Pane through the single-instance lock);
#   - its data and Chromium profile are in ~\.pane_<name>, and it wrote nothing
#     into ~\.pane;
#   - the installed Pane's login item and pane:// handler are unchanged.
# Writes results.json and a screenshot to -OutDir. Exits 1 on any failure.
param(
  [Parameter(Mandatory = $true)][string]$TestExe,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion,
  [Parameter(Mandatory = $true)][string]$InstalledSetup,
  [string]$SideBySideName = 'cloudtest',
  [string]$OutDir = 'smoke'
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$results = [ordered]@{}
$failed = $false
function Check([string]$name, [bool]$ok, [string]$detail) {
  $script:results[$name] = [ordered]@{ ok = $ok; detail = $detail }
  if (-not $ok) { $script:failed = $true }
  Write-Host ("{0} {1}: {2}" -f ($(if ($ok) { 'PASS' } else { 'FAIL' })), $name, $detail)
}
function WaitFor([scriptblock]$condition, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (& $condition) { return $true }
    Start-Sleep -Seconds 2
  }
  return [bool](& $condition)
}
function HasFiles([string]$dir) { return @(Get-ChildItem -File -Force $dir -ErrorAction SilentlyContinue).Count -gt 0 }
# By executable path: the silent install may already have started the installed Pane.
function Running([string]$exe) { return [bool](Get-Process -Name Pane -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }) }
function RegistrySnapshot {
  $run = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue
  $runValues = if ($run) { $run.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object { "$($_.Name)=$($_.Value)" } } else { @() }
  $handler = (Get-ItemProperty -Path 'HKCU:\Software\Classes\pane\shell\open\command' -ErrorAction SilentlyContinue).'(default)'
  return [ordered]@{ run = (@($runValues) | Sort-Object) -join "`n"; paneHandler = "$handler" }
}
function Screenshot([string]$path) {
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose(); $bitmap.Dispose()
  } catch { Write-Host "screenshot failed: $_" }
}

$installedDir = Join-Path $HOME '.pane'
$testDir = Join-Path $HOME ".pane_$SideBySideName"
$installedExe = Join-Path $env:LOCALAPPDATA 'Programs\Pane\Pane.exe'

# 1. --version answers before any service starts (and before any data dir is touched).
# Pane.exe is a GUI-subsystem program: PowerShell's `&` neither waits for it nor keeps its stdout.
$versionFile = Join-Path $OutDir 'version.txt'
Start-Process -FilePath $TestExe -ArgumentList '--version' -Wait -NoNewWindow -RedirectStandardOutput $versionFile
$versionOut = Get-Content -Raw $versionFile
Check 'version' ($versionOut.Trim() -eq $ExpectedVersion) "got '$($versionOut.Trim())', want '$ExpectedVersion'"
Check 'version-touches-no-data' (-not (Test-Path $testDir)) "$testDir absent after --version"

# 2. The released Pane, installed and running the way it is on Red's machine.
Start-Process -FilePath $InstalledSetup -ArgumentList '/S' -Wait
Check 'installed-present' (Test-Path $installedExe) $installedExe
Start-Process -FilePath $installedExe | Out-Null
$installedUp = WaitFor { HasFiles $installedDir } 180
Check 'installed-running' ($installedUp -and (Running $installedExe)) "files in $installedDir; $installedExe running"
# The installed Pane writes openrouter-prices.json itself some seconds after startup (run 36727033473
# counted it against the test build): take the "before" listing once it is there.
WaitFor { Test-Path (Join-Path $installedDir 'openrouter-prices.json') } 90 | Out-Null
Start-Sleep -Seconds 15
$before = RegistrySnapshot
$installedEntriesBefore = @(Get-ChildItem -Force $installedDir | ForEach-Object Name | Sort-Object)

# 3. The test build, launched with no environment or flags.
$env:PANE_DIR = $null
Start-Process -FilePath $TestExe | Out-Null
$testUp = WaitFor { (HasFiles $testDir) -and (Test-Path (Join-Path $testDir 'chromium-profile')) } 180
Start-Sleep -Seconds 20
Check 'test-data-dir' $testUp "$testDir has files and chromium-profile: [$(@(Get-ChildItem -Force $testDir -ErrorAction SilentlyContinue | ForEach-Object Name) -join ', ')]"
Check 'test-still-running' (Running $TestExe) "$TestExe alive 20 s after its data dir appeared (not handed to the installed Pane)"
Check 'installed-still-running' (Running $installedExe) "$installedExe"
function TestWindowTitle { return (Get-Process -Name Pane -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $TestExe -and $_.MainWindowTitle } | Select-Object -First 1).MainWindowTitle }
$testWindow = WaitFor { [bool](TestWindowTitle) } 60
Check 'test-window' $testWindow "title '$(TestWindowTitle)'"
Screenshot (Join-Path $OutDir 'side-by-side.png')

$after = RegistrySnapshot
Check 'login-item-unchanged' ($before.run -eq $after.run) "HKCU Run before: [$($before.run)] after: [$($after.run)]"
Check 'pane-link-handler-unchanged' ($before.paneHandler -eq $after.paneHandler) "before: [$($before.paneHandler)] after: [$($after.paneHandler)]"
$installedEntriesAfter = @(Get-ChildItem -Force $installedDir | ForEach-Object Name | Sort-Object)
$added = @($installedEntriesAfter | Where-Object { $installedEntriesBefore -notcontains $_ })
Check 'installed-data-dir-untouched' ($added.Count -eq 0 -and -not (Test-Path (Join-Path $installedDir 'chromium-profile'))) "new entries in ${installedDir}: [$($added -join ', ')]"

# 4. Clean up both apps.
Get-Process -Name Pane -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

$results['result'] = $(if ($failed) { 'FAIL' } else { 'PASS' })
$results | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $OutDir 'results.json')
Write-Host "RESULT $($results['result'])"
if ($failed) { exit 1 }
