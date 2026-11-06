/**
 * The sign-in line typed into the host terminal for the user to run; never
 * submitted for them. BROWSER=false keeps gh from opening a browser on the
 * host: it prints a one-time code for the user to enter on their own computer.
 * Each shell sets the variable its own way, so the line follows the shell the
 * host terminal runs (Git Bash on Windows is bash).
 */
export function getGitHubSignInTerminalCommand(shell: string | null): string {
  const name = shell?.split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, '') ?? '';
  if (name === 'pwsh' || name === 'powershell') {
    return "$env:BROWSER='false'; gh auth login --web --git-protocol https; if ($?) { gh auth setup-git }";
  }
  if (name === 'cmd') {
    return 'set BROWSER=false && gh auth login --web --git-protocol https && gh auth setup-git';
  }
  return 'BROWSER=false gh auth login --web --git-protocol https && gh auth setup-git';
}

/** The shell the active host's terminal runs, or would run, as its daemon reports it; null when it can't be read. */
export async function getHostTerminalShell(): Promise<string | null> {
  try {
    const response: { success: boolean; data?: { shell: string | null } } = await window.electronAPI.invoke('host-terminal:shell');
    return response.success && response.data ? response.data.shell : null;
  } catch {
    return null;
  }
}
