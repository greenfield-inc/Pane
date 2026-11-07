import { describe, expect, it, vi } from 'vitest';
import { RepositoryIdentities, repositoryIdentityFromRemote } from './repositoryIdentity';

describe('repositoryIdentityFromRemote', () => {
  it.each([
    ['git@github.com:greenfield-inc/Pane.git', 'github.com/greenfield-inc/pane'],
    ['https://github.com/greenfield-inc/Pane.git', 'github.com/greenfield-inc/pane'],
    ['https://github.com/greenfield-inc/pane', 'github.com/greenfield-inc/pane'],
    ['https://tyler@github.com/greenfield-inc/pane/', 'github.com/greenfield-inc/pane'],
    ['ssh://git@github.com:22/greenfield-inc/pane.git', 'github.com/greenfield-inc/pane'],
    ['git://GitHub.com/Greenfield-Inc/Pane.git\n', 'github.com/greenfield-inc/pane'],
    ['git@gitlab.com:group/sub/project.git', 'gitlab.com/group/sub/project'],
    ['https://bitbucket.org/team/repo.git', 'bitbucket.org/team/repo'],
  ])('reads %s as %s', (remote, identity) => {
    expect(repositoryIdentityFromRemote(remote)).toBe(identity);
  });

  it.each([[''], ['/srv/git/pane.git'], ['file:///srv/git/pane.git'], ['../pane'], ['C:\\repos\\pane'], ['https://github.com/']])('has no identity for %j', (remote) => {
    expect(repositoryIdentityFromRemote(remote)).toBeNull();
  });
});

describe('RepositoryIdentities', () => {
  const project = (path: string) => ({ path, wsl_enabled: false, wsl_distribution: null });

  it('reads git once per project path, however often the list is asked for', async () => {
    const readOrigin = vi.fn(async (path: string) => (path === '/code/pane' ? 'git@github.com:greenfield-inc/pane.git' : null));
    const identities = new RepositoryIdentities(readOrigin);

    for (let i = 0; i < 3; i += 1) {
      expect(await identities.of([project('/code/pane'), project('/code/scratch')])).toEqual(['github.com/greenfield-inc/pane', null]);
    }
    expect(readOrigin).toHaveBeenCalledTimes(2);
  });

  it('reads git again when a project\'s path changes', async () => {
    const readOrigin = vi.fn(async (path: string) => (path === '/code/pane-2' ? 'https://github.com/greenfield-inc/pane' : null));
    const identities = new RepositoryIdentities(readOrigin);

    expect(await identities.of([project('/code/pane')])).toEqual([null]);
    expect(await identities.of([project('/code/pane-2')])).toEqual(['github.com/greenfield-inc/pane']);
  });

  it('has no identity for a project whose origin cannot be read, and does not ask again', async () => {
    const readOrigin = vi.fn(async () => { throw new Error('not a git repository'); });
    const identities = new RepositoryIdentities(readOrigin);

    expect(await identities.of([project('/code/gone')])).toEqual([null]);
    expect(await identities.of([project('/code/gone')])).toEqual([null]);
    expect(readOrigin).toHaveBeenCalledTimes(1);
  });
});
