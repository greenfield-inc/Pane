import { stageUpdateRuntime } from '../../../packages/runpane/src/updateRuntime';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getWSLShellSpawn, WSLPATH } from '../utils/wslUtils';
import {
  installRunpaneShim,
  PANE_MANAGED_SHIM_MARKER,
  withRunpaneBinOnPath,
  withRunpaneOnPath,
  type RunpaneShimState,
} from './runpaneShim';

let root: string;
let appDirectory: string;
let bundledCliPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-runpane-shim-'));
  appDirectory = path.join(root, 'pane dir');
  bundledCliPath = path.join(root, 'bundle', 'runpane.cjs');
  fs.mkdirSync(path.dirname(bundledCliPath), { recursive: true });
  fs.writeFileSync(bundledCliPath, "console.log('pane-runpane ' + process.env.PANE_DIR + ' ' + process.argv.slice(2).join(' '));\n");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function install(): RunpaneShimState {
  const state = installRunpaneShim({ appDirectory, bundledCliPath, execPath: process.execPath, platform: 'darwin' });
  if (!state) throw new Error('Expected the shim to install');
  return state;
}

describe('installRunpaneShim', () => {
  it('copies the bundled CLI and writes a managed shim', () => {
    const state = install();
    expect(state.shimPath).toBe(path.join(appDirectory, 'bin', 'runpane'));
    expect(fs.readFileSync(path.join(appDirectory, 'bin', 'runpane.cjs'), 'utf8')).toBe(fs.readFileSync(bundledCliPath, 'utf8'));
    expect(fs.readFileSync(state.shimPath, 'utf8')).toContain(PANE_MANAGED_SHIM_MARKER);
  });

  it.skipIf(process.platform === 'win32')('runs the POSIX shim', () => {
    const state = install();
    expect(fs.statSync(state.shimPath).mode & 0o111).not.toBe(0);
    const env = { ...process.env };
    delete env.PANE_DIR;
    const result = spawnSync(state.shimPath, ['--version'], { encoding: 'utf8', env });
    expect(result.stdout.trim()).toBe(`pane-runpane ${appDirectory} --version`);
  });

  it('keeps an explicitly updated managed CLI when the older Pane starts again', () => {
    install();
    const cliRoot = path.join(appDirectory, 'bin', 'cli', 'requested');
    fs.mkdirSync(cliRoot, { recursive: true });
    const entrypoint = path.join(cliRoot, 'cli.cjs');
    const runtime = stageUpdateRuntime(process.execPath, path.join(cliRoot, 'runtime'));
    fs.writeFileSync(entrypoint, "console.log('requested-cli-version');\n");
    fs.writeFileSync(path.join(appDirectory, 'bin', 'runpane-override.json'), JSON.stringify({ version: '9.9.9', entrypoint, runtime }));
    const state = installRunpaneShim({ appDirectory, bundledCliPath, execPath: process.execPath });
    expect(state).not.toBeNull();
    const result = process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', `""${state!.shimPath}" --version"`], { encoding: 'utf8', windowsVerbatimArguments: true })
      : spawnSync(state!.shimPath, ['--version'], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('requested-cli-version');
  });

  it('rewrites only when content changes', () => {
    const state = install();
    const past = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(state.shimPath, past, past);
    install();
    expect(fs.statSync(state.shimPath).mtime.getTime()).toBe(past.getTime());
    fs.writeFileSync(bundledCliPath, "console.log('v2');\n");
    install();
    expect(fs.readFileSync(path.join(appDirectory, 'bin', 'runpane.cjs'), 'utf8')).toBe("console.log('v2');\n");
  });

  it('never replaces a runpane file Pane did not write, or a symbolic link', () => {
    fs.mkdirSync(path.join(appDirectory, 'bin'), { recursive: true });
    const shim = path.join(appDirectory, 'bin', 'runpane');
    fs.writeFileSync(shim, '#!/bin/sh\necho mine\n');
    expect(installRunpaneShim({ appDirectory, bundledCliPath, execPath: process.execPath, platform: 'darwin' })).toBeNull();
    expect(fs.readFileSync(shim, 'utf8')).toBe('#!/bin/sh\necho mine\n');
    fs.rmSync(shim);
    const target = path.join(root, 'elsewhere');
    fs.writeFileSync(target, 'untouched');
    fs.symlinkSync(target, shim);
    expect(installRunpaneShim({ appDirectory, bundledCliPath, execPath: process.execPath, platform: 'darwin' })).toBeNull();
    expect(fs.readFileSync(target, 'utf8')).toBe('untouched');
  });

  it('does nothing when the bundled CLI is missing', () => {
    expect(installRunpaneShim({ appDirectory, bundledCliPath: path.join(root, 'missing.cjs'), execPath: process.execPath })).toBeNull();
    expect(fs.existsSync(path.join(appDirectory, 'bin'))).toBe(false);
  });

  it('writes a Windows command shim beside the POSIX one', () => {
    const state = installRunpaneShim({ appDirectory, bundledCliPath, execPath: 'C:\\Program Files\\Pane\\Pane.exe', platform: 'win32' });
    expect(state?.shimPath).toBe(path.join(appDirectory, 'bin', 'runpane.cmd'));
    const cmd = fs.readFileSync(path.join(appDirectory, 'bin', 'runpane.cmd'), 'utf8');
    expect(cmd).toContain('set ELECTRON_RUN_AS_NODE=1');
    expect(cmd).toContain('"C:\\Program Files\\Pane\\Pane.exe"');
    expect(fs.existsSync(path.join(appDirectory, 'bin', 'runpane'))).toBe(true);
  });
});

describe('WSL terminals', () => {
  it.skipIf(process.platform === 'win32' || fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop'))('explains when WSL interop is off', () => {
    const state = installRunpaneShim({ appDirectory, bundledCliPath, execPath: 'C:\\Program Files\\Pane\\Pane.exe', platform: 'win32' });
    const result = spawnSync(path.join(state!.binDir, 'runpane'), ['doctor'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', WSL_DISTRO_NAME: 'Ubuntu-24.04' } });
    expect(result.status).toBe(126);
    expect(result.stderr).toContain('WSL interop is off in Ubuntu-24.04');
    expect(result.stderr).toContain('Nothing was run');
  });

  /**
   * Runs the WSL terminal launch in a real bash. Outside WSL there is no
   * /bin/wslpath, so the launch script and rcfile call a fake one instead.
   */
  function launchWslTerminal(fakeWslpath: string, probe: string) {
    const state = installRunpaneShim({ appDirectory, bundledCliPath, execPath: process.execPath, platform: 'win32' })!;
    const home = path.join(root, 'home');
    const globalBin = path.join(root, 'global bin');
    for (const dir of [home, globalBin]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(globalBin, 'runpane'), '#!/bin/sh\necho global\n', { mode: 0o755 });
    fs.writeFileSync(path.join(home, '.profile'), `export PATH='${globalBin}':"$PATH"\nexport USER_PROFILE_RAN=yes\n`);
    const wslpath = path.join(root, 'wslpath');
    fs.writeFileSync(wslpath, fakeWslpath, { mode: 0o755 });
    const rcFile = path.join(root, 'wsl-rcfile');
    fs.writeFileSync(rcFile, fs.readFileSync(state.wslBashRcFile!, 'utf8').replaceAll(WSLPATH, wslpath));
    const script = getWSLShellSpawn('Ubuntu', home, rcFile).args.at(-1)!.replaceAll(WSLPATH, wslpath);
    const env = { HOME: home, PATH: '/usr/bin:/bin', TERM: 'dumb' };
    const result = spawnSync('/bin/bash', ['-c', script], { input: probe, encoding: 'utf8', env, timeout: 15_000 });
    return `${result.stdout}${result.stderr}`;
  }

  it.skipIf(process.platform === 'win32')('keeps Pane runpane first after the login files edit PATH', () => {
    // Paths are already POSIX here, so wslpath -u returns its argument.
    const output = launchWslTerminal('#!/bin/sh\nprintf %s "$2"\n',
      'echo "RESOLVED=$(command -v runpane) BIN=$PANE_RUNPANE_BIN PROFILE=$USER_PROFILE_RAN"; runpane probe; exit\n');
    expect(output).toContain(`RESOLVED=${appDirectory}/bin/runpane BIN=${appDirectory}/bin/runpane PROFILE=yes`);
    expect(output).toContain(`pane-runpane ${appDirectory} probe`);
  });

  it.skipIf(process.platform === 'win32')('starts a login shell when wslpath fails', () => {
    const output = launchWslTerminal('#!/bin/sh\nexit 1\n',
      'shopt -q login_shell && echo LOGIN=yes; echo "RESOLVED=$(command -v runpane) PROFILE=$USER_PROFILE_RAN"; exit\n');
    expect(output).toContain('LOGIN=yes');
    expect(output).toContain(`RESOLVED=${path.join(root, 'global bin')}/runpane PROFILE=yes`);
  });
});

describe('withRunpaneOnPath', () => {
  const state: RunpaneShimState = { binDir: '/pane/bin', shimPath: '/pane/bin/runpane', zshDotDir: '/pane/shell/zsh', bashRcFile: '/pane/shell/bash/rcfile' };
  const env = { PATH: '/usr/bin:/pane/bin:/bin', HOME: '/home/me' };

  it('leaves the launch untouched without an installed shim', () => {
    expect(withRunpaneOnPath({ name: 'zsh', args: ['-i'] }, env, null)).toEqual({ args: ['-i'], env });
  });

  it('moves the bin directory to the front and exports the shim path', () => {
    const launch = withRunpaneOnPath({ name: 'sh', args: ['-i'] }, env, state, 'darwin');
    expect(launch.env.PATH).toBe('/pane/bin:/usr/bin:/bin');
    expect(launch.env.PANE_RUNPANE_BIN).toBe('/pane/bin/runpane');
    expect(launch.args).toEqual(['-i']);
  });

  it('points zsh at the wrapper and remembers the user ZDOTDIR', () => {
    expect(withRunpaneOnPath({ name: 'zsh', args: ['-i'] }, env, state, 'darwin').env).toMatchObject({ ZDOTDIR: '/pane/shell/zsh' });
    expect(withRunpaneOnPath({ name: 'zsh', args: ['-i'] }, { ...env, ZDOTDIR: '/home/me/.config/zsh' }, state, 'darwin').env)
      .toMatchObject({ ZDOTDIR: '/pane/shell/zsh', PANE_USER_ZDOTDIR: '/home/me/.config/zsh' });
  });

  it('uses --rcfile for interactive bash and --init-command for fish', () => {
    expect(withRunpaneOnPath({ name: 'bash', args: ['-i'] }, env, state, 'linux').args).toEqual(['--rcfile', '/pane/shell/bash/rcfile', '-i']);
    expect(withRunpaneOnPath({ name: 'bash', args: ['-l'] }, env, state, 'linux').args).toEqual(['-l']);
    const fish = withRunpaneOnPath({ name: 'fish', args: ['-i'] }, env, state, 'linux').args;
    expect(fish.slice(0, 2)).toEqual(['-i', '--init-command']);
    expect(fish[2]).toContain("'/pane/bin'");
  });

  it('only prepends PATH on Windows and for non-interactive commands', () => {
    const win = withRunpaneOnPath({ name: 'bash', args: ['-i'] }, { PATH: 'C:\\Windows' }, { ...state, binDir: 'C:\\pane\\bin' }, 'win32');
    expect(win).toEqual({ args: ['-i'], env: { PATH: 'C:\\pane\\bin;C:\\Windows', PANE_RUNPANE_BIN: '/pane/bin/runpane' } });
    expect(withRunpaneBinOnPath({ PATH: '/usr/bin' }, state, 'linux')).toEqual({ PATH: '/pane/bin:/usr/bin', PANE_RUNPANE_BIN: '/pane/bin/runpane' });
  });
});

/**
 * Real shells: a user profile that puts its own `runpane` first must still
 * resolve Pane's shim, and the user's startup files must still run.
 */
describe.each([
  { shell: 'zsh', rc: '.zshrc' },
  { shell: 'bash', rc: '.bashrc' },
  { shell: 'fish', rc: path.join('.config', 'fish', 'config.fish') },
])('$shell startup', ({ shell, rc }) => {
  const shellPath = ['/bin', '/usr/bin', '/opt/homebrew/bin', '/usr/local/bin'].map(dir => path.join(dir, shell)).find(candidate => fs.existsSync(candidate));

  it.skipIf(!shellPath || process.platform === 'win32')('keeps Pane runpane first after the user profile edits PATH', () => {
    const state = install();
    const home = path.join(root, 'home');
    const globalBin = path.join(root, 'global bin');
    fs.mkdirSync(globalBin, { recursive: true });
    fs.writeFileSync(path.join(globalBin, 'runpane'), '#!/bin/sh\necho global\n', { mode: 0o755 });
    fs.mkdirSync(path.dirname(path.join(home, rc)), { recursive: true });
    const profile = shell === 'fish'
      ? `set -gx PATH '${globalBin}' $PATH\nset -gx USER_RC_RAN yes\n`
      : `export PATH='${globalBin}':"$PATH"\nexport USER_RC_RAN=yes\n`;
    fs.writeFileSync(path.join(home, rc), profile);

    const baseEnv = { HOME: home, PATH: '/usr/bin:/bin', TERM: 'dumb', XDG_CONFIG_HOME: path.join(home, '.config') };
    const launch = withRunpaneOnPath({ name: shell, args: ['-i'] }, baseEnv, state, process.platform);
    const probe = 'echo "RESOLVED=$(command -v runpane) RC=$USER_RC_RAN"; runpane probe; exit';
    const result = spawnSync(shellPath!, [...launch.args, '-c', probe], { encoding: 'utf8', env: launch.env, timeout: 15_000 });
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain(`RESOLVED=${state.shimPath}`);
    expect(output).toContain('RC=yes');
    expect(output).toContain(`pane-runpane ${appDirectory} probe`);
  });
});
