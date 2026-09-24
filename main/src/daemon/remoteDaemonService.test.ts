import { execFileSync } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  findPaneSourceRoot,
  installRemoteDaemonService,
  repairRemoteDaemonService,
  renderPosixRemoteDaemonLauncher,
  renderWindowsRemoteDaemonLauncher,
} from './remoteDaemonService';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('remote daemon service launchers', () => {
  it('walks past nested package files without a name when locating the Pane source root', async () => {
    const root = await makeTempDir('pane-source-root-');
    const nested = path.join(root, 'packages', 'feature');
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'Pane' }));
    await fs.writeFile(path.join(nested, 'package.json'), JSON.stringify({ private: true }));

    expect(findPaneSourceRoot(nested)).toBe(root);
  });

  it.skipIf(process.platform === 'win32')('resolves the canonical executable at start time and preserves headless arguments', async () => {
    const root = await makeTempDir('pane-launcher-');
    const paneDir = path.join(root, "pane dir's data");
    const executable = path.join(root, 'pane');
    const launcher = path.join(root, 'start.sh');
    await fs.writeFile(executable, [
      '#!/usr/bin/env sh',
      'printf "%s\\n" "$PANE_DIR" "$ELECTRON_OZONE_PLATFORM_HINT" "$@"',
    ].join('\n'), 'utf8');
    await fs.chmod(executable, 0o755);
    await fs.writeFile(launcher, renderPosixRemoteDaemonLauncher({
      paneDir,
      platform: 'linux',
      executableCandidates: [path.join(root, 'Pane'), executable],
    }), 'utf8');
    await fs.chmod(launcher, 0o755);

    const output = execFileSync(launcher, { encoding: 'utf8' }).trim().split('\n');
    expect(output).toEqual([
      paneDir,
      'headless',
      '--ozone-platform=headless',
      '--disable-gpu',
      '--daemon-headless',
      '--pane-dir',
      paneDir,
    ]);
  });

  it('makes the Windows Scheduled Task launcher resolve at runtime', () => {
    const rendered = renderWindowsRemoteDaemonLauncher({
      paneDir: 'C:\\Users\\Pane User\\.pane_remote',
      executableCandidates: ['C:\\Program Files\\Pane\\Pane.exe'],
    });
    expect(rendered).toContain('pane-remote-daemon-launcher-v2');
    expect(rendered).toContain('where %%I');
    expect(rendered).toContain('"%PANE_EXECUTABLE%" --daemon-headless');
  });

  it('points launchd at the runtime-resolving launcher instead of an executable literal', async () => {
    const root = await makeTempDir('pane-launchd-');
    const paneDir = path.join(root, '.pane_remote');
    const executable = path.join(root, 'Pane.app', 'Contents', 'MacOS', 'Pane');
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const runCommand = vi.fn(() => ({ ok: true, stdout: '', stderr: '' }));

    const result = await installRemoteDaemonService(paneDir, {
      platform: 'darwin',
      homeDir: root,
      executablePath: executable,
      executableCandidates: [executable],
      sourceRoot: null,
      commandExists: () => true,
      runCommand,
    });
    const launcherPath = path.join(paneDir, 'remote-daemon', 'start.sh');
    const plistPath = path.join(root, 'Library', 'LaunchAgents', 'com.dcouple.pane.remote-daemon.plist');
    const [launcher, plist] = await Promise.all([
      fs.readFile(launcherPath, 'utf8'),
      fs.readFile(plistPath, 'utf8'),
    ]);

    expect(result.strategy).toBe('launch-agent');
    expect(launcher).toContain('pane-remote-daemon-launcher-v2');
    expect(launcher).toContain(executable);
    expect(plist).toContain(`<string>${launcherPath}</string>`);
    expect(plist).not.toContain(`<string>${executable}</string>`);
    expect(runCommand).toHaveBeenCalledWith('launchctl', ['load', '-w', plistPath]);
  });

  it('points the Windows Scheduled Task at start.cmd', async () => {
    const root = await makeTempDir('pane-scheduled-task-');
    const paneDir = path.join(root, '.pane_remote');
    const executable = path.join(root, 'Pane.exe');
    await fs.writeFile(executable, 'binary', { mode: 0o755 });
    const runCommand = vi.fn(() => ({ ok: true, stdout: '', stderr: '' }));

    const result = await installRemoteDaemonService(paneDir, {
      platform: 'win32',
      homeDir: root,
      executablePath: executable,
      executableCandidates: [executable],
      sourceRoot: null,
      commandExists: () => true,
      runCommand,
    });
    const launcherPath = path.join(paneDir, 'remote-daemon', 'start.cmd');
    const createCall = runCommand.mock.calls.find(([command, args]) => command === 'schtasks' && args[0] === '/Create');

    expect(result.strategy).toBe('scheduled-task');
    expect(await fs.readFile(launcherPath, 'utf8')).toContain('pane_executable_found');
    expect(createCall?.[1]).toContain(`cmd.exe /d /c "${launcherPath}"`);
    expect(createCall?.[1].join(' ')).not.toContain(`"${executable}" --daemon-headless`);
  });

  async function linuxServiceDependencies(runCommand: (command: string, args: string[]) => { ok: boolean; stdout: string; stderr: string }) {
    const root = await makeTempDir('pane-systemd-');
    const executable = path.join(root, 'pane');
    await fs.writeFile(executable, '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 });
    return {
      paneDir: path.join(root, '.pane_remote'),
      dependencies: {
        platform: 'linux' as const,
        homeDir: root,
        executablePath: executable,
        executableCandidates: [executable],
        sourceRoot: null,
        commandExists: () => true,
        runCommand,
      },
    };
  }

  it('keeps the systemd user service running after logout by enabling lingering', async () => {
    const runCommand = vi.fn((_command: string, _args: string[]) => ({ ok: true, stdout: '', stderr: '' }));
    const { paneDir, dependencies } = await linuxServiceDependencies(runCommand);

    const result = await installRemoteDaemonService(paneDir, dependencies);

    expect(result).toMatchObject({ strategy: 'systemd-user', installed: true, started: true });
    expect(runCommand).toHaveBeenCalledWith('loginctl', ['enable-linger', '--no-ask-password', os.userInfo().username]);
  });

  it('enables lingering through passwordless sudo when the user may not enable it directly', async () => {
    const runCommand = vi.fn((command: string, _args: string[]) => command === 'loginctl'
      ? { ok: false, stdout: '', stderr: 'Could not enable linger: Access denied' }
      : { ok: true, stdout: '', stderr: '' });
    const { paneDir, dependencies } = await linuxServiceDependencies(runCommand);

    const result = await installRemoteDaemonService(paneDir, dependencies);

    expect(runCommand).toHaveBeenCalledWith('sudo', ['-n', 'loginctl', 'enable-linger', '--no-ask-password', os.userInfo().username]);
    expect(result.message).toBe('Installed and started a user systemd service.');
  });

  it('explains how to enable lingering when neither the user nor passwordless sudo can', async () => {
    const runCommand = vi.fn((command: string, _args: string[]) => command === 'loginctl' || command === 'sudo'
      ? { ok: false, stdout: '', stderr: 'Access denied' }
      : { ok: true, stdout: '', stderr: '' });
    const { paneDir, dependencies } = await linuxServiceDependencies(runCommand);

    const result = await installRemoteDaemonService(paneDir, dependencies);

    expect(result).toMatchObject({ strategy: 'systemd-user', installed: true, started: true });
    expect(result.message).toContain('sudo loginctl enable-linger "$USER"');
  });

  it('repairs the v2.4.30 launcher idempotently without touching config', async () => {
    const root = await makeTempDir('pane-repair-');
    const paneDir = path.join(root, '.pane_remote');
    const executable = path.join(root, 'pane');
    const launcherDir = path.join(paneDir, 'remote-daemon');
    const launcherPath = path.join(launcherDir, 'start.sh');
    const fixturePath = path.join(__dirname, '__fixtures__', 'remote-daemon-start-v2.4.30.sh');
    await fs.mkdir(launcherDir, { recursive: true });
    await fs.copyFile(fixturePath, launcherPath);
    await fs.writeFile(executable, '#!/usr/bin/env sh\nexit 0\n', 'utf8');
    await fs.chmod(executable, 0o755);
    const configPath = path.join(paneDir, 'config.json');
    const config = '{"remoteDaemon":{"sentinel":"unchanged"}}\n';
    await fs.writeFile(configPath, config, 'utf8');
    const runCommand = vi.fn(() => ({ ok: true, stdout: '', stderr: '' }));
    const dependencies = {
      platform: 'linux' as const,
      homeDir: root,
      executablePath: executable,
      executableCandidates: [executable],
      sourceRoot: null,
      commandExists: () => true,
      runCommand,
    };

    const first = await repairRemoteDaemonService(paneDir, dependencies);
    const repaired = await fs.readFile(launcherPath, 'utf8');
    const second = await repairRemoteDaemonService(paneDir, dependencies);

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(repaired).toContain('pane-remote-daemon-launcher-v2');
    expect(repaired).not.toContain('/opt/Pane/Pane');
    expect(await fs.readFile(configPath, 'utf8')).toBe(config);
    expect(runCommand).toHaveBeenCalledWith('systemctl', ['--user', 'restart', 'pane-remote-daemon.service']);
  });

  it('rejects a packaged custom executable before writing service assets', async () => {
    const root = await makeTempDir('pane-custom-');
    const paneDir = path.join(root, '.pane_remote');
    const executable = path.join(root, 'custom-pane');
    await fs.writeFile(executable, '#!/usr/bin/env sh\nexit 0\n', 'utf8');
    await fs.chmod(executable, 0o755);

    await expect(repairRemoteDaemonService(paneDir, {
      platform: 'linux',
      homeDir: root,
      executablePath: executable,
      executableCandidates: [path.join(root, '.local', 'bin', 'pane')],
      sourceRoot: null,
      commandExists: () => true,
      runCommand: () => ({ ok: false, stdout: '', stderr: '' }),
    })).rejects.toThrow('cannot persist the current executable safely');
    await expect(fs.stat(path.join(paneDir, 'remote-daemon', 'start.sh'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
