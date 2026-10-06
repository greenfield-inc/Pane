import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execOnMachine, readMachineFile, resolveMachinePath, writeMachineFile } from './workspaceMachine';

afterEach(() => {
  vi.restoreAllMocks();
});

const windows = { platform: 'win32' as const, homeDir: 'C:\\Users\\khaza', wslDistro: 'Ubuntu' };
const wsl = { platform: 'linux' as const, homeDir: '/home/khaza', isWsl: true, wslDistro: 'Ubuntu' };
const mac = { platform: 'darwin' as const, homeDir: '/Users/parsa' };

describe('resolveMachinePath', () => {
  it('reaches the same Windows file from a drive path and a /mnt path', () => {
    expect(resolveMachinePath('C:\\Users\\khaza\\.pane\\plans\\a\\index.html', windows))
      .toBe('C:\\Users\\khaza\\.pane\\plans\\a\\index.html');
    expect(resolveMachinePath('/mnt/c/Users/khaza/.pane/plans/a/index.html', windows))
      .toBe('C:\\Users\\khaza\\.pane\\plans\\a\\index.html');
    expect(resolveMachinePath('C:/Users/khaza/notes.md', windows)).toBe('C:\\Users\\khaza\\notes.md');
  });

  it('reads WSL-internal paths through \\\\wsl.localhost on Windows', () => {
    expect(resolveMachinePath('/home/khaza/repo/README.md', windows))
      .toBe('\\\\wsl.localhost\\Ubuntu\\home\\khaza\\repo\\README.md');
    expect(resolveMachinePath('\\\\wsl.localhost\\Debian\\etc\\hosts', windows))
      .toBe('\\\\wsl.localhost\\Debian\\etc\\hosts');
    expect(resolveMachinePath('\\\\wsl$\\Ubuntu\\home\\khaza', windows)).toBe('\\\\wsl$\\Ubuntu\\home\\khaza');
  });

  it('refuses a Linux path on Windows without WSL', () => {
    expect(() => resolveMachinePath('/home/khaza/x', { ...windows, wslDistro: undefined }))
      .toThrow(/no WSL distribution/);
  });

  it('maps Windows paths into WSL mounts when Pane runs inside WSL', () => {
    expect(resolveMachinePath('C:\\Users\\khaza\\notes.md', wsl)).toBe('/mnt/c/Users/khaza/notes.md');
    expect(resolveMachinePath('\\\\wsl.localhost\\Ubuntu\\home\\khaza\\x', wsl)).toBe('/home/khaza/x');
    expect(resolveMachinePath('/home/khaza/x', wsl)).toBe('/home/khaza/x');
    expect(() => resolveMachinePath('\\\\wsl.localhost\\Debian\\home\\khaza\\x', wsl)).toThrow(/Debian distribution/);
  });

  it('expands ~ against the machine home', () => {
    expect(resolveMachinePath('~/.pane/config.json', mac)).toBe('/Users/parsa/.pane/config.json');
    expect(resolveMachinePath('~\\.pane\\config.json', windows)).toBe('C:\\Users\\khaza\\.pane\\config.json');
    expect(resolveMachinePath('~', wsl)).toBe('/home/khaza');
  });

  it('refuses Windows paths on a Mac and relative paths anywhere', () => {
    expect(() => resolveMachinePath('C:\\Users\\khaza\\x', mac)).toThrow(/Windows path/);
    expect(() => resolveMachinePath('notes.md', mac)).toThrow(/absolute/);
  });
});

describe('machine file and command operations', () => {
  it('writes a file, creating parent folders, and reads it back', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-machine-'));
    const target = path.join(dir, 'plans', 'topic', 'index.html');
    expect(await writeMachineFile({ path: target, content: '<h1>brief</h1>\n' })).toMatchObject({ path: target, bytes: 15 });
    expect(await readMachineFile({ path: target })).toEqual({
      path: target, encoding: 'utf8', content: '<h1>brief</h1>\n', bytes: 15,
    });
  });

  it('returns binary files as base64', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-machine-'));
    const target = path.join(dir, 'blob.bin');
    await fs.writeFile(target, Buffer.from([0xff, 0x00, 0xfe]));
    expect(await readMachineFile({ path: target })).toMatchObject({ encoding: 'base64', content: '/wD+', bytes: 3 });
  });

  it.skipIf(process.platform === 'win32')('refuses devices and pipes, which have no end to read', async () => {
    await expect(readMachineFile({ path: '/dev/zero' })).rejects.toThrow(/not a regular file/);
  });

  it('runs a command in the machine shell and reports output, exit code, and shell', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pane-machine-')));
    const result = await execOnMachine({ command: 'echo out; echo err 1>&2; exit 3', cwd: dir });
    expect(result).toMatchObject({ exitCode: 3, stdout: 'out\n', stderr: 'err\n', cwd: dir, timedOut: false });
    expect(result.shell).toMatch(/sh(\.exe)?$/);
    expect(result.os).toBe(new Map([['darwin', 'macOS'], ['win32', 'Windows']]).get(process.platform) ?? 'Linux');
  });

  it('answers when the shell exits even if a background job still holds its output', async () => {
    const started = Date.now();
    const result = await execOnMachine({ command: 'sleep 5 & echo started' });
    expect(result).toMatchObject({ exitCode: 0, stdout: 'started\n' });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('stops a command that runs past its timeout', async () => {
    const result = await execOnMachine({ command: 'sleep 5', timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.stillRunning).toBeUndefined();
  });

  // Kills go through process.kill on POSIX; Windows uses taskkill, whose failures are caught.
  it.skipIf(process.platform === 'win32')('answers, and says the command may still run, when the process tree cannot be stopped', async () => {
    // Every SIGKILL is lost, as when the kill itself fails; existence checks still work.
    const realKill = process.kill.bind(process);
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => (signal === 'SIGKILL' ? true : realKill(pid, signal)));
    const started = Date.now();
    const result = await execOnMachine({ command: 'sleep 4', timeoutMs: 200 });
    expect(result).toMatchObject({ timedOut: true, stillRunning: true, exitCode: null });
    expect(Date.now() - started).toBeLessThan(3500);
  });
});
