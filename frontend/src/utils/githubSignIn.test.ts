import { describe, expect, it } from 'vitest';
import { getGitHubSignInTerminalCommand } from './githubSignIn';

const POSIX = 'BROWSER=false gh auth login --web --git-protocol https && gh auth setup-git';
const POWERSHELL = "$env:BROWSER='false'; gh auth login --web --git-protocol https; if ($?) { gh auth setup-git }";

describe('getGitHubSignInTerminalCommand', () => {
  it.each([
    ['linux', POSIX],
    ['darwin', POSIX],
    ['win32', POWERSHELL],
  ])('types the %s shell\'s sign-in line', (platform, command) => {
    expect(getGitHubSignInTerminalCommand(platform)).toBe(command);
  });

  it('falls back to the POSIX line when the host did not say', () => {
    expect(getGitHubSignInTerminalCommand(null)).toBe(POSIX);
  });

  it.each(['linux', 'darwin', 'win32'])('never presses Enter on %s', (platform) => {
    expect(getGitHubSignInTerminalCommand(platform)).not.toMatch(/[\r\n]/);
  });
});
