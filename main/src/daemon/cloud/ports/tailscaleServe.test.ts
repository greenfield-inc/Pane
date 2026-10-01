import { describe, expect, it } from 'vitest';
import type { ExecFileOptions } from 'child_process';
import { CommandExecutor } from '../../../utils/commandExecutor';
import { createTailscaleServeBackend, describeListener, parseServeListeners, serveRunner } from './tailscaleServe';

const HOST = 'rp-a1b2c3d4.example.ts.net';

describe('parseServeListeners', () => {
  it('reads tcp forwards, TLS-terminated tcp and web handlers', () => {
    const listeners = parseServeListeners(JSON.stringify({
      TCP: {
        42137: { TCPForward: '127.0.0.1:42137' },
        443: { TCPForward: '127.0.0.1:42137', TerminateTLS: HOST },
        8787: { TCPForward: '127.0.0.1:8787' },
        8788: { HTTPS: true },
        9000: { HTTP: true },
      },
      Web: {
        [`${HOST}:8788`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } },
        [`${HOST}:9000`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:9000' } } },
      },
    }), HOST);
    expect([...listeners.entries()]).toEqual([
      [443, { kind: 'tcp', forward: '127.0.0.1:42137', terminateTls: true }],
      [8787, { kind: 'tcp', forward: '127.0.0.1:8787', terminateTls: false }],
      [8788, { kind: 'web', scheme: 'https', proxy: 'http://127.0.0.1:3000' }],
      [9000, { kind: 'web', scheme: 'http', proxy: 'http://127.0.0.1:9000' }],
      [42137, { kind: 'tcp', forward: '127.0.0.1:42137', terminateTls: false }],
    ]);
    expect(describeListener(listeners.get(8787) ?? { kind: 'tcp', forward: '', terminateTls: false })).toBe('plain tcp -> 127.0.0.1:8787');
  });

  it('reads an empty config', () => {
    expect(parseServeListeners('', HOST).size).toBe(0);
    expect(parseServeListeners('{}', HOST).size).toBe(0);
  });
});

describe('createTailscaleServeBackend', () => {
  it('runs serve as the operator and retries with sudo -n only when access is denied', async () => {
    const calls: string[] = [];
    const backend = createTailscaleServeBackend(async (file, args) => {
      calls.push([file, ...args].join(' '));
      if (file === 'tailscale') return { code: 1, stdout: '', stderr: 'Access denied: serve config denied' };
      return { code: 0, stdout: '', stderr: '' };
    });
    await backend.applyWeb('https', 8788, 3000);
    expect(calls).toEqual([
      'tailscale serve --bg --https=8788 http://127.0.0.1:3000',
      'sudo -n tailscale serve --bg --https=8788 http://127.0.0.1:3000',
    ]);
  });

  it('turns off the right kind of entry', async () => {
    const calls: string[] = [];
    const backend = createTailscaleServeBackend(async (file, args) => {
      calls.push([file, ...args].join(' '));
      return { code: 0, stdout: '', stderr: '' };
    });
    await backend.remove(8787, { kind: 'tcp', forward: '127.0.0.1:8787', terminateTls: false });
    await backend.remove(8788, { kind: 'web', scheme: 'https' });
    await backend.remove(9000, { kind: 'web', scheme: 'http' });
    expect(calls).toEqual(['tailscale serve --tcp=8787 off', 'tailscale serve --https=8788 off', 'tailscale serve --http=9000 off']);
  });

  it('reports a failed serve change with its message', async () => {
    const backend = createTailscaleServeBackend(async () => ({ code: 1, stdout: '', stderr: 'error: port in use' }));
    await expect(backend.applyWeb('https', 8788, 3000)).rejects.toThrow(/port in use/u);
  });
});

describe('serveRunner', () => {
  function executor(outcome: (file: string) => { stdout: string; stderr: string } | Error) {
    const seen: Array<{ file: string; args: string[]; options: ExecFileOptions }> = [];
    const fileExecutor = async (file: string, args: readonly string[], options: ExecFileOptions) => {
      seen.push({ file, args: [...args], options });
      const result = outcome(file);
      if (result instanceof Error) throw result;
      return result;
    };
    // SAFETY: the fake implements the promisified execFile call shape CommandExecutor uses.
    return { seen, executor: new CommandExecutor(fileExecutor as ConstructorParameters<typeof CommandExecutor>[0]) };
  }

  function exitError(code: number | string, stderr: string): Error {
    return Object.assign(new Error(`Command failed: tailscale\n${stderr}`), { code, stdout: '', stderr });
  }

  it('runs Serve commands through the shared CommandExecutor with a timeout and an output cap', async () => {
    const { seen, executor: shared } = executor(() => ({ stdout: '{}', stderr: '' }));
    const result = await serveRunner(shared)('tailscale', ['serve', 'status', '--json']);
    expect(result).toEqual({ code: 0, stdout: '{}', stderr: '' });
    expect(seen.map(call => [call.file, ...call.args].join(' '))).toEqual(['tailscale serve status --json']);
    expect(seen[0]?.options).toMatchObject({ timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
  });

  it('turns a failed exit, a timeout or too much output into a failed result the backend reports', async () => {
    const denied = executor(file => file === 'tailscale' ? exitError(1, 'Access denied: serve config denied') : { stdout: '', stderr: '' });
    const backend = createTailscaleServeBackend(serveRunner(denied.executor));
    await backend.applyWeb('https', 8788, 3000);
    expect(denied.seen.map(call => call.file)).toEqual(['tailscale', 'sudo']);

    const overflow = executor(() => exitError('ERR_CHILD_PROCESS_STDIO_MAXBUFFER', ''));
    expect(await serveRunner(overflow.executor)('tailscale', ['serve', 'status', '--json'])).toMatchObject({ code: 1, stderr: expect.stringContaining('Command failed') });

    const killed = executor(() => Object.assign(new Error('Command failed: tailscale status'), { code: null, killed: true, signal: 'SIGTERM', stdout: '', stderr: '' }));
    expect(await serveRunner(killed.executor)('tailscale', ['status', '--json'])).toMatchObject({ code: 1, stderr: expect.stringContaining('Command failed') });
  });
});
