import { execFile } from 'child_process';
import { promisify } from 'util';
import { CloneRepo } from 'pane-cloud-contract';
import { repositoryAddressFromRemote } from './repositoryIdentity';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5_000;

/**
 * The repo a new cloud Session clones for a project (D-107): its `origin` as an https URL, and the
 * branch the project has checked out, else the remote's default. Null for a project with no remote
 * a cloud machine can clone over https.
 */
export async function cloneRepoOf(projectPath: string): Promise<CloneRepo | null> {
  const git = (...args: string[]) =>
    execFileAsync('git', ['-C', projectPath, ...args], { timeout: GIT_TIMEOUT_MS }).then(({ stdout }) => stdout.trim(), () => '');
  const identity = repositoryAddressFromRemote(await git('remote', 'get-url', 'origin'));
  if (!identity) return null;
  const branch = (await git('symbolic-ref', '--quiet', '--short', 'HEAD')) || (await git('symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD')).replace(/^origin\//, '');
  const repo = CloneRepo.safeParse({ url: `https://${identity}`, branch });
  return repo.success ? repo.data : null;
}
