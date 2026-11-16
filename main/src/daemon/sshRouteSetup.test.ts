import http from 'http';
import { afterEach, describe, expect, it } from 'vitest';
import { encodePaneRemoteConnection, normalizeRemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import type { ComputerRoute } from '../../../shared/types/remoteComputers';
import type { AppConfig } from '../types/config';
import { SshTunnels, type SshCommandResult, type SshForward, type SshRunner } from './sshRoute';
import { connectSshRoute, saveSshRoute, type SshRouteProgress } from './sshRouteSetup';

const ok = (stdout: string): SshCommandResult => ({ code: 0, stdout, stderr: '', timedOut: false });

/**
 * A host reached over ssh: `node` answers the version check, `npx` prints `setupOutput` line by
 * line, and a forward serves the host's `/health`.
 */
function fakeHost(options: { node: string; setupOutput?: string[] }): SshRunner & { commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    async run(args, { onLine }) {
      const command = args[args.length - 1];
      commands.push(command);
      if (command.includes('pane-ssh-ok')) return ok('Welcome to devbox\npane-ssh-ok\n');
      if (command.includes('pane-node:')) return ok(`pane-node:${options.node}\n`);
      const lines = options.setupOutput ?? [];
      for (const line of lines) onLine?.(line);
      return ok(lines.join('\n'));
    },
    forward(_host, localPort): SshForward {
      const server = http.createServer((_request, response) => response.end('ok'));
      server.listen(localPort, '127.0.0.1');
      let end = () => {};
      const exited = new Promise<void>((resolve) => { end = resolve; });
      const kill = () => { server.closeAllConnections(); server.close(() => end()); };
      cleanups.push(kill);
      return { exited, stderr: () => '', kill };
    },
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

const connectionCode = encodePaneRemoteConnection({
  v: 1, label: 'parsas-mac', baseUrl: 'http://127.0.0.1:42137', token: 'pairing-token-1', transport: 'http+sse',
  tunnel: { kind: 'ssh', selected: true, command: 'ssh -N -L 42137:127.0.0.1:42137 me@devbox' },
});

/** What `runpane install daemon` prints on a host without Pane (packages/runpane/src/cli.ts, formatSetupRemoteHostResult). */
const freshInstallOutput = [
  'runpane: resolving Pane release latest...',
  'runpane: downloading pane-linux-x64.deb...',
  'runpane: installing Pane...',
  'runpane: starting remote setup...',
  'Pane remote daemon setup',
  'Service: systemd-user - Installed and started pane-remote-daemon.service',
  'Connection code:',
  connectionCode,
];

function run(host: SshRunner, saved: ComputerRoute[]) {
  const progress: SshRouteProgress[] = [];
  const keeper = new SshTunnels(host);
  cleanups.push(() => keeper.stopAll());
  const result = connectSshRoute('devbox', {
    runner: host,
    tunnels: keeper,
    save: async (_alias, route) => { saved.push(route); return 'ssh-devbox'; },
    clientLabel: 'parsas-mac',
    onProgress: (event) => progress.push(event),
    hostReadyTimeoutMs: 2_000,
  });
  return { result, progress };
}

describe('connectSshRoute', () => {
  it('stops before installing anything when the host has no Node.js', async () => {
    const host = fakeHost({ node: '' });
    const saved: ComputerRoute[] = [];
    const { result, progress } = run(host, saved);

    await expect(result).rejects.toMatchObject({ code: 'ERR_SSH_NO_NODE', next: expect.stringContaining('Install Node.js 22 or later on devbox') });
    expect(host.commands.some((command) => command.includes('npx'))).toBe(false);
    expect(saved).toEqual([]);
    expect(progress.at(-1)?.step).toBe('failed');
  });

  it('installs Pane with npx on a host without it, then saves an SSH route with the printed pairing token', async () => {
    const host = fakeHost({ node: 'v22.23.4', setupOutput: freshInstallOutput });
    const saved: ComputerRoute[] = [];
    const { result, progress } = run(host, saved);

    await expect(result).resolves.toEqual({ computerId: 'ssh-devbox' });
    expect(host.commands.at(-1)).toContain('npx --yes runpane@latest install daemon --label "parsas-mac" --prefer-tunnel ssh');
    expect(progress.map((event) => event.step)).toEqual(['connecting', 'checking-node', 'starting', 'installing', 'starting', 'linked']);
    expect(saved).toEqual([{
      id: 'ssh:devbox',
      kind: 'ssh',
      source: 'ssh',
      baseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u),
      token: 'pairing-token-1',
      ssh: { host: 'devbox', remotePort: 42137 },
    }]);
  });
});

describe('saveSshRoute', () => {
  it('adding the same host again replaces its route on the same computer', async () => {
    // SAFETY: saveSshRoute reads and writes only remoteDaemon.
    let config = { remoteDaemon: normalizeRemoteDaemonConfig(undefined) } as AppConfig;
    const configManager = {
      updateConfigWith: async (update: (current: AppConfig) => Partial<AppConfig>) => (config = { ...config, ...update(config) }),
    };
    const route = (token: string): ComputerRoute => ({ id: 'ssh:devbox', kind: 'ssh', source: 'ssh', baseUrl: 'http://127.0.0.1:42137', token, ssh: { host: 'devbox', remotePort: 42137 } });

    const first = await saveSshRoute(configManager, 'devbox', route('old'));
    const second = await saveSshRoute(configManager, 'devbox', route('new'));

    expect(second).toBe(first);
    expect(config.remoteDaemon?.client.computers).toEqual([{ id: first, label: 'devbox', routes: [route('new')] }]);
  });
});
