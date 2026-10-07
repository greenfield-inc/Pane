import fs from 'fs/promises';
import net from 'net';
import os from 'os';
import path from 'path';
import childProcess from 'child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodePaneRemoteConnection } from '../../../shared/types/remoteDaemon';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import {
  readConfiguredTailscaleServeAccess,
  setupRemoteHost as setupRemoteHostImpl,
  type SetupRemoteHostOptions,
} from './setupRemoteHost';
import { createFakeTailscale, TAILNET_A, TAILNET_B } from './__fixtures__/fakeTailscale';
import { formatTailscaleIssue } from './tailscaleSetup';

const spawnSyncMock = vi.fn<typeof childProcess.spawnSync>();

function setupRemoteHost(options: SetupRemoteHostOptions = {}) {
  return setupRemoteHostImpl({
    ...options,
    tailscaleDependencies: { spawnSync: spawnSyncMock },
  });
}
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

function commandResult(options: {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}) {
  return {
    status: options.status,
    stdout: options.stdout ?? '',
    stderr: options.stderr ?? '',
    error: options.error,
  };
}

function missingCommandResult(command: string) {
  const error = Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' });
  return commandResult({ status: null, error });
}

describe('setupRemoteHost', () => {
  afterEach(() => {
    spawnSyncMock.mockReset();
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  });

  it('attempts Tailscale setup before rejecting the default cross-device setup', async () => {
    spawnSyncMock.mockReturnValue(missingCommandResult('tailscale'));

    await expect(setupRemoteHost({
      paneDir: path.join(os.tmpdir(), 'pane-remote-missing-tailscale'),
      installService: false,
    })).rejects.toThrow('Tailscale is required for cross-device remote setup, but Pane could not find the tailscale CLI after attempting setup.');

    expect(spawnSyncMock).toHaveBeenCalledWith('tailscale', ['version'], expect.any(Object));
  });

  it('rejects an undiscoverable packaged executable before changing configuration', async () => {
    const paneDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-remote-custom-executable-'));
    const executable = path.join(paneDir, 'custom-pane');
    const writeConfig = vi.fn(async () => {});
    await fs.writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    try {
      await expect(setupRemoteHost({
        paneDir,
        writeConfig,
        installService: true,
        serviceDependencies: {
          platform: 'linux',
          homeDir: paneDir,
          executablePath: executable,
          executableCandidates: [path.join(paneDir, '.local', 'bin', 'pane')],
          sourceRoot: null,
          runCommand: () => ({ ok: false, stdout: '', stderr: '' }),
        },
      })).rejects.toThrow('cannot persist the current executable safely');
      expect(writeConfig).not.toHaveBeenCalled();
      await expect(fs.stat(path.join(paneDir, 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(paneDir, { recursive: true, force: true });
    }
  });

  it('uses a Tailscale Serve HTTPS URL for the generated connection code', async () => {
    const paneDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-remote-tailscale-'));
    try {
      spawnSyncMock.mockImplementation((command: string, args: string[]) => {
        if (command === 'tailscale' && args[0] === 'version') {
          return commandResult({ status: 0, stdout: '1.80.0\n' });
        }
        if (
          command === 'tailscale' &&
          args[0] === 'serve' &&
          args[1] === '--bg' &&
          args[2] === '--tls-terminated-tcp=443' &&
          args[3] === '42137'
        ) {
          return commandResult({
            status: 0,
            stdout: 'Available within your tailnet:\n|-- tcp://office-mac.tailnet.ts.net:443 (TLS terminated)\n',
          });
        }
        if (command === 'tailscale' && args[0] === 'serve' && args[1] === 'status') {
          return commandResult({
            status: 0,
            stdout: 'tcp://office-mac.tailnet.ts.net:443 (TLS terminated) forward tcp://127.0.0.1:42137\n',
          });
        }
        if (command === 'tailscale' && args[0] === 'ip' && args[1] === '-4') {
          return commandResult({
            status: 0,
            stdout: '100.127.116.52\n',
          });
        }

        return missingCommandResult(command);
      });

      const result = await setupRemoteHost({
        paneDir,
        label: 'Office Mac',
        installService: false,
      });
      const payload = decodePaneRemoteConnection(result.connectionCode);
      const config = decodeBoundary(
        JSON.parse(await fs.readFile(path.join(paneDir, 'config.json'), 'utf8')),
        boundary.object({
          remoteDaemon: boundary.object({
            host: boundary.object({
              config: boundary.object({
                enabled: boundary.boolean,
                listenHost: boundary.string,
                listenPort: boundary.number,
              }),
              access: boundary.optional(boundary.object({
                baseUrl: boundary.string,
                tunnel: boundary.optional(boundary.object({
                  kind: boundary.string,
                  tailscaleIp: boundary.optional(boundary.string),
                })),
                updatedAt: boundary.string,
              })),
            }),
          }),
        }),
      );

      expect(result.tunnel?.kind).toBe('tailscale');
      expect(result.tunnel?.command).toBe('tailscale serve --bg --tls-terminated-tcp=443 42137');
      expect(result.tunnel?.tailscaleIp).toBe('100.127.116.52');
      expect(payload.baseUrl).toBe('https://office-mac.tailnet.ts.net');
      expect(payload.tunnel?.kind).toBe('tailscale');
      expect(payload.tunnel?.tailscaleIp).toBe('100.127.116.52');
      expect(config.remoteDaemon.host.config).toMatchObject({
        enabled: true,
        listenHost: '127.0.0.1',
        listenPort: 42137,
      });
      expect(config.remoteDaemon.host.access).toMatchObject({
        baseUrl: 'https://office-mac.tailnet.ts.net',
        tunnel: {
          kind: 'tailscale',
          tailscaleIp: '100.127.116.52',
        },
      });
      expect(config.remoteDaemon.host.access?.updatedAt).toEqual(expect.any(String));
    } finally {
      await fs.rm(paneDir, { recursive: true, force: true });
    }
  });

  it('uses sudo for Tailscale Serve permission errors during interactive Linux setup', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const paneDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-remote-tailscale-sudo-'));
    try {
      spawnSyncMock.mockImplementation((command: string, args: string[]) => {
        if (command === 'tailscale' && args[0] === 'version') {
          return commandResult({ status: 0, stdout: '1.80.0\n' });
        }
        if (
          command === 'tailscale' &&
          args[0] === 'serve' &&
          args[1] === '--bg' &&
          args[2] === '--tls-terminated-tcp=443'
        ) {
          return commandResult({
            status: 1,
            stderr: [
              'sending serve config: Access denied: serve config denied',
              '',
              'Use \'sudo tailscale serve --bg --tls-terminated-tcp=443 42137\'.',
              'To not require root, use \'sudo tailscale set --operator=$USER\' once.',
            ].join('\n'),
          });
        }
        if (
          command === 'sudo' &&
          args[0] === 'tailscale' &&
          args[1] === 'serve' &&
          args[2] === '--bg' &&
          args[3] === '--tls-terminated-tcp=443'
        ) {
          return commandResult({ status: 0 });
        }
        if (command === 'tailscale' && args[0] === 'serve' && args[1] === 'status') {
          return commandResult({
            status: 0,
            stdout: 'tcp://wsl-host.tailnet.ts.net:443 (TLS terminated) forward tcp://127.0.0.1:42137\n',
          });
        }

        return missingCommandResult(command);
      });

      const result = await setupRemoteHost({
        paneDir,
        label: 'WSL',
        installService: false,
        interactiveTailscaleSetup: true,
      });

      expect(result.tunnel?.kind).toBe('tailscale');
      expect(spawnSyncMock).toHaveBeenCalledWith('sudo', [
        'tailscale',
        'serve',
        '--bg',
        '--tls-terminated-tcp=443',
        '42137',
      ], expect.objectContaining({
        stdio: 'inherit',
      }));
    } finally {
      await fs.rm(paneDir, { recursive: true, force: true });
    }
  });

  it('installs Tailscale with Homebrew on macOS before configuring Serve', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const paneDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-remote-brew-tailscale-'));
    let tailscaleVersionCalls = 0;
    try {
      spawnSyncMock.mockImplementation((command: string, args: string[]) => {
        if (command === 'tailscale' && args[0] === 'version') {
          tailscaleVersionCalls += 1;
          return tailscaleVersionCalls === 1
            ? missingCommandResult(command)
            : commandResult({ status: 0, stdout: '1.80.0\n' });
        }
        if (command === 'brew' && args[0] === '--version') {
          return commandResult({ status: 0, stdout: 'Homebrew 4.0.0\n' });
        }
        if (command === 'brew' && args[0] === 'install') {
          return commandResult({ status: 0, stdout: 'Installed tailscale\n' });
        }
        if (command === 'open') {
          return commandResult({ status: 0 });
        }
        if (
          command === 'tailscale' &&
          args[0] === 'serve' &&
          args[1] === '--bg' &&
          args[2] === '--tls-terminated-tcp=443'
        ) {
          return commandResult({
            status: 0,
            stdout: 'Available within your tailnet:\n|-- tcp://office-mac.tailnet.ts.net:443 (TLS terminated)\n',
          });
        }
        if (command === 'tailscale' && args[0] === 'serve' && args[1] === 'status') {
          return commandResult({
            status: 0,
            stdout: 'tcp://office-mac.tailnet.ts.net:443 (TLS terminated) forward tcp://127.0.0.1:42137\n',
          });
        }

        return missingCommandResult(command);
      });

      const result = await setupRemoteHost({
        paneDir,
        installService: false,
      });

      expect(result.tunnel?.kind).toBe('tailscale');
      expect(spawnSyncMock).toHaveBeenCalledWith('brew', ['install', '--cask', 'tailscale'], expect.any(Object));
      expect(spawnSyncMock).toHaveBeenCalledWith('open', ['-a', 'Tailscale'], expect.any(Object));
    } finally {
      await fs.rm(paneDir, { recursive: true, force: true });
    }
  });

  it('keeps SSH tunnel setup available only when explicitly selected', async () => {
    const result = await setupRemoteHost({
      printOnly: true,
      preferTunnel: 'ssh',
      installService: false,
    });
    const payload = decodePaneRemoteConnection(result.connectionCode);

    expect(payload.baseUrl).toBe('http://127.0.0.1:42137');
    expect(payload.tunnel?.kind).toBe('ssh');
    expect(payload.tunnel?.command).toContain('ssh -N -L 42137:127.0.0.1:42137');
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('pairs with an in-memory config whose optional fields are unset', async () => {
    const writeConfig = vi.fn(async (_config: Parameters<NonNullable<SetupRemoteHostOptions['writeConfig']>>[0]) => {});

    const result = await setupRemoteHost({
      preferTunnel: 'ssh',
      installService: false,
      existingConfig: {
        verbose: true,
        anthropicApiKey: undefined,
        analytics: { enabled: true, githubEmail: undefined },
      },
      writeConfig,
    });

    expect(result.wroteConfig).toBe(true);
    const written = writeConfig.mock.calls[0][0];
    expect(written).toMatchObject({ verbose: true, analytics: { enabled: true } });
    expect(written.remoteDaemon).toBeDefined();
  });

  it('selects the next available loopback port when requested', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || !(address instanceof Object)) {
      throw new Error('Expected test server to listen on a TCP port');
    }

    try {
      const result = await setupRemoteHost({
        printOnly: true,
        preferTunnel: 'ssh',
        installService: false,
        listenPort: address.port,
        autoSelectListenPort: true,
      });

      expect(result.listenPort).toBeGreaterThan(address.port);
      expect(result.tunnel?.command).toContain(`${result.listenPort}:127.0.0.1:${result.listenPort}`);
      expect(result.connectionCode).toContain('pane-remote://');
      expect(spawnSyncMock).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it('requires a manual HTTPS base URL when manual mode is selected', async () => {
    await expect(setupRemoteHost({
      printOnly: true,
      preferTunnel: 'manual',
      installService: false,
    })).rejects.toThrow('Manual HTTPS remote setup requires a base URL.');
  });
});

describe('readConfiguredTailscaleServeAccess', () => {
  it('reports a missing 443 forward instead of returning the Workspaces 8443 URL', async () => {
    const tailscale = createFakeTailscale();
    tailscale.serveWorkspaceOnly();

    const result = await readConfiguredTailscaleServeAccess(42137, { run: tailscale.run });

    expect(result).toMatchObject({
      ok: false,
      issue: { summary: expect.stringContaining('forwards port 443 to this Pane (127.0.0.1:42137)') },
    });
    expect(JSON.stringify(result)).not.toContain(':8443');
    expect(tailscale.serveCalls()).toEqual([]);
  });

  it('builds access from live tailnet status when the 443 forward targets the listen port', async () => {
    const tailscale = createFakeTailscale({ tailnet: TAILNET_B });
    tailscale.serveWorkspaceOnly();
    tailscale.serveRemoteForward(42137);

    const result = await readConfiguredTailscaleServeAccess(42137, { run: tailscale.run });

    expect(result).toMatchObject({
      ok: true,
      tailnet: TAILNET_B.name,
      access: {
        baseUrl: 'https://parsa-devbox.tail3c2c57.ts.net',
        tunnel: { kind: 'tailscale', tailscaleIp: TAILNET_B.ip, command: 'tailscale serve --bg --tls-terminated-tcp=443 42137' },
      },
    });
  });

  it('leaves a 443 forward to another port alone instead of taking it over', async () => {
    const tailscale = createFakeTailscale({ tailnet: TAILNET_A });
    tailscale.serveRemoteForward(9999);

    await expect(readConfiguredTailscaleServeAccess(42137, { run: tailscale.run, reapply: true })).resolves.toMatchObject({
      ok: false,
      issue: { summary: expect.stringContaining('already forwards to 127.0.0.1:9999') },
    });
    expect(tailscale.serveCalls()).toEqual([]);
  });
});

describe('readConfiguredTailscaleServeAccess after a tailnet switch', () => {
  const macCli = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  });

  it.each([
    { platform: 'darwin', cli: macCli, env: { TAILSCALE_BE_CLI: '1' }, display: `TAILSCALE_BE_CLI=1 '${macCli}'` },
    { platform: 'win32', cli: 'tailscale', env: undefined, display: 'tailscale' },
    { platform: 'linux', cli: 'tailscale', env: undefined, display: 'tailscale' },
  ])('re-applies the 443 forward on the new tailnet with the $platform CLI', async ({ platform, cli, env, display }) => {
    Object.defineProperty(process, 'platform', { value: platform });
    const tailscale = createFakeTailscale({ cli, tailnet: TAILNET_A });
    tailscale.serveRemoteForward(42137);
    tailscale.switchTailnet(TAILNET_B);
    tailscale.serveWorkspaceOnly();

    const result = await readConfiguredTailscaleServeAccess(42137, {
      run: tailscale.run, reapply: true, pathExists: candidate => candidate === macCli,
    });

    expect(result).toMatchObject({
      ok: true,
      reapplied: true,
      tailnet: TAILNET_B.name,
      access: {
        baseUrl: 'https://parsa-devbox.tail3c2c57.ts.net',
        tunnel: { tailscaleIp: TAILNET_B.ip, command: `${display} serve --bg --tls-terminated-tcp=443 42137` },
      },
    });
    expect(tailscale.serveCalls()).toEqual([{
      command: cli,
      args: ['serve', '--bg', '--tls-terminated-tcp=443', '42137'],
      env: env ? expect.objectContaining(env) : undefined,
    }]);
  });
});

describe('Tailscale problems name what is wrong and the step that fixes it', () => {
  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  });

  type FakeTailscale = ReturnType<typeof createFakeTailscale>;
  const cases: Array<{
    name: string;
    platform?: NodeJS.Platform;
    arrange: (tailscale: FakeTailscale) => FakeTailscale['run'] | void;
    reapply?: boolean;
    summary: string;
    fix: string;
    command?: string;
  }> = [
    {
      name: 'Tailscale is not installed',
      arrange: () => async () => ({ ok: false, stdout: '', stderr: 'spawn tailscale ENOENT' }),
      summary: 'Tailscale isn\'t installed on this machine',
      fix: 'https://tailscale.com/download',
    },
    {
      name: 'tailscaled is not running',
      platform: 'darwin',
      arrange: tailscale => tailscale.failStatus('failed to connect to local tailscaled; it doesn\'t appear to be running'),
      summary: 'Tailscale is installed but not running',
      fix: 'open the Tailscale app',
    },
    {
      name: 'status fails for another reason',
      arrange: tailscale => tailscale.failStatus('unexpected EOF'),
      summary: 'Pane couldn\'t read Tailscale\'s status: unexpected EOF',
      fix: 'see the full error',
      command: 'tailscale status',
    },
    {
      name: 'status output is not JSON',
      arrange: tailscale => async (command, args, options) => (args.join(' ') === 'status --json'
        ? { ok: true, stdout: 'Logged out.', stderr: '' }
        : tailscale.run(command, args, options)),
      summary: 'Pane couldn\'t understand Tailscale\'s status',
      fix: 'update Tailscale',
    },
    {
      name: 'signed out',
      arrange: tailscale => tailscale.setBackendState('NeedsLogin'),
      summary: 'Tailscale is signed out',
      fix: 'sign in',
    },
    {
      name: 'disconnected',
      arrange: tailscale => tailscale.setBackendState('Stopped'),
      summary: 'Tailscale is disconnected',
      fix: 'Connect',
    },
    {
      name: 'still connecting',
      arrange: tailscale => tailscale.setBackendState('Starting'),
      summary: 'Tailscale is still connecting',
      fix: 'wait a few seconds',
    },
    {
      name: 'waiting for admin approval',
      arrange: tailscale => tailscale.setBackendState('NeedsMachineAuth'),
      summary: 'waiting for approval',
      fix: 'https://login.tailscale.com/admin/machines',
    },
    {
      name: 'no 443 forward and nothing re-applies it',
      arrange: () => {},
      summary: `Nothing on tailnet ${TAILNET_A.name} forwards port 443 to this Pane (127.0.0.1:42137)`,
      fix: 'run remote setup again',
      command: 'tailscale serve --bg --tls-terminated-tcp=443 42137',
    },
    {
      name: '443 forwards to another port',
      arrange: tailscale => tailscale.serveRemoteForward(9999),
      reapply: true,
      summary: 'Port 443 on tailnet example.github already forwards to 127.0.0.1:9999, not to this Pane (127.0.0.1:42137)',
      fix: 'another Pane',
      command: 'tailscale serve --bg --tls-terminated-tcp=443 42137',
    },
    {
      name: 'Serve is turned off for the tailnet',
      arrange: tailscale => tailscale.failServe('Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=n123\n'),
      reapply: true,
      summary: 'Tailscale Serve couldn\'t forward port 443 to this Pane on tailnet example.github',
      fix: 'turn on Tailscale Serve for your tailnet at https://login.tailscale.com/f/serve?node=n123',
    },
    {
      name: 'Linux denies Serve changes',
      platform: 'linux',
      arrange: tailscale => tailscale.failServe('serve config denied'),
      reapply: true,
      summary: 'Tailscale said: serve config denied',
      fix: 'sudo tailscale set --operator=$USER',
      command: 'sudo tailscale set --operator=$USER',
    },
    {
      name: 'Serve fails for another reason',
      platform: 'win32',
      arrange: tailscale => tailscale.failServe('500 Internal Server Error: listener in use'),
      reapply: true,
      summary: 'Tailscale said: 500 Internal Server Error: listener in use',
      fix: 'in a terminal to see the full error',
      command: 'tailscale serve --bg --tls-terminated-tcp=443 42137',
    },
    {
      name: 'Serve succeeds but the forward never appears',
      arrange: tailscale => tailscale.ignoreServe(),
      reapply: true,
      summary: 'Tailscale still doesn\'t list a port 443 forward',
      fix: 'compare it with',
      command: 'tailscale serve status',
    },
  ];

  it.each(cases)('$name', async ({ platform, arrange, reapply, summary, fix, command }) => {
    if (platform) Object.defineProperty(process, 'platform', { value: platform });
    const tailscale = createFakeTailscale({ tailnet: TAILNET_A });
    const run = arrange(tailscale) ?? tailscale.run;

    const result = await readConfiguredTailscaleServeAccess(42137, { run, reapply, pathExists: () => false });

    if (result.ok) throw new Error('expected a Tailscale problem');
    expect(result.issue.summary).toContain(summary);
    expect(result.issue.fix).toContain(fix);
    expect(result.issue.command).toBe(command);
    expect(formatTailscaleIssue(result.issue)).not.toMatch(/\n/);
    expect(formatTailscaleIssue(result.issue)).toContain('To fix it:');
  });
});
