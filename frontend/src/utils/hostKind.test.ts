import { describe, expect, it } from 'vitest';
import { Cloud, Laptop, Server } from 'lucide-react';
import { describeHost, HOST_ICONS } from './hostKind';
import { normalizeRemoteDaemonConfig, type RemotePaneConnectionProfile } from '../../../shared/types/remoteDaemon';

function profile(overrides: Partial<RemotePaneConnectionProfile> = {}): RemotePaneConnectionProfile {
  return {
    id: 'profile-1',
    label: 'devbox',
    baseUrl: 'http://100.64.0.1:42137',
    token: 'token',
    transport: 'http+sse',
    ...overrides,
  };
}

describe('describeHost', () => {
  it('names the local runtime "This computer"', () => {
    expect(describeHost(null)).toEqual({ name: 'This computer', kindLabel: null, icon: 'local' });
    expect(describeHost(undefined)).toEqual({ name: 'This computer', kindLabel: null, icon: 'local' });
  });

  it('treats a profile without a host kind as a self-hosted server', () => {
    expect(describeHost(profile())).toEqual({ name: 'devbox', kindLabel: 'remote host', icon: 'server' });
  });

  it('uses the label and icon the profile was saved with', () => {
    expect(describeHost(profile({ label: 'sandbox-1', hostKind: { label: 'cloud sandbox', icon: 'cloud' } })))
      .toEqual({ name: 'sandbox-1', kindLabel: 'cloud sandbox', icon: 'cloud' });
  });

  it('draws each icon kind', () => {
    expect(HOST_ICONS).toEqual({ local: Laptop, server: Server, cloud: Cloud });
  });
});

describe('saved host kind', () => {
  it('survives config normalization', () => {
    const hostKind = { label: 'cloud sandbox', icon: 'cloud' as const };
    const config = normalizeRemoteDaemonConfig({ client: { profiles: [profile({ hostKind })], activeProfileId: null, mode: 'local' } });
    expect(config.client.profiles[0].hostKind).toEqual(hostKind);
  });

  it('keeps whether gh on the host stores its token in a file', () => {
    const config = normalizeRemoteDaemonConfig({
      client: { profiles: [profile({ ghInsecureStorage: true }), profile({ id: 'plain' })], activeProfileId: null, mode: 'local' },
    });
    expect(config.client.profiles[0].ghInsecureStorage).toBe(true);
    expect(config.client.profiles[1].ghInsecureStorage).toBeUndefined();
  });

  it('drops a profile whose token storage setting is not a boolean', () => {
    const config = normalizeRemoteDaemonConfig({
      client: { profiles: [{ ...profile(), ghInsecureStorage: 'yes' }], activeProfileId: null, mode: 'local' },
    });
    expect(config.client.profiles).toEqual([]);
  });

  it('keeps a host whose GitHub sign-in lives in Settings', () => {
    const config = normalizeRemoteDaemonConfig({
      client: { profiles: [profile({ githubSignIn: 'settings' }), profile({ id: 'plain' })], activeProfileId: null, mode: 'local' },
    });
    expect(config.client.profiles[0].githubSignIn).toBe('settings');
    expect(config.client.profiles[1].githubSignIn).toBeUndefined();
  });

  it('drops a profile with an unknown GitHub sign-in route', () => {
    const config = normalizeRemoteDaemonConfig({
      client: { profiles: [{ ...profile(), githubSignIn: 'terminal' }], activeProfileId: null, mode: 'local' },
    });
    expect(config.client.profiles).toEqual([]);
  });

  it('drops a profile whose host kind has an unknown icon', () => {
    const config = normalizeRemoteDaemonConfig({
      client: { profiles: [{ ...profile(), hostKind: { label: 'x', icon: 'rocket' } }], activeProfileId: null, mode: 'local' },
    });
    expect(config.client.profiles).toEqual([]);
  });
});
