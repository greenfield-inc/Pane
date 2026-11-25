import { stageUpdateRuntime } from '../../../packages/runpane/src/updateRuntime';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { getWSLShellSpawn, WSLPATH } from '../utils/wslUtils';
import {
  addRunpaneToUserPath,
  installRunpaneShim,
  PANE_MANAGED_SHIM_MARKER,
  withRunpaneBinOnPath,
  withRunpaneOnPath,
  writeBrowserShim,
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

afterEach(async () => {
  // On Windows a just-exited node.exe can hold its folder for a moment: EBUSY. Retry the delete.
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

  it.skipIf(process.platform === 'win32')('runs any script through pane-node, with Pane\'s binary or node on PATH', () => {
    const script = path.join(root, 'hello.mjs');
    fs.writeFileSync(script, "console.log('ran ' + process.argv.slice(2).join(' '));\n");
    const state = install();
    const result = spawnSync(path.join(state.binDir, 'pane-node'), [script, 'a b'], { encoding: 'utf8', env: { PATH: path.join(root, 'empty') } });
    expect(result.stdout.trim()).toBe('ran a b');

    const moved = installRunpaneShim({ appDirectory, bundledCliPath, execPath: path.join(root, 'moved', 'Pane'), platform: 'darwin' })!;
    const viaNode = spawnSync(path.join(moved.binDir, 'pane-node'), [script], { encoding: 'utf8', env: { PATH: path.dirname(process.execPath) } });
    expect(viaNode.stdout.trim()).toBe('ran');
    const neither = spawnSync(path.join(moved.binDir, 'pane-node'), [script], { encoding: 'utf8', env: { PATH: path.join(root, 'empty') } });
    expect(neither.status).toBe(127);
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

describe('the agent-farm shim', () => {
  let entry: string;
  let configRoot: string;
  beforeEach(() => {
    entry = path.join(root, 'app.asar', 'agent-farm', 'dist', 'cli.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    // The real entry is an ES module (the package is "type": "module"); this one prints what it got.
    fs.writeFileSync(path.join(path.dirname(entry), '..', 'package.json'), '{"type":"module"}');
    fs.writeFileSync(entry, "console.log(`AF ${process.argv.slice(2).join('|')} NODE=${process.env.ELECTRON_RUN_AS_NODE}`); console.error(`TELEMETRY=${process.env.AGENT_FARM_TELEMETRY}`);\n");
    configRoot = path.join(appDirectory, 'agent-farm');
  });

  function installWithAgentFarm(platform: NodeJS.Platform = 'darwin', execPath = process.execPath): RunpaneShimState {
    const state = installRunpaneShim({ appDirectory, bundledCliPath, execPath, platform, agentFarm: { entry, configRoot } });
    if (!state) throw new Error('Expected the shim to install');
    return state;
  }

  function agentFarm(state: RunpaneShimState, args: string[]) {
    return spawnSync(path.join(state.binDir, 'agent-farm'), args, { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  }

  it.skipIf(process.platform === 'win32')('runs the bundled Agent Farm with Pane\'s config root, before any -- passthrough', () => {
    const state = installWithAgentFarm();
    expect(agentFarm(state, ['profiles', 'list']).stdout.trim()).toBe(`AF profiles|list|--config-root|${configRoot} NODE=1`);
    expect(agentFarm(state, ['run', 'greenfield/planner', '--', '--resume', 'x']).stdout.trim()).toBe(`AF run|greenfield/planner|--config-root|${configRoot}|--|--resume|x NODE=1`);
  });

  it.skipIf(process.platform === 'win32')('turns Agent Farm telemetry off unless Pane\'s switch is on, keeping a value already set', () => {
    const state = installWithAgentFarm();
    const telemetry = (env: Record<string, string> = {}) => spawnSync(path.join(state.binDir, 'agent-farm'), ['profiles', 'list'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ...env } }).stderr.trim();
    expect(telemetry()).toBe('TELEMETRY=off');
    fs.mkdirSync(configRoot, { recursive: true });
    fs.writeFileSync(path.join(configRoot, 'settings.json'), JSON.stringify({ telemetry: { enabled: true } }));
    expect(telemetry()).toBe('TELEMETRY=undefined');
    fs.writeFileSync(path.join(configRoot, 'settings.json'), JSON.stringify({ telemetry: { enabled: false } }));
    expect(telemetry()).toBe('TELEMETRY=off');
    expect(telemetry({ AGENT_FARM_TELEMETRY: 'on' })).toBe('TELEMETRY=on');
  });

  it.skipIf(process.platform === 'win32')('passes a command through unchanged when it names its own config root, or needs none', () => {
    const state = installWithAgentFarm();
    expect(agentFarm(state, ['plugin', 'list', '--config-root', '/mine']).stdout.trim()).toBe('AF plugin|list|--config-root|/mine NODE=1');
    expect(agentFarm(state, ['--version']).stdout.trim()).toBe('AF --version NODE=1');
    expect(agentFarm(state, ['help', 'run']).stdout.trim()).toBe('AF help|run NODE=1');
  });

  it.skipIf(process.platform === 'win32')('refuses the commands that only work on ~/.config/agent-farm, saying why', () => {
    const state = installWithAgentFarm();
    for (const args of [[], ['init'], ['doctor']]) {
      const result = agentFarm(state, args);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(configRoot);
      expect(result.stderr).toContain('Nothing was run');
    }
  });

  it.skipIf(process.platform === 'win32')('explains when the Pane binary is gone', () => {
    const state = installWithAgentFarm('darwin', path.join(root, 'moved', 'Pane'));
    const result = agentFarm(state, ['profiles', 'list']);
    expect(result.status).toBe(127);
    expect(result.stderr).toContain('Reinstall Pane');
  });

  it('writes a Windows command shim that runs the same launcher with Pane\'s binary', () => {
    const state = installWithAgentFarm('win32', 'C:\\Program Files\\Pane\\Pane.exe');
    const cmd = fs.readFileSync(path.join(state.binDir, 'agent-farm.cmd'), 'utf8');
    expect(cmd).toContain(PANE_MANAGED_SHIM_MARKER);
    expect(cmd).toContain('set ELECTRON_RUN_AS_NODE=1');
    expect(cmd).toContain(`"C:\\Program Files\\Pane\\Pane.exe" "${path.join(state.binDir, 'agent-farm.cjs')}" %*`);
    expect(fs.readFileSync(path.join(state.binDir, 'agent-farm'), 'utf8')).toContain('WSL_DISTRO_NAME');
  });

  it.skipIf(process.platform === 'win32' || fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop'))('explains in WSL when interop is off', () => {
    const state = installWithAgentFarm('win32', 'C:\\Program Files\\Pane\\Pane.exe');
    const result = spawnSync(path.join(state.binDir, 'agent-farm'), ['profiles', 'list'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', WSL_DISTRO_NAME: 'Ubuntu-24.04' } });
    expect(result.status).toBe(126);
    expect(result.stderr).toContain('WSL interop is off in Ubuntu-24.04');
  });

  it('writes no agent-farm without a bundled Agent Farm, and never replaces one Pane did not write', () => {
    const state = install();
    expect(fs.existsSync(path.join(state.binDir, 'agent-farm'))).toBe(false);
    fs.writeFileSync(path.join(state.binDir, 'agent-farm'), '#!/bin/sh\necho mine\n');
    installWithAgentFarm();
    expect(fs.readFileSync(path.join(state.binDir, 'agent-farm'), 'utf8')).toBe('#!/bin/sh\necho mine\n');
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
      'echo "RESOLVED=$(command -v runpane) BIN=$PANE_RUNPANE_BIN HOOK=$AGENT_FARM_SESSION_HOOK PROFILE=$USER_PROFILE_RAN"; runpane probe; exit\n');
    expect(output).toContain(`RESOLVED=${appDirectory}/bin/runpane BIN=${appDirectory}/bin/runpane HOOK=${appDirectory}/bin/runpane PROFILE=yes`);
    expect(output).toContain(`pane-runpane ${appDirectory} probe`);
  });

  it.skipIf(process.platform === 'win32')('starts a login shell when wslpath fails', () => {
    const output = launchWslTerminal('#!/bin/sh\nexit 1\n',
      'shopt -q login_shell && echo LOGIN=yes; echo "RESOLVED=$(command -v runpane) PROFILE=$USER_PROFILE_RAN"; exit\n');
    expect(output).toContain('LOGIN=yes');
    expect(output).toContain(`RESOLVED=${path.join(root, 'global bin')}/runpane PROFILE=yes`);
  });
});

describe('addRunpaneToUserPath', () => {
  let home: string;
  let binDir: string;
  const add = (loginShell: string, platform: NodeJS.Platform = 'darwin', env: NodeJS.ProcessEnv = {}) =>
    addRunpaneToUserPath({ binDir, home, loginShell, platform, env, installed: true });
  const read = (file: string) => fs.readFileSync(path.join(home, file), 'utf8');
  const marker = '# pane-runpane-path v1';

  beforeEach(() => {
    home = path.join(root, 'home');
    binDir = path.join(home, '.pane', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
  });

  it('appends the zsh block to ~/.zshenv once', async () => {
    const block = [
      '# pane-runpane-path v1: Pane added these lines so runpane works in every terminal.',
      '# Delete them to undo; Pane does not add them again.',
      'case ":$PATH:" in',
      `  *:'${binDir}':*) ;;`,
      `  *) export PATH="\${PATH:+$PATH:}"'${binDir}' ;;`,
      'esac',
      '# end pane-runpane-path v1',
      '',
    ].join('\n');
    expect(await add('/bin/zsh', 'linux')).toEqual([path.join(home, '.zshenv')]);
    expect(read('.zshenv')).toBe(block);
    expect(await add('/bin/zsh', 'linux')).toEqual([]);
    expect(read('.zshenv')).toBe(block);
  });

  it("uses the user's ZDOTDIR, but not Pane's own zsh wrapper", async () => {
    const zdotdir = path.join(home, '.config', 'zsh');
    expect(await add('/bin/zsh', 'linux', { ZDOTDIR: zdotdir })).toEqual([path.join(zdotdir, '.zshenv')]);
    fs.rmSync(path.join(binDir, 'user-path.json'));
    expect(await add('/bin/zsh', 'linux', { ZDOTDIR: path.join(home, '.pane', 'shell', 'zsh') })).toEqual([path.join(home, '.zshenv')]);
  });

  it('appends to ~/.bashrc, and creates ~/.bash_profile on macOS only when bash has no login file', async () => {
    expect(await add('/bin/bash', 'linux')).toEqual([path.join(home, '.bashrc')]);
    expect(fs.existsSync(path.join(home, '.bash_profile'))).toBe(false);
    expect(await add('/bin/bash', 'darwin')).toEqual([path.join(home, '.bash_profile')]);
    expect(read('.bash_profile')).toContain(marker);
  });

  it("appends to a macOS bash user's ~/.profile instead of hiding it behind a new ~/.bash_profile", async () => {
    fs.writeFileSync(path.join(home, '.profile'), 'export EDITOR=vim\n', { mode: 0o600 });
    expect(await add('/bin/bash', 'darwin')).toEqual([path.join(home, '.bashrc'), path.join(home, '.profile')]);
    expect(fs.existsSync(path.join(home, '.bash_profile'))).toBe(false);
    expect(read('.profile')).toMatch(/^export EDITOR=vim\n\n# pane-runpane-path v1/);
    // Windows has no POSIX modes, and Pane never writes shell files there.
    if (process.platform !== 'win32') expect(fs.statSync(path.join(home, '.profile')).mode & 0o777).toBe(0o600);
  });

  it('adds an existing macOS bash login file for a zsh user too', async () => {
    fs.writeFileSync(path.join(home, '.bash_profile'), 'alias ll="ls -l"');
    await add('/bin/zsh');
    expect(read('.bash_profile')).toMatch(/^alias ll="ls -l"\n\n# pane-runpane-path v1/);
    expect(fs.existsSync(path.join(home, '.bashrc'))).toBe(false);
  });

  it('writes a fish conf.d file under XDG_CONFIG_HOME', async () => {
    const config = path.join(root, 'xdg');
    expect(await add('/opt/homebrew/bin/fish', 'linux', { XDG_CONFIG_HOME: config })).toEqual([path.join(config, 'fish', 'conf.d', 'pane.fish')]);
    expect(fs.readFileSync(path.join(config, 'fish', 'conf.d', 'pane.fish'), 'utf8')).toContain(marker);
  });

  it('never follows a symbolic link', async () => {
    const dotfile = path.join(root, 'dotfiles', 'zshenv');
    fs.mkdirSync(path.dirname(dotfile));
    fs.writeFileSync(dotfile, 'mine\n');
    fs.symlinkSync(dotfile, path.join(home, '.zshenv'));
    expect(await add('/bin/zsh', 'linux')).toEqual([]);
    expect(fs.readFileSync(dotfile, 'utf8')).toBe('mine\n');
  });

  it('keeps going when one file cannot be written, and retries it next time', async () => {
    fs.mkdirSync(path.join(home, '.zshenv'));
    fs.writeFileSync(path.join(home, '.bash_profile'), '');
    expect(await add('/bin/zsh', 'darwin')).toEqual([path.join(home, '.bash_profile')]);
    fs.rmdirSync(path.join(home, '.zshenv'));
    expect(await add('/bin/zsh', 'darwin')).toEqual([path.join(home, '.zshenv')]);
  });

  it('does not add the block back after the user removes it', async () => {
    await add('/bin/zsh', 'linux');
    fs.writeFileSync(path.join(home, '.zshenv'), '');
    expect(await add('/bin/zsh', 'linux')).toEqual([]);
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

    it.each([
      ['through %VARIABLES%', () => ['%PANE_TEST_HOME%', '.pane', 'bin', ''].join(path.sep)],
      ['in quotes', () => `"${binDir}"`],
      ['with the other slash and a trailing one', () => `${binDir.replace(/[\\/]/g, match => (match === '/' ? '\\' : '/'))}/`],
    ])('leaves an existing entry alone, written %s', async (_spelling, entry) => {
      registry = { kind: 'ExpandString', value: `C:\\Tools;${entry()}` };
      expect(await addOnWindows({ PANE_TEST_HOME: home })).toEqual([]);
      expect(registry.value).toBe(`C:\\Tools;${entry()}`);
      expect(reads).toBe(1);
    });
  });
});

/** The block in a real shell: an awkward home path, loaded twice, adds the directory once, at the end. */
describe.each([
  { shell: 'zsh', script: 'source "$HOME/.zshenv"; printf %s "$PATH"' },
  { shell: 'bash', script: 'source "$HOME/.bashrc"; source "$HOME/.bashrc"; printf %s "$PATH"' },
  { shell: 'fish', script: 'source "$HOME/.config/fish/conf.d/pane.fish"; string join : $PATH' },
])('$shell user PATH block', ({ shell, script }) => {
  const shellPath = ['/bin', '/usr/bin', '/opt/homebrew/bin', '/usr/local/bin'].map(dir => path.join(dir, shell)).find(candidate => fs.existsSync(candidate));

  it.skipIf(!shellPath || process.platform === 'win32')('appends the directory exactly once', async () => {
    const home = path.join(root, "it's my home");
    const binDir = path.join(home, '.pane', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    await addRunpaneToUserPath({ binDir, home, loginShell: shellPath, platform: 'linux', env: {}, installed: true });
    // zsh and fish also load their file once on their own before the script sources it again.
    const result = spawnSync(shellPath!, ['-c', script], { encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin', TERM: 'dumb' }, timeout: 15_000 });
    expect(result.status, result.stderr).toBe(0);
    const entries = result.stdout.trim().split(':');
    expect(entries.at(-1)).toBe(binDir);
    expect(entries.filter(entry => entry === binDir)).toHaveLength(1);
  });
});

/**
 * BROWSER in Pane's terminals, run as gh or Python's webbrowser run it: one URL argument. A fake
 * CLI records what it was asked, and a fake `open` stands in for the system browser.
 */
describe.skipIf(process.platform === 'win32')('pane-browser', () => {
  const url = 'https://github.com/acme/app/pull/12?files=1&w=1#diff-%20a';

  function run(cliExit: number) {
    fs.writeFileSync(bundledCliPath, `require('fs').writeFileSync(process.env.PANE_TEST_LOG, process.argv.slice(2).join(' ')); process.exit(${cliExit});\n`);
    const state = install();
    return runBrowser(state);
  }

  function runBrowser(state: RunpaneShimState) {
    const fakeBin = path.join(root, 'fake bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const openLog = path.join(root, 'opened.txt');
    const cliLog = path.join(root, 'cli.txt');
    fs.writeFileSync(path.join(fakeBin, 'open'), `#!/bin/sh\nprintf '%s' "$1" > '${openLog}'\n`, { mode: 0o755 });
    const result = spawnSync(state.browserPath, [url], { encoding: 'utf8', env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, PANE_TEST_LOG: cliLog } });
    expect(result.status).toBe(0);
    const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
    return { cli: read(cliLog), opened: read(openLog) };
  }

  it('opens the link in a Pane tab beside the terminal, with the URL intact', () => {
    expect(run(0)).toEqual({ cli: `panels open --url ${url} --split --source user --yes`, opened: '' });
  });

  it('opens the link in the system browser when Pane cannot open the tab', () => {
    expect(run(1).opened).toBe(url);
  });

  it('opens links in the system browser when Settings > Links says so', () => {
    const state = install();
    writeBrowserShim('system', state, 'darwin');
    expect(runBrowser(state)).toEqual({ cli: '', opened: url });
  });
});

describe('pane-browser on Windows', () => {
  it('writes a PowerShell script that passes each URL to the CLI as one argument, and falls back to the system browser', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-browser-win-'));
    onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
    const state: RunpaneShimState = { binDir: "C:\\Users\\O'Neil\\.pane\\bin", shimPath: '', cli: { executable: 'C:\\Pane\\Pane.exe', script: "C:\\Users\\O'Neil\\.pane\\bin\\runpane.cjs" }, browserPath: path.join(dir, 'pane-browser.ps1'), zshDotDir: '', bashRcFile: '' };
    writeBrowserShim('pane', state, 'win32');
    const script = fs.readFileSync(state.browserPath, 'utf8');
    // Single-quoted PowerShell strings double a quote; the URL goes as $url, never through cmd.exe.
    expect(script).toContain("& 'C:\\Pane\\Pane.exe' 'C:\\Users\\O''Neil\\.pane\\bin\\runpane.cjs' panels open --url $url --split --source user --yes");
    expect(script).toContain('catch { $opened = $false }');
    expect(script).toContain('Start-Process $url');
    writeBrowserShim('system', state, 'win32');
    expect(fs.readFileSync(state.browserPath, 'utf8')).not.toContain('panels open');
  });
});

describe('withRunpaneOnPath', () => {
  const state: RunpaneShimState = { binDir: '/pane/bin', shimPath: '/pane/bin/runpane', cli: { executable: '/pane/electron', script: '/pane/bin/runpane.cjs' }, browserPath: '/pane/bin/pane-browser', zshDotDir: '/pane/shell/zsh', bashRcFile: '/pane/shell/bash/rcfile' };
  const env = { PATH: '/usr/bin:/pane/bin:/bin', HOME: '/home/me' };

  it('leaves the launch untouched without an installed shim', () => {
    expect(withRunpaneOnPath({ name: 'zsh', args: ['-i'] }, env, null)).toEqual({ args: ['-i'], env });
  });

  it('moves the bin directory to the front and exports the shim path', () => {
    const launch = withRunpaneOnPath({ name: 'sh', args: ['-i'] }, env, state, 'darwin');
    expect(launch.env.PATH).toBe('/pane/bin:/usr/bin:/bin');
    expect(launch.env.PANE_RUNPANE_BIN).toBe('/pane/bin/runpane');
    // Agent Farm's SessionStart hook runs this executable with `session-start` (D-403).
    expect(launch.env.AGENT_FARM_SESSION_HOOK).toBe('/pane/bin/runpane');
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

  it('only prepends PATH on Windows and for non-interactive commands, with BROWSER everywhere', () => {
    const winState = { ...state, binDir: 'C:\\Users\\Ada Lovelace\\.pane\\bin', browserPath: 'C:\\Users\\Ada Lovelace\\.pane\\bin\\pane-browser.ps1' };
    // Windows tools hand BROWSER the URL unquoted, which a batch file would split at `&`: PowerShell runs
    // the script with -File, its path in forward slashes because gh and Python split BROWSER POSIX-style.
    const browser = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:/Users/Ada Lovelace/.pane/bin/pane-browser.ps1"';
    const win = withRunpaneOnPath({ name: 'bash', args: ['-i'] }, { PATH: 'C:\\Windows' }, winState, 'win32');
    expect(win).toEqual({ args: ['-i'], env: { PATH: 'C:\\Users\\Ada Lovelace\\.pane\\bin;C:\\Windows', PANE_RUNPANE_BIN: '/pane/bin/runpane', AGENT_FARM_SESSION_HOOK: '/pane/bin/runpane', BROWSER: browser } });
    expect(withRunpaneBinOnPath({ PATH: '/usr/bin' }, state, 'linux')).toEqual({ PATH: '/pane/bin:/usr/bin', PANE_RUNPANE_BIN: '/pane/bin/runpane', BROWSER: '/pane/bin/pane-browser' });
    expect(withRunpaneBinOnPath({ PATH: 'C:\\Windows' }, winState, 'win32')).toEqual({ PATH: 'C:\\Users\\Ada Lovelace\\.pane\\bin;C:\\Windows', PANE_RUNPANE_BIN: '/pane/bin/runpane', BROWSER: browser });
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
