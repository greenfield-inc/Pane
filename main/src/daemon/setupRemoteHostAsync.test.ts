import { expect, it, vi } from 'vitest';
import { setupRemoteHost } from './setupRemoteHost';
import type { RemoteSetupCommandRunner } from './remote-setup-command';
import type { TailscaleSetupDependencies } from './tailscaleSetup';

const forbidSync: TailscaleSetupDependencies = {
  spawnSync: () => { throw new Error('Synchronous setup cannot run on the desktop'); },
};

it('reports a missing Tailscale dependency without installing or writing configuration', async () => {
  const run = vi.fn<RemoteSetupCommandRunner>().mockResolvedValue({ ok: false, stdout: '', stderr: 'not found' });
  const writeConfig = vi.fn(async () => {});
  await expect(setupRemoteHost({
    installService: false, asyncCommandRunner: run, tailscaleDependencies: forbidSync, writeConfig,
  })).rejects.toThrow('Tailscale is not installed');
  expect(writeConfig).not.toHaveBeenCalled();
  expect(run.mock.calls.every(([, args]) => args.join(' ') === 'version')).toBe(true);
});

it('lets the event loop run while Serve is pending and returns the configured connection', async () => {
  let finishServe = () => {};
  const serving = new Promise<void>(resolve => { finishServe = resolve; });
  let notifyServing = () => {};
  const started = new Promise<void>(resolve => { notifyServing = resolve; });
  const run: RemoteSetupCommandRunner = async (_command, args) => {
    if (args[0] === 'serve' && args[1] === '--bg') {
      notifyServing();
      await serving;
    }
    return { ok: true, stdout: args[0] === 'ip' ? '100.100.10.1\n' : 'https://pane-fixture.ts.net', stderr: '' };
  };
  const writeConfig = vi.fn(async () => {});
  const setup = setupRemoteHost({
    installService: false, asyncCommandRunner: run, tailscaleDependencies: forbidSync, existingConfig: {}, writeConfig,
  });
  await started;
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(writeConfig).not.toHaveBeenCalled();
  finishServe();
  const result = await setup;
  expect(result.tunnel).toMatchObject({ kind: 'tailscale', selected: true, tailscaleIp: '100.100.10.1' });
  expect(writeConfig).toHaveBeenCalledOnce();
});
