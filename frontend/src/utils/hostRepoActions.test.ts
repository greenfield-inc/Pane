import { describe, expect, it } from 'vitest';
import {
  buildCloneOptions,
  buildCreateProjectRequest,
  defaultCloneDestination,
  folderBrowseTarget,
  formatHostChipText,
  getActiveHost,
  withHostLabel,
  type ActiveHost,
} from './hostRepoActions';
import {
  createDefaultRemotePaneConnectionState,
  type RemotePaneConnectionProfile,
  type RemotePaneConnectionState,
} from '../../../shared/types/remoteDaemon';

const devbox: RemotePaneConnectionProfile = {
  id: 'devbox',
  label: 'devbox',
  baseUrl: 'https://devbox.example.ts.net',
  token: 'synthetic',
  transport: 'http+sse',
};
const testina: RemotePaneConnectionProfile = {
  ...devbox,
  id: 'testina',
  label: 'testina',
  hostKind: { label: 'cloud sandbox', icon: 'cloud' },
};

function connectedTo(profile: RemotePaneConnectionProfile): RemotePaneConnectionState {
  return {
    ...createDefaultRemotePaneConnectionState(),
    mode: 'remote',
    status: 'connected',
    activeProfileId: profile.id,
    activeProfileLabel: profile.label,
  };
}

const local = getActiveHost(createDefaultRemotePaneConnectionState(), [devbox, testina]);
const selfHosted = getActiveHost(connectedTo(devbox), [devbox, testina]);
const sandbox = getActiveHost(connectedTo(testina), [devbox, testina]);

describe('getActiveHost', () => {
  it('is this computer in local mode, even with saved hosts', () => {
    expect(local).toEqual({ remote: false, name: 'This computer', kindLabel: null, icon: 'local' });
  });

  it('names the active saved host and its kind', () => {
    expect(selfHosted).toEqual({ remote: true, name: 'devbox', kindLabel: 'remote host', icon: 'server' });
    expect(sandbox).toEqual({ remote: true, name: 'testina', kindLabel: 'cloud sandbox', icon: 'cloud' });
  });

  it('stays remote when the active profile is missing, using the pushed label', () => {
    const host = getActiveHost({ ...connectedTo(testina), activeProfileId: 'gone' }, []);
    expect(host).toEqual({ remote: true, name: 'testina', kindLabel: 'remote host', icon: 'server' });
  });
});

describe('formatHostChipText', () => {
  it.each<[string, ActiveHost, string]>([
    ['local', local, 'On: This computer'],
    ['self-hosted remote', selfHosted, 'On: devbox (remote host)'],
    ['cloud sandbox', sandbox, 'On: testina (cloud sandbox)'],
  ])('reads right for a %s', (_kind, host, text) => {
    expect(formatHostChipText(host)).toBe(text);
  });
});

describe('buildCreateProjectRequest', () => {
  it('always sends the mode, so the host never falls back to create + git init for Open', () => {
    expect(buildCreateProjectRequest(local, { name: 'app', path: '/src/app', mode: 'open' }))
      .toEqual({ name: 'app', path: '/src/app', mode: 'open' });
    expect(buildCreateProjectRequest(local, { name: 'app', path: '/src/app', mode: 'new' }))
      .toMatchObject({ mode: 'new' });
  });

  it('sends the host label on a remote so host errors name it, not its hostname', () => {
    expect(buildCreateProjectRequest(sandbox, { name: 'app', path: '~/app', mode: 'open' }))
      .toEqual({ name: 'app', path: '~/app', mode: 'open', hostLabel: 'testina' });
  });

  it('keeps the optional scripts the dialog collected', () => {
    expect(buildCreateProjectRequest(local, { name: 'a', path: '/a', mode: 'new', buildScript: 'make' }))
      .toMatchObject({ buildScript: 'make' });
  });
});

describe('withHostLabel', () => {
  it('adds the label only on a remote host', () => {
    expect(withHostLabel(local, { path: '~' })).toEqual({ path: '~' });
    expect(withHostLabel(selfHosted, { path: '~' })).toEqual({ path: '~', hostLabel: 'devbox' });
  });
});

describe('clone defaults', () => {
  it('defaults the destination to the remote home, and leaves local empty as before', () => {
    expect(defaultCloneDestination(sandbox)).toBe('~');
    expect(defaultCloneDestination(selfHosted)).toBe('~');
    expect(defaultCloneDestination(local)).toBe('');
  });

  it('passes the host label to the clone on a remote only', () => {
    expect(buildCloneOptions(sandbox)).toEqual({ hostLabel: 'testina' });
    expect(buildCloneOptions(local)).toEqual({});
  });
});

describe('folderBrowseTarget', () => {
  it('uses the native dialog only for this computer', () => {
    expect(folderBrowseTarget(local)).toBe('native');
    expect(folderBrowseTarget(selfHosted)).toBe('host');
    expect(folderBrowseTarget(sandbox)).toBe('host');
  });
});
