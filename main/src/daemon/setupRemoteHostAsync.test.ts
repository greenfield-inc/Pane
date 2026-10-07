import { expect, it, vi } from 'vitest';
import { decodePaneRemoteConnection } from '../../../shared/types/remoteDaemon';
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

it('uses the 443 forward, not the Workspaces 8443 proxy, for the connection code', async () => {
  const serveStatus = [
    'https://office-mac.tailnet.ts.net:8443 (tailnet only)',
    '|-- / proxy http://127.0.0.1:55555/secret',
    '',
    '|-- tcp://office-mac.tailnet.ts.net:443 (TLS terminated)',
    '|--> tcp://127.0.0.1:42137',
  ].join('\n');
  const run: RemoteSetupCommandRunner = async (_command, args) => ({
    ok: true,
    stdout: args[0] === 'ip' ? '100.100.10.1\n' : args.join(' ') === 'serve status' ? serveStatus : '',
    stderr: '',
  });
  const result = await setupRemoteHost({
    installService: false, asyncCommandRunner: run, tailscaleDependencies: forbidSync, existingConfig: {}, writeConfig: async () => {},
  });
  expect(decodePaneRemoteConnection(result.connectionCode).baseUrl).toBe('https://office-mac.tailnet.ts.net');
});
