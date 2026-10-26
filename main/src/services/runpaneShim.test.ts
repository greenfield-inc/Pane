import { stageUpdateRuntime } from '../../../packages/runpane/src/updateRuntime';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addRunpaneToUserPath,
  installRunpaneShim,
  PANE_MANAGED_SHIM_MARKER,
  withRunpaneBinOnPath,
  withRunpaneOnPath,
  type RunpaneShimState,
  type WindowsUserPath,
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

  it.skipIf(process.platform === 'win32')('falls back to node on PATH when the Pane binary is gone', () => {
    const state = installRunpaneShim({ appDirectory, bundledCliPath, execPath: path.join(root, 'moved', 'Pane'), platform: 'darwin' })!;
    const result = spawnSync(state.shimPath, ['update'], { encoding: 'utf8', env: { PATH: path.dirname(process.execPath), PANE_DIR: '/pane' } });
    expect(result.stdout.trim()).toBe('pane-runpane /pane update');

    const noNode = spawnSync(state.shimPath, ['update'], { encoding: 'utf8', env: { PATH: path.join(root, 'empty') } });
    expect(noNode.status).toBe(127);
    expect(noNode.stderr.trim()).toBe('runpane: Pane is missing and Node.js is not on PATH. Reinstall Pane from https://runpane.com, or install Node.js and run: npx --yes runpane@latest update');
  });

  it.runIf(process.platform === 'win32')('falls back to node on PATH when Pane.exe is gone (Windows)', () => {
    const state = installRunpaneShim({ appDirectory, bundledCliPath, execPath: path.join(root, 'moved', 'Pane.exe'), platform: 'win32' })!;
    const result = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${state.shimPath}" update"`], {
      encoding: 'utf8', windowsVerbatimArguments: true, env: { ...process.env, PATH: `${path.dirname(process.execPath)};${process.env.SystemRoot}\\System32`, PANE_DIR: 'C:\\pane' },
    });
    expect(result.stdout.trim()).toBe('pane-runpane C:\\pane update');
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

describe('addRunpaneToUserPath', () => {
  let home: string;
  let binDir: string;
  const posixBlock = () => [
    '# pane-runpane-path v1: Pane added these lines so runpane works in every terminal.',
    '# Delete them to undo; Pane does not add them again.',
    'case ":$PATH:" in',
    `  *:'${binDir}':*) ;;`,
    `  *) export PATH="\${PATH:+$PATH:}"'${binDir}' ;;`,
    'esac',
    '# end pane-runpane-path v1',
    '',
  ].join('\n');
  const add = (loginShell: string, platform: NodeJS.Platform = 'darwin', env: NodeJS.ProcessEnv = {}) =>
    addRunpaneToUserPath({ binDir, home, loginShell, platform, env, installed: true });
  const read = (file: string) => fs.readFileSync(path.join(home, file), 'utf8');

  beforeEach(() => {
    home = path.join(root, 'home');
    binDir = path.join(home, '.pane', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
  });

  it('appends the zsh block to ~/.zshenv once', async () => {
    expect(await add('/bin/zsh')).toEqual([path.join(home, '.zshenv')]);
    expect(read('.zshenv')).toBe(posixBlock());
    expect(await add('/bin/zsh')).toEqual([]);
    expect(read('.zshenv')).toBe(posixBlock());
  });

  it('appends to ~/.bashrc, and ~/.bash_profile on macOS', async () => {
    expect(await add('/bin/bash', 'linux')).toEqual([path.join(home, '.bashrc')]);
    expect(fs.existsSync(path.join(home, '.bash_profile'))).toBe(false);
    expect(await add('/bin/bash', 'darwin')).toEqual([path.join(home, '.bash_profile')]);
    expect(read('.bashrc')).toBe(posixBlock());
    expect(read('.bash_profile')).toBe(posixBlock());
  });

  it('adds an existing ~/.bash_profile on macOS for a zsh user, keeping its lines', async () => {
    fs.writeFileSync(path.join(home, '.bash_profile'), 'alias ll="ls -l"');
    await add('/bin/zsh');
    expect(read('.bash_profile')).toBe(`alias ll="ls -l"\n\n${posixBlock()}`);
    expect(fs.existsSync(path.join(home, '.bashrc'))).toBe(false);
  });

  it('writes a fish conf.d file', async () => {
    expect(await add('/opt/homebrew/bin/fish', 'linux')).toEqual([path.join(home, '.config', 'fish', 'conf.d', 'pane.fish')]);
    expect(read('.config/fish/conf.d/pane.fish')).toBe([
      '# pane-runpane-path v1: Pane added these lines so runpane works in every terminal.',
      '# Delete them to undo; Pane does not add them again.',
      `if not contains -- '${binDir}' $PATH`,
      `    set -gx PATH $PATH '${binDir}'`,
      'end',
      '# end pane-runpane-path v1',
      '',
    ].join('\n'));
  });

  it('leaves a file that already puts the directory on PATH alone', async () => {
    fs.writeFileSync(path.join(home, '.zshenv'), 'export PATH="$HOME/.pane/bin:$PATH"\n');
    expect(await add('/bin/zsh')).toEqual([]);
    expect(read('.zshenv')).toBe('export PATH="$HOME/.pane/bin:$PATH"\n');
  });

  it('never follows a symbolic link', async () => {
    const dotfile = path.join(root, 'dotfiles', 'zshenv');
    fs.mkdirSync(path.dirname(dotfile));
    fs.writeFileSync(dotfile, 'mine\n');
    fs.symlinkSync(dotfile, path.join(home, '.zshenv'));
    expect(await add('/bin/zsh')).toEqual([]);
    expect(fs.readFileSync(dotfile, 'utf8')).toBe('mine\n');
  });

  it('does not add the block back after the user removes it', async () => {
    await add('/bin/zsh');
    fs.writeFileSync(path.join(home, '.zshenv'), '');
    expect(await add('/bin/zsh')).toEqual([]);
    expect(read('.zshenv')).toBe('');
  });

  it('writes nothing with OS integration disabled, or outside the installed app', async () => {
    expect(await add('/bin/zsh', 'darwin', { PANE_DISABLE_OS_INTEGRATION: '1' })).toEqual([]);
    expect(await addRunpaneToUserPath({ binDir, home, loginShell: '/bin/zsh', platform: 'darwin', env: {}, installed: false })).toEqual([]);
    // Tests run unpackaged, like a dev build.
    expect(await addRunpaneToUserPath({ binDir, home, loginShell: '/bin/zsh', platform: 'darwin', env: {} })).toEqual([]);
    expect(fs.readdirSync(home)).toEqual(['.pane']);
    expect(fs.readdirSync(binDir)).toEqual([]);
  });

  describe('Windows user PATH', () => {
    let registry: WindowsUserPath;
    let reads = 0;
    const addOnWindows = (env: NodeJS.ProcessEnv = {}) => addRunpaneToUserPath({
      binDir, home, platform: 'win32', env, installed: true,
      windowsUserPath: {
        read: async () => { reads += 1; return registry; },
        write: async next => { registry = next; },
      },
    });

    beforeEach(() => {
      reads = 0;
    });

    it('appends once and keeps REG_EXPAND_SZ', async () => {
      registry = { kind: 'ExpandString', value: '%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Tools' };
      expect(await addOnWindows()).toEqual(['HKCU\\Environment\\Path']);
      expect(registry).toEqual({ kind: 'ExpandString', value: `%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Tools;${binDir}` });
      expect(await addOnWindows()).toEqual([]);
      expect(reads).toBe(1);
    });

    it('keeps REG_SZ and creates a missing value as REG_EXPAND_SZ', async () => {
      registry = { kind: 'String', value: 'C:\\Tools;' };
      await addOnWindows();
      expect(registry).toEqual({ kind: 'String', value: `C:\\Tools;${binDir}` });

      fs.rmSync(path.join(binDir, 'user-path.json'));
      registry = { kind: 'None', value: '' };
      await addOnWindows();
      expect(registry).toEqual({ kind: 'ExpandString', value: binDir });
    });

    it('leaves an existing entry alone, matched through %VARIABLES%', async () => {
      const entry = ['%PANE_TEST_HOME%', '.pane', 'bin', ''].join(path.sep);
      registry = { kind: 'ExpandString', value: `C:\\Tools;${entry}` };
      expect(await addOnWindows({ PANE_TEST_HOME: home })).toEqual([]);
      expect(registry.value).toBe(`C:\\Tools;${entry}`);
      expect(reads).toBe(1);
    });
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
