# Installs the Pane desktop side-by-side test build and its proof kit from a fork prerelease, next to
# (never over) an installed Pane. Everything lands in one folder, by default %USERPROFILE%\PaneCloudTest:
#   app\        the unpacked test build (app\Pane.exe)
#   kit\        seed-profile.cjs, proof.mjs, run-proof.ps1, remove.ps1, node_modules\playwright-core
#   downloads\  the verified zips
# Nothing else is written: no installer, registry, Start menu or PATH change. The test build keeps its
# data in %USERPROFILE%\.pane_cloudtest once it runs. Undo with kit\remove.ps1.
#
# Over an earlier install it upgrades in place: app\ and kit\ are replaced; pairing.txt and the data dir
# (saved hosts, Chromium profile) are kept. -Fresh also resets the data dir (pairing.txt stays, so
# run-proof.ps1 without -SkipSeed saves the host again). A running test build is only closed with
# -CloseRunning.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Tag rc-desktop-<sha8> -AppSha256 <hex> -KitSha256 <hex>
param(
  [Parameter(Mandatory = $true)][string]$Tag,
  [Parameter(Mandatory = $true)][string]$AppSha256,
  [Parameter(Mandatory = $true)][string]$KitSha256,
  [string]$Repo = 'jamari-morrison/Pane',
  [string]$Root = (Join-Path $env:USERPROFILE 'PaneCloudTest'),
  [string]$PaneDir = (Join-Path $env:USERPROFILE '.pane_cloudtest'),
  [switch]$Fresh,
  [switch]$CloseRunning
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = [IO.Path]::GetFullPath($Root)
$PaneDir = [IO.Path]::GetFullPath($PaneDir)
$installedPane = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\Pane'))
$installedData = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.pane'))
foreach ($protected in @($installedPane, $installedData)) {
  foreach ($target in @($Root, $PaneDir)) {
    if ($target.TrimEnd('\').Equals($protected, 'OrdinalIgnoreCase') -or $target.StartsWith("$protected\", 'OrdinalIgnoreCase') -or $protected.StartsWith("$target\", 'OrdinalIgnoreCase')) {
      throw "Refusing to install into or around $protected"
    }
  }
}
if ($PaneDir.TrimEnd('\').Equals([IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\'), 'OrdinalIgnoreCase')) { throw 'Refusing: -PaneDir is the home folder' }
if ($Repo -like 'greenfield-inc/*') { throw "Refusing: $Repo is upstream; test builds come from the fork" }

$downloads = Join-Path $Root 'downloads'
New-Item -ItemType Directory -Force -Path $downloads | Out-Null
$base = "https://github.com/$Repo/releases/download/$Tag"
$sums = Invoke-WebRequest -UseBasicParsing "$base/SHA256SUMS.txt"
$sumsText = [Text.Encoding]::UTF8.GetString($sums.Content)
function AssetName([string]$pattern) {
  $line = $sumsText -split "`n" | Where-Object { $_ -match $pattern } | Select-Object -First 1
  if (-not $line) { throw "No asset matching $pattern in $Tag" }
  return ($line -split '\s+', 2)[1].Trim().TrimStart('*')
}
function Fetch([string]$name, [string]$expected) {
  $file = Join-Path $downloads $name
  Write-Host "Downloading $name"
  Invoke-WebRequest -UseBasicParsing "$base/$name" -OutFile $file
  $actual = (Get-FileHash -Algorithm SHA256 $file).Hash.ToLower()
  if ($actual -ne $expected.ToLower()) {
    Remove-Item -Force $file
    throw "SHA-256 mismatch for ${name}: got $actual, expected $expected. Nothing was installed."
  }
  Write-Host "  sha256 $actual OK"
  Unblock-File $file
  return $file
}
function AppVersion([string]$exe, [string]$file) {
  Start-Process -FilePath $exe -ArgumentList '--version' -Wait -NoNewWindow -RedirectStandardOutput $file
  return (Get-Content -Raw $file).Trim()
}
$exe = Join-Path $Root 'app\Pane.exe'
$previous = if (Test-Path $exe) { AppVersion $exe (Join-Path $downloads 'previous-version.txt') } else { $null }

# A running test build holds its files open. Someone may be working in it, so it is closed only when
# asked, and only processes started from this folder.
$running = @(Get-Process -Name Pane -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith("$Root\", 'OrdinalIgnoreCase') })
if ($running.Count -gt 0) {
  if (-not $CloseRunning) { throw "The test build is running from $Root\app. Close its window, or re-run with -CloseRunning to close it. Nothing was changed." }
  Write-Host "Closing the running test build ($($running.Count) processes)"
  $running | Stop-Process -Force
  Start-Sleep -Seconds 2
}

$appZip = Fetch (AssetName '-Windows-x64\.zip$') $AppSha256
$kitZip = Fetch (AssetName 'relay-kit.*\.zip$') $KitSha256

foreach ($pair in @(@($appZip, 'app'), @($kitZip, 'kit'))) {
  $target = Join-Path $Root $pair[1]
  $staging = Join-Path $Root "$($pair[1]).staging"
  foreach ($dir in @($target, $staging)) { if (Test-Path $dir) { Remove-Item -Recurse -Force $dir } }
  Expand-Archive -Path $pair[0] -DestinationPath $staging
  $inner = @(Get-ChildItem $staging)
  # Each zip holds one top-level folder; its contents become app\ or kit\.
  if ($inner.Count -eq 1 -and $inner[0].PSIsContainer) { Move-Item $inner[0].FullName $target; Remove-Item -Recurse -Force $staging }
  else { Move-Item $staging $target }
}
if (-not (Test-Path $exe)) { throw "Pane.exe missing after unpacking: $exe" }
$version = AppVersion $exe (Join-Path $downloads 'version.txt')

if ($Fresh -and (Test-Path $PaneDir)) {
  Remove-Item -Recurse -Force $PaneDir
  Write-Host "Fresh: removed the test data dir $PaneDir"
}
# What was kept, without reading anything secret: saved host labels only, never their tokens.
$pairing = Join-Path $Root 'pairing.txt'
$hosts = @()
$configFile = Join-Path $PaneDir 'config.json'
if (Test-Path $configFile) {
  try { $hosts = @((Get-Content -Raw $configFile | ConvertFrom-Json).remoteDaemon.client.profiles | ForEach-Object { $_.label }) } catch { $hosts = @('(config.json unreadable)') }
}
if ($previous) { Write-Host "Upgraded test build $previous -> $version at $exe" } else { Write-Host "Installed test build $version at $exe" }
Write-Host "Proof kit at $(Join-Path $Root 'kit')"
Write-Host "Pairing file: $(if (Test-Path $pairing) { 'kept' } else { 'none yet' }) ($pairing)"
Write-Host "Test data: $(if (Test-Path $PaneDir) { "kept, saved hosts: $(if ($hosts.Count) { $hosts -join ', ' } else { 'none' })" } else { 'none yet' }) ($PaneDir)"
Write-Host "Installed Pane untouched: $installedPane"
