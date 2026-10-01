# CI only (rc-desktop.yml relay-proof): stands in for the cloud Session on a Windows runner that has no
# tailnet. It pairs and starts a real headless Pane daemon from the test build on loopback, registers two
# git repos (Hello-World, montlakev2) and a "morning" Session with the fork's runpane CLI, and writes the
# daemon's pane-remote:// code to -PairingFile the way the relay does on SOBECK. The code is never printed.
#
# Session ports: the daemon's ports service reads Tailscale through the `tailscale` CLI. A fake
# tailscale.exe, on the PATH of this daemon only, reports a running node named "localhost" whose Serve
# config starts with one web entry, tailnet :$PortsPort -> http://127.0.0.1:$PortsPort; ports.json names it
# "taste" (plain http: no certificate on a runner), and a small HTTP server answers behind it. The desktop
# then shows a real "taste" chip whose URL is http://localhost:$PortsPort/. `serve --bg`/`off` change the
# fake's entries, so `runpane port open|close` in the fake host's terminal work too (R3.5's proof).
#
# The fake host's terminals use Git Bash (preferredShell), as a cloud Session's terminals use bash: R3.5's
# session-checks.sh runs in one.
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$PairingFile,
  [Parameter(Mandatory = $true)][string]$RunpaneCli,
  [string]$HostDir = 'C:\rc-fake-host',
  [string]$ReposDir = 'C:\rc-fake-repos',
  [string]$Label = 'Scratch',
  [int]$Port = 42199,
  [int]$PortsPort = 8443
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $HostDir, $ReposDir | Out-Null

$fakeBin = Join-Path $HostDir 'fake-tailscale'
New-Item -ItemType Directory -Force -Path $fakeBin | Out-Null
$fakeSource = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
class FakeTailscale {
  // Serve entries, one per line: "<tailnet port> <http|https> <proxy target>". `serve --bg --http=P <target>`
  // adds one and `serve --http=P off` removes it, so `runpane port open|close` work against this fake too.
  static int Main(string[] args) {
    string dir = AppDomain.CurrentDomain.BaseDirectory;
    string joined = string.Join(" ", args);
    File.AppendAllText(Path.Combine(dir, "calls.log"), joined + Environment.NewLine);
    string state = Path.Combine(dir, "serve-entries.txt");
    List<string> entries = File.ReadAllLines(state).Where(l => l.Trim().Length > 0).ToList();
    if (joined == "status --json") { Console.Write(File.ReadAllText(Path.Combine(dir, "status.json"))); return 0; }
    if (joined == "serve status --json") {
      var tcp = entries.Select(e => e.Split(' ')).Select(p => "\"" + p[0] + "\":{\"" + (p[1] == "https" ? "HTTPS" : "HTTP") + "\":true}");
      var web = entries.Select(e => e.Split(' ')).Select(p => "\"localhost:" + p[0] + "\":{\"Handlers\":{\"/\":{\"Proxy\":\"" + p[2] + "\"}}}");
      Console.Write("{\"TCP\":{" + string.Join(",", tcp) + "},\"Web\":{" + string.Join(",", web) + "}}");
      return 0;
    }
    string flag = args.Length > 1 && args[0] == "serve" ? args.FirstOrDefault(a => a.StartsWith("--http=") || a.StartsWith("--https=")) : null;
    if (flag != null) {
      string scheme = flag.Substring(2, flag.IndexOf('=') - 2);
      string port = flag.Substring(flag.IndexOf('=') + 1);
      entries.RemoveAll(e => e.Split(' ')[0] == port);
      if (args[args.Length - 1] != "off") entries.Add(port + " " + scheme + " " + args[args.Length - 1]);
      File.WriteAllLines(state, entries.ToArray());
    }
    return 0;
  }
}
'@
Set-Content -Path (Join-Path $fakeBin 'FakeTailscale.cs') -Value $fakeSource
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" -nologo -out:(Join-Path $fakeBin 'tailscale.exe') (Join-Path $fakeBin 'FakeTailscale.cs') | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'could not compile the fake tailscale.exe' }
Set-Content -Path (Join-Path $fakeBin 'status.json') -Value '{"BackendState":"Running","Self":{"DNSName":"localhost."}}'
Set-Content -Path (Join-Path $fakeBin 'serve-entries.txt') -Value "$PortsPort http http://127.0.0.1:$PortsPort"
# A daemon is in a Runpane Cloud Session when /etc/rp-cloud/serve.json exists (bootstrap writes it); Node
# on Windows reads that path from the current drive, so write it on the system drive and on this one.
foreach ($drive in @($env:SystemDrive, "$((Get-Location).Drive.Name):") | Select-Object -Unique) {
  New-Item -ItemType Directory -Force -Path "$drive\etc\rp-cloud" | Out-Null
  Set-Content -Path "$drive\etc\rp-cloud\serve.json" -Value "{`"port`":$Port}"
}
$portsDir = Join-Path $env:USERPROFILE '.runpane-cloud'
New-Item -ItemType Directory -Force -Path $portsDir | Out-Null
Set-Content -Path (Join-Path $portsDir 'ports.json') -Value (@{
    version = 1; autoOpen = $false; dismissed = @()
    ports = @(@{ name = 'taste'; port = $PortsPort; httpsPort = $PortsPort; scheme = 'http'; path = '/'; source = 'user'; createdAt = (Get-Date).ToUniversalTime().ToString('o') })
  } | ConvertTo-Json -Depth 6)
$server = Join-Path $HostDir 'taste-stand-in.cjs'
Set-Content -Path $server -Value "require('node:http').createServer((q, r) => r.end('taste stand-in')).listen($PortsPort);"
Start-Process -FilePath node -ArgumentList "`"$server`"" -WindowStyle Hidden | Out-Null
Write-Host "Session ports stand-in: fake tailscale.exe, ports.json taste -> http://localhost:$PortsPort/"

$setupOut = Join-Path $HostDir 'setup.out.txt'
$setup = Start-Process -FilePath $Exe -Wait -NoNewWindow -PassThru -RedirectStandardOutput $setupOut -RedirectStandardError (Join-Path $HostDir 'setup.err.txt') `
  -ArgumentList "--remote-setup --label $Label --pane-dir `"$HostDir`" --listen-port $Port --prefer-tunnel manual --base-url http://127.0.0.1:$Port --no-install-service"
if ($setup.ExitCode -ne 0) { throw "remote setup exited $($setup.ExitCode)" }
if (-not (Select-String -Path $setupOut -Pattern 'pane-remote://' -Quiet)) { throw 'remote setup printed no pane-remote:// code' }
# Keep only the fields a cloud Session's code has (no tunnel): the desktop reaches this host directly.
New-Item -ItemType Directory -Force -Path (Split-Path $PairingFile) | Out-Null
$rewrite = @'
const fs = require('node:fs');
const [setupOut, pairingFile, port] = process.argv.slice(2);
const code = fs.readFileSync(setupOut, 'utf8').match(/pane-remote:\/\/[A-Za-z0-9_-]+/)[0];
const payload = JSON.parse(Buffer.from(code.slice('pane-remote://'.length), 'base64url').toString('utf8'));
const direct = { v: 1, label: payload.label, baseUrl: `http://127.0.0.1:${port}`, token: payload.token, transport: 'http+sse' };
fs.writeFileSync(pairingFile, `pane-remote://${Buffer.from(JSON.stringify(direct)).toString('base64url')}`);
'@
$rewriteFile = Join-Path $HostDir 'rewrite-code.cjs'
Set-Content -Path $rewriteFile -Value $rewrite
node $rewriteFile $setupOut $PairingFile $Port
if ($LASTEXITCODE -ne 0) { throw 'could not rewrite the pairing code' }
Remove-Item $setupOut
Write-Host "Wrote the fake host's pairing code to $PairingFile (not shown)"

$hostConfig = (Get-Content -Raw (Join-Path $HostDir 'config.json') | ConvertFrom-Json).remoteDaemon.host.config
Write-Host "fake host config: enabled=$($hostConfig.enabled) listen=$($hostConfig.listenHost):$($hostConfig.listenPort)"

# Pinned rather than left to "auto" (which also prefers Git Bash when it is installed).
node -e "const fs=require('fs');const f=process.argv[1];const c=JSON.parse(fs.readFileSync(f,'utf8'));c.preferredShell='gitbash';fs.writeFileSync(f,JSON.stringify(c,null,2))" (Join-Path $HostDir 'config.json')
if ($LASTEXITCODE -ne 0) { throw 'could not set the fake host shell' }

# cmd owns the output files, so the daemon never writes into a pipe that dies with this PowerShell.
# The fake tailscale.exe is on this daemon's PATH only (a child keeps the PATH it started with).
$daemonCmd = "`"$Exe`" --daemon-headless --pane-dir `"$HostDir`" > `"$HostDir\daemon.out.txt`" 2> `"$HostDir\daemon.err.txt`""
$pathBefore = $env:PATH
$env:PATH = "$fakeBin;$pathBefore"
# cmd /c strips the first and last quote of a line that starts with one: wrap it in one more pair.
try { Start-Process -FilePath cmd.exe -ArgumentList '/d', '/s', '/c', "`"$daemonCmd`"" -WindowStyle Hidden | Out-Null } finally { $env:PATH = $pathBefore }
$deadline = (Get-Date).AddSeconds(120)
$healthy = $false
while (-not $healthy -and (Get-Date) -lt $deadline) {
  try { $healthy = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/health" -TimeoutSec 3).StatusCode -eq 200 } catch { Start-Sleep -Seconds 2 }
}
if (-not $healthy) {
  Write-Host '--- daemon processes'
  Get-CimInstance Win32_Process -Filter "Name = 'Pane.exe'" | Where-Object { $_.CommandLine -like '*daemon-headless*' } | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }
  Write-Host '--- listeners'
  netstat -ano -p tcp | Select-String 'LISTENING' | Select-Object -First 40
  foreach ($file in 'daemon.out.txt', 'daemon.err.txt') { Write-Host "--- $file"; Get-Content (Join-Path $HostDir $file) -Tail 60 -ErrorAction SilentlyContinue }
  Write-Host '--- daemon log'
  Get-ChildItem (Join-Path $HostDir 'logs') -File -ErrorAction SilentlyContinue | Get-Content -Tail 60
  throw 'fake host daemon never answered /health'
}
Write-Host "Fake host daemon healthy on 127.0.0.1:$Port"

foreach ($name in 'Hello-World', 'montlakev2') {
  $repo = Join-Path $ReposDir $name
  New-Item -ItemType Directory -Force -Path $repo | Out-Null
  git -C $repo init -q -b main
  Set-Content -Path (Join-Path $repo 'README.md') -Value "# $name"
  git -C $repo add README.md
  git -C $repo -c user.name=ci -c user.email=ci@invalid commit -q -m init
  node $RunpaneCli repos add --path $repo --name $name --yes --json --pane-dir $HostDir
  if ($LASTEXITCODE -ne 0) { throw "runpane repos add $name failed" }
}
'{"name":"morning","agent":"claude"}' | node $RunpaneCli sessions create --from-json - --json --pane-dir $HostDir
if ($LASTEXITCODE -ne 0) { throw 'runpane sessions create failed' }
node $RunpaneCli sessions list --json --pane-dir $HostDir | Select-String -SimpleMatch '"morning"' | Out-Null
