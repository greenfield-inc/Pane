import { API } from './api';

/**
 * The sign-in line typed into a host's terminal for the user to run; never
 * submitted for them. BROWSER=false keeps gh from opening a browser on the
 * host: it prints a one-time code for the user to enter on their own computer.
 * A Windows host's terminal runs PowerShell, which has no `VAR=value cmd`.
 */
export function getGitHubSignInTerminalCommand(platform: string | null): string {
  if (platform === 'win32') {
    return "$env:BROWSER='false'; gh auth login --web --git-protocol https; if ($?) { gh auth setup-git }";
  }
  return 'BROWSER=false gh auth login --web --git-protocol https && gh auth setup-git';
}

/** The active host's `process.platform`, as its daemon reports it; null when it can't be read. */
export async function getActiveHostPlatform(hostLabel: string): Promise<string | null> {
  try {
    const response = await API.hostFs.browseDirectories({ hostLabel });
    return response.success && response.data ? response.data.platform : null;
  } catch {
    return null;
  }
}
