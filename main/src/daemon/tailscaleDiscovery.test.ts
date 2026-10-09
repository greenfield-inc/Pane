import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteSetupCommandRunner } from './remote-setup-command';
import { resolveTailscaleCommandAsync } from './tailscaleSetup';

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

function installedAt(installed: string) {
  const run = vi.fn<RemoteSetupCommandRunner>(async command => ({ ok: command === installed, stdout: '', stderr: '' }));
  return { run, exists: (candidate: string) => candidate === installed };
}

describe('Tailscale discovery with a desktop launcher PATH', () => {
  beforeEach(() => {
    vi.stubEnv('PATH', '/usr/bin:/bin:/usr/sbin:/sbin');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
  });

  it.each([
    ['linux', '/snap/bin/tailscale'],
    ['linux', '/run/current-system/sw/bin/tailscale'],
    ['linux', path.join(os.homedir(), '.nix-profile', 'bin', 'tailscale')],
    ['darwin', '/run/current-system/sw/bin/tailscale'],
    ['darwin', path.join(os.homedir(), '.nix-profile', 'bin', 'tailscale')],
  ])('finds the %s CLI installed at %s', async (platform, installed) => {
    Object.defineProperty(process, 'platform', { value: platform });
    const { run, exists } = installedAt(installed);

    await expect(resolveTailscaleCommandAsync(run, exists)).resolves.toEqual({
      command: installed,
      displayCommand: `'${installed}'`,
    });
  });

  it('prefers the tailscale on PATH over an installed fallback', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const run = vi.fn<RemoteSetupCommandRunner>(async () => ({ ok: true, stdout: '', stderr: '' }));

    await expect(resolveTailscaleCommandAsync(run, () => true)).resolves.toEqual({
      command: 'tailscale',
      displayCommand: 'tailscale',
    });
    expect(run).toHaveBeenCalledOnce();
  });

  it('reports no CLI when nothing is installed', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const { run } = installedAt('/nowhere/tailscale');

    await expect(resolveTailscaleCommandAsync(run, () => false)).resolves.toBeNull();
  });
});
