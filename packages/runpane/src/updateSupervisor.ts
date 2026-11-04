import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { RunpaneError } from './errors';

export interface UpdateSupervisorJob {
  id: string;
  directory: string;
  executable: string;
  args: string[];
}

function windowsTool(name: string): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', name);
}

function run(file: string, args: string[]): string {
  try { return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim(); }
  catch (error) { throw new RunpaneError('ERR_UPDATE_SUPERVISOR', `The current-user supervisor command failed: ${error instanceof Error ? error.message : String(error)}`, 'Inspect the operation status. Before shutdown Pane remains running; enable the current-user OS supervisor or use the installer manually.'); }
}

function xml(value: string): string {
  return value.replace(/[<>&"']/g, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character]!);
}

function jobName(id: string): string {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new RunpaneError('ERR_UPDATE_ID', 'The update operation ID is invalid. Nothing was changed.', 'Use the ID returned by runpane update.');
  return `com.pane.update.${id}`;
}

/** Refuse before downtime when the current user's independent supervisor is unavailable. */
export function checkUpdateSupervisor(): void {
  if (process.platform === 'darwin') run('/bin/launchctl', ['print', `gui/${process.getuid!()}`]);
  else if (process.platform === 'win32') run(windowsTool('schtasks.exe'), ['/Query', '/FO', 'CSV', '/NH']);
  else if (process.platform === 'linux') run('systemctl', ['--user', 'show-environment']);
  else throw new RunpaneError('ERR_UPDATE_PLATFORM', `Independent updates are unavailable on ${process.platform}. Nothing was changed.`, 'Use the supported installer on the owning host.');
}

/** Launch through an OS service manager, never an inherited PTY/process tree. */
export function startUpdateSupervisor(job: UpdateSupervisorJob): void {
  const name = jobName(job.id);
  if (!path.isAbsolute(job.executable) || !path.isAbsolute(job.directory)) {
    throw new RunpaneError('ERR_UPDATE_PATH', 'Update helper paths must be absolute. Nothing was changed.', 'Run update again from the supported CLI installation.');
  }
  fs.mkdirSync(job.directory, { recursive: true, mode: 0o700 });
  if (process.platform === 'darwin') {
    const file = path.join(job.directory, 'supervisor.plist');
    fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${name}</string>
<key>ProgramArguments</key><array>${[job.executable, ...job.args].map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(job.directory)}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>5</integer>
<key>StandardOutPath</key><string>${xml(path.join(job.directory, 'supervisor.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(job.directory, 'supervisor.log'))}</string>
</dict></plist>`, { mode: 0o600 });
    run('/bin/launchctl', ['bootstrap', `gui/${process.getuid!()}`, file]);
    return;
  }
  if (process.platform === 'win32') {
    const sid = run(windowsTool('whoami.exe'), ['/user', '/fo', 'csv', '/nh']).match(/S-1-[\d-]+/)?.[0];
    if (!sid) throw new RunpaneError('ERR_UPDATE_IDENTITY', 'Could not identify the Windows account for the updater. Nothing was changed.', 'Run update from an interactive Windows login.');
    const file = path.join(job.directory, 'supervisor.xml');
    // Windows CommandLineToArgvW quoting, after XML escaping. No shell expansion.
    const args = job.args.map(arg => `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`).join(' ');
    fs.writeFileSync(file, `\uFEFF<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<Principals><Principal id="Owner"><UserId>${sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>
<Actions Context="Owner"><Exec><Command>${xml(job.executable)}</Command><Arguments>${xml(args)}</Arguments><WorkingDirectory>${xml(job.directory)}</WorkingDirectory></Exec></Actions>
</Task>`, { encoding: 'utf16le', mode: 0o600 });
    run(windowsTool('schtasks.exe'), ['/Create', '/TN', name, '/XML', file]);
    // RunEx flag 2 avoids silently queuing behind battery/idle constraints.
    // Startup is still unconfirmed until the helper writes its own acknowledgement.
    const start = `$service = New-Object -ComObject Schedule.Service; $service.Connect(); $null = $service.GetFolder('\\').GetTask('${name}').RunEx($null, 2, 0, $null)`;
    run(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(start, 'utf16le').toString('base64')]);
    return;
  }
  if (process.platform === 'linux') {
    run('systemd-run', ['--user', '--collect', `--unit=${name}`, '--property=Restart=on-failure', '--property=RestartSec=5s', `--working-directory=${job.directory}`, '--', job.executable, ...job.args]);
    return;
  }
  checkUpdateSupervisor();
}

/** Removes only this operation's supervisor registration. It never stops Pane. */
export function removeUpdateSupervisor(id: string): void {
  const name = jobName(id);
  if (process.platform === 'darwin') run('/bin/launchctl', ['bootout', `gui/${process.getuid!()}/${name}`]);
  else if (process.platform === 'win32') run(windowsTool('schtasks.exe'), ['/Delete', '/TN', name, '/F']);
  else if (process.platform === 'linux') run('systemctl', ['--user', 'stop', name]);
}
