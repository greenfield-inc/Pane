import type { GitIdentity, GitIdentityScope } from '../../../shared/types/gitIdentity';
import type { CommandRunner } from './commandRunner';

type GitFileRunner = Pick<CommandRunner, 'execFile'>;

export interface GitFailure {
  /** One readable line from git, without the command line Pane ran. */
  message: string;
  /** The full error, command line and git output included. */
  details: string;
  identityMissing: boolean;
}

const IDENTITY_MISSING_PATTERN = /Author identity unknown|Committer identity unknown|empty ident name|unable to auto-detect email address|Please tell me who you are/i;

/** Reads the identity in the repository's own environment (native or WSL). */
export async function readGitIdentity(runner: GitFileRunner, cwd: string): Promise<GitIdentity> {
  const [ident, name, email] = await Promise.all([
    runner.execFile('git', ['var', 'GIT_AUTHOR_IDENT'], cwd, { okExitCodes: [128], silent: true }),
    runner.execFile('git', ['config', 'user.name'], cwd, { okExitCodes: [1], silent: true }),
    runner.execFile('git', ['config', 'user.email'], cwd, { okExitCodes: [1], silent: true }),
  ]);
  return {
    configured: ident.exitCode === 0,
    name: name.stdout.trim(),
    email: email.stdout.trim(),
  };
}

export async function writeGitIdentity(
  runner: GitFileRunner,
  cwd: string,
  identity: { name: string; email: string; scope: GitIdentityScope },
): Promise<void> {
  const name = identity.name.trim();
  const email = identity.email.trim();
  if (!name) throw new Error('Enter a name for your commits');
  if (!email.includes('@')) throw new Error('Enter a valid email for your commits');
  const scopeFlag = identity.scope === 'global' ? '--global' : '--local';
  await runner.execFile('git', ['config', scopeFlag, 'user.name', name], cwd);
  await runner.execFile('git', ['config', scopeFlag, 'user.email', email], cwd);
}

export function describeGitFailure(error: Error): GitFailure {
  const details = error.message;
  const stderr = 'stderr' in error ? String(error.stderr ?? '') : '';
  const lines = (stderr || details).split('\n').map(line => line.trim()).filter(Boolean);
  const conclusion = lines.filter(line => /^(fatal|error):/i.test(line)).pop();
  const message = conclusion?.replace(/^(fatal|error):\s*/i, '') ?? lines[lines.length - 1] ?? details;
  return { message, details, identityMissing: IDENTITY_MISSING_PATTERN.test(details) };
}
