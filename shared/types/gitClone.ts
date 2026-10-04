/**
 * `git:clone-repo` failure code for git not being able to sign in to the
 * repository's server (HTTPS credentials or SSH keys). The renderer uses it to
 * offer signing in on a remote host instead of only showing the message.
 */
export const GIT_CLONE_AUTH_REQUIRED = 'GIT_CLONE_AUTH_REQUIRED';

/** Which way git tried to sign in when a clone failed with `GIT_CLONE_AUTH_REQUIRED`. */
export type GitCloneAuthProtocol = 'https' | 'ssh';
