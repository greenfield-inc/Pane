import http from 'http';
import net from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import type { ComputerRoute } from '../../../shared/types/remoteComputers';
import { SshTunnels, type SshForward, type SshRunner } from './sshRoute';

/** A forward that serves `/health` on its local port, as a tunnel to a running host does; `drop()` ends it like a lost connection. */
function fakeSsh(): SshRunner & { forwards: Array<{ localPort: number; drop: () => void }> } {
  const forwards: Array<{ localPort: number; drop: () => void }> = [];
  return {
    forwards,
    run: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
    forward(_host, localPort): SshForward {
      const server = http.createServer((_request, response) => response.end('ok'));
      let end = () => {};
      const exited = new Promise<void>((resolve) => { end = resolve; });
      const drop = () => { server.closeAllConnections(); server.close(() => end()); };
      server.listen(localPort, '127.0.0.1');
      forwards.push({ localPort, drop });
      return { exited, stderr: () => '', kill: drop };
    },
  };
}

function health(baseUrl: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}/health`, (response) => { response.resume(); resolve(response.statusCode ?? 0); }).once('error', reject);
  });
}

function sshRoute(localPort: number): ComputerRoute {
  return { id: 'ssh:devbox', kind: 'ssh', source: 'ssh', baseUrl: `http://127.0.0.1:${localPort}`, token: 't', ssh: { host: 'devbox', remotePort: 42137 } };
}

function tcpAddress(server: net.Server): net.AddressInfo {
  // SAFETY: every server here listens on 127.0.0.1 and a TCP port.
  return server.address() as net.AddressInfo;
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = tcpAddress(server);
      server.close(() => resolve(port));
    });
  });
}

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function tunnels(runner: SshRunner): SshTunnels {
  const created = new SshTunnels(runner, { readyTimeoutMs: 2_000, firstRetryMs: 20, maxRetryMs: 50, giveUpMs: 5_000 });
  cleanups.push(() => created.stopAll());
  return created;
}

describe('SSH tunnel keeper', () => {
  it('reopens the tunnel on the same local port after the ssh process exits', async () => {
    const ssh = fakeSsh();
    const keeper = tunnels(ssh);
    const port = await freePort();

    const first = await keeper.ensure(sshRoute(port));
    expect(first).toBe(`http://127.0.0.1:${port}`);
    expect(await health(first)).toBe(200);

    ssh.forwards[0].drop();
    await expect.poll(() => ssh.forwards.length, { timeout: 3_000 }).toBe(2);
    expect(ssh.forwards[1].localPort).toBe(port);
    await expect.poll(() => health(first).catch(() => 0), { timeout: 3_000 }).toBe(200);
    expect(await keeper.ensure(sshRoute(port))).toBe(first);
  });

  it('dials a new local port when the saved one is taken', async () => {
    const taken = net.createServer();
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => taken.close());
    const takenPort = tcpAddress(taken).port;

    const baseUrl = await tunnels(fakeSsh()).ensure(sshRoute(takenPort));

    expect(baseUrl).not.toBe(`http://127.0.0.1:${takenPort}`);
    expect(await health(baseUrl)).toBe(200);
  });
});
