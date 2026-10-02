import { describe, expect, it } from 'vitest';
import { hasHeadlessDaemonLaunchArg, hasRemoteSetupLaunchArg, hasVersionQueryArg } from './runtimeMode';

describe('hasHeadlessDaemonLaunchArg', () => {
  it('detects the primary headless daemon flag', () => {
    expect(hasHeadlessDaemonLaunchArg(['--daemon-headless'])).toBe(true);
  });

  it('accepts the legacy alias', () => {
    expect(hasHeadlessDaemonLaunchArg(['--headless-daemon'])).toBe(true);
  });

  it('ignores unrelated args', () => {
    expect(hasHeadlessDaemonLaunchArg(['--pane-dir', '/tmp/pane'])).toBe(false);
  });
});

describe('hasRemoteSetupLaunchArg', () => {
  it('detects remote setup when packaged Electron places user args at argv index 1', () => {
    expect(hasRemoteSetupLaunchArg(['Pane.exe', '--remote-setup', '--print-only'])).toBe(true);
  });

  it('accepts the legacy setup alias', () => {
    expect(hasRemoteSetupLaunchArg(['Pane.exe', '--setup-remote'])).toBe(true);
  });

  it('routes the internal repair through the existing remote setup launch mode', () => {
    expect(hasRemoteSetupLaunchArg([
      'pane',
      '--remote-setup',
      '--remote-repair-service',
      '--pane-dir',
      '/tmp/.pane_remote',
    ])).toBe(true);
  });
});

describe('hasVersionQueryArg', () => {
  it('detects the version query runpane doctor sends to the installed app', () => {
    expect(hasVersionQueryArg(['/home/user/.local/bin/pane', '--version'])).toBe(true);
  });

  it('ignores normal and headless daemon launches', () => {
    expect(hasVersionQueryArg(['pane', '--daemon-headless', '--pane-dir', '/tmp/pane'])).toBe(false);
  });
});
