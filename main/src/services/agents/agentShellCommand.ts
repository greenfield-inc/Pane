import { escapeForBash } from '../../utils/wslUtils';

/** Quote argv for a noninteractive shell whose lifetime ends with the agent. */
export function quoteAgentArgument(value: string, powershell = false): string {
  return powershell ? `'${value.replace(/'/g, "''")}'` : escapeForBash(value);
}

export function buildAgentShellCommand(
  launch: { executable: string; args: string[] },
  powershell = false,
): string {
  const argv = [launch.executable, ...launch.args].map(value => quoteAgentArgument(value, powershell));
  // A noninteractive PowerShell exits after the invocation even if it fails;
  // POSIX exec replaces the shell entirely. Neither can accept later prompts.
  return powershell ? `$ErrorActionPreference = 'Stop'; & ${argv.join(' ')}; exit $LASTEXITCODE` : `exec ${argv.join(' ')}`;
}
