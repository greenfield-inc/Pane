import { GIT_CLONE_AUTH_REQUIRED } from '../../../shared/types/gitClone';

/** Ways `git clone` fails because the host could not sign in to the repository's server. */
type GitCloneAuthFailure = 'https-auth' | 'https-forbidden' | 'ssh-host-key' | 'ssh-publickey';

interface GitCloneFailureDescription {
  error: string;
  code?: typeof GIT_CLONE_AUTH_REQUIRED;
}

/** Reads git's output from a failed clone and says whether signing in would fix it. */
export function classifyGitCloneFailure(message: string): GitCloneAuthFailure | null {
  if (message.includes('could not read Username') || message.includes('Authentication failed')) return 'https-auth';
  if (message.includes('The requested URL returned error: 403')) return 'https-forbidden';
  if (message.includes('Host key verification failed')) return 'ssh-host-key';
  if (message.includes('Permission denied (publickey)')) return 'ssh-publickey';
  return null;
}

/** Turns a failed clone's raw error into the message the clone dialog shows. */
export function describeGitCloneFailure(message: string): GitCloneFailureDescription {
  if (message.includes('Could not resolve host') || message.includes('Connection timed out')) {
    return { error: 'Network error — check your internet connection and try again.' };
  }

  switch (classifyGitCloneFailure(message)) {
    case 'https-auth':
      return { error: 'Authentication failed — check your credentials or use an SSH URL.', code: GIT_CLONE_AUTH_REQUIRED };
    case 'https-forbidden':
      return { error: message, code: GIT_CLONE_AUTH_REQUIRED };
    case 'ssh-host-key':
      return {
        error: "SSH host key verification failed — this computer doesn't trust the Git server yet. Connect to it once with ssh to accept its host key, or use an HTTPS URL.",
        code: GIT_CLONE_AUTH_REQUIRED,
      };
    case 'ssh-publickey':
      return {
        error: 'SSH authentication failed — the Git server rejected this computer\'s SSH key. Add your SSH key to your Git host, or use an HTTPS URL.',
        code: GIT_CLONE_AUTH_REQUIRED,
      };
    case null:
      break;
  }

  if (message.includes('not found') || message.includes('does not exist')) {
    return { error: 'Repository not found — check the URL and try again.' };
  }
  return { error: message };
}
