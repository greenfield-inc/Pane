import { describe, expect, it } from 'vitest';
import { getGitHubSignInTerminalCommand } from './githubSignIn';

const POSIX = 'BROWSER=false gh auth login --web --git-protocol https && gh auth setup-git';
const POWERSHELL = "$env:BROWSER='false'; gh auth login --web --git-protocol https; if ($?) { gh auth setup-git }";
const CMD = 'set BROWSER=false && gh auth login --web --git-protocol https && gh auth setup-git';

describe('getGitHubSignInTerminalCommand', () => {
  it.each([
    ['/bin/bash', POSIX],
    ['/usr/bin/zsh', POSIX],
    ['/bin/sh', POSIX],
    ['C:\\Program Files\\Git\\bin\\bash.exe', POSIX],
    ['pwsh.exe', POWERSHELL],
    ['/usr/local/bin/pwsh', POWERSHELL],
    ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', POWERSHELL],
    ['C:\\Windows\\System32\\cmd.exe', CMD],
    ['CMD.EXE', CMD],
  ])('types the line %s understands', (shell, command) => {
    expect(getGitHubSignInTerminalCommand(shell)).toBe(command);
  });

  it('falls back to the POSIX line when the host did not say', () => {
    expect(getGitHubSignInTerminalCommand(null)).toBe(POSIX);
  });

  it.each(['/bin/bash', 'pwsh.exe', 'cmd.exe'])('never presses Enter in %s', (shell) => {
    expect(getGitHubSignInTerminalCommand(shell)).not.toMatch(/[\r\n]/);
  });
});
