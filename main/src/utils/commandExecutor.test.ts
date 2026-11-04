import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { CommandExecutor } from './commandExecutor';

describe('CommandExecutor.execFileAsync', () => {
  it('builds one escaped bash command for the WSL branch', async () => {
    const fileExecutor = vi.fn(async () => ({ stdout: 'ok\n', stderr: '' }));
    const executor = new CommandExecutor(fileExecutor);

    const result = await executor.execFileAsync(
      'git',
      ['diff', '$HOME', "quote'arg"],
      {
        cwd: '/repo with space',
        env: { PANE_DIFF_TEST_ENV: 'value with space' },
        silent: true,
      },
      { enabled: true, distribution: 'Ubuntu-Test', linuxPath: '/repo with space' },
    );

    expect(result).toEqual({ stdout: 'ok\n', stderr: '', exitCode: 0 });
    expect(fileExecutor).toHaveBeenCalledOnce();
    expect(fileExecutor).toHaveBeenCalledWith(
      'wsl.exe',
      [
        '-d',
        'Ubuntu-Test',
        '--',
        'bash',
        '-c',
        "export PANE_DIFF_TEST_ENV='value with space'; cd '/repo with space' && 'git' 'diff' '$HOME' 'quote'\\''arg'",
      ],
      expect.objectContaining({ cwd: undefined }),
    );
  });
});

describe('CommandExecutor.execFileAsync timeout', () => {
  // Git for Windows can put a launcher (cmd\git.exe) on PATH that runs the real
  // git as its child. A timeout that stops only the launcher leaves git and its
  // ssh command running in the repository, which then cannot be deleted.
  const launcher = 'C:\\Program Files\\Git\\cmd\\git.exe';
  it.runIf(process.platform === 'win32' && existsSync(launcher))('stops the whole process tree a launcher started', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'pane-exec-timeout-'));
    const marker = join(folder, 'still-running').replace(/\\/g, '/');
    try {
      await expect(new CommandExecutor().execFileAsync(launcher, [
        '-c', `core.sshCommand=sleep 3 && touch '${marker}' #`, 'ls-remote', 'ssh://pane.invalid/remote.git',
      ], { cwd: folder, timeout: 1_000, silent: true })).rejects.toMatchObject({ killed: true });

      await new Promise(resolve => setTimeout(resolve, 4_000));
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }, 15_000);
});
