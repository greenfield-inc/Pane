import childProcess from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteSetupCommandRunner } from './remote-setup-command';
import { resolveTailscaleCommand, resolveTailscaleCommandAsync } from './tailscaleSetup';

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
const exists = vi.fn<(candidate: string) => boolean>();
const spawn = vi.fn<typeof childProcess.spawnSync>();
const run = vi.fn<RemoteSetupCommandRunner>();

describe('Tailscale discovery after a macOS GUI relaunch', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    vi.stubEnv('PATH', '/usr/bin:/bin:/usr/sbin:/sbin');
    exists.mockReturnValue(false);
    spawn.mockReturnValue({ status: 1, stdout: '', stderr: 'not found' });
    run.mockResolvedValue({ ok: false, stdout: '', stderr: 'not found' });
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
  });

  it.each(['/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'])(
    'finds %s without Homebrew on PATH in synchronous setup', candidate => {
      exists.mockImplementation(file => file === candidate);
      spawn.mockImplementation(command => ({
        status: command === candidate ? 0 : 1, stdout: '', stderr: '',
      }));

      expect(resolveTailscaleCommand({ spawnSync: spawn }, exists)).toEqual({
        command: candidate, displayCommand: `'${candidate}'`,
      });
      expect(spawn).toHaveBeenCalledWith(candidate, ['version'], expect.objectContaining({
        env: expect.objectContaining({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }),
      }));
    },
  );

  it.each(['/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'])(
    'finds %s without Homebrew on PATH in asynchronous health checks', async candidate => {
      run.mockImplementation(async command => ({ ok: command === candidate, stdout: '', stderr: '' }));

      await expect(resolveTailscaleCommandAsync(run, file => file === candidate)).resolves.toEqual({
        command: candidate, displayCommand: `'${candidate}'`,
      });
      expect(run).toHaveBeenCalledWith(candidate, ['version'], { env: undefined });
    },
  );

  it('tries the next installed CLI when the first Homebrew candidate cannot run', async () => {
    exists.mockReturnValue(true);
    run.mockImplementation(async command => ({
      ok: command === '/usr/local/bin/tailscale', stdout: '', stderr: '',
    }));

    await expect(resolveTailscaleCommandAsync(run, exists)).resolves.toMatchObject({
      command: '/usr/local/bin/tailscale',
    });
    expect(run.mock.calls.map(([command]) => command)).toEqual([
      'tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale',
    ]);
  });

  it('keeps a working PATH command ahead of installed fallback commands', async () => {
    exists.mockReturnValue(true);
    spawn.mockReturnValue({ status: 0, stdout: '', stderr: '' });
    run.mockResolvedValue({ ok: true, stdout: '', stderr: '' });

    expect(resolveTailscaleCommand({ spawnSync: spawn }, exists)).toEqual({ command: 'tailscale', displayCommand: 'tailscale' });
    await expect(resolveTailscaleCommandAsync(run, exists)).resolves.toEqual({ command: 'tailscale', displayCommand: 'tailscale' });
    expect(spawn).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
  });

  it('retains the app bundle fallback and its CLI environment', async () => {
    const candidate = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
    run.mockResolvedValue({ ok: true, stdout: '', stderr: '' });
    run.mockResolvedValueOnce({ ok: false, stdout: '', stderr: 'not found' });

    await expect(resolveTailscaleCommandAsync(run, file => file === candidate)).resolves.toMatchObject({
      command: candidate,
      displayCommand: `TAILSCALE_BE_CLI=1 '${candidate}'`,
      env: { TAILSCALE_BE_CLI: '1', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    });
  });
});
