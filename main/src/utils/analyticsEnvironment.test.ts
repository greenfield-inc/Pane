import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { CI_ENVIRONMENT_KEYS, detectAnalyticsEnvironment, type EnvironmentProbe } from './analyticsEnvironment';

function probe(overrides: Partial<EnvironmentProbe> & { files?: Record<string, string> } = {}): EnvironmentProbe {
  const { files = {}, ...rest } = overrides;
  return {
    env: {},
    platform: 'linux',
    osRelease: '6.8.0-45-generic',
    readFile: (path) => files[path],
    isPackaged: true,
    customPaneDir: false,
    ...rest,
  };
}

const person = { ci: false, ci_provider: 'none', container: false, wsl: false, packaged: true, custom_pane_dir: false, automated: false };

describe('detectAnalyticsEnvironment', () => {
  it.each(['darwin', 'win32'] as const)('tags a person on %s as not automated', (platform) => {
    expect(detectAnalyticsEnvironment(probe({ platform }))).toEqual({ ...person, display: 'native' });
  });

  it('tags a Linux desktop session by its display server', () => {
    expect(detectAnalyticsEnvironment(probe({ env: { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' } }))).toEqual({ ...person, display: 'wayland' });
    expect(detectAnalyticsEnvironment(probe({ env: { DISPLAY: ':0' }, files: { '/tmp/.X0-lock': '      1234\n', '/proc/1234/comm': 'Xorg\n' } })))
      .toEqual({ ...person, display: 'x11' });
  });

  it('tags a GitHub Actions run in Docker under xvfb-run as automated', () => {
    const env = { CI: 'true', GITHUB_ACTIONS: 'true', DISPLAY: ':99' };
    const files = { '/.dockerenv': '', '/tmp/.X99-lock': '      4321\n', '/proc/4321/comm': 'Xvfb\n' };
    expect(detectAnalyticsEnvironment(probe({ env, files }))).toEqual({
      ...person, ci: true, ci_provider: 'github_actions', container: true, display: 'virtual', automated: true,
    });
  });

  it.each([
    [{ GITLAB_CI: 'true', CI: 'true' }, 'gitlab'],
    [{ BUILDKITE: 'true' }, 'buildkite'],
    [{ CIRCLECI: 'true' }, 'circleci'],
    [{ TF_BUILD: 'True' }, 'azure_pipelines'],
    [{ JENKINS_URL: 'https://ci.example' }, 'jenkins'],
    [{ TEAMCITY_VERSION: '2024.1' }, 'teamcity'],
    [{ CODEBUILD_BUILD_ID: 'build:1' }, 'codebuild'],
    [{ CI: '1' }, 'other'],
  ])('names the CI provider for %o', (env, provider) => {
    const tags = detectAnalyticsEnvironment(probe({ platform: 'darwin', env }));
    expect(tags).toMatchObject({ ci: true, ci_provider: provider, automated: true });
  });

  it.each([
    ['/run/.containerenv (Podman)', { env: {}, files: { '/run/.containerenv': '' } }],
    ['the container env var', { env: { container: 'podman' }, files: {} }],
    ['a Docker cgroup', { env: {}, files: { '/proc/1/cgroup': '0::/docker/0123abcd\n' } }],
    ['a Kubernetes cgroup', { env: {}, files: { '/proc/1/cgroup': '12:pids:/kubepods/besteffort/pod1\n' } }],
  ])('detects a container from %s', (_name, overrides) => {
    const env = { WAYLAND_DISPLAY: 'wayland-0', ...overrides.env };
    const tags = detectAnalyticsEnvironment(probe({ ...overrides, env }));
    expect(tags).toMatchObject({ container: true, automated: true });
  });

  it('does not count Flatpak or a host cgroup as a container', () => {
    const tags = detectAnalyticsEnvironment(probe({
      env: { container: 'flatpak', WAYLAND_DISPLAY: 'wayland-0' },
      files: { '/proc/1/cgroup': '0::/init.scope\n' },
    }));
    expect(tags).toMatchObject({ container: false, automated: false });
  });

  it('counts a Linux run without a display as automated', () => {
    expect(detectAnalyticsEnvironment(probe())).toMatchObject({ display: 'none', automated: true });
  });

  it('treats an X display whose server cannot be read as x11', () => {
    expect(detectAnalyticsEnvironment(probe({ env: { DISPLAY: 'localhost:10.0' } }))).toMatchObject({ display: 'x11', automated: false });
  });

  it('tags WSL from its env var or kernel release, with WSLg as a person', () => {
    expect(detectAnalyticsEnvironment(probe({ env: { WSL_DISTRO_NAME: 'Ubuntu', WAYLAND_DISPLAY: 'wayland-0' } })))
      .toEqual({ ...person, wsl: true, display: 'wayland' });
    expect(detectAnalyticsEnvironment(probe({ osRelease: '6.6.87.2-microsoft-standard-WSL2', env: { WAYLAND_DISPLAY: 'wayland-0' } })))
      .toMatchObject({ wsl: true });
    expect(detectAnalyticsEnvironment(probe({ platform: 'win32', osRelease: '10.0.26100' }))).toMatchObject({ wsl: false });
  });

  it('reports a dev build and a custom data directory without counting them as automated', () => {
    expect(detectAnalyticsEnvironment(probe({ platform: 'darwin', isPackaged: false, customPaneDir: true })))
      .toEqual({ ...person, display: 'native', packaged: false, custom_pane_dir: true });
  });

  it('survives unreadable files', () => {
    const tags = detectAnalyticsEnvironment(probe({ readFile: () => { throw new Error('EACCES'); }, env: { DISPLAY: ':0' } }));
    expect(tags).toEqual({ ...person, display: 'x11' });
  });

  it('uses the same CI env list as both runpane wrappers', () => {
    const root = join(__dirname, '../../..');
    const npm = readFileSync(join(root, 'packages/runpane/src/telemetry.ts'), 'utf8');
    const pip = readFileSync(join(root, 'packages/runpane-py/src/runpane/telemetry.py'), 'utf8');
    const keys = (source: string) => [...(source.match(/CI_ENVIRONMENT_KEYS = [[(]([^\])]*)/)?.[1].matchAll(/['"]([A-Z_]+)['"]/g) ?? [])].map((m) => m[1]);
    expect(keys(npm)).toEqual([...CI_ENVIRONMENT_KEYS]);
    expect(keys(pip)).toEqual([...CI_ENVIRONMENT_KEYS]);
  });
});
