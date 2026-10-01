# Removes the side-by-side test build: stops processes started from its folder, then deletes the folder
# (app, kit, downloads, evidence, pairing file) and its data dir. The installed Pane is not touched.
#
#   powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\PaneCloudTest\kit\remove.ps1" -KeepEvidence
param(
  [string]$Root = (Join-Path $env:USERPROFILE 'PaneCloudTest'),
  [string]$PaneDir = (Join-Path $env:USERPROFILE '.pane_cloudtest'),
  [switch]$KeepEvidence
)
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath($Root)
$PaneDir = [IO.Path]::GetFullPath($PaneDir)
foreach ($protected in @((Join-Path $env:USERPROFILE '.pane'), (Join-Path $env:LOCALAPPDATA 'Programs\Pane'), $env:USERPROFILE)) {
  $protected = [IO.Path]::GetFullPath($protected).TrimEnd('\')
  foreach ($target in @($Root, $PaneDir)) {
    if ($target.TrimEnd('\').Equals($protected, 'OrdinalIgnoreCase')) { throw "Refusing to delete $protected" }
  }
}
Get-Process -Name Pane -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith("$Root\", 'OrdinalIgnoreCase') } | Stop-Process -Force
Start-Sleep -Seconds 2
if ($KeepEvidence -and (Test-Path (Join-Path $Root 'evidence'))) {
  $kept = Join-Path $env:USERPROFILE ("PaneCloudTest-evidence-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  Move-Item (Join-Path $Root 'evidence') $kept
  Write-Host "Evidence kept at $kept"
}
foreach ($target in @($Root, $PaneDir)) {
  if (Test-Path $target) { Remove-Item -Recurse -Force $target; Write-Host "Removed $target" }
}
Write-Host 'The installed Pane and its data were not touched.'
