/** Error code `git:commit` returns when git has no user.name/user.email to commit with. */
export const GIT_IDENTITY_MISSING = 'GIT_IDENTITY_MISSING';

export interface GitIdentity {
  /** Whether git can build an author ident here, exactly as `git commit` would. */
  configured: boolean;
  name: string;
  email: string;
}

export type GitIdentityScope = 'global' | 'local';
